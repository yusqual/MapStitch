// query.js — 点查询：判断一个世界坐标落在哪些 brush 体积内（clip / 实体 / 水）。
//
// brush 内部 = 对所有 side 平面满足 dot(n, p) - d <= 0。
// brush 实体模型的几何是局部坐标，需要先减去实体 origin。

import { CONTENTS } from './bsp.js';

const dot = (n, p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2];

// 缓存 brush -> model、model -> entity
export function brushContext(bsp) {
  if (bsp._brushCtx) return bsp._brushCtx;
  const modelEnt = new Map();
  for (const e of bsp.entities) {
    if (!e.model || e.model[0] !== '*') continue;
    const idx = Number(e.model.slice(1));
    if (!Number.isFinite(idx)) continue;
    const o = (e.origin || '').trim().split(/\s+/).map(Number);
    modelEnt.set(idx, {
      classname: e.classname || '',
      targetname: e.targetname || '',
      origin: o.length === 3 && o.every(Number.isFinite) ? o : [0, 0, 0],
    });
  }
  const brushModel = new Map();
  const modelCount = bsp.count('MODELS');
  const nodes = bsp.count('NODES');
  for (let m = 0; m < modelCount; m++) {
    const md = bsp.model(m);
    if (md.headnode < 0 || md.headnode >= nodes) continue;
    for (const b of bsp.modelBrushes(md.headnode)) if (!brushModel.has(b)) brushModel.set(b, m);
  }
  bsp._brushCtx = { modelEnt, brushModel };
  return bsp._brushCtx;
}

export function brushOrigin(bsp, brushIndex) {
  const { modelEnt, brushModel } = brushContext(bsp);
  const m = brushModel.get(brushIndex);
  const ent = m !== undefined ? modelEnt.get(m) : null;
  return ent ? ent.origin : [0, 0, 0];
}

export function brushMeta(bsp, brushIndex) {
  const { modelEnt, brushModel } = brushContext(bsp);
  const m = brushModel.get(brushIndex);
  const ent = m !== undefined ? modelEnt.get(m) : null;
  return { model: m, classname: ent ? ent.classname : '', targetname: ent ? ent.targetname : '' };
}

// 返回 { inside, depth }：depth = 到最近侧面的距离（正数表示在内部）
export function pointInBrush(bsp, brushIndex, worldPoint) {
  const br = bsp.brush(brushIndex);
  const off = brushOrigin(bsp, brushIndex);
  const p = [worldPoint[0] - off[0], worldPoint[1] - off[1], worldPoint[2] - off[2]];
  let maxDist = -Infinity;
  for (let s = 0; s < br.numsides; s++) {
    const side = bsp.brushSide(br.firstside + s);
    if (side.bevel) continue;
    const pl = bsp.plane(side.planenum);
    const v = dot(pl.normal, p) - pl.dist;
    if (v > maxDist) maxDist = v;
  }
  return { inside: maxDist <= 1e-3, depth: -maxDist };
}

export function classifyContents(contents) {
  if (contents & (CONTENTS.PLAYERCLIP | CONTENTS.MONSTERCLIP)) return 'clip';
  if (contents & CONTENTS.WATER) return 'water';
  if (contents & CONTENTS.SOLID) return 'solid';
  return 'other';
}

// 不可见体积实体：即使 contents 含 SOLID 也不应视为“卡在实体里”
const INVISIBLE_BRUSH_ENT =
  /^(trigger|func_precipitation|fog_volume|func_areaportal|env_|shadow_|water_|func_smokevolume|func_occluder|func_instance_io_proxy|logic_|math_|point_)/i;

export function brushesAtPoint(bsp, point) {
  const out = [];
  const n = bsp.count('BRUSHES');
  for (let b = 0; b < n; b++) {
    const br = bsp.brush(b);
    const kind = classifyContents(br.contents);
    if (kind === 'other') continue;
    const meta = brushMeta(bsp, b);
    if (kind === 'solid' && INVISIBLE_BRUSH_ENT.test(meta.classname)) continue;
    const r = pointInBrush(bsp, b, point);
    if (!r.inside) continue;
    out.push({ brush: b, kind, contents: br.contents, depth: r.depth, ...meta });
  }
  out.sort((a, b) => a.depth - b.depth);
  return out;
}
