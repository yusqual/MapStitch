#!/usr/bin/env node
// cli.js — MapStitch 命令行入口。
//
//   node src/cli.js pairs [campaign]        只算偏移表（快，只读实体块）
//   node src/cli.js pairs --addon <vp/目录>  只算选中 addon 的章节偏移
//   node src/cli.js build --all             导出全部官方战役（含 DLC 目录）+ index.json
//   node src/cli.js build --campaign c1     只导出某个战役
//   node src/cli.js build --addon <vp/目录>  解包选中 addon 并加入 index（可重复 --addon）
//   node src/cli.js build c1m1_hotel c1m2_streets [landmark]
//   node src/cli.js serve [--port 8123]     启动可视化
//   node src/cli.js check <A> <B> <x> <y> <z>  查一个点传到下一章后落在什么体积里
//   node src/cli.js info <map>              输出单图 lump/统计信息
//   node src/cli.js addons [filter]         列出 addons/创意工坊 addon（--inspect 看地图数）
//   node src/cli.js vpk <file> [prefix]     列出 VPK 目录树（验证 preload/分卷）
//
// 选项：--game-dir <dir>  --maps-dir <dir>（可重复）  --addon <spec>（可重复）
//       --out <dir>  --force  --merge（build --all 时与已有 index 合并）
// 游戏目录默认从 Steam 注册表/库目录自动检测，也可用 L4D2_GAME_DIR 覆盖。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadBsp } from './bsp.js';
import { extractMap, TINTS } from './geometry.js';
import { writeMst, readMstHeader } from './export.js';
import {
  officialMapsDirs, resolveMap, calcOffset,
} from './offset.js';
import {
  listAddons, resolveAddon, openContent, scanAddon, parseMissionsText, listOfficialPairs,
  analyzeAddons, materializeAddons,
} from './addon.js';
import {
  getGameInfo, getGameRoot, setGameRoot,
} from './gamepath.js';
import { openVpk } from './vpk.js';
import { brushesAtPoint } from './query.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    mapsDir: null,
    mapsDirs: [],
    addons: [],
    out: path.join(ROOT, 'out'),
    force: false,
    merge: false,
    gameRoot: '',
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maps-dir') opts.mapsDirs.push(argv[++i]);
    else if (a === '--game-dir') opts.gameRoot = argv[++i];
    else if (a === '--addon') opts.addons.push(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--merge') opts.merge = true;
    else rest.push(a);
  }
  return { opts, rest };
}

// --game-dir 优先于自动检测；--maps-dir 优先于游戏目录推导。
function applyGameOptions(opts) {
  if (opts.gameRoot) {
    try {
      setGameRoot(opts.gameRoot, { persist: false });
    } catch (e) {
      throw new Error(e.message);
    }
  }
  if (opts.mapsDirs.length) opts.mapsDir = opts.mapsDirs;
  else if (process.env.L4D2_MAPS_DIR) opts.mapsDir = [process.env.L4D2_MAPS_DIR];
  else opts.mapsDir = officialMapsDirs();
  opts.gameRoot = getGameRoot();
  return opts;
}

function fmtVec(v, digits = 1) { return `(${v.map((x) => Number(x).toFixed(digits)).join(', ')})`; }
function ms(t) { return `${(t / 1000).toFixed(1)}s`; }

// ---------- pairs ----------
function printPairRows(rows) {
  console.log('战役  上一章 -> 下一章                               landmark              偏移量 (B - A)');
  for (const r of rows) {
    const tag = `${r.from} -> ${r.to}`;
    if (r.error) console.log(`${String(r.campaign).padEnd(5)} ${tag.padEnd(46)} 失败: ${r.error}`);
    else console.log(`${String(r.campaign).padEnd(5)} ${tag.padEnd(46)} ${String(r.landmark).padEnd(21)} ${fmtVec(r.offset)}${r.note ? '  [' + r.note + ']' : ''}`);
  }
}

function reportAddonPairs(opts) {
  const analyzed = analyzeAddons(opts.addons, opts);
  console.log(`addon: ${analyzed.addons.map((a) => `${a.name} (${a.kind})`).join(' + ')}`);
  for (const c of analyzed.campaigns) {
    console.log(`战役 ${c.id}（${c.name}）: ${c.chapters.map((ch) => ch.mapName + (ch.derived ? '*' : '')).join(' -> ')}${c.missing.length ? `  [过滤占位名: ${c.missing.join(', ')}]` : ''}`);
  }
  printPairRows(analyzed.pairs);
  return analyzed.pairs;
}

