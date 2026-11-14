// offset.js — 相邻章节坐标偏移计算（与 tools/l4d2_map_offset.js 同一套算法）。
//
// offset = 下一图 landmark 坐标 - 上一图 landmark 坐标
// 下一图坐标 = 上一图坐标 + offset
//
// 不用 info_changelevel 指方向（Valve 官方图经常写错），改用两图 info_landmark
// targetname 交集；多候选时优先取 changelevel 引用的 landmark。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAPS_DIR =
  process.env.L4D2_MAPS_DIR ||
  'C:/Users/<用户名>/Home/Programs/Steam/steamapps/common/Left 4 Dead 2/left4dead2/maps';

// 官方地图分散在多个游戏目录；DEFAULT_MAPS_DIR 的上一级就是游戏根目录。
export const GAME_ROOT =
  process.env.L4D2_GAME_DIR || path.resolve(DEFAULT_MAPS_DIR, '..', '..');

export const OFFICIAL_MAPS_SUBDIRS = [
  'left4dead2/maps',
  'left4dead2_dlc1/maps',
  'left4dead2_dlc2/maps',
  'left4dead2_dlc3/maps',
  'update/maps',
];

export function officialMapsDirs(gameRoot = GAME_ROOT) {
  return OFFICIAL_MAPS_SUBDIRS
    .map((sub) => path.join(gameRoot, ...sub.split('/')))
    .filter((dir) => fs.existsSync(dir));
}

function asDirList(mapsDir) {
  return Array.isArray(mapsDir) ? mapsDir : [mapsDir];
}

export function resolveMap(nameOrPath, mapsDir = DEFAULT_MAPS_DIR) {
  if (path.isAbsolute(nameOrPath)) {
    const withExt = nameOrPath.toLowerCase().endsWith('.bsp') ? nameOrPath : `${nameOrPath}.bsp`;
    if (!fs.existsSync(withExt)) throw new Error(`找不到地图文件: ${withExt}`);
    return withExt;
  }
  const tried = [];
  for (const dir of asDirList(mapsDir)) {
    const p = path.join(dir, nameOrPath);
    const withExt = p.toLowerCase().endsWith('.bsp') ? p : `${p}.bsp`;
    if (fs.existsSync(withExt)) return withExt;
    tried.push(withExt);
  }
  throw new Error(`找不到地图文件: ${tried.join(' 或 ')}`);
}

// mapsDir 可以是单个目录或目录数组（官方图分散在 left4dead2/maps、*_dlc*/maps、update/maps）
export function listCampaignMaps(mapsDir = DEFAULT_MAPS_DIR) {
  const campaigns = new Map();
  // 官方 maps 目录里还有 c5m1_waterfront_sndscape 这类非章节变体，排除
  const isVariant = (f) => /(_sndscape|_exclude|_vs|_l4d1|_test)/i.test(f);
  for (const dir of asDirList(mapsDir)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (isVariant(f)) continue;
      const m = /^(c\d+m\d+)_.*\.bsp$/i.exec(f);
      if (!m) continue;
      const camp = m[1].slice(0, m[1].indexOf('m')).toLowerCase();
      const chapter = m[1].toLowerCase();
      if (!campaigns.has(camp)) campaigns.set(camp, new Map());
      const chapterMap = campaigns.get(camp);
      const name = f.replace(/\.bsp$/i, '');
      // 同一章节可能有多个文件（如 _a/_b 变体），保留名字最短的
      const prev = chapterMap.get(chapter);
      if (!prev || name.length < prev.length) chapterMap.set(chapter, name);
    }
  }
  const out = new Map();
  for (const [camp, chapterMap] of campaigns) {
    out.set(camp, [...chapterMap.values()].sort());
  }
  return out;
}

export function listPairs(mapsDir = DEFAULT_MAPS_DIR) {
  const pairs = [];
  for (const [campaign, list] of listCampaignMaps(mapsDir)) {
    for (let i = 0; i + 1 < list.length; i++) pairs.push({ campaign, from: list[i], to: list[i + 1] });
  }
  return pairs;
}

export function findSharedLandmarks(entsA, entsB) {
  const namesA = new Set(entsA.filter((e) => e.classname === 'info_landmark' && e.targetname).map((e) => e.targetname));
  const namesB = new Set(entsB.filter((e) => e.classname === 'info_landmark' && e.targetname).map((e) => e.targetname));
  return [...namesA].filter((n) => namesB.has(n));
}

function originOf(ent) {
  const o = (ent.origin || '0 0 0').trim().split(/\s+/).map(Number);
  if (o.length !== 3 || o.some(Number.isNaN)) throw new Error(`非法 origin: ${ent.origin}`);
  return o;
}

export function calcOffset(entsA, entsB, landmarkName) {
  let landmark = landmarkName;
  let note = '';
  if (!landmark) {
    const shared = findSharedLandmarks(entsA, entsB);
    if (shared.length === 0) throw new Error('两张图没有同名的 info_landmark，请手动指定');
    if (shared.length > 1) {
      const refs = new Set(entsA.filter((e) => e.classname === 'info_changelevel' && e.landmark).map((e) => e.landmark));
      landmark = shared.find((n) => refs.has(n)) || shared[0];
      note = `多候选 [${shared.join(', ')}]，选 ${landmark}`;
    } else {
      landmark = shared[0];
    }
  }
  const lmA = entsA.find((e) => e.classname === 'info_landmark' && e.targetname === landmark);
  const lmB = entsB.find((e) => e.classname === 'info_landmark' && e.targetname === landmark);
  if (!lmA) throw new Error(`A 图中找不到 info_landmark "${landmark}"`);
  if (!lmB) throw new Error(`B 图中找不到 info_landmark "${landmark}"`);
  const a = originOf(lmA);
  const b = originOf(lmB);
  return {
    landmark,
    a,
    b,
    offset: [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    note,
  };
}

// 计算“把 B 的几何平移到 A 的坐标系”所需的位移：A 坐标 = B 坐标 - offset
export function alignTranslation(offset) {
  return [-offset[0], -offset[1], -offset[2]];
}
