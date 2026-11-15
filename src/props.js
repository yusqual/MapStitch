// props.js — prop_static 包围盒（GAME_LUMP 的 prps + MDL studiohdr hull）。
//
// 数据布局（本机 c1m1_hotel / c5m2_park / atr01 / ssv1 实测）：
//
//   GAME_LUMP 头: int lumpCount; dgamelump_t lumps[lumpCount]（16 字节/条：
//                 4 字节 fourCC（"prps"）、u16 flags、u16 version、i32 fileofs、i32 filelen）
//   dgamelump_t.fileofs 是 BSP 文件内的绝对偏移；LZMA 压缩后绝对偏移失效，
//   此时按条目顺序紧接在头之后排列（实测各 lump 就是连续的，可直接回退）。
//
//   prps (version 9): int nameCount; char names[nameCount][128];
//                     int leafCount; u16 leafIndices[leafCount];
//                     int propCount; StaticPropLump_t props[propCount];
//   StaticPropLump_t 步长 72 字节（v9；字段顺序与 Source SDK gamebspfile.h 一致）：
//     origin f32[3] @0、angles f32[3] @12、propType u16 @24、firstLeaf u16 @26、
//     leafCount u16 @28、solid u8 @30、flags u8 @31、skin i32 @32、
//     fadeMin @36、fadeMax @40、lightingOrigin @44、forcedFadeScale @56。
//   v10 追加 flagsEx，v11 追加 uniformScale（float，位于记录末尾）；基础字段偏移不变，
//   遇到 v11 时从记录最后 4 字节读取 uniformScale 并缩放包围盒（L4D2 的图都是 v9）。
//
//   MDL studiohdr_t (version 49)：IDST @0、version @4、hull_min @104、hull_max @116、
//   view_bbmin @128、view_bbmax @140。没有碰撞 hull 的模型回退到 view bbox。

import fs from 'node:fs';
import path from 'node:path';
import { LUMP } from './bsp.js';
import { getGameRoot } from './gamepath.js';
import { openVpk } from './vpk.js';
import { openContent, resolveAddon } from './addon.js';

export const PROPS_LAYER = 'props';
export const PROPS_COLOR = [0.42, 0.86, 0.58];
export const PROPS_NAME = 'prps';

// 引擎的挂载顺序（后面的被前面的覆盖）：update > dlc3 > dlc2 > dlc1 > base
const GAME_CONTENT_DIRS = ['update', 'left4dead2_dlc3', 'left4dead2_dlc2', 'left4dead2_dlc1', 'left4dead2'];

const NAME_LEN = 128;
const MDL_HEAD_BYTES = 160;

// ---------- GAME_LUMP / prps ----------

// 返回 { version, data }；找不到或结构异常返回 null。
export function gameLump(bsp, fourCC) {
  const gl = bsp.lump(LUMP.GAME_LUMP);
  if (!gl || gl.length < 4) return null;
  const count = gl.readInt32LE(0);
  if (count <= 0 || count > 64 || 4 + count * 16 > gl.length) return null;
  const baseOfs = bsp.lumps[LUMP.GAME_LUMP].ofs;
  let sequential = 4 + count * 16;
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 16;
    const id = gl.toString('latin1', o, o + 4);
    const version = gl.readUInt16LE(o + 6);
    const fileofs = gl.readInt32LE(o + 8);
    const len = gl.readInt32LE(o + 12);
    let rel = fileofs - baseOfs;
    // LZMA 压缩后 fileofs 是原始文件偏移；解压后的 lump 内按顺序连续排列
    if (!(rel >= 0 && len >= 0 && rel + len <= gl.length)) rel = sequential;
    sequential += Math.max(0, len);
    if (id !== fourCC) continue;
    if (!(rel >= 0 && len > 0 && rel + len <= gl.length)) return null;
    return { version, data: gl.subarray(rel, rel + len) };
  }
  return null;
}

