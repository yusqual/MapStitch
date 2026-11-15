// addon.js — 创意工坊 / addons 地图发现与配对。
//
// 设计要点：
//   * 默认只处理用户选中的那一个 addon（VPK 或散装目录），不扫描全部 addons；
//   * VPK 只解包选中战役实际引用的 .bsp，缓存到 out/cache/<addon>/，按源文件
//     mtime/size 失效；偏移计算直接读 VPK 里的实体 lump，不解包整张图；
//   * 章节顺序优先取 missions/<战役>.txt 的 modes → coop → "1..N" → Map，
//     只取 coop，且与 addon 内实际存在的 .bsp 取交集（过滤 map_x 之类占位名）；
//   * 没有 missions 时回退到 trigger_changelevel / info_changelevel 的 map+landmark 连链；
//   * 官方 DLC 的 missions 在 pak01_dir.vpk 内，同样支持读取。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openVpk } from './vpk.js';
import { parseEntityLump } from './bsp.js';
import { getGameRoot } from './gamepath.js';
import {
  officialMapsDirs, calcOffset, listCampaignMaps, listPairs,
} from './offset.js';

const BSP_HEADER_BYTES = 12 + 64 * 16;
const BSP_ENTITIES_LUMP = 0;
const CHANGELEVEL_CLASSES = /^(trigger|info)_changelevel$/i;
const EXTRACT_CHUNK = 8 * 1024 * 1024;

function lower(s) { return String(s || '').toLowerCase(); }
function stripBsp(s) { return String(s || '').replace(/\.bsp$/i, ''); }
function naturalCompare(a, b) { return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }); }
function sanitizeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'addon'; }

export function defaultAddonsDir(gameRoot = getGameRoot()) {
  return path.join(gameRoot, 'left4dead2', 'addons');
}

export function defaultWorkshopDir(gameRoot = getGameRoot()) {
  return path.resolve(gameRoot, '..', '..', 'workshop', 'content', '550');
}

// ---------- addon 发现 ----------

function isVolumeFile(name) { return /_\d{3}\.vpk$/i.test(name); }

// 列出可选的 addon：addons/*.vpk、addons/*/（散装）、workshop/content/550/*/。
// 只做元数据扫描，不打开 VPK。
export function listAddons(gameRoot = getGameRoot()) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = lower(item.source);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  const addonsDir = defaultAddonsDir(gameRoot);
  if (fs.existsSync(addonsDir)) {
    for (const name of fs.readdirSync(addonsDir)) {
      const full = path.join(addonsDir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isFile() && /\.vpk$/i.test(name) && !isVolumeFile(name)) {
        const display = name.replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
        push({ id: display, name: display, kind: 'vpk', source: full, size: st.size });
      } else if (st.isDirectory()) {
        if (fs.existsSync(path.join(full, 'maps'))) {
          push({ id: name, name, kind: 'dir', source: full, size: 0 });
        }
      }
    }
  }

  const workshop = defaultWorkshopDir(gameRoot);
  if (fs.existsSync(workshop)) {
    for (const id of fs.readdirSync(workshop)) {
      const full = path.join(workshop, id);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (fs.existsSync(path.join(full, 'maps'))) {
          push({ id, name: id, kind: 'dir', source: full, size: 0 });
        }
        // 有些 workshop item 内部再放 vpk
        for (const f of fs.readdirSync(full)) {
          if (!/\.vpk$/i.test(f) || isVolumeFile(f)) continue;
          const vp = path.join(full, f);
          const vs = fs.statSync(vp);
          const display = f.replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
          push({ id: `${id}/${display}`, name: display, kind: 'vpk', source: vp, size: vs.size });
        }
      } else if (st.isFile() && /\.vpk$/i.test(id) && !isVolumeFile(id)) {
        const display = id.replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
        push({ id: display, name: display, kind: 'vpk', source: full, size: st.size });
      }
    }
  }
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}