function reportPairs(rest, opts) {
  if (opts.addons.length) return reportAddonPairs(opts);
  const campaign = rest[0];
  let pairs = listOfficialPairs(opts.mapsDir);
  if (campaign) pairs = pairs.filter((p) => p.campaign === campaign);
  const rows = [];
  for (const p of pairs) {
    try {
      const bspA = loadBsp(resolveMap(p.from, opts.mapsDir));
      const bspB = loadBsp(resolveMap(p.to, opts.mapsDir));
      const r = calcOffset(bspA.entities, bspB.entities, p.landmark);
      rows.push({ ...p, ...r });
    } catch (e) {
      rows.push({ ...p, error: e.message });
    }
  }
  printPairRows(rows);
  return rows;
}

// ---------- build ----------

function markerSummary(markers) {
  const pick = (cls) => markers.filter((m) => m.classname === cls);
  return {
    landmarks: pick('info_landmark').map((m) => ({ name: m.targetname, origin: m.origin })),
    spawns: markers.filter((m) => m.classname.startsWith('info_player')).map((m) => ({ classname: m.classname, origin: m.origin })),
    changelevels: markers.filter((m) => /^(trigger|info)_changelevel$/i.test(m.classname))
      .map((m) => ({ classname: m.classname, map: m.map, landmark: m.landmark, origin: m.origin })),
  };
}

function buildMap(name, opts, srcFile) {
  const src = srcFile || resolveMap(name, opts.mapsDir);
  const dst = path.join(opts.out, 'maps', `${name}.mst`);
  const st = fs.statSync(src);
  if (!opts.force && fs.existsSync(dst)) {
    const d = fs.statSync(dst);
    if (d.mtimeMs >= st.mtimeMs) {
      return { name, file: dst, cached: true, size: d.size };
    }
  }
  const t0 = Date.now();
  const bsp = loadBsp(src);
  const extracted = extractMap(bsp, {
    mapName: name,
    tint: opts.tint || TINTS.a,
    tintAmount: opts.tintAmount,
  });
  extracted.markers = markerSummary(extracted.markers);
  const r = writeMst(dst, extracted);
  const secs = ms(Date.now() - t0);
  const tris = extracted.layers.reduce((s, l) => s + l.vertexCount / 3, 0) | 0;
  console.log(`  ${name.padEnd(28)} ${String(tris).padStart(8)} 三角形  ${(r.bytes / 1048576).toFixed(1)} MB  ${secs}`);
  return { name, file: dst, cached: false, size: r.bytes, header: r.header };
}