export function parseStaticProps(bsp) {
  if (bsp._staticProps !== undefined) return bsp._staticProps;
  bsp._staticProps = null;
  let lump = null;
  try { lump = gameLump(bsp, PROPS_NAME); } catch { return null; }
  if (!lump) return null;
  const { version, data } = lump;
  let p = 0;
  try {
    if (data.length < 8) return null;
    const nameCount = data.readInt32LE(p); p += 4;
    if (nameCount < 0 || p + nameCount * NAME_LEN > data.length) return null;
    const names = new Array(nameCount);
    for (let i = 0; i < nameCount; i++) {
      names[i] = data.toString('latin1', p, p + NAME_LEN).replace(/\0.*$/, '').replace(/\\/g, '/');
      p += NAME_LEN;
    }
    const leafCount = data.readInt32LE(p); p += 4;
    if (leafCount < 0 || leafCount > 0x100000 || p + leafCount * 2 > data.length) return null;
    p += leafCount * 2;
    const propCount = data.readInt32LE(p); p += 4;
    if (propCount < 0 || p > data.length) return null;
    const stride = propCount > 0 ? Math.floor((data.length - p) / propCount) : 0;
    if (propCount > 0 && (stride < 48 || stride > 96)) return null;

    const readVec = (o) => [data.readFloatLE(o), data.readFloatLE(o + 4), data.readFloatLE(o + 8)];
    // v11 起才有 uniformScale，且总是记录里的最后一个 float；按步长倒推可避开填充差异
    const scaleOffset = version >= 11 && stride >= 72 ? stride - 4 : -1;
    const props = [];
    for (let i = 0; i < propCount; i++) {
      const o = p + i * stride;
      const propType = data.readUInt16LE(o + 24);
      const origin = readVec(o);
      if (propType >= nameCount || !origin.every(Number.isFinite)) continue;
      let scale = 1;
      if (scaleOffset >= 0) {
        const s = data.readFloatLE(o + scaleOffset);
        if (Number.isFinite(s) && s > 0.001 && s < 1000) scale = s;
      }
      props.push({
        index: i,
        origin,
        angles: readVec(o + 12),
        propType,
        model: names[propType],
        solid: data[o + 30],
        flags: data[o + 31],
        firstLeaf: data.readUInt16LE(o + 26),
        leafCount: data.readUInt16LE(o + 28),
        scale,
      });
    }
    bsp._staticProps = { version, stride, names, props };
    return bsp._staticProps;
  } catch {
    return null;
  }
}

// ---------- MDL 包围盒 ----------

function boxUsable(mins, maxs) {
  let size = 0;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(mins[i]) || !Number.isFinite(maxs[i])) return false;
    if (maxs[i] < mins[i] - 0.01) return false;
    size = Math.max(size, maxs[i] - mins[i]);
  }
  return size >= 0.05;
}

