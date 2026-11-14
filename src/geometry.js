// geometry.js — 把 BSP 转成渲染用的三角网格（Source 坐标系：X 东、Y 北、Z 上）。
//
// 分层输出：
//   world     世界几何（模型 0 的可见面）
//   disp      地形位移面（单独一层，方便观察野外）
//   sky       天空盒刷面
//   nodraw    不可见但参与碰撞的 nodraw 面（卡墙的关键）
//   water     水面
//   detail    其它模型（门、可破坏物等 brush 实体）
// 每层都是 non-indexed 三角形（位置 Float32 / 法线 Float32 / 颜色 Uint8）。

import { LUMP, SURF, CONTENTS } from './bsp.js';

// ---------- 材质配色 ----------

const PALETTE = [
  [/concrete|cement|rock|stone|gravel/i, [0.58, 0.56, 0.52]],
  [/plaster|drywall|wallpaper|paint/i, [0.78, 0.75, 0.68]],
  [/tile|ceramic|porcelain/i, [0.70, 0.73, 0.72]],
  [/metal|steel|iron|aluminum|grate|pipe/i, [0.52, 0.56, 0.60]],
  [/wood|timber|plank|floor/i, [0.55, 0.40, 0.26]],
  [/brick|cinderblock/i, [0.62, 0.41, 0.33]],
  [/carpet|fabric|cloth|rug|curtain/i, [0.46, 0.42, 0.38]],
  [/glass|window/i, [0.55, 0.72, 0.80]],
  [/water|river|swamp/i, [0.24, 0.44, 0.58]],
  [/grass|dirt|ground|mud|sand|terrain|field|yard/i, [0.40, 0.46, 0.27]],
  [/foliage|tree|bush|leaf|plant|vine/i, [0.30, 0.40, 0.24]],
  [/roof|shingle/i, [0.44, 0.44, 0.46]],
  [/sign|poster|decal/i, [0.65, 0.60, 0.40]],
  [/blood|gore/i, [0.45, 0.18, 0.16]],
];

function materialBaseColor(mat) {
  for (const [re, col] of PALETTE) if (re.test(mat.name)) return col;
  // 未知材质用 reflectivity 作为灰度，做一点 gamma
  const r = Math.max(0.02, mat.reflectivity[0] || 0.5);
  const g = Math.max(0.02, mat.reflectivity[1] || 0.5);
  const b = Math.max(0.02, mat.reflectivity[2] || 0.5);
  const m = Math.max(r, g, b);
  const k = 0.72 / m;
  return [Math.min(1, r * k + 0.12), Math.min(1, g * k + 0.12), Math.min(1, b * k + 0.12)];
}

export const TINTS = {
  a: [0.82, 0.90, 1.0],   // 上一章：冷色
  b: [1.0, 0.85, 0.68],   // 下一章：暖色
};

function tinted(color, tint, amount) {
  return [
    color[0] * (1 - amount) + color[0] * tint[0] * amount,
    color[1] * (1 - amount) + color[1] * tint[1] * amount,
    color[2] * (1 - amount) + color[2] * tint[2] * amount,
  ];
}

function specialKind(name, flags) {
  const n = name.toUpperCase();
  if (flags & SURF.SKY || n.includes('SKYBOX')) return 'sky';
  if (n.includes('TRIGGER') || n.includes('FOGVOLUME') || n.includes('AREAPORTAL') || n.includes('TOOLSTEXTURE')) return 'skip';
  if (n.includes('CLIP') || n.includes('INVISIBLE')) return 'clip';
  if (n.includes('NODRAW') || n.includes('SKIP') || n.includes('HINT') || (flags & SURF.NODRAW)) return 'nodraw';
  if (n.includes('WATER') || (flags & SURF.WARP)) return 'water';
  return 'world';
}

// 特殊图层的固定颜色（比材质色更容易辨认）
const SPECIAL_COLOR = {
  clip: [1.0, 0.80, 0.22],
  nodraw: [0.90, 0.55, 0.42],
  water: [0.24, 0.52, 0.72],
  sky: [0.32, 0.52, 0.86],
};

// ---------- 网格构建 ----------

class MeshBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }
  get vertexCount() { return this.pos.length / 3; }
  tri(a, b, c, color, normal) {
    const n = normal || faceNormal(a, b, c);
    for (const v of [a, b, c]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(
        Math.max(0, Math.min(255, Math.round(color[0] * 255))),
        Math.max(0, Math.min(255, Math.round(color[1] * 255))),
        Math.max(0, Math.min(255, Math.round(color[2] * 255))),
      );
    }
  }
  quadAsTris(a, b, c, d, color, normals) {
    if (normals) {
      this._triN(a, b, c, color, normals[0], normals[1], normals[2]);
      this._triN(a, c, d, color, normals[0], normals[2], normals[3]);
    } else {
      this.tri(a, b, c, color);
      this.tri(a, c, d, color);
    }
  }
  _triN(a, b, c, color, na, nb, nc) {
    const vs = [a, b, c], ns = [na, nb, nc];
    for (let i = 0; i < 3; i++) {
      this.pos.push(vs[i][0], vs[i][1], vs[i][2]);
      this.nrm.push(ns[i][0], ns[i][1], ns[i][2]);
      this.col.push(
        Math.max(0, Math.min(255, Math.round(color[0] * 255))),
        Math.max(0, Math.min(255, Math.round(color[1] * 255))),
        Math.max(0, Math.min(255, Math.round(color[2] * 255))),
      );
    }
  }
}

function faceNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// 位移面：n = 2^power 格；基准点是面四角的双线性插值，
// 每格顶点再叠加 vec*dist。顶点在 lump 中按行优先（y 行、x 列）存储。
//
// 网格 (0,0) 角不一定是 face 的第 0 个顶点：它是离 dispinfo.startPosition
// 最近的角（baseI），其余角沿 face 顶点顺序环绕。快速索引 i 沿 baseI+3，
// 行索引 j 沿 baseI+1。这条规则用相邻位移面共享边重合验证过：
// c1/c2/c3/c5 的接缝 RMS < 1（个别重叠面除外）。
export function buildDispGrid(bsp, faceIndex) {
  const f = bsp.face(faceIndex);
  const di = bsp.dispInfo(f.dispinfo);
  const n = 1 << di.power;
  const corners = bsp.faceVertices(faceIndex);
  if (corners.length !== 4) return null;
  let baseI = 0, baseDist = Infinity;
  for (let k = 0; k < 4; k++) {
    const d = Math.abs(corners[k][0] - di.startPosition[0]) +
      Math.abs(corners[k][1] - di.startPosition[1]) +
      Math.abs(corners[k][2] - di.startPosition[2]);
    if (d < baseDist) { baseDist = d; baseI = k; }
  }
  const c00 = corners[baseI];
  const c10 = corners[(baseI + 3) % 4];
  const c01 = corners[(baseI + 1) % 4];
  const c11 = corners[(baseI + 2) % 4];
  const grid = [];
  for (let j = 0; j <= n; j++) {
    const tv = j / n;
    for (let i = 0; i <= n; i++) {
      const tu = i / n;
      const base = add(
        add(mul(c00, (1 - tu) * (1 - tv)), mul(c10, tu * (1 - tv))),
        add(mul(c01, (1 - tu) * tv), mul(c11, tu * tv)),
      );
      const dv = bsp.dispVert(di.dispVertStart + j * (n + 1) + i);
      (grid[j] || (grid[j] = []))[i] = add(base, mul(dv.vec, dv.dist));
    }
  }
  return { n, grid, baseI, corners };
}

function addDisplacement(bsp, faceIndex, mesh, color, tint) {
  const built = buildDispGrid(bsp, faceIndex);
  if (!built) return null;
  const { n, grid } = built;

  // 顶点法线（网格内部用中心差分）
  const normals = [];
  for (let j = 0; j <= n; j++) {
    normals[j] = [];
    for (let i = 0; i <= n; i++) {
      const iL = Math.max(0, i - 1), iR = Math.min(n, i + 1);
      const jD = Math.max(0, j - 1), jU = Math.min(n, j + 1);
      const du = sub(grid[j][iR], grid[j][iL]);
      const dv = sub(grid[jU][i], grid[jD][i]);
      normals[j][i] = norm(faceNormal([0, 0, 0], du, dv));
    }
  }

  const col = tinted(color, tint, 0.32);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = grid[j][i];
      const b = grid[j][i + 1];
      const c = grid[j + 1][i + 1];
      const d = grid[j + 1][i];
      const na = normals[j][i], nb = normals[j][i + 1];
      const nc = normals[j + 1][i + 1], nd = normals[j + 1][i];
      mesh._triN(a, b, c, col, na, nb, nc);
      mesh._triN(a, c, d, col, na, nc, nd);
    }
  }
  return { verts: (n + 1) * (n + 1) };
}