// mapFiles: { <mapName>: <bsp 绝对路径> }；mapMeta: { <mapName>: { addon } }
function buildAll(pairs, opts, { merge = true, mapFiles = {}, mapMeta = {}, extraMaps = [], addonInfo = null } = {}) {
  const names = [...new Set([...extraMaps, ...pairs.flatMap((p) => [p.from, p.to])])];
  console.log(`导出 ${names.length} 张地图 -> ${path.join(opts.out, 'maps')}`);
  const maps = {};
  // A/B 用同一素材色，冷暖 tint 留给查看器做（避免同一张图导出两份）
  for (const name of names) {
    const src = mapFiles[name];
    const r = buildMap(name, { ...opts, tint: [1, 1, 1], tintAmount: 0 }, src);
    const header = r.header || readMstHeader(r.file);
    maps[name] = {
      mst: path.relative(opts.out, r.file).split(path.sep).join('/'),
      size: r.size,
      bounds: header.bounds,
      stats: header.stats,
      markers: header.markers,
      source: path.resolve(src || resolveMap(name, opts.mapsDir)),
      ...(mapMeta[name] || {}),
    };
  }
  const pairRows = [];
  for (const p of pairs) {
    if (p.error) {
      pairRows.push({ ...p });
      continue;
    }
    if (p.offset && p.landmark) {
      pairRows.push({ ...p });
      continue;
    }
    try {
      const fileA = mapFiles[p.from] || resolveMap(p.from, opts.mapsDir);
      const fileB = mapFiles[p.to] || resolveMap(p.to, opts.mapsDir);
      const bspA = loadBsp(fileA);
      const bspB = loadBsp(fileB);
      const r = calcOffset(bspA.entities, bspB.entities, p.landmark);
      pairRows.push({
        campaign: p.campaign, from: p.from, to: p.to,
        landmark: r.landmark, offset: r.offset, note: r.note,
        landmarkA: r.a, landmarkB: r.b,
        source: p.source,
      });
    } catch (e) {
      pairRows.push({ campaign: p.campaign, from: p.from, to: p.to, error: e.message, source: p.source });
    }
  }
  // 与已有 index 合并：只构建部分章节时不清掉其它章节
  const indexFile = path.join(opts.out, 'index.json');
  let prev = { maps: {}, pairs: [], addons: [] };
  if (merge && fs.existsSync(indexFile)) {
    try { prev = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* ignore */ }
  }
  const mergedPairs = [...(prev.pairs || [])];
  for (const row of pairRows) {
    const i = mergedPairs.findIndex((p) => p.from === row.from && p.to === row.to);
    if (i >= 0) mergedPairs[i] = row; else mergedPairs.push(row);
  }
  // 官方章节在前（查看器默认打开第一对），附加地图在后；组内按地图名排序
  mergedPairs.sort((a, b) => {
    const ao = a.addon ? 1 : 0;
    const bo = b.addon ? 1 : 0;
    if (ao !== bo) return ao - bo;
    const c = String(a.campaign).localeCompare(String(b.campaign), 'en', { numeric: true, sensitivity: 'base' });
    if (c) return c;
    return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
  });

  const addons = [...(prev.addons || [])];
  if (addonInfo) {
    const i = addons.findIndex((a) => a.id === addonInfo.id && a.source === addonInfo.source);
    if (i >= 0) addons[i] = addonInfo; else addons.push(addonInfo);
  }

  const index = {
    generatedAt: new Date().toISOString(),
    mapsDir: opts.mapsDir,
    maps: { ...(prev.maps || {}), ...maps },
    pairs: mergedPairs,
    addons,
  };
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  console.log(`写入 ${indexFile}`);
  return index;
}

// ---------- addon build ----------

function buildAddon(opts) {
  let analyzed;
  try {
    analyzed = analyzeAddons(opts.addons, opts);
  } catch (e) {
    throw new Error(`读取 addon 失败: ${e.message}`);
  }
  for (const a of analyzed.addons) {
    console.log(`addon: ${a.name}  ${a.kind === 'vpk' ? 'VPK' : '目录'}  ${a.source}`);
  }
  for (const c of analyzed.campaigns) {
    console.log(`  战役 ${c.id}（${c.name}）: ${c.chapters.map((ch) => ch.mapName + (ch.derived ? '*' : '')).join(' -> ')}${c.missing.length ? `  [过滤: ${c.missing.join(', ')}]` : ''}`);
  }
  if (!analyzed.campaigns.length) {
    console.log(`  没有 missions，使用 ${analyzed.source === 'name-order' ? '名称排序' : 'changelevel 连链'}配对`);
  }

  const t0 = Date.now();
  const materialized = materializeAddons(analyzed, {
    outDir: opts.out,
    force: opts.force,
    log: (s) => console.log(s),
  });
  console.log(`  解包耗时 ${ms(Date.now() - t0)}`);
  if (!materialized.maps.length) {
    throw new Error(`addon ${analyzed.addons.map((a) => a.name).join(' + ')} 里没有找到任何 .bsp（不是地图 addon？）`);
  }

  const mapFiles = {};
  const mapMeta = {};
  for (const m of materialized.maps) {
    if (!m.file) throw new Error(`地图 ${m.name} 没有本地文件`);
    mapFiles[m.name] = m.file;
    mapMeta[m.name] = { addon: m.addon };
  }
  const extraMaps = materialized.maps.map((m) => m.name);
  const addonInfo = {
    id: analyzed.addons.map((a) => a.id).join('+'),
    name: analyzed.addons.map((a) => a.name).join(' + '),
    entries: analyzed.addons.map((a) => ({ id: a.id, name: a.name, kind: a.kind, source: a.source })),
    campaigns: analyzed.campaigns.map((c) => ({
      id: c.id, name: c.name, chapters: c.chapters.map((ch) => ch.mapName),
    })),
    cache: materialized.cacheDirs.map((d) => path.relative(opts.out, d).split(path.sep).join('/')),
    pairing: analyzed.source,
  };
  const index = buildAll(analyzed.pairs, opts, {
    merge: true, mapFiles, mapMeta, extraMaps, addonInfo,
  });
  console.log('');
  printPairRows(index.pairs.filter((p) => analyzed.pairs.some((q) => q.from === p.from && q.to === p.to)));
  return index;
}

