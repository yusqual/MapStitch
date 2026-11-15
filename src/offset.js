// offset.js — 相邻章节坐标偏移计算（与 tools/l4d2_map_offset.js 同一套算法）。
//
// 普通换关（平移）：
//   offset = 下一图 landmark 坐标 - 上一图 landmark 坐标
//   下一图坐标 = 上一图坐标 + offset
//
// 旋转换关（L4D2 在 server.dll 里硬编码 landmark 名 coldstream3_coldstream4）：
//   显示坐标（A 空间） = lmA + Rz(yaw) * (pB - lmB)
//   下一图坐标（游戏规则） = lmB + Rz(-yaw) * (pA - lmA)
// 平移是旋转 yaw = 0 的特例。
//
// 不用 info_changelevel 指方向（Valve 官方图经常写错），改用两图 info_landmark
// targetname 交集；多候选时优先取 changelevel 引用的 landmark。

import fs from 'node:fs';
import path from 'node:path';
import { getGameRoot } from './gamepath.js';

// 兼容旧调用；实际默认值在调用时由 getDefaultMapsDir() 动态计算。
export const DEFAULT_MAPS_DIR = getDefaultMapsDir();

export function getDefaultMapsDir() {
  if (process.env.L4D2_MAPS_DIR) return process.env.L4D2_MAPS_DIR;
  const root = getGameRoot();
  return root ? path.join(root, 'left4dead2', 'maps') : '';
}

export const OFFICIAL_MAPS_SUBDIRS = [
  'left4dead2/maps',
  'left4dead2_dlc1/maps',
  'left4dead2_dlc2/maps',
  'left4dead2_dlc3/maps',
  'update/maps',
];

// 官方地图分散在多个游戏目录；没有检测到游戏目录时返回空数组。
export function officialMapsDirs(gameRoot = getGameRoot()) {
  if (!gameRoot) return [];
  return OFFICIAL_MAPS_SUBDIRS
    .map((sub) => path.join(gameRoot, ...sub.split('/')))
    .filter((dir) => fs.existsSync(dir));
}

function asDirList(mapsDir) {
  return (Array.isArray(mapsDir) ? mapsDir : [mapsDir]).filter(Boolean);
}

export function resolveMap(nameOrPath, mapsDir = getDefaultMapsDir()) {
  if (path.isAbsolute(nameOrPath)) {
    const withExt = nameOrPath.toLowerCase().endsWith('.bsp') ? nameOrPath : `${nameOrPath}.bsp`;
    if (!fs.existsSync(withExt)) throw new Error(`找不到地图文件: ${withExt}`);
    return withExt;
  }
  const dirs = asDirList(mapsDir);
  if (!dirs.length) {
    throw new Error('未找到 L4D2 安装目录：请设置 L4D2_GAME_DIR，或在页面左侧填写游戏目录');
  }
  const tried = [];
  for (const dir of dirs) {
    const p = path.join(dir, nameOrPath);
    const withExt = p.toLowerCase().endsWith('.bsp') ? p : `${p}.bsp`;
    if (fs.existsSync(withExt)) return withExt;
    tried.push(withExt);
  }
  throw new Error(`找不到地图文件: ${tried.join(' 或 ')}`);
}

// mapsDir 可以是单个目录或目录数组（官方图分散在 left4dead2/maps、*_dlc*/maps、update/maps）
export function listCampaignMaps(mapsDir = getDefaultMapsDir()) {
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

export function listPairs(mapsDir = getDefaultMapsDir()) {
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

// ---------- 旋转 ----------

// L4D2 唯一的旋转换关开关：landmark 名（server.dll 里的硬编码字符串）。
// 来源：docs/roadmap.md §3.1，本机 c13m3 → c13m4 实测。
export const ROTATING_LANDMARKS = new Map([
  ['coldstream3_coldstream4', 180],
]);

export function landmarkYaw(landmark) {
  if (!landmark) return 0;
  return ROTATING_LANDMARKS.get(String(landmark).toLowerCase()) || 0;
}

// 绕 Z 轴旋转（角度制，逆时针为正；与 Source 的 yaw 同向）
export function rotateZ(v, degrees) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

// A 坐标 → B 坐标（游戏换关规则）
export function aToB(pA, { a, b, yaw = 0 }) {
  const d = [pA[0] - a[0], pA[1] - a[1], pA[2] - a[2]];
  const q = rotateZ(d, -yaw);
  return [b[0] + q[0], b[1] + q[1], b[2] + q[2]];
}

// B 坐标 → A 空间显示坐标（查看器把 B 摆到 A 里时使用）
export function bToA(pB, { a, b, yaw = 0 }) {
  const d = [pB[0] - b[0], pB[1] - b[1], pB[2] - b[2]];
  const q = rotateZ(d, yaw);
  return [a[0] + q[0], a[1] + q[1], a[2] + q[2]];
}

// 查看器里 B 的默认 position（groupB.rotation.z = yaw）
export function alignShift({ a, b, yaw = 0 }) {
  const q = rotateZ(b, yaw);
  return [a[0] - q[0], a[1] - q[1], a[2] - q[2]];
}

function originOf(ent) {
  const o = (ent.origin || '0 0 0').trim().split(/\s+/).map(Number);
  if (o.length !== 3 || o.some(Number.isNaN)) throw new Error(`非法 origin: ${ent.origin}`);
  return o;
}

// yawOverride：手动指定旋转角（0/90/180/270）；不传则按 landmark 名自动判断。
export function calcOffset(entsA, entsB, landmarkName, yawOverride = null) {
  let landmark = landmarkName;
  const notes = [];
  if (!landmark) {
    const shared = findSharedLandmarks(entsA, entsB);
    if (shared.length === 0) throw new Error('两张图没有同名的 info_landmark，请手动指定');
    if (shared.length > 1) {
      const refs = new Set(entsA.filter((e) => e.classname === 'info_changelevel' && e.landmark).map((e) => e.landmark));
      landmark = shared.find((n) => refs.has(n)) || shared[0];
      notes.push(`多候选 [${shared.join(', ')}]，选 ${landmark}`);
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
  const autoYaw = landmarkYaw(landmark);
  const explicitYaw = yawOverride !== null && yawOverride !== undefined;
  const yaw = explicitYaw ? Number(yawOverride) : autoYaw;
  if (!Number.isFinite(yaw)) throw new Error(`非法旋转角: ${yawOverride}`);
  if (explicitYaw && yaw !== autoYaw) {
    notes.push(autoYaw ? `手动旋转 ${yaw}° 覆盖自动 ${autoYaw}°` : `手动旋转 ${yaw}°`);
  } else if (yaw) {
    notes.push('旋转换关');
  }
  return {
    landmark,
    a,
    b,
    offset: [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    yaw,
    autoYaw,
    note: notes.join('；'),
  };
}

// 计算“把 B 的几何平移到 A 的坐标系”所需的位移：A 坐标 = B 坐标 - offset
export function alignTranslation(offset) {
  return [-offset[0], -offset[1], -offset[2]];
}
