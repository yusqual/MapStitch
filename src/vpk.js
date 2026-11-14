// vpk.js — Valve Pak v1 读取器（L4D2 的 addon 与官方 pak01 都是 v1）。
//
// 目录树格式（重要）：
//   for ext:
//     for dir:
//       for name:
//         18 字节目录项 { crc u32, preloadBytes u16, archiveIndex u16,
//                        entryOffset u32, entryLength u32, 0xffff u16 }
//         紧跟 preloadBytes 字节的 preload 数据 —— 必须跳过，否则从第一个带
//         preload 的文件开始错位（官方 pak01_dir.vpk 会从 22,273 条掉到 17,646 条）。
//
// archiveIndex == 0x7fff 表示数据内嵌在 *_dir.vpk 自身，偏移从
// (12 + treeSize) 的数据区起算；其它值表示分卷 <base>_NNN.vpk，偏移是文件绝对偏移。
//
// 一个“逻辑文件”的字节 = preload 数据 + 分卷/内嵌数据，二者可能都存在。

import fs from 'node:fs';
import path from 'node:path';

export const VPK_SIGNATURE = 0x55aa1234;
export const EMBEDDED_ARCHIVE = 0x7fff;

function normPath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export class Vpk {
  constructor(file) {
    this.file = path.resolve(file);
    this.entries = [];
    this.byPath = new Map();
    this._archiveCache = new Map();
    this._parse();
  }

  _readAt(file, offset, length) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = fs.readSync(fd, buf, got, length - got, offset + got);
        if (!n) break;
        got += n;
      }
      if (got !== length) throw new Error(`${file}: 读取越界（需要 ${length} 字节 @${offset}，实际 ${got}）`);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  _parse() {
    if (!fs.existsSync(this.file)) throw new Error(`找不到 VPK: ${this.file}`);
    this.fileSize = fs.statSync(this.file).size;
    if (this.fileSize < 12) throw new Error(`${this.file}: 文件太小，不是 VPK`);
    const head = this._readAt(this.file, 0, 12);
    const sig = head.readUInt32LE(0);
    if (sig !== VPK_SIGNATURE) throw new Error(`${this.file}: 不是 VPK (signature=0x${sig.toString(16)})`);
    this.version = head.readUInt32LE(4);
    if (this.version !== 1) {
      throw new Error(`${this.file}: 只支持 VPK v1，实际 v${this.version}`);
    }
    this.headerSize = 12;
    this.treeSize = head.readUInt32LE(8);
    if (this.headerSize + this.treeSize > this.fileSize) {
      throw new Error(`${this.file}: 目录树大小 ${this.treeSize} 超出文件`);
    }
    const tree = this._readAt(this.file, this.headerSize, this.treeSize);
    this.dataStart = this.headerSize + this.treeSize;

    let p = 0;
    const readString = () => {
      const start = p;
      while (p < tree.length && tree[p] !== 0) p++;
      if (p >= tree.length) throw new Error(`${this.file}: 目录树字符串未结束 @${start}`);
      const s = tree.toString('utf8', start, p);
      p++;
      return s;
    };

    while (true) {
      const ext = readString();
      if (!ext) break;
      while (true) {
        const dir = readString();
        if (!dir) break;
        while (true) {
          const name = readString();
          if (!name) break;
          if (p + 18 > tree.length) throw new Error(`${this.file}: 目录项越界 @${p}`);
          const crc = tree.readUInt32LE(p);
          const preloadBytes = tree.readUInt16LE(p + 4);
          const archiveIndex = tree.readUInt16LE(p + 6);
          const entryOffset = tree.readUInt32LE(p + 8);
          const entryLength = tree.readUInt32LE(p + 12);
          const terminator = tree.readUInt16LE(p + 16);
          p += 18;
          if (terminator !== 0xffff) {
            throw new Error(`${this.file}: 目录项终止符错误 @${p - 2}（可能 preload 未跳过）`);
          }
          if (p + preloadBytes > tree.length) throw new Error(`${this.file}: preload 数据越界 @${p}`);
          const preload = preloadBytes ? Buffer.from(tree.subarray(p, p + preloadBytes)) : null;
          p += preloadBytes;

          const baseName = ext.trim() ? `${name}.${ext}` : name;
          const rel = dir ? `${dir}/${baseName}` : baseName;
          const entry = {
            path: rel,
            key: normPath(rel),
            crc,
            preload,
            preloadBytes,
            archiveIndex,
            entryOffset,
            entryLength,
            size: preloadBytes + entryLength,
          };
          this.entries.push(entry);
          // 同名条目后者覆盖（VPK 语义）
          this.byPath.set(entry.key, entry);
        }
      }
    }
  }

  // 分卷路径：pak01_dir.vpk -> pak01_003.vpk；普通 foo.vpk -> foo_000.vpk
  archiveFile(index) {
    if (this._archiveCache.has(index)) return this._archiveCache.get(index);
    const dir = path.dirname(this.file);
    const base = path.basename(this.file).replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
    const file = path.join(dir, `${base}_${String(index).padStart(3, '0')}.vpk`);
    this._archiveCache.set(index, file);
    return file;
  }

  // 读取逻辑文件 [relOffset, relOffset+length)，可跨 preload 与归档数据
  readRange(entry, relOffset = 0, length = entry.size) {
    if (relOffset < 0 || length < 0 || relOffset + length > entry.size) {
      throw new Error(`${entry.path}: 读取范围越界 (${relOffset}+${length}/${entry.size})`);
    }
    const parts = [];
    let skip = relOffset;
    let want = length;

    const preloadLen = entry.preloadBytes;
    if (want > 0 && skip < preloadLen) {
      const n = Math.min(want, preloadLen - skip);
      parts.push(entry.preload.subarray(skip, skip + n));
      skip = 0;
      want -= n;
    } else {
      skip -= preloadLen;
    }

    if (want > 0) {
      const archiveSize = entry.entryLength;
      if (skip + want > archiveSize) throw new Error(`${entry.path}: 数据长度与目录项不符`);
      if (entry.archiveIndex === EMBEDDED_ARCHIVE) {
        if (this.dataStart + entry.entryOffset + skip + want > this.fileSize) {
          throw new Error(`${entry.path}: 内嵌数据越界`);
        }
        parts.push(this._readAt(this.file, this.dataStart + entry.entryOffset + skip, want));
      } else {
        const af = this.archiveFile(entry.archiveIndex);
        if (!fs.existsSync(af)) throw new Error(`${entry.path}: 缺少分卷 ${path.basename(af)}`);
        parts.push(this._readAt(af, entry.entryOffset + skip, want));
      }
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  readEntry(entry) { return this.readRange(entry, 0, entry.size); }

  find(logicalPath) { return this.byPath.get(normPath(logicalPath)); }

  has(logicalPath) { return this.byPath.has(normPath(logicalPath)); }

  // 按前缀筛选（大小写不敏感，路径用 /）
  list(prefix = '') {
    const p = normPath(prefix);
    return this.entries.filter((e) => e.key.startsWith(p));
  }
}

export function openVpk(file) { return new Vpk(file); }