// ---------- serve ----------
const bspCache = new Map();

// 优先用 index.json 记录的 source（覆盖 addon 缓存与 DLC 目录），否则按 --maps-dir 找。
function mapSourcesFromIndex(outDir) {
  const map = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
    for (const [name, meta] of Object.entries(index.maps || {})) {
      if (meta && meta.source) map.set(name.toLowerCase(), meta.source);
    }
  } catch { /* 没有 index 时退回目录扫描 */ }
  return map;
}

function loadBspCached(name, opts, sources) {
  const key = String(name).toLowerCase();
  let file = sources.get(key);
  // serve 启动后可能又 build 了新的 addon：source 不存在时重新读一次 index
  if (!file || !fs.existsSync(file)) {
    const fresh = mapSourcesFromIndex(opts.out);
    file = fresh.get(key);
    if (file) {
      sources.clear();
      for (const [k, v] of fresh) sources.set(k, v);
    }
  }
  file = file || resolveMap(name, opts.mapsDir);
  if (!bspCache.has(file)) bspCache.set(file, loadBsp(file));
  return bspCache.get(file);
}

// GET /api/point?map=<map>&x=&y=&z=  返回该点所在的 solid/clip/water brush
function apiPoint(url, opts, sources, res) {
  const q = url.searchParams;
  const map = q.get('map');
  const p = ['x', 'y', 'z'].map((k) => Number(q.get(k)));
  if (!map || p.some((v) => !Number.isFinite(v))) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad params' }));
    return;
  }
  try {
    const bsp = loadBspCached(map, opts, sources);
    const hits = brushesAtPoint(bsp, p).map((h) => ({
      kind: h.kind, brush: h.brush, classname: h.classname, targetname: h.targetname,
      depth: Number(h.depth.toFixed(1)),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ map, p, hits }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
}

// ---------- addon API（查看器里的“选择 VPK 并自动解析”入口） ----------

const CLI_FILE = fileURLToPath(import.meta.url);
const addonScanCache = new Map();
const jobs = new Map();
let runningJob = null;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readIndexFile(outDir) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8')); } catch { return null; }
}

function builtAddonSources(index) {
  const set = new Set();
  for (const a of (index && index.addons) || []) {
    for (const e of a.entries || []) set.add(path.resolve(e.source).toLowerCase());
  }
  return set;
}

// GET /api/addons — 列出 addons，附带地图数与 coop 章节（只读目录树，不解析几何）
function apiAddons(res, opts) {
  const index = readIndexFile(opts.out);
  const built = builtAddonSources(index);
  const out = [];
  for (const addon of listAddons()) {
    let st;
    try { st = fs.statSync(addon.source); } catch { continue; }
    const stamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const key = addon.source.toLowerCase();
    let summary = addonScanCache.get(key);
    if (!summary || summary.stamp !== stamp) {
      const item = {
        id: addon.id, name: addon.name, kind: addon.kind, source: addon.source,
        size: st.isDirectory() ? 0 : st.size,
        maps: 0, campaigns: [], missing: [], error: '', stamp,
      };
      try {
        const content = openContent(addon);
        const scanned = scanAddon(addon, content);
        item.maps = scanned.maps.length;
        item.campaigns = scanned.campaigns.map((c) => ({
          id: c.id, name: c.name,
          chapters: c.chapters.map((ch) => ch.mapName),
          missing: c.missing,
        }));
      } catch (e) {
        item.error = e.message;
      }
      summary = item;
      addonScanCache.set(key, summary);
    }
    out.push({ ...summary, built: built.has(key) });
  }
  sendJson(res, 200, {
    addons: out,
    game: { ...getGameInfo(), mapsDirs: officialMapsDirs() },
    index: indexSummary(opts.out),
  });
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function indexSummary(outDir) {
  const index = readIndexFile(outDir);
  const maps = (index && index.maps) || {};
  const pairs = (index && index.pairs) || [];
  return {
    mapsTotal: Object.keys(maps).length,
    officialMaps: Object.values(maps).filter((m) => m && !m.addon).length,
    officialPairs: pairs.filter((p) => !p.addon).length,
    pairsTotal: pairs.length,
    addonsTotal: ((index && index.addons) || []).length,
  };
}

function buildBaseArgs(opts) {
  const args = [CLI_FILE, 'build', '--out', opts.out];
  const root = opts.gameRoot || getGameRoot();
  if (root) args.push('--game-dir', root);
  for (const d of opts.mapsDirs || []) args.push('--maps-dir', d);
  return args;
}

function startBuildJob(args, opts, { kind, specs = [], summarize = null }) {
  if (runningJob && jobs.get(runningJob)?.status === 'running') {
    throw new Error('已有解析任务在运行，请等待完成');
  }
  const id = randomUUID();
  const before = readIndexFile(opts.out);
  const beforePairs = new Set(((before && before.pairs) || []).map((p) => `${p.from}|${p.to}`));
  const job = {
    id, kind, status: 'running', startedAt: Date.now(), log: [], result: null, error: '', specs,
  };
  jobs.set(id, job);
  runningJob = id;

  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
  const pushLog = (line) => {
    const s = line.replace(/\r$/, '');
    if (!s) return;
    job.log.push(s);
    if (job.log.length > 500) job.log.shift();
    console.log(`  [job] ${s}`);
  };
  const collect = (d) => {
    for (const line of d.toString('utf8').split('\n')) pushLog(line);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  child.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
    pushLog(`启动失败: ${e.message}`);
    runningJob = null;
  });
  child.on('exit', (code) => {
    job.finishedAt = Date.now();
    if (code !== 0) {
      job.status = 'error';
      job.error = job.error || `构建进程退出码 ${code}`;
    } else {
      const after = readIndexFile(opts.out);
      const afterPairs = (after && after.pairs) || [];
      const newPairs = afterPairs.filter((p) => !beforePairs.has(`${p.from}|${p.to}`));
      const usable = newPairs.filter((p) => !p.error);
      job.status = 'done';
      job.result = {
        kind,
        newPairs,
        usableCount: usable.length,
        failedCount: newPairs.length - usable.length,
        ...(summarize ? summarize(after, newPairs) : {}),
      };
      if (kind === 'official') {
        pushLog(`完成：官方地图 ${job.result.officialMaps} 张 / ${job.result.officialPairs} 对，index 共 ${job.result.mapsTotal} 张图 / ${job.result.pairsTotal} 对`);
      } else {
        pushLog(`完成：${usable.length} 个可用章节对${newPairs.length > usable.length ? `，${newPairs.length - usable.length} 个偏移失败` : ''}`);
      }
    }
    runningJob = null;
  });

  // 只保留最近 20 个任务
  const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => b.startedAt - a.startedAt);
  for (const j of finished.slice(20)) jobs.delete(j.id);
  return job;
}

