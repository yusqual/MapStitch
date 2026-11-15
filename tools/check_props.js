#!/usr/bin/env node
// check_props.js — prop_static 包围盒校验。
//
//   node tools/check_props.js <地图名>            用 index.json 的 source 或 --maps-dir 找 bsp
//   node tools/check_props.js <file.bsp> [x y z]  指定坐标时额外做一次点查询
//
// 输出：prps 的 propCount / 模型数、可解析 hull 的盒子数、缺失模型，
// 以及与 .mst 里 props 层三角形数的对比（若同名 .mst 存在）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBsp } from '../src/bsp.js';
import { readMstHeader } from '../src/export.js';
import {
  ModelProvider, parseStaticProps, propBoxes, propsAtPoint,
} from '../src/props.js';
import { resolveMap, officialMapsDirs } from '../src/offset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const INDEX = path.join(OUT, 'index.json');

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return null; }
}

function findBsp(name) {
  if (/\.bsp$/i.test(name) && fs.existsSync(name)) return path.resolve(name);
  const index = readIndex();
  const meta = index && index.maps && index.maps[name];
  if (meta && meta.source && fs.existsSync(meta.source)) return meta.source;
  try { return resolveMap(name, officialMapsDirs()); } catch { return null; }
}

const [arg, ...rest] = process.argv.slice(2);
if (!arg) {
  console.error('用法: node tools/check_props.js <地图名|file.bsp> [x y z]');
  process.exit(1);
}
const bspFile = findBsp(arg);
if (!bspFile) {
  console.error(`找不到地图: ${arg}`);
  process.exit(1);
}
const bsp = loadBsp(bspFile);
const data = parseStaticProps(bsp);
const index = readIndex();
const provider = new ModelProvider({ addonSpecs: addonSpecs(index) });

function addonSpecs(idx) {
  const out = [];
  for (const a of (idx && idx.addons) || []) {
    for (const e of a.entries || []) if (e && e.source) out.push({ kind: e.kind, source: e.source });
  }
  return out;
}

console.log(`地图 ${path.basename(bspFile)}`);
if (!data) {
  console.log('没有 prps lump（静态道具 0）');
  process.exit(0);
}
console.log(`prps v${data.version}  步长 ${data.stride} B  propCount ${data.props.length}  模型 ${data.names.length}`);

const result = propBoxes(bsp, provider);
console.log(`可解析包围盒 ${result.boxes.length}  缺模型 ${result.missing}`);
if (result.missing) console.log(`缺失模型示例: ${result.missingModels.slice(0, 5).join(', ')}`);

// .mst 层的三角形数应该正好是 盒子数 x 36
const mapName = path.basename(bspFile, '.bsp');
const mst = path.join(OUT, 'maps', `${mapName}.mst`);
if (fs.existsSync(mst)) {
  try {
    const header = readMstHeader(mst);
    const layer = header.layers.find((l) => l.name === 'props');
    const expected = (layer ? layer.vertexCount : 0) / 36;
    console.log(`.mst props 层：${layer ? layer.vertexCount : 0} 顶点 = ${expected} 个盒子（期望 ${result.boxes.length}）`);
  } catch (e) {
    console.log(`.mst 读取失败: ${e.message}`);
  }
}

// 抽样：显示前 3 个盒子的模型、原点与尺寸（已按 angles 旋转前的 hull 尺寸）
for (const box of result.boxes.slice(0, 3)) {
  const size = box.maxs.map((x, i) => (x - box.mins[i]).toFixed(2)).join(' x ');
  console.log(`  ${box.model}  origin ${box.origin.map((x) => x.toFixed(0)).join(',')}  hull ${size}  solid ${box.solid}`);
}

const point = rest.length >= 3 ? rest.slice(0, 3).map(Number) : null;
if (point && point.every(Number.isFinite)) {
  const hits = propsAtPoint(bsp, provider, point);
  console.log(`\n点 ${point.join(', ')} 命中 ${hits.length} 个 prop 包围盒:`);
  for (const h of hits.slice(0, 5)) console.log(`  ${h.model}  距最近面 ${h.depth.toFixed(1)}`);
  if (!hits.length) console.log('  （不在任何 prop 包围盒内）');
}