// 接受：绝对/相对路径（.vpk 或散装目录）、addons 里的名字（可省略 .vpk）。
// 同名既有 VPK 又有散装目录时优先 VPK；要选目录请直接传目录路径。
export function resolveAddon(spec, gameRoot = getGameRoot()) {
  if (!spec) throw new Error('缺少 addon（--addon <vpk 或目录>）');

  const asPath = (c) => {
    if (!fs.existsSync(c)) return null;
    const st = fs.statSync(c);
    if (st.isDirectory()) {
      const name = path.basename(path.resolve(c));
      return { id: name, name, kind: 'dir', source: path.resolve(c), size: 0 };
    }
    if (st.isFile() && /\.vpk$/i.test(c)) {
      const base = path.basename(c);
      const name = base.replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
      return { id: name, name, kind: 'vpk', source: path.resolve(c), size: st.size };
    }
    return null;
  };

  // 显式路径：原样使用
  const looksLikePath = path.isAbsolute(spec) || /[\\/]/.test(spec) || /\.vpk$/i.test(spec);
  if (looksLikePath) {
    const hit = asPath(spec) || asPath(path.resolve(spec));
    if (hit) return hit;
  }

  // 名字：优先 addons/<name>.vpk（VPK 原件），其次 addons/<name>/ 散装目录
  const addonsDir = defaultAddonsDir(gameRoot);
  const vpkHit = asPath(path.join(addonsDir, `${spec}.vpk`));
  if (vpkHit) return vpkHit;
  const dirHit = asPath(path.join(addonsDir, spec));
  if (dirHit) return dirHit;

  const wanted = lower(path.basename(spec)).replace(/\.vpk$/i, '');
  const all = listAddons(gameRoot);
  const matches = all.filter((a) => lower(a.name) === wanted || lower(a.id) === wanted
    || lower(path.basename(a.source, '.vpk')) === wanted);
  if (!matches.length) {
    throw new Error(`找不到 addon "${spec}"（可用 "node src/cli.js addons" 查看）`);
  }
  matches.sort((a, b) => (a.kind === 'vpk' ? -1 : 1) - (b.kind === 'vpk' ? -1 : 1));
  return matches[0];
}

// ---------- missions（KeyValues） ----------

function tokenizeKV(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < text.length) {
        if (text[i] === '\\' && text[i + 1] === '"') { s += '"'; i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        s += text[i++];
      }
      tokens.push(s);
      continue;
    }
    if (c === '{' || c === '}') { tokens.push(c); i++; continue; }
    let s = '';
    while (i < text.length && !/[\s{}"]/.test(text[i])) {
      if (text[i] === '/' && text[i + 1] === '/') break;
      s += text[i++];
    }
    if (s) tokens.push(s);
  }
  return tokens;
}

export function parseKV(text) {
  const tokens = tokenizeKV(text);
  let i = 0;
  const parseBlock = (nested) => {
    const obj = {};
    while (i < tokens.length) {
      const key = tokens[i++];
      if (key === '}') {
        if (nested) return obj;
        continue;
      }
      if (key === '{') continue;
      let value;
      if (tokens[i] === '{') {
        i++;
        value = parseBlock(true);
      } else {
        value = tokens[i++];
      }
      obj[key] = value;
    }
    return obj;
  };
  return parseBlock(false);
}

function kvGet(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lk = lower(key);
  for (const k of Object.keys(obj)) if (lower(k) === lk) return obj[k];
  return undefined;
}