function startAddonJob(specs, opts, force) {
  const addons = specs.map((s) => resolveAddonForApi(s));
  const args = buildBaseArgs(opts);
  for (const a of addons) args.push('--addon', a.source);
  if (force) args.push('--force');
  return startBuildJob(args, opts, {
    kind: 'addon',
    specs: addons.map((a) => ({ id: a.id, name: a.name, kind: a.kind, source: a.source })),
    summarize: (after) => {
      const sources = new Set(addons.map((a) => path.resolve(a.source).toLowerCase()));
      const campaigns = [];
      const builtAddons = [];
      for (const a of (after && after.addons) || []) {
        if (!(a.entries || []).some((e) => sources.has(path.resolve(e.source).toLowerCase()))) continue;
        builtAddons.push({ id: a.id, name: a.name });
        for (const c of a.campaigns || []) campaigns.push({ id: c.id, name: c.name, chapters: c.chapters });
      }
      return { campaigns, addons: builtAddons };
    },
  });
}

function startOfficialJob(opts, force) {
  const args = buildBaseArgs(opts);
  args.push('--all', '--merge');
  if (force) args.push('--force');
  return startBuildJob(args, opts, {
    kind: 'official',
    summarize: (after) => {
      const maps = (after && after.maps) || {};
      const pairs = (after && after.pairs) || [];
      return {
        mapsTotal: Object.keys(maps).length,
        officialMaps: Object.values(maps).filter((m) => m && !m.addon).length,
        officialPairs: pairs.filter((p) => !p.addon).length,
        pairsTotal: pairs.length,
        addonsTotal: ((after && after.addons) || []).length,
        game: getGameInfo(),
      };
    },
  });
}

// 允许传 addon.id / 名称 / 路径（与 CLI 的 --addon 解析一致）
function resolveAddonForApi(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('addon 参数无效');
  return resolveAddon(spec);
}

