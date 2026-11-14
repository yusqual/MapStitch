// gamepath.js — 查找 L4D2 安装目录，避免把某台机器的路径写死。
//
// 优先级：L4D2_GAME_DIR > L4D2_MAPS_DIR（反推）> .mapstitch.json（页面保存）> Steam 库 > 常见路径。
// Steam 库通过 Windows 注册表 + steamapps/libraryfolders.vdf 查找，支持自定义库目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(ROOT, '.mapstitch.json');
export const GAME_DIR_NAME = 'Left 4 Dead 2';

let cachedInfo;

export function normalizeGameRoot(input) {
  if (!input) return '';
  let p = path.resolve(String(input).trim().replace(/^"(.*)"$/, '$1'));
  const base = path.basename(p).toLowerCase();
  const parent = path.basename(path.dirname(p)).toLowerCase();
  if (base === 'maps' && parent === 'left4dead2') return path.resolve(p, '..', '..');
  if (base === 'left4dead2') return path.resolve(p, '..');
  return p;
}

export function isGameRoot(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'left4dead2', 'maps'))
    || fs.existsSync(path.join(dir, 'left4dead2', 'addons'));
}

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof data.gameRoot === 'string' ? data.gameRoot : '';
  } catch {
    return '';
  }
}

function writeConfig(gameRoot) {
  try {
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ gameRoot }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function regValue(key, value) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, 'i'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function steamRoots() {
  const roots = [];
  const add = (p) => {
    if (!p) return;
    const full = path.resolve(String(p).replace(/^"(.*)"$/, '$1'));
    if (!roots.some((r) => r.toLowerCase() === full.toLowerCase())) roots.push(full);
  };

  add(process.env.STEAM_ROOT);
  add(process.env.STEAM_PATH);

  if (process.platform === 'win32') {
    add(regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'));
    add(regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
    add(regValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
    add(process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam') : '');
    add(process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Steam') : '');
    add('C:/Steam');
  } else if (process.platform === 'darwin') {
    add(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    add(path.join(os.homedir(), '.steam', 'steam'));
    add(path.join(os.homedir(), '.local', 'share', 'Steam'));
    add('/usr/local/Steam');
  }
  return roots;
}

function unescapeVdf(s) {
  return s.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

function libraryPaths(steamRoot) {
  const out = [];
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(vdf)) {
    let text = '';
    try { text = fs.readFileSync(vdf, 'utf8'); } catch { /* ignore */ }
    // 新版："path" "D:\\SteamLibrary"；旧版："1" "D:\\SteamLibrary"
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/gi)) out.push(unescapeVdf(m[1]));
    if (!out.length) {
      for (const m of text.matchAll(/"\d+"\s+"([^"]+)"/g)) out.push(unescapeVdf(m[1]));
    }
  }
  out.push(steamRoot);
  return out;
}

function gameAt(root) {
  const candidates = [
    path.join(root, 'steamapps', 'common', GAME_DIR_NAME),
    path.join(root, 'common', GAME_DIR_NAME),
    path.join(root, GAME_DIR_NAME),
  ];
  return candidates.find((c) => isGameRoot(c)) || '';
}

function detect() {
  // 1. 环境变量
  const envRoot = normalizeGameRoot(process.env.L4D2_GAME_DIR || '');
  if (envRoot && isGameRoot(envRoot)) return { root: envRoot, source: 'L4D2_GAME_DIR' };

  const envMaps = process.env.L4D2_MAPS_DIR;
  if (envMaps) {
    const root = normalizeGameRoot(envMaps);
    if (isGameRoot(root)) return { root, source: 'L4D2_MAPS_DIR' };
  }

  // 2. 页面保存的配置
  const configured = normalizeGameRoot(readConfig());
  if (configured && isGameRoot(configured)) return { root: configured, source: '.mapstitch.json' };

  // 3. Steam 库
  for (const steam of steamRoots()) {
    for (const lib of libraryPaths(steam)) {
      const hit = gameAt(lib);
      if (hit) return { root: hit, source: 'Steam 库' };
    }
  }
  return { root: '', source: '' };
}

export function getGameInfo() {
  if (cachedInfo === undefined) cachedInfo = detect();
  return { ...cachedInfo };
}

export function getGameRoot() {
  return getGameInfo().root;
}

// 保存页面填写的目录（persist=true 时写入 .mapstitch.json），并刷新缓存。
export function setGameRoot(input, { persist = true } = {}) {
  const root = normalizeGameRoot(input);
  if (!isGameRoot(root)) throw new Error(`不是有效的 L4D2 安装目录（缺少 left4dead2/maps 或 left4dead2/addons）: ${root || '(空)'}`);
  if (persist && !writeConfig(root)) {
    throw new Error(`无法写入 ${CONFIG_FILE}`);
  }
  process.env.L4D2_GAME_DIR = root;
  cachedInfo = { root, source: persist ? '.mapstitch.json' : 'CLI --game-dir' };
  return { ...cachedInfo };
}

export function clearGameRootCache() { cachedInfo = undefined; }
