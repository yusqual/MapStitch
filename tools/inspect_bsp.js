#!/usr/bin/env node
// inspect_bsp.js — 打印 BSP 头、lump 表和关键几何 lump 的数量。
// 用法: node tools/inspect_bsp.js <map.bsp> [...]
import path from 'node:path';
import { loadBsp, LUMP } from '../src/bsp.js';

const NAMES = new Map(Object.entries(LUMP).map(([k, v]) => [v, k]));
const SIZE_HINT = {
  PLANES: 20, TEXDATA: 32, VERTEXES: 12, NODES: 32, TEXINFO: 72, FACES: 56, LEAFS: 32,
  EDGES: 4, SURFEDGES: 4, MODELS: 48, BRUSHES: 12, BRUSHSIDES: 8,
  DISPINFO: 176, DISP_VERTS: 20, DISP_TRIS: 8, CUBEMAPS: 16, OVERLAYS: 352,
};

function inspect(file) {
  const bsp = loadBsp(file);
  console.log(`\n=== ${path.basename(file)} ===`);
  console.log(`version=${bsp.version}  lumpBase=${bsp.lumpBase}`);
  for (let i = 0; i < 64; i++) {
    const l = bsp.lumps[i];
    if (!l || l.len <= 0) continue;
    const name = NAMES.get(i) || `lump_${i}`;
    let extra = '';
    const size = SIZE_HINT[name];
    if (size) extra = `  count=${l.len / size}${l.len % size ? `  REM=${l.len % size}` : ''}`;
    let lzma = '';
    try {
      if (bsp.lump(i).toString('latin1', 0, 4) === 'LZMA') lzma = '  [LZMA]';
    } catch { lzma = '  [LZMA?]'; }
    console.log(`${String(i).padStart(2)} ${name.padEnd(28)} ofs=${String(l.ofs).padStart(9)} len=${String(l.len).padStart(9)} ver=${l.ver}${extra}${lzma}`);
  }
  const m0 = bsp.model(0);
  console.log(`世界范围 ${m0.mins.map((x) => x.toFixed(0)).join(',')} .. ${m0.maxs.map((x) => x.toFixed(0)).join(',')}`);
}

for (const f of process.argv.slice(2)) inspect(f);