async function handleAddonBuild(req, res, opts) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const raw = Array.isArray(body.specs) ? body.specs : (body.spec ? [body.spec] : []);
  const specs = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  if (!specs.length) { sendJson(res, 400, { error: '缺少 specs' }); return; }
  try {
    const job = startAddonJob(specs, opts, Boolean(body.force));
    sendJson(res, 202, { id: job.id, specs: job.specs });
  } catch (e) {
    sendJson(res, e.message.includes('已有解析任务') ? 409 : 400, { error: e.message });
  }
}

async function handleOfficialBuild(req, res, opts) {
  let body = {};
  try { body = await readJsonBody(req); } catch { /* 允许空 body */ }
  if (!officialMapsDirs().length) {
    sendJson(res, 400, { error: '未检测到 L4D2 安装目录：请先填写并保存游戏目录，或设置 L4D2_GAME_DIR' });
    return;
  }
  try {
    const job = startOfficialJob(opts, Boolean(body.force));
    sendJson(res, 202, { id: job.id });
  } catch (e) {
    sendJson(res, e.message.includes('已有解析任务') ? 409 : 400, { error: e.message });
  }
}

async function handleGameDir(req, res, opts) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const info = setGameRoot(String(body.gameRoot || ''));
    opts.gameRoot = info.root;
    opts.mapsDir = opts.mapsDirs.length
      ? opts.mapsDirs
      : (process.env.L4D2_MAPS_DIR ? [process.env.L4D2_MAPS_DIR] : officialMapsDirs(info.root));
    addonScanCache.clear();
    sendJson(res, 200, {
      game: { ...info, mapsDirs: officialMapsDirs(info.root) },
      index: indexSummary(opts.out),
    });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

function apiJob(id, res) {
  const job = jobs.get(id);
  if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
  sendJson(res, 200, {
    id: job.id, kind: job.kind, status: job.status, error: job.error, result: job.result,
    specs: job.specs, log: job.log.join('\n'),
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mst': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serve(opts) {
  const port = opts.port || 8123;
  const sources = mapSourcesFromIndex(opts.out);
  const game = getGameInfo();
  if (game.root) console.log(`游戏目录: ${game.root}（${game.source}）`);
  else console.log('未检测到 L4D2 安装目录：可在页面填写，或设置 L4D2_GAME_DIR');
  if (sources.size) console.log(`index.json 中 ${sources.size} 张地图带 source 路径`);
  const roots = [
    { prefix: '/out/', dir: opts.out },
    { prefix: '/', dir: path.join(ROOT, 'web'), fallthrough: true },
    { prefix: '/node_modules/', dir: path.join(ROOT, 'node_modules') },
  ];
  const server = http.createServer((req, res) => {
    let parsed;
    try { parsed = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
    if (parsed.pathname === '/api/point') { apiPoint(parsed, opts, sources, res); return; }
    if (parsed.pathname === '/api/addons') { apiAddons(res, opts); return; }
    if (parsed.pathname === '/api/addon/build') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '请用 POST' }); return; }
      handleAddonBuild(req, res, opts);
      return;
    }
    if (parsed.pathname === '/api/build/official') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '请用 POST' }); return; }
      handleOfficialBuild(req, res, opts);
      return;
    }
    if (parsed.pathname === '/api/game-dir') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '请用 POST' }); return; }
      handleGameDir(req, res, opts);
      return;
    }
    const jobMatch = /^\/api\/job\/([\w-]+)$/.exec(parsed.pathname);
    if (jobMatch) { apiJob(jobMatch[1], res); return; }
    let urlPath;
    try { urlPath = decodeURIComponent(parsed.pathname); } catch { res.writeHead(400).end(); return; }
    if (urlPath === '/') urlPath = '/index.html';
    for (const r of roots) {
      let rel;
      if (r.prefix === '/') rel = urlPath;
      else if (urlPath.startsWith(r.prefix)) rel = urlPath.slice(r.prefix.length);
      else continue;
      const file = path.resolve(r.dir, '.' + (r.prefix === '/' ? rel : '/' + rel));
      if (!file.startsWith(path.resolve(r.dir))) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  });
  server.listen(port, () => {
    console.log(`MapStitch 可视化: http://localhost:${port}/`);
    console.log(`（数据目录 ${opts.out}）`);
  });
}

// ---------- addons / vpk ----------