// 解析 missions/<战役>.txt：只取 modes → coop → 数字键 → Map。
export function parseMissionsText(text, label = 'missions') {
  const source = String(text || '').replace(/^﻿/, '');
  const root = parseKV(source);
  const mission = kvGet(root, 'mission') || root;
  const modes = kvGet(mission, 'modes');
  const coop = kvGet(modes, 'coop');
  if (!coop || typeof coop !== 'object') return null;

  const keys = Object.keys(coop);
  const numeric = keys.filter((k) => /^\d+$/.test(k.trim()));
  const ordered = (numeric.length ? numeric : keys)
    .sort((a, b) => (numeric.length ? Number(a) - Number(b) : naturalCompare(a, b)));

  const chapters = [];
  for (const k of ordered) {
    const ch = coop[k];
    if (!ch || typeof ch !== 'object') continue;
    const map = kvGet(ch, 'Map') || kvGet(ch, 'map');
    if (!map) continue;
    chapters.push({
      index: numeric.length ? Number(k) : chapters.length + 1,
      map: stripBsp(path.basename(String(map).replace(/\\/g, '/'))),
      displayName: kvGet(ch, 'DisplayName') || '',
    });
  }
  if (!chapters.length) return null;
  return {
    name: kvGet(mission, 'Name') || path.basename(label).replace(/\.txt$/i, ''),
    file: label,
    chapters,
  };
}

function campaignIdFor(missionsName, chapters) {
  const first = chapters[0] && chapters[0].map;
  const m = /^(c\d+)m\d+/i.exec(first || '');
  if (m) return lower(m[1]);
  return lower(String(missionsName || 'addon')).replace(/[^a-z0-9_]+/gi, '_');
}

// ---------- 内容访问（VPK / 散装目录） ----------

function readAtFile(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, offset + got);
      if (!n) break;
      got += n;
    }
    if (got !== length) throw new Error(`${file}: 读取越界 @${offset}+${length}`);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function entitiesFromHeader(head, readRange, label) {
  if (head.length < BSP_HEADER_BYTES) throw new Error(`${label}: BSP 头不完整`);
  const ident = head.readUInt32LE(0);
  if (ident !== 0x50534256) throw new Error(`${label}: 不是 VBSP`);
  const version = head.readInt32LE(4);
  const lumpBase = version >= 21 ? 12 : 8;
  const ofs = head.readInt32LE(lumpBase + BSP_ENTITIES_LUMP * 16);
  const len = head.readInt32LE(lumpBase + BSP_ENTITIES_LUMP * 16 + 4);
  if (len <= 0) return [];
  return parseEntityLump(readRange(ofs, len), label);
}

class VpkContent {
  constructor(addon, vpk) {
    this.addon = addon;
    this.vpk = vpk;
  }

  maps() {
    let entries = this.vpk.entries.filter((e) => /\.bsp$/i.test(e.path) && /^maps\//i.test(e.path));
    // 少数 addon 把 bsp 放根目录
    if (!entries.length) entries = this.vpk.entries.filter((e) => /^[^/]+\.bsp$/i.test(e.path));
    const byName = new Map();
    for (const e of entries) {
      const name = stripBsp(path.basename(e.path));
      if (!byName.has(lower(name))) byName.set(lower(name), { name, internalPath: e.path, size: e.size, entry: e });
    }
    return [...byName.values()].sort((a, b) => naturalCompare(a.name, b.name));
  }

  missions() {
    return this.vpk.list('missions/')
      .filter((e) => /\.txt$/i.test(e.path))
      .map((e) => ({ internalPath: e.path, text: this.vpk.readEntry(e).toString('utf8') }));
  }

  entities(map) {
    const label = `${this.addon.name}:${map.internalPath}`;
    const head = this.vpk.readRange(map.entry, 0, Math.min(BSP_HEADER_BYTES, map.entry.size));
    return entitiesFromHeader(head, (o, l) => this.vpk.readRange(map.entry, o, l), label);
  }

  extractMap(map, destFile) {
    const { entry } = map;
    const { vpk } = this;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const tmp = `${destFile}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      if (entry.preloadBytes) fs.writeSync(fd, entry.preload);
      for (let done = 0; done < entry.entryLength; done += EXTRACT_CHUNK) {
        const n = Math.min(EXTRACT_CHUNK, entry.entryLength - done);
        const chunk = vpk.readRange(entry, entry.preloadBytes + done, n);
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destFile);
    return destFile;
  }

  fingerprint() {
    const dir = path.dirname(this.addon.source);
    const base = path.basename(this.addon.source).replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{3}\\.vpk$`, 'i');
    const files = [this.addon.source];
    for (const f of fs.readdirSync(dir)) {
      if (re.test(f)) files.push(path.join(dir, f));
    }
    return files.sort().map((f) => {
      const st = fs.statSync(f);
      return `${path.basename(f)}:${st.size}:${Math.floor(st.mtimeMs)}`;
    }).join('|');
  }
}

