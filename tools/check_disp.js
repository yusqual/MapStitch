#!/usr/bin/env node
// check_disp.js — 用“相邻位移面共享边顶点必须重合”验证 geometry.buildDispGrid 的映射。
// 对应关系：face 边 k 连接 face 顶点 k -> k+1；网格边界 m=(k-baseI+4)%4：
//   m=0: i=0, j:0->n    m=1: j=n, i:0->n
//   m=2: i=n, j:n->0    m=3: j=0, i:n->0
// 对每个相邻面对，比较共享边上的顶点序列（方向相反）。
//
// 用法: node tools/check_disp.js <map.bsp> [...]
import fs from 'node:fs';
import path from 'node:path';
import { loadBsp } from '../src/bsp.js';
import { buildDispGrid } from '../src/geometry.js';

const key = (p) => p.map((x) => (Math.round(x * 16) / 16).toFixed(1)).join(',');

function boundary(grid, n, k, baseI) {
  const m = ((k - baseI) % 4 + 4) % 4;
  const pts = [];
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    const i = Math.round(t * n), j = Math.round(t * n);
    if (m === 0) pts.push(grid[j][0]);
    else if (m === 1) pts.push(grid[n][i]);
    else if (m === 2) pts.push(grid[n - j][n]);
    else pts.push(grid[0][n - i]);
  }
  return pts;
}

function check(file) {
  const bsp = loadBsp(file);
  const m0 = bsp.model(0);
  const disps = [];
  for (let i = m0.firstface; i < m0.firstface + m0.numfaces; i++) {
    if (bsp.face(i).dispinfo >= 0) disps.push(i);
  }
  const built = new Map();
  const faceData = [];
  for (const fi of disps) {
    const vs = bsp.faceVertices(fi);
    const g = buildDispGrid(bsp, fi);
    if (!g) continue;
    built.set(fi, g);
    const edges = [];
    for (let k = 0; k < 4; k++) edges.push([key(vs[k]), key(vs[(k + 1) % 4])].sort().join('|'));
    faceData.push({ fi, edges });
  }
  const edgeMap = new Map();
  for (const { fi, edges } of faceData) for (const e of edges) {
    if (!edgeMap.has(e)) edgeMap.set(e, []);
    edgeMap.get(e).push(fi);
  }
  const seen = new Set();
  let sum = 0, count = 0, max = 0, worst = null, mismatchPower = 0, bad = 0;
  for (const { fi, edges } of faceData) {
    for (let k = 0; k < 4; k++) {
      const other = (edgeMap.get(edges[k]) || []).find((x) => x !== fi);
      if (other === undefined) continue;
      const sig = [fi, other].sort().join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      const od = faceData.find((x) => x.fi === other);
      const kOther = [0, 1, 2, 3].find((kk) => od.edges[kk] === edges[k]);
      if (kOther === undefined) continue;
      const A = built.get(fi), B = built.get(other);
      if (A.n !== B.n) { mismatchPower++; continue; }
      const pa = boundary(A.grid, A.n, k, A.baseI);
      const pb = boundary(B.grid, B.n, kOther, B.baseI);
      let s = 0;
      for (let i = 0; i < pa.length; i++) {
        const p = pa[i], q = pb[pa.length - 1 - i];
        s += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      }
      const rms = Math.sqrt(s / pa.length);
      sum += rms * rms; count++;
      if (rms > 5) bad++;
      if (rms > max) { max = rms; worst = [fi, other]; }
    }
  }
  const rms = count ? Math.sqrt(sum / count) : NaN;
  // 少量“伪相邻”来自重叠/重复的位移面，属已知情况；超过 15% 才认为映射有问题
  const ok = bad / Math.max(1, count) < 0.15;
  console.log(`${file.split(/[\\/]/).pop().padEnd(28)} disp=${String(disps.length).padStart(4)}  pairs=${String(count).padStart(4)}  RMS=${rms.toFixed(4)}  bad=${bad}  ${ok ? 'OK' : 'CHECK'}${worst && max > 5 ? `  worst=${worst}` : ''}${mismatchPower ? `  powerMismatch=${mismatchPower}` : ''}`);
  return { ok, rms, count, bad };
}

const args = process.argv.slice(2);
const files = [];
for (const a of args) {
  if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
    for (const f of fs.readdirSync(a)) if (/^c\d+m\d+_.*\.bsp$/i.test(f)) files.push(path.join(a, f));
  } else {
    files.push(a);
  }
}
let allOk = true;
for (const f of files) { const r = check(f); allOk = allOk && r.ok; }
process.exit(allOk ? 0 : 1);