function cmdAddons(rest, opts) {
  const inspect = rest.includes('--inspect');
  const filter = rest.find((a) => !a.startsWith('--'));
  let all = listAddons();
  if (filter) {
    const f = filter.toLowerCase();
    all = all.filter((a) => a.name.toLowerCase().includes(f) || a.id.toLowerCase().includes(f));
  }
  if (!all.length) {
    console.log('没有匹配的 addon（默认目录 left4dead2/addons 与 workshop/content/550）');
    return;
  }
  for (const a of all) {
    const size = a.size ? `${(a.size / 1048576).toFixed(0)} MB` : '目录';
    let detail = '';
    if (inspect) {
      try {
        const content = openContent(a);
        const s = scanAddon(a, content);
        const coop = s.campaigns.map((c) => `${c.id}:${c.chapters.length}章`).join(', ') || '无 missions';
        detail = `  地图 ${String(s.maps.length).padStart(3)}  ${coop}`;
      } catch (e) {
        detail = `  [读取失败: ${e.message}]`;
      }
    }
    console.log(`${a.name.padEnd(46)} ${a.kind.padEnd(4)} ${size.padStart(7)}  ${a.source}${detail}`);
  }
}

function cmdVpk(rest) {
  const file = rest[0];
  if (!file) throw new Error('用法: cli.js vpk <file.vpk> [prefix] [--missions]');
  const prefix = rest.slice(1).find((a) => !a.startsWith('--')) || '';
  const showMissions = rest.includes('--missions');
  const vpk = openVpk(file);
  const preloads = vpk.entries.filter((e) => e.preloadBytes > 0);
  console.log(`VPK v${vpk.version}  ${vpk.file}`);
  console.log(`条目 ${vpk.entries.length}  目录树 ${vpk.treeSize} B  数据区 @${vpk.dataStart}`);
  console.log(`带 preload 的条目 ${preloads.length}（合计 ${preloads.reduce((s, e) => s + e.preloadBytes, 0)} B）`);
  const list = vpk.list(prefix);
  const limit = 200;
  console.log(`\n${prefix ? `前缀 "${prefix}" ` : ''}匹配 ${list.length} 条${list.length > limit ? `，只显示前 ${limit}` : ''}:`);
  for (const e of list.slice(0, limit)) {
    const arch = e.archiveIndex === 0x7fff ? '内嵌' : `分卷 ${String(e.archiveIndex).padStart(3, '0')}`;
    console.log(`  ${e.path.padEnd(64)} ${String(e.size).padStart(10)} B  ${arch}  preload ${e.preloadBytes}`);
  }
  if (list.length > limit) console.log(`  ... 还有 ${list.length - limit} 条`);
  if (showMissions) {
    const mis = vpk.list('missions/').filter((e) => /\.txt$/i.test(e.path));
    console.log(`\nmissions (${mis.length}):`);
    for (const e of mis) {
      let parsed = null;
      try { parsed = parseMissionsText(vpk.readEntry(e).toString('utf8'), e.path); } catch { /* ignore */ }
      console.log(`  ${e.path}${parsed ? `  coop: ${parsed.chapters.map((ch) => ch.map).join(' -> ')}` : ''}`);
    }
  }
}

// ---------- info ----------
function resolveMapWithIndex(name, opts) {
  const sources = mapSourcesFromIndex(opts.out);
  return sources.get(String(name).toLowerCase()) || resolveMap(name, opts.mapsDir);
}

function info(name, opts) {
  const bsp = loadBsp(resolveMapWithIndex(name, opts));
  const m = bsp.model(0);
  console.log(`地图 ${name}  version=${bsp.version}  lumpBase=${bsp.lumpBase}`);
  console.log(`世界范围 ${fmtVec(m.mins)} .. ${fmtVec(m.maxs)}`);
  console.log(`面 ${bsp.count('FACES')}  位移面 ${bsp.count('DISPINFO')}  顶点 ${bsp.count('VERTEXES')}`);
  console.log(`brush ${bsp.count('BRUSHES')}  brushside ${bsp.count('BRUSHSIDES')}  模型 ${bsp.count('MODELS')}`);
  const lm = bsp.entities.filter((e) => e.classname === 'info_landmark');
  console.log(`info_landmark (${lm.length}):`);
  for (const e of lm) console.log(`  ${(e.targetname || '?').padEnd(28)} ${e.origin}`);
}