// studiohdr_t：hull（碰撞盒）优先，退化时用 view bbox
export function mdlBounds(buf) {
  if (!buf || buf.length < 152) return null;
  if (buf.toString('latin1', 0, 4) !== 'IDST') return null;
  const version = buf.readInt32LE(4);
  if (version < 20 || version > 51) return null;
  const vec = (o) => [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
  let mins = vec(104);
  let maxs = vec(116);
  let source = 'hull';
  if (!boxUsable(mins, maxs)) {
    mins = vec(128);
    maxs = vec(140);
    source = 'view';
  }
  if (!boxUsable(mins, maxs)) return null;
  return { mins, maxs, source, version };
}

function readHead(file, maxBytes) {
  const size = fs.statSync(file).size;
  const n = Math.max(0, Math.min(maxBytes, size));
  const buf = Buffer.alloc(n);
  if (n > 0) {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
  }
  return buf;
}

// 模型查找：addon（覆盖官方）→ 游戏目录散装文件 → 游戏 pak01 分卷。
// addon 只按需打开，serve / check 通常只查询已解析过的那几个。
export class ModelProvider {
  constructor({ gameRoot = getGameRoot(), addons = [], addonSpecs = [] } = {}) {
    this.gameRoot = gameRoot || '';
    this.mounts = addons.slice();
    this.specs = addonSpecs.slice();
    this._mountsReady = this.specs.length === 0;
    this._bounds = new Map();
    this._paks = new Map();
  }

  _addonMounts() {
    if (this._mountsReady) return this.mounts;
    for (const spec of this.specs) {
      try {
        const addon = (typeof spec === 'object' && spec && spec.kind && spec.source)
          ? resolveAddon(spec.source, this.gameRoot)
          : resolveAddon(String(spec), this.gameRoot);
        this.mounts.push(openContent(addon));
      } catch { /* 读不到的 addon 直接跳过 */ }
    }
    this.specs = [];
    this._mountsReady = true;
    return this.mounts;
  }

  _pak(file) {
    if (this._paks.has(file)) return this._paks.get(file);
    let vpk = null;
    if (fs.existsSync(file)) {
      try { vpk = openVpk(file); } catch { vpk = null; }
    }
    this._paks.set(file, vpk);
    return vpk;
  }

  // 读逻辑路径（models/...）的前 maxBytes 字节；找不到返回 null。
  readFile(logicalPath, maxBytes = Infinity) {
    const rel = String(logicalPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return null;
    for (const mount of this._addonMounts()) {
      const buf = mount.readFile(rel, maxBytes);
      if (buf) return buf;
    }
    if (!this.gameRoot) return null;
    for (const dir of GAME_CONTENT_DIRS) {
      const base = path.join(this.gameRoot, dir);
      const loose = path.join(base, ...rel.split('/'));
      if (fs.existsSync(loose)) {
        try { return readHead(loose, maxBytes); } catch { /* 读失败继续找 VPK */ }
      }
      const vpk = this._pak(path.join(base, 'pak01_dir.vpk'));
      if (!vpk) continue;
      const entry = vpk.find(rel);
      if (!entry) continue;
      try {
        const n = Math.min(maxBytes, entry.size);
        return n > 0 ? vpk.readRange(entry, 0, n) : Buffer.alloc(0);
      } catch { /* 分卷缺失等，继续 */ }
    }
    return null;
  }

  // 模型包围盒（模型局部坐标），找不到返回 null。结果按路径缓存。
  bounds(modelPath) {
    const key = String(modelPath || '').replace(/\\/g, '/').toLowerCase();
    if (!key) return null;
    if (this._bounds.has(key)) return this._bounds.get(key);
    let box = null;
    try {
      box = mdlBounds(this.readFile(key, MDL_HEAD_BYTES));
    } catch { box = null; }
    this._bounds.set(key, box);
    return box;
  }
}

export function modelProviderFromIndex(index, { gameRoot = getGameRoot() } = {}) {
  const specs = [];
  for (const a of (index && index.addons) || []) {
    for (const e of a.entries || []) {
      if (e && e.source) specs.push({ kind: e.kind, source: e.source });
    }
  }
  return new ModelProvider({ gameRoot, addonSpecs: specs });
}

// ---------- OBB ----------

// Source AngleMatrix 的三行（forward / left / up），模型局部轴 → 世界方向
export function angleMatrix(angles) {
  const d = Math.PI / 180;
  const sp = Math.sin((angles[0] || 0) * d), cp = Math.cos((angles[0] || 0) * d);
  const sy = Math.sin((angles[1] || 0) * d), cy = Math.cos((angles[1] || 0) * d);
  const sr = Math.sin((angles[2] || 0) * d), cr = Math.cos((angles[2] || 0) * d);
  return [
    [cp * cy, cp * sy, -sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp],
    [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  ];
}

function localToWorld(m, origin, l) {
  return [
    origin[0] + m[0][0] * l[0] + m[1][0] * l[1] + m[2][0] * l[2],
    origin[1] + m[0][1] * l[0] + m[1][1] * l[1] + m[2][1] * l[2],
    origin[2] + m[0][2] * l[0] + m[1][2] * l[1] + m[2][2] * l[2],
  ];
}

function worldToLocal(m, origin, p) {
  const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  return [
    m[0][0] * d[0] + m[0][1] * d[1] + m[0][2] * d[2],
    m[1][0] * d[0] + m[1][1] * d[1] + m[1][2] * d[2],
    m[2][0] * d[0] + m[2][1] * d[1] + m[2][2] * d[2],
  ];
}

// 解析出可绘制的 prop 盒（缺模型的不计入，单独统计）
export function propBoxes(bsp, provider) {
  if (!provider) return { total: 0, boxes: [], missing: 0, names: 0, version: 0, stride: 0 };
  if (bsp._propBoxes && bsp._propBoxes.provider === provider) return bsp._propBoxes.result;
  const data = parseStaticProps(bsp);
  const result = data
    ? { ...collectBoxes(data, provider) }
    : { total: 0, boxes: [], missing: 0, names: 0, version: 0, stride: 0 };
  bsp._propBoxes = { provider, result };
  return result;
}

function collectBoxes(data, provider) {
  const boxes = [];
  let missing = 0;
  const missingModels = new Set();
  for (const prop of data.props) {
    const box = provider.bounds(prop.model);
    if (!box) {
      missing++;
      missingModels.add(prop.model);
      continue;
    }
    const s = prop.scale || 1;
    boxes.push({
      ...prop,
      mins: box.mins.map((x) => x * s),
      maxs: box.maxs.map((x) => x * s),
      boxSource: box.source,
    });
  }
  return {
    total: data.props.length,
    names: data.names.length,
    version: data.version,
    stride: data.stride,
    boxes,
    missing,
    missingModels: [...missingModels].slice(0, 20),
  };
}

// 世界点是否在 prop OBB 内；depth = 到最近面的距离
export function propsAtPoint(bsp, provider, point, eps = 0.5) {
  const { boxes } = propBoxes(bsp, provider);
  const out = [];
  for (const box of boxes) {
    const m = angleMatrix(box.angles);
    const l = worldToLocal(m, box.origin, point);
    let inside = true;
    let depth = Infinity;
    for (let i = 0; i < 3; i++) {
      if (l[i] < box.mins[i] - eps || l[i] > box.maxs[i] + eps) { inside = false; break; }
      depth = Math.min(depth, l[i] - box.mins[i], box.maxs[i] - l[i]);
    }
    if (!inside) continue;
    out.push({
      index: box.index,
      model: box.model,
      solid: box.solid !== 0,
      solidType: box.solid,
      origin: box.origin,
      depth: Math.max(0, depth),
    });
  }
  // 越靠包围盒中心越靠前
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

// ---------- 渲染层 ----------

function crateTris(m, origin, mins, maxs, out, color, tint) {
  const v = (x, y, z) => localToWorld(m, origin, [x, y, z]);
  const x0 = mins[0], x1 = maxs[0];
  const y0 = mins[1], y1 = maxs[1];
  const z0 = mins[2], z1 = maxs[2];
  // axis = 模型局部轴，sign = 该面的外法线方向
  const faces = [
    { axis: 0, sign: 1, pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { axis: 0, sign: -1, pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { axis: 1, sign: 1, pts: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { axis: 1, sign: -1, pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { axis: 2, sign: 1, pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { axis: 2, sign: -1, pts: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
  ];
  const col = [
    Math.round((color[0] * (1 - 0.12) + color[0] * tint[0] * 0.12) * 255),
    Math.round((color[1] * (1 - 0.12) + color[1] * tint[1] * 0.12) * 255),
    Math.round((color[2] * (1 - 0.12) + color[2] * tint[2] * 0.12) * 255),
  ];
  for (const face of faces) {
    let [a, b, c, d] = face.pts.map((p) => v(p[0], p[1], p[2]));
    const nrm = m[face.axis].map((x) => x * face.sign);
    // 修正绕序，保证外法线一致（材质是 DoubleSide，但绕序仍影响背面剔除与光照）
    const ua = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const va = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      ua[1] * va[2] - ua[2] * va[1],
      ua[2] * va[0] - ua[0] * va[2],
      ua[0] * va[1] - ua[1] * va[0],
    ];
    if (cross[0] * nrm[0] + cross[1] * nrm[1] + cross[2] * nrm[2] < 0) [b, d] = [d, b];
    for (const tri of [[a, b, c], [a, c, d]]) {
      for (const p of tri) {
        out.pos.push(p[0], p[1], p[2]);
        out.nrm.push(nrm[0], nrm[1], nrm[2]);
        out.col.push(col[0], col[1], col[2]);
      }
    }
  }
}

// 返回与 extractMap 的 layer 同形状的对象（stats 始终存在；没有可绘制包围盒时 vertexCount = 0，
// 调用方不应把它写进 .mst）。这样构建缓存可以区分“图里没有 prop”和“模型没找到”。
export function buildPropsLayer(bsp, provider, { tint = [1, 1, 1], color = PROPS_COLOR } = {}) {
  const result = propBoxes(bsp, provider);
  const out = { pos: [], nrm: [], col: [] };
  for (const box of result.boxes) {
    crateTris(angleMatrix(box.angles), box.origin, box.mins, box.maxs, out, color, tint);
  }
  return {
    name: PROPS_LAYER,
    positions: new Float32Array(out.pos),
    normals: new Float32Array(out.nrm),
    colors: new Uint8Array(out.col),
    vertexCount: out.pos.length / 3,
    stats: {
      props: result.total,
      propModels: result.names,
      propsDrawn: result.boxes.length,
      propsMissing: result.missing,
      propMissingModels: result.missingModels,
      propLumpVersion: result.version,
      propStride: result.stride,
    },
  };
}
