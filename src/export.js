// export.js — MapStitch 二进制地图格式（.mst）
//
// 布局：
//   0..3   magic 'MST1'
//   4..7   header JSON 的字节长度 (u32 LE)
//   8..    header JSON (utf8)
//   之后   各层的 positions (Float32 x3)、normals (Float32 x3)、colors (Uint8 x3)，
//          每段按 4 字节对齐；header.layers[i] 里记录相对数据区起点的偏移。
//
// header = {
//   version, map, bounds, stats, markers,
//   layers: [{ name, vertexCount, posOffset, nrmOffset, colOffset }]
// }

import fs from 'node:fs';
import path from 'node:path';

const MAGIC = 'MST1';

export function writeMst(file, extracted) {
  const layers = [];
  let cursor = 0;
  const chunks = [];
  for (const layer of extracted.layers) {
    const pos = Buffer.from(layer.positions.buffer, layer.positions.byteOffset, layer.positions.byteLength);
    const nrm = Buffer.from(layer.normals.buffer, layer.normals.byteOffset, layer.normals.byteLength);
    const col = Buffer.from(layer.colors.buffer, layer.colors.byteOffset, layer.colors.byteLength);
    const entry = { name: layer.name, vertexCount: layer.vertexCount };
    entry.posOffset = cursor; cursor += pos.length;
    chunks.push(pos);
    entry.nrmOffset = cursor; cursor += nrm.length;
    chunks.push(nrm);
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    entry.colOffset = cursor; cursor += col.length;
    chunks.push(col);
    const pad2 = (4 - (cursor % 4)) % 4;
    if (pad2) { chunks.push(Buffer.alloc(pad2)); cursor += pad2; }
    layers.push(entry);
  }
  const header = {
    version: 1,
    map: extracted.map,
    bounds: extracted.bounds,
    stats: extracted.stats,
    markers: extracted.markers,
    layers,
  };
  // JSON 头补齐到 4 字节，保证后续 Float32Array 视图对齐
  let headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const padHeader = (4 - (headerBuf.length % 4)) % 4;
  if (padHeader) headerBuf = Buffer.concat([headerBuf, Buffer.alloc(padHeader, 0x20)]);
  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(headerBuf.length, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, headerBuf);
    for (const c of chunks) fs.writeSync(fd, c);
  } finally {
    fs.closeSync(fd);
  }
  return { file, bytes: 8 + headerBuf.length + cursor, header };
}

export function readMstHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(8);
    fs.readSync(fd, h, 0, 8, 0);
    if (h.toString('latin1', 0, 4) !== MAGIC) throw new Error(`${file}: 不是 .mst 文件`);
    const len = h.readUInt32LE(4);
    const jb = Buffer.alloc(len);
    fs.readSync(fd, jb, 0, len, 8);
    return JSON.parse(jb.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