// 用面 plane 的朝向修正法线，避免个别退化三角形算反
function planeNormal(bsp, faceIndex) {
  const f = bsp.face(faceIndex);
  const p = bsp.plane(f.planenum);
  return p.normal;
}

// ---------- brush 凸多面体重建（clip 体积） ----------

// 平面上的大四边形
function planeQuad(n, d, S = 16384) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = norm(cross(n, up));
  const t2 = norm(cross(n, t1));
  const c = mul(n, d);
  const p = (a, b) => [
    c[0] + t1[0] * a + t2[0] * b,
    c[1] + t1[1] * a + t2[1] * b,
    c[2] + t1[2] * a + t2[2] * b,
  ];
  return [p(S, S), p(-S, S), p(-S, -S), p(S, -S)];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// brush 内部满足 dot(n,x) - d <= 0（已用 224/619 个 clip brush 的包围盒验证）
function clipPolygon(poly, n, d) {
  const f = (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d;
  const out = [];
  const eps = 1e-3;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa <= eps) out.push(a);
    if ((fa < -eps && fb > eps) || (fa > eps && fb < -eps)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

function brushFaces(bsp, brushIndex) {
  const br = bsp.brush(brushIndex);
  const planes = [];
  for (let s = 0; s < br.numsides; s++) {
    const side = bsp.brushSide(br.firstside + s);
    if (side.bevel) continue;
    planes.push(bsp.plane(side.planenum));
  }
  const polys = [];
  for (let i = 0; i < planes.length; i++) {
    let poly = planeQuad(planes[i].normal, planes[i].dist);
    for (let j = 0; j < planes.length && poly.length; j++) {
      if (j === i) continue;
      poly = clipPolygon(poly, planes[j].normal, planes[j].dist);
    }
    if (poly.length >= 3) polys.push({ poly, normal: planes[i].normal });
  }
  return polys;
}

// brush 编号 -> model 编号：遍历每个 model 的 BSP 树叶节点
function buildBrushModelMap(bsp) {
  const map = new Map();
  const modelCount = bsp.count('MODELS');
  const nodes = bsp.count('NODES');
  for (let m = 0; m < modelCount; m++) {
    const md = bsp.model(m);
    if (md.headnode < 0 || md.headnode >= nodes) continue;
    for (const b of bsp.modelBrushes(md.headnode)) if (!map.has(b)) map.set(b, m);
  }
  return map;
}

// ---------- 主流程 ----------

export function extractMap(bsp, opts = {}) {
  const tint = opts.tint || TINTS.a;
  const tintAmount = opts.tintAmount ?? 0.30;
  const layers = new Map();
  const layer = (name) => {
    if (!layers.has(name)) layers.set(name, new MeshBuilder());
    return layers.get(name);
  };

  const worldModel = bsp.model(0);
  const faceCount = bsp.count('FACES');
  const dispFaces = [];

  // 模型 0 的世界几何（brush 实体的面在 model0 范围之外）
  for (let i = worldModel.firstface; i < worldModel.firstface + worldModel.numfaces && i < faceCount; i++) {
    const f = bsp.face(i);
    if (f.dispinfo >= 0) { dispFaces.push(i); continue; }
    const mat = bsp.materialForFace(f);
    const flags = bsp.flagsForFace(f);
    const kind = specialKind(mat.name, flags);
    if (kind === 'skip') continue;
    const verts = bsp.faceVertices(i);
    if (verts.length < 3) continue;
    const mesh = layer(kind === 'world' ? 'world' : kind);
    const base = SPECIAL_COLOR[kind] || materialBaseColor(mat);
    const col = tinted(base, tint, kind === 'world' ? tintAmount : 0.1);
    const pn = planeNormal(bsp, i);
    for (let k = 1; k + 1 < verts.length; k++) {
      // 用 plane 法线统一朝向（比三角形叉积稳）
      mesh.tri(verts[0], verts[k], verts[k + 1], col, pn);
    }
  }

  // 位移面（水面位移单独进 water 层）
  const dispMesh = layer('disp');
  const waterDispMesh = layer('water');
  let dispVerts = 0;
  for (const fi of dispFaces) {
    const f = bsp.face(fi);
    const mat = bsp.materialForFace(f);
    const kind = specialKind(mat.name, bsp.flagsForFace(f));
    const isWater = kind === 'water';
    const color = isWater ? SPECIAL_COLOR.water : materialBaseColor(mat);
    const r = addDisplacement(bsp, fi, isWater ? waterDispMesh : dispMesh, color, tint);
    if (r) dispVerts += r.verts;
  }

  // brush 实体（门、可破坏物、clip 体积等）：每个 dmodel 的面。
  // 这些模型的顶点是相对实体 origin 的局部坐标，需要加回实体 origin。
  const modelCount = bsp.count('MODELS');
  const modelEnt = new Map();
  for (const e of bsp.entities) {
    if (!e.model || e.model[0] !== '*') continue;
    const idx = Number(e.model.slice(1));
    if (!Number.isFinite(idx)) continue;
    const o = (e.origin || '').trim().split(/\s+/).map(Number);
    modelEnt.set(idx, {
      classname: e.classname || '',
      origin: o.length === 3 && o.every(Number.isFinite) ? o : [0, 0, 0],
    });
  }
  for (let m = 1; m < modelCount; m++) {
    const md = bsp.model(m);
    const ent = modelEnt.get(m);
    const off = ent ? ent.origin : [0, 0, 0];
    if (/trigger|fog|areaportal|precipitation|shadow|nav_blocker|point_|env_|light|soundscape|func_instance_io_proxy/i.test(ent ? ent.classname : '')) continue;
    for (let i = md.firstface; i < md.firstface + md.numfaces && i < faceCount; i++) {
      const f = bsp.face(i);
      if (f.dispinfo >= 0) continue;
      const mat = bsp.materialForFace(f);
      const kind = specialKind(mat.name, bsp.flagsForFace(f));
      if (kind === 'skip' || kind === 'sky') continue;
      const verts = bsp.faceVertices(i).map((v) => add(v, off));
      if (verts.length < 3) continue;
      const col = tinted(materialBaseColor(mat), tint, kind === 'world' ? 0.12 : 0);
      const target = layer(kind === 'world' ? 'detail' : kind);
      for (let k = 1; k + 1 < verts.length; k++) target.tri(verts[0], verts[k], verts[k + 1], col);
    }
  }

  // clip 体积：clip 面不在 FACES 里，必须从 BRUSHES/BRUSHSIDES 的平面重建凸多面体。
  const clipMesh = layer('clip');
  const brushModel = buildBrushModelMap(bsp);
  let clipBrushes = 0;
  const brushCount = bsp.count('BRUSHES');
  for (let b = 0; b < brushCount; b++) {
    const br = bsp.brush(b);
    if (!(br.contents & (CONTENTS.PLAYERCLIP | CONTENTS.MONSTERCLIP))) continue;
    const mIdx = brushModel.get(b);
    const ent = mIdx !== undefined ? modelEnt.get(mIdx) : null;
    const off = ent ? ent.origin : [0, 0, 0];
    const col = tinted(SPECIAL_COLOR.clip, tint, 0.15);
    for (const { poly, normal } of brushFaces(bsp, b)) {
      const pts = poly.map((p) => add(p, off));
      for (let k = 1; k + 1 < pts.length; k++) clipMesh.tri(pts[0], pts[k], pts[k + 1], col, normal);
    }
    clipBrushes++;
  }

  // 统计/导出
  const outLayers = [];
  for (const [name, mesh] of layers) {
    if (mesh.vertexCount === 0) continue;
    outLayers.push({
      name,
      positions: new Float32Array(mesh.pos),
      normals: new Float32Array(mesh.nrm),
      colors: new Uint8Array(mesh.col),
      vertexCount: mesh.vertexCount,
    });
  }

  // 实体标记
  const markers = extractMarkers(bsp);

  return {
    map: opts.mapName || null,
    bounds: { mins: worldModel.mins, maxs: worldModel.maxs },
    layers: outLayers,
    markers,
    stats: {
      faces: worldModel.numfaces,
      dispFaces: dispFaces.length,
      dispVerts,
      models: modelCount,
      clipBrushes,
    },
  };
}

const MARKER_CLASSES = new Set([
  'info_landmark', 'info_player_start', 'info_player_deathmatch', 'info_player_coop',
  'info_player_versus', 'info_target', 'info_changelevel', 'trigger_changelevel',
  'info_survivor_position', 'info_goal_infected_chase', 'prop_survival_spawn',
]);

function extractMarkers(bsp) {
  const out = [];
  for (const e of bsp.entities) {
    if (!MARKER_CLASSES.has(e.classname)) continue;
    const o = (e.origin || '').trim().split(/\s+/).map(Number);
    if (o.length !== 3 || o.some(Number.isNaN)) continue;
    out.push({ classname: e.classname, targetname: e.targetname || '', origin: o, landmark: e.landmark || '', map: e.map || '' });
  }
  return out;
}

export { CONTENTS };