// ---------- check ----------
function describeBrushes(list) {
  if (!list.length) return '  开阔空间（不在任何 solid/clip/water brush 内）';
  return list.map((b) => {
    const where = b.classname ? `，实体 ${b.classname}${b.targetname ? ` "${b.targetname}"` : ''}` : '，世界几何';
    return `  [${b.kind.padEnd(5)}] brush #${b.brush}${where}，距最近面 ${b.depth.toFixed(1)}`;
  }).join('\n');
}

function checkPoint(rest, opts) {
  const [fromName, toName, x, y, z] = rest;
  if (!toName || [x, y, z].some((v) => v === undefined || Number.isNaN(Number(v)))) {
    throw new Error('用法: cli.js check <上一章> <下一章> <x> <y> <z>');
  }
  const pA = [Number(x), Number(y), Number(z)];
  const bspA = loadBsp(resolveMapWithIndex(fromName, opts));
  const bspB = loadBsp(resolveMapWithIndex(toName, opts));
  const r = calcOffset(bspA.entities, bspB.entities);
  const pB = [pA[0] + r.offset[0], pA[1] + r.offset[1], pA[2] + r.offset[2]];

  console.log(`landmark ${r.landmark}  偏移 (B - A) = ${fmtVec(r.offset)}`);
  console.log(`\nA 点 ${fmtVec(pA)}:`);
  console.log(describeBrushes(brushesAtPoint(bspA, pA)));
  console.log(`\nB 点 = A + 偏移 = ${fmtVec(pB)}:`);
  const hits = brushesAtPoint(bspB, pB);
  console.log(describeBrushes(hits));
  const clip = hits.filter((h) => h.kind === 'clip');
  const solid = hits.filter((h) => h.kind === 'solid');
  if (clip.length) console.log('\n判定: B 点落在 clip 体积内 —— 卡墙传点后大概率被卡住，可用。');
  else if (solid.length) console.log('\n判定: B 点落在实体几何内 —— 位于墙/地板内部，可能被挤压或卡住。');
  else console.log('\n判定: B 点处于开阔空间 —— 传点后会正常落地/站立。');
}

// ---------- main ----------
function main() {
  const argv = process.argv.slice(2);
  const { opts, rest } = parseArgs(argv);
  applyGameOptions(opts);
  const cmd = rest.shift();

  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
    return;
  }
  if (cmd === 'pairs') { reportPairs(rest, opts); return; }
  if (cmd === 'addons') { cmdAddons(rest, opts); return; }
  if (cmd === 'vpk') { cmdVpk(rest); return; }
  if (cmd === 'info') {
    if (!rest[0]) throw new Error('用法: cli.js info <map>');
    info(rest[0], opts);
    return;
  }
  if (cmd === 'serve') { serve(opts); return; }
  if (cmd === 'check') { checkPoint(rest, opts); return; }
  if (cmd === 'build') {
    if (opts.addons.length) {
      // build --all --addon X：先重建官方索引，再把选中 addon 合并进去
      if (rest[0] === '--all') {
        const allPairs = listOfficialPairs(opts.mapsDir);
        if (!allPairs.length) throw new Error('没有匹配到官方相邻章节');
        buildAll(allPairs, opts, { merge: false });
      }
      buildAddon(opts);
      return;
    }
    let pairs;
    let merge = true;
    if (rest[0] === '--all') { pairs = listOfficialPairs(opts.mapsDir); merge = opts.merge; }
    else if (rest[0] === '--campaign') pairs = listOfficialPairs(opts.mapsDir).filter((p) => p.campaign === rest[1]);
    else if (rest[0] === '--pairs') { pairs = listOfficialPairs(opts.mapsDir); merge = opts.merge; }
    else if (rest.length >= 2) {
      const from = path.basename(rest[0], '.bsp');
      const to = path.basename(rest[1], '.bsp');
      const camp = /^(c\d+)/i.exec(from);
      pairs = [{ campaign: camp ? camp[1].toLowerCase() : 'custom', from, to, landmark: rest[2] }];
    } else {
      throw new Error('用法: cli.js build <from> <to> [landmark] | --campaign c1 | --all | --addon <spec>');
    }
    if (!pairs.length) throw new Error('没有匹配到相邻章节');
    buildAll(pairs, opts, { merge });
    return;
  }
  throw new Error(`未知命令: ${cmd}`);
}

try {
  main();
} catch (e) {
  console.error(`错误: ${e.message}`);
  process.exit(1);
}
