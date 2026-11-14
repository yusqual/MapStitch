#!/usr/bin/env node
// probe_brush.js — 验证 brush 凸多面体重建（clip 体积）的平面朝向与 brush→model 归属。
// 用法: node tools/probe_brush.js <map.bsp> [...]
import { loadBsp } from '../src/bsp.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function planeQuad(n, d, S = 16384) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = norm(cross(n, up));
  const t2 = cross(n, t1);
  const c = [n[0] * d, n[1] * d, n[2] * d];
  const p = (a, b) => [c[0] + t1[0] * a + t2[0] * b, c[1] + t1[1] * a + t2[1] * b, c[2] + t1[2] * a + t2[2] * b];
  return [p(S, S), p(-S, S), p(-S, -S), p(S, -S)];
}

// flip=false: 内部满足 dot(n,x)-d <= 0；flip=true 取反
function clipPoly(poly, n, d, flip) {
  const s = flip ? -1 : 1;
  const f = (p) => s * (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d);
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

function brushPolys(bsp, bi, flip) {
  const br = bsp.brush(bi);
  const planes = [];
  for (let s = 0; s < br.numsides; s++) {
    const side = bsp.brushSide(br.firstside + s);
    if (side.bevel) continue;
    const pl = bsp.plane(side.planenum);
    planes.push(pl);
  }
  const polys = [];
  for (let i = 0; i < planes.length; i++) {
    let poly = planeQuad(planes[i].normal, planes[i].dist);
    for (let j = 0; j < planes.length && poly.length; j++) {
      if (j === i) continue;
      poly = clipPoly(poly, planes[j].normal, planes[j].dist, flip);
    }
    if (poly.length >= 3) polys.push(poly);
  }
  return polys;
}

function probe(file) {
  const bsp = loadBsp(file);
  // brush -> model
  const brushModel = new Map();
  const modelCount = bsp.count('MODELS');
  for (let m = 0; m < modelCount; m++) {
    const md = bsp.model(m);
    if (md.headnode < 0 || md.headnode >= bsp.count('NODES')) continue;
    for (const b of bsp.modelBrushes(md.headnode)) {
      if (!brushModel.has(b)) brushModel.set(b, m);
    }
  }
  const brushes = bsp.count('BRUSHES');
  const clipBrushes = [];
  for (let b = 0; b < brushes; b++) {
    const br = bsp.brush(b);
    let clip = false;
    for (let s = 0; s < br.numsides; s++) {
      const side = bsp.brushSide(br.firstside + s);
      const name = bsp.materials[bsp.texinfoTexdata[side.texinfo]]?.name || '';
      if (/CLIP|INVISIBLE/i.test(name)) clip = true;
    }
    if (clip) clipBrushes.push(b);
  }
  console.log(`\n${file.split(/[\\/]/).pop()}  brush=${brushes}  clip=${clipBrushes.length}`);
  for (const flip of [false, true]) {
    let ok = 0, empty = 0;
    const sizes = [];
    const byModel = {};
    for (const b of clipBrushes) {
      const polys = brushPolys(bsp, b, flip);
      if (!polys.length) { empty++; continue; }
      ok++;
      const m = brushModel.get(b) ?? -1;
      byModel[m] = (byModel[m] || 0) + 1;
      let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      for (const poly of polys) for (const p of poly) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
      sizes.push(Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
    }
    sizes.sort((a, b) => a - b);
    console.log(`  flip=${flip}  非空=${ok} 空=${empty}  尺寸中位数=${sizes.length ? sizes[sizes.length >> 1].toFixed(0) : '-'}  最大=${sizes.length ? sizes[sizes.length - 1].toFixed(0) : '-'}`);
    console.log(`  brushModel:`, Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 8));
  }
}

for (const f of process.argv.slice(2)) probe(f);