function walkFiles(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walkFiles(full, ext, out);
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

class DirContent {
  constructor(addon) {
    this.addon = addon;
    this.root = addon.source;
  }

  maps() {
    let files = walkFiles(path.join(this.root, 'maps'), /\.bsp$/i);
    if (!files.length) files = walkFiles(this.root, /\.bsp$/i).filter((f) => path.dirname(f) === this.root);
    const byName = new Map();
    for (const f of files) {
      const name = stripBsp(path.basename(f));
      if (!byName.has(lower(name))) {
        byName.set(lower(name), { name, internalPath: path.relative(this.root, f).replace(/\\/g, '/'), size: fs.statSync(f).size, file: f });
      }
    }
    return [...byName.values()].sort((a, b) => naturalCompare(a.name, b.name));
  }

  missions() {
    return walkFiles(path.join(this.root, 'missions'), /\.txt$/i)
      .map((f) => ({ internalPath: path.relative(this.root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
  }

  entities(map) {
    const head = readAtFile(map.file, 0, BSP_HEADER_BYTES);
    return entitiesFromHeader(head, (o, l) => readAtFile(map.file, o, l), map.file);
  }

  extractMap(map) { return map.file; }

  fingerprint() {
    return [this.addon.source];
  }
}

export function openContent(addon) {
  if (addon.kind === 'vpk') return new VpkContent(addon, openVpk(addon.source));
  return new DirContent(addon);
}

// ---------- 发现 + 配对 ----------

function hintLandmark(entsA, toName) {
  const target = lower(toName);
  for (const e of entsA) {
    if (!CHANGELEVEL_CLASSES.test(e.classname || '')) continue;
    if (lower(stripBsp(path.basename(String(e.map || '').replace(/\\/g, '/')))) !== target) continue;
    if (e.landmark) return e.landmark;
  }
  return '';
}

function makePair(campaign, from, to, getEntities, hint, extra = {}, yaw = null) {
  try {
    const ea = getEntities(from);
    const eb = getEntities(to);
    let r;
    if (hint) {
      try { r = calcOffset(ea, eb, hint, yaw); } catch { r = calcOffset(ea, eb, null, yaw); }
    } else {
      r = calcOffset(ea, eb, null, yaw);
    }
    const { note: extraNote, ...rest } = extra;
    return {
      campaign, from: from.name, to: to.name,
      landmark: r.landmark, offset: r.offset, yaw: r.yaw,
      note: [r.note, extraNote].filter(Boolean).join('；'),
      landmarkA: r.a, landmarkB: r.b,
      ...rest,
    };
  } catch (e) {
    return { campaign, from: from.name, to: to.name, error: e.message, ...extra };
  }
}

// 没有 missions 时的回退：trigger_changelevel / info_changelevel 的 map 连链。
function changelevelChains(maps, getEntities) {
  const byLower = new Map(maps.map((m) => [lower(m.name), m]));
  const edges = new Map();
  for (const m of maps) {
    let ents;
    try { ents = getEntities(m); } catch { continue; }
    const list = [];
    for (const e of ents) {
      if (!CHANGELEVEL_CLASSES.test(e.classname || '')) continue;
      const target = lower(stripBsp(path.basename(String(e.map || '').replace(/\\/g, '/'))));
      if (!target || target === lower(m.name) || !byLower.has(target)) continue;
      if (list.some((x) => lower(x.to.name) === target)) continue;
      list.push({ to: byLower.get(target), landmark: e.landmark || '' });
    }
    if (list.length) edges.set(lower(m.name), list.sort((a, b) => naturalCompare(a.to.name, b.to.name)));
  }

  const indegree = new Map(maps.map((m) => [lower(m.name), 0]));
  for (const list of edges.values()) for (const e of list) indegree.set(lower(e.to.name), (indegree.get(lower(e.to.name)) || 0) + 1);

  const starts = maps.filter((m) => !indegree.get(lower(m.name))).sort((a, b) => naturalCompare(a.name, b.name));
  const orderedStarts = starts.length ? starts : [...maps].sort((a, b) => naturalCompare(a.name, b.name));
  const visited = new Set();
  const chains = [];
  for (const start of orderedStarts) {
    if (visited.has(lower(start.name))) continue;
    const chain = [];
    let cur = start;
    while (cur && !visited.has(lower(cur.name))) {
      visited.add(lower(cur.name));
      chain.push(cur);
      const nexts = (edges.get(lower(cur.name)) || []).filter((e) => !visited.has(lower(e.to.name)));
      cur = nexts.length ? nexts[0].to : null;
    }
    chains.push(chain);
  }
  // 未访问的（环）单独成链
  for (const m of maps) {
    if (!visited.has(lower(m.name))) chains.push([m]);
  }
  return { chains, edges };
}

export function scanAddon(addon, content = openContent(addon)) {
  const maps = content.maps();
  const mapByLower = new Map(maps.map((m) => [lower(m.name), m]));
  const missions = content.missions();
  const campaigns = [];
  const usedMissionFiles = new Set();

  for (const mf of missions) {
    let parsed;
    try { parsed = parseMissionsText(mf.text, mf.internalPath); } catch { continue; }
    if (!parsed) continue;
    const chapters = parsed.chapters
      .filter((ch) => mapByLower.has(lower(ch.map)))
      .map((ch) => ({ ...ch, mapName: mapByLower.get(lower(ch.map)).name }));
    if (!chapters.length) continue;
    const id = campaignIdFor(parsed.name || path.basename(mf.internalPath), chapters);
    campaigns.push({
      id,
      name: parsed.name,
      source: mf.internalPath,
      chapters,
      missing: parsed.chapters.filter((ch) => !mapByLower.has(lower(ch.map))).map((ch) => ch.map),
    });
    usedMissionFiles.add(mf.internalPath);
  }

  // 同一战役 id 出现多次时加后缀，避免分组混淆
  const seen = new Map();
  for (const c of campaigns) {
    const n = seen.get(c.id) || 0;
    seen.set(c.id, n + 1);
    if (n) c.id = `${c.id}_${n + 1}`;
  }

  return { maps, mapByLower, missions, campaigns, usedMissionFiles };
}

// 计算配对。specs 可以是单个 addon 或多个（多分卷 addon，例如 Journey to Splash
// Mountain Part 1 + Part 2 合起来才是 splash1–6）。只读取实体 lump，不解包整张图。
export function analyzeAddons(specs, opts = {}) {
  const list = Array.isArray(specs) ? specs : [specs];
  const yaw = opts.yaw ?? null;
  const parts = list.map((spec) => {
    const addon = typeof spec === 'string' ? resolveAddon(spec, opts.gameRoot) : spec;
    const content = openContent(addon);
    const scanned = scanAddon(addon, content);
    return { addon, content, scanned };
  });

  // 合并所有 addon 的地图；同名以先选中的为准
  const mapByLower = new Map();
  for (const part of parts) {
    for (const m of part.scanned.maps) {
      const key = lower(m.name);
      if (!mapByLower.has(key)) mapByLower.set(key, { ...m, part });
    }
  }
  const allMaps = [...mapByLower.values()];

  const entityCache = new Map();
  const getEntities = (map) => {
    const key = lower(map.name);
    if (!entityCache.has(key)) entityCache.set(key, map.part.content.entities(map));
    return entityCache.get(key);
  };

  // 换关边：missions 补链和“无 missions”回退都要用
  const { chains, edges } = changelevelChains(allMaps, getEntities);

  // ---- missions 战役 ----
  const campaigns = [];
  for (const part of parts) {
    for (const mf of part.scanned.missions) {
      let parsed;
      try { parsed = parseMissionsText(mf.text, mf.internalPath); } catch { continue; }
      if (!parsed) continue;
      const chapters = parsed.chapters
        .filter((ch) => mapByLower.has(lower(ch.map)))
        .map((ch) => ({ ...ch, mapName: mapByLower.get(lower(ch.map)).name }));
      if (!chapters.length) continue;
      const id = campaignIdFor(parsed.name || path.basename(mf.internalPath), chapters);
      campaigns.push({
        id,
        name: parsed.name,
        source: mf.internalPath,
        addon: part.addon.id,
        addonName: part.addon.name,
        chapters,
        missing: parsed.chapters.filter((ch) => !mapByLower.has(lower(ch.map))).map((ch) => ch.map),
      });
    }
  }

  const seen = new Map();
  for (const c of campaigns) {
    const n = seen.get(c.id) || 0;
    seen.set(c.id, n + 1);
    if (n) c.id = `${c.id}_${n + 1}`;
  }

  // missions 的章节顺序是权威的；若末尾还有未收录的图（例如分卷 missions 写漏
  // 了最终章），再沿 changelevel 向后补链。
  const claimed = new Set();
  for (const c of campaigns) for (const ch of c.chapters) claimed.add(lower(ch.mapName));
  for (const camp of campaigns) {
    const own = new Set(camp.chapters.map((ch) => lower(ch.mapName)));
    let tail = camp.chapters[camp.chapters.length - 1];
    while (tail) {
      const next = (edges.get(lower(tail.mapName)) || []).find((e) => {
        const k = lower(e.to.name);
        return !own.has(k) && !claimed.has(k);
      });
      if (!next) break;
      const k = lower(next.to.name);
      claimed.add(k);
      own.add(k);
      const map = mapByLower.get(k);
      camp.chapters.push({
        index: camp.chapters.length + 1,
        map: map.name,
        mapName: map.name,
        displayName: '',
        derived: true,
      });
      tail = camp.chapters[camp.chapters.length - 1];
    }
  }

  const pairs = [];
  let source = 'missions';
  let validChains = null;

  if (campaigns.length) {
    for (const camp of campaigns) {
      for (let i = 0; i + 1 < camp.chapters.length; i++) {
        const a = mapByLower.get(lower(camp.chapters[i].mapName));
        const b = mapByLower.get(lower(camp.chapters[i + 1].mapName));
        if (!a || !b) continue;
        const derived = camp.chapters[i].derived || camp.chapters[i + 1].derived;
        let hint = '';
        try { hint = hintLandmark(getEntities(a), b.name); } catch { /* 实体读不到时忽略 */ }
        pairs.push(makePair(camp.id, a, b, getEntities, hint, {
          source: derived ? 'changelevel' : 'missions',
          addon: a.part.addon.id, addonName: a.part.addon.name,
        }, yaw));
      }
    }
  } else {
    source = 'changelevel';
    validChains = chains.filter((c) => c.length >= 2);
    if (!validChains.length) {
      // 全无换关实体时按自然名称排序兜底（仍会尝试 landmark 交集）
      source = 'name-order';
      validChains = [allMaps.slice().sort((a, b) => naturalCompare(a.name, b.name))];
    }
    const campaign = parts.map((p) => p.addon.id).join('+');
    for (const chain of validChains) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i];
        const b = chain[i + 1];
        const edge = (edges.get(lower(a.name)) || []).find((e) => lower(e.to.name) === lower(b.name)) || null;
        pairs.push(makePair(campaign, a, b, getEntities, edge ? edge.landmark : '', {
          source, addon: a.part.addon.id, addonName: a.part.addon.name,
          note: (edge && edge.landmark) ? '' : (source === 'name-order' ? '无 missions / changelevel，按名称排序' : ''),
        }, yaw));
      }
    }
  }

  // 需要注册/解包的地图：missions 战役里的章节；否则连链里的图；再否则全部
  let usedNames;
  if (campaigns.length) {
    usedNames = [...new Set(campaigns.flatMap((c) => c.chapters.map((ch) => lower(ch.mapName))))];
  } else if (validChains) {
    usedNames = [...new Set(validChains.flat().map((m) => lower(m.name)))];
  } else {
    usedNames = allMaps.map((m) => lower(m.name));
  }
  let usedMaps = usedNames.map((n) => mapByLower.get(n)).filter(Boolean);
  if (!usedMaps.length) usedMaps = allMaps.slice();

  return {
    parts,
    addon: parts[0].addon,
    addons: parts.map((p) => p.addon),
    mapByLower,
    usedMaps,
    pairs,
    source,
    campaigns,
    chains,
  };
}

export function analyzeAddon(spec, opts = {}) { return analyzeAddons([spec], opts); }

// ---------- 解包缓存 ----------

export function addonCacheDir(outDir, addon) {
  const hash = crypto.createHash('sha1').update(path.resolve(addon.source)).digest('hex').slice(0, 8);
  return path.join(outDir, 'cache', `${sanitizeName(addon.name)}-${hash}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 确保 usedMaps 已在本地有 .bsp 文件；VPK 解包到 cache/maps，散装目录直接返回原文件。
// usedMaps 可覆盖（多 addon 合并时按来源分组解包）。
export function materializeAddon(analyzed, { outDir, force = false, log = () => {}, usedMaps } = {}) {
  const { addon, content } = analyzed;
  usedMaps = usedMaps || analyzed.usedMaps;
  const cacheDir = addonCacheDir(outDir, addon);
  const mapsDir = path.join(cacheDir, 'maps');
  const manifestFile = path.join(cacheDir, 'cache.json');

  if (content instanceof DirContent) {
    return {
      cacheDir,
      maps: usedMaps.map((m) => ({ name: m.name, file: m.file, size: m.size, internalPath: m.internalPath })),
      extracted: false,
    };
  }

  const fingerprint = content.fingerprint();
  const manifest = readJson(manifestFile);
  let valid = !force && manifest
    && manifest.version === 1
    && manifest.addonSource === path.resolve(addon.source)
    && manifest.fingerprint === fingerprint
    && usedMaps.every((m) => {
      const f = path.join(mapsDir, `${m.name}.bsp`);
      return fs.existsSync(f) && fs.statSync(f).size === m.size;
    });

  const maps = usedMaps.map((m) => ({
    name: m.name,
    file: path.join(mapsDir, `${m.name}.bsp`),
    size: m.size,
    internalPath: m.internalPath,
  }));

  if (valid) {
    log(`  缓存命中 ${path.relative(outDir, cacheDir)}（${maps.length} 张图）`);
    return { cacheDir, maps, extracted: false, cached: true };
  }

  fs.rmSync(mapsDir, { recursive: true, force: true });
  fs.mkdirSync(mapsDir, { recursive: true });
  log(`  解包 ${addon.name} -> ${path.relative(outDir, cacheDir)}（${maps.length} 张图）`);
  for (const m of usedMaps) {
    const dest = path.join(mapsDir, `${m.name}.bsp`);
    const t0 = Date.now();
    content.extractMap(m, dest);
    log(`    ${m.name.padEnd(28)} ${(m.size / 1048576).toFixed(1).padStart(8)} MB ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const out = {
    version: 1,
    addonSource: path.resolve(addon.source),
    addonName: addon.name,
    fingerprint,
    extractedAt: new Date().toISOString(),
    maps: maps.map((m) => ({ name: m.name, internalPath: m.internalPath, size: m.size })),
  };
  fs.writeFileSync(`${manifestFile}.tmp`, JSON.stringify(out, null, 2));
  fs.renameSync(`${manifestFile}.tmp`, manifestFile);
  return { cacheDir, maps, extracted: true, cached: false };
}

// 多 addon 合并时按来源分别解包，再合并成 name → 本地 .bsp 路径。
export function materializeAddons(analyzed, opts = {}) {
  const byPart = new Map();
  for (const m of analyzed.usedMaps) {
    if (!byPart.has(m.part)) byPart.set(m.part, []);
    byPart.get(m.part).push(m);
  }
  const fileByLower = new Map();
  const cacheDirs = [];
  let extractedAny = false;
  for (const part of analyzed.parts) {
    const maps = byPart.get(part) || [];
    if (!maps.length) continue;
    const r = materializeAddon({ addon: part.addon, content: part.content }, { ...opts, usedMaps: maps });
    for (const m of r.maps) fileByLower.set(lower(m.name), m.file);
    cacheDirs.push(r.cacheDir);
    extractedAny = extractedAny || r.extracted;
  }
  return {
    cacheDirs: [...new Set(cacheDirs)],
    extracted: extractedAny,
    maps: analyzed.usedMaps.map((m) => ({
      name: m.name,
      file: fileByLower.get(lower(m.name)),
      size: m.size,
      internalPath: m.internalPath,
      addon: m.part.addon.id,
    })),
  };
}

// ---------- 官方 DLC missions ----------

const OFFICIAL_PAKS = [
  'left4dead2/pak01_dir.vpk',
  'left4dead2_dlc1/pak01_dir.vpk',
  'left4dead2_dlc2/pak01_dir.vpk',
  'left4dead2_dlc3/pak01_dir.vpk',
  'update/pak01_dir.vpk',
];

// 从官方 pak01_dir.vpk 里读 missions/*.txt（不依赖散装 missions 文件）。
export function readOfficialMissions(gameRoot = getGameRoot()) {
  const campaigns = new Map();
  for (const rel of OFFICIAL_PAKS) {
    const file = path.join(gameRoot, ...rel.split('/'));
    if (!fs.existsSync(file)) continue;
    let vpk;
    try { vpk = openVpk(file); } catch (e) {
      console.warn(`  [warn] 无法读取 ${rel}: ${e.message}`);
      continue;
    }
    for (const entry of vpk.list('missions/')) {
      if (!/\.txt$/i.test(entry.path)) continue;
      let parsed;
      try { parsed = parseMissionsText(vpk.readEntry(entry).toString('utf8'), entry.path); } catch { continue; }
      if (!parsed) continue;
      const key = lower(path.basename(entry.path));
      const prev = campaigns.get(key);
      // 后读到的 update/ 优先（官方补丁目录排在最后）
      if (!prev || parsed.chapters.length >= prev.chapters.length) {
        campaigns.set(key, { ...parsed, pak: rel });
      }
    }
  }
  return [...campaigns.values()];
}

// 官方图：先用目录扫描得到基础相邻对，再用 VPK 内 missions 的 coop 顺序补充/覆盖。
export function listOfficialPairs(mapsDirs = officialMapsDirs(), gameRoot = getGameRoot()) {
  const base = listPairs(mapsDirs);
  const maps = listCampaignMaps(mapsDirs);
  const existing = new Set(base.map((p) => `${lower(p.from)}|${lower(p.to)}`));
  const byName = new Map();
  for (const list of maps.values()) for (const name of list) byName.set(lower(name), name);

  let missionCampaigns = [];
  try { missionCampaigns = readOfficialMissions(gameRoot); } catch { /* 读不到就只用目录顺序 */ }

  const pairs = base.map((p) => ({ ...p, source: 'maps-dir' }));
  for (const camp of missionCampaigns) {
    const chapters = camp.chapters.filter((ch) => byName.has(lower(ch.map)))
      .map((ch) => byName.get(lower(ch.map)));
    if (chapters.length < 2) continue;
    const id = campaignIdFor(camp.name, chapters.map((m) => ({ map: m })));
    for (let i = 0; i + 1 < chapters.length; i++) {
      const from = chapters[i];
      const to = chapters[i + 1];
      const key = `${lower(from)}|${lower(to)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      pairs.push({ campaign: id, from, to, source: 'missions', missionFile: camp.file });
    }
  }
  return pairs;
}
