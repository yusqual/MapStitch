// main.js — MapStitch 查看器：加载两张地图 .mst，按 landmark 偏移叠加显示。
// 坐标保持 Source 约定：X 东、Y 北、Z 上（three.js 里把 up 设为 +Z）。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const TINT = {
  A: new THREE.Color(0.86, 1.02, 1.30),
  B: new THREE.Color(1.32, 0.94, 0.60),
};

const PARAMS = new URLSearchParams(location.search);
const LAYER_LABEL = {
  world: '世界几何',
  disp: '地形位移面',
  sky: '天空盒',
  nodraw: 'nodraw',
  water: '水面',
  clip: 'clip 体积',
  detail: '门/实体',
  props: '静态道具',
};
// 特殊图层的额外透明度（最终 = 地图不透明度 x 此系数）
const LAYER_OPACITY = { clip: 0.5, water: 0.72, sky: 0.3, nodraw: 0.8, props: 0.6 };
// 透明图层默认不写深度，three.js 按“包围球中心的投影深度”排序；相机一转这个深度就变，
// 同一张图的各图层顺序会翻转（表现为 props/clip 时隐时现）。这里给每层固定绘制顺序。
const LAYER_DRAW_ORDER = {
  sky: 0, world: 10, disp: 11, detail: 20, nodraw: 30, water: 40, clip: 80, props: 90,
};
// 深度遮挡模式：用只写深度、不写颜色的影子网格，在世界颜色层之后、props 之前
// 把世界几何的深度写进深度缓冲（不动颜色层，A/B 互相透视不受影响）。
const DEPTH_OCCLUDER_LAYERS = new Set(['world', 'disp', 'detail', 'nodraw']);
const OCCLUDER_DRAW_ORDER = 70;

const view = document.getElementById('view');
const loadingEl = document.getElementById('loading');
const readoutEl = document.getElementById('readout');
const statsEl = document.getElementById('stats');
const pairSelect = document.getElementById('pairSelect');
const addonListEl = document.getElementById('addonList');
const addonOnlyMapsEl = document.getElementById('addonOnlyMaps');
const addonBuildBtn = document.getElementById('addonBuildBtn');
const addonRefreshBtn = document.getElementById('addonRefreshBtn');
const addonStatusEl = document.getElementById('addonStatus');
const addonLogEl = document.getElementById('addonLog');
const officialStatusEl = document.getElementById('officialStatus');
const officialBuildBtn = document.getElementById('officialBuildBtn');
const officialForceEl = document.getElementById('officialForce');
const officialLogEl = document.getElementById('officialLog');
const gameRootInput = document.getElementById('gameRootInput');
const gameRootSaveBtn = document.getElementById('gameRootSaveBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.fog = null;

const camera = new THREE.PerspectiveCamera(55, 1, 10, 200000);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
view.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
view.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
// 调试/自动化入口（CDP 测试或控制台里可读相机状态）
window.__mapstitch = { camera, controls };
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.98;
controls.screenSpacePanning = true;
// 左键：环绕旋转；中键：平移；右键：自由视角（由下方 lookBy 自己处理）
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = null;

scene.add(new THREE.HemisphereLight(0xcfe1ff, 0x4a4034, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(0.4, 0.7, 1.2);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9fb6d8, 0.9);
fill.position.set(-0.8, -0.6, 0.4);
scene.add(fill);

// 网格（XY 平面）
const grid = new THREE.GridHelper(32768, 128, 0x2a3040, 0x222834);
grid.rotation.x = Math.PI / 2;
grid.position.z = -1000;
scene.add(grid);

// 剖切：clipPlane 保留 Z ≤ constant；clipPlaneLow 保留 Z ≥ -constant
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 100000);
const clipPlaneLow = new THREE.Plane(new THREE.Vector3(0, 0, 1), 3000);

const state = {
  index: null,
  pair: null,
  A: null,
  B: null,
  offset: [0, 0, 0],
  yaw: 0,        // B 绕 landmark 的旋转角（度，绕 Z）
  shift: [0, 0, 0],
  pickMarker: null,
  layerVisible: new Map(),
  showSpawns: true,
  clipEnabled: false,
  clipLowEnabled: false,
  depthMode: PARAMS.get('depth') !== '0',
  fitted: false,
};
// 自动化测试/调试用（CDP 里读 state.depthMode 等）
window.__mapstitch.state = state;

// 绕 Z 轴旋转（与 Source 的 yaw 同向：逆时针为正）
function rotZ(v, degrees) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

// B 的默认平移：使 B 的 landmark 在旋转后落到 A 的 landmark 上。
// 显示坐标 = Rz(yaw) * pB + shift，代入 pB = lmB 得 shift = lmA - Rz(yaw) * lmB。
function defaultShift(pair, yaw) {
  if (pair && pair.landmarkA && pair.landmarkB) {
    const q = rotZ(pair.landmarkB, yaw);
    return [pair.landmarkA[0] - q[0], pair.landmarkA[1] - q[1], pair.landmarkA[2] - q[2]];
  }
  // 旧 index 没有 landmark 坐标：只有纯平移时才能还原
  const off = (pair && pair.offset) || [0, 0, 0];
  return yaw ? [0, 0, 0] : [-off[0], -off[1], -off[2]];
}

// ---------- 数据加载 ----------

async function fetchIndex() {
  const r = await fetch('/out/index.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`读取 index.json 失败 (${r.status})，先运行: node src/cli.js build --all`);
  return r.json();
}

function parseMst(buf, url) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MST1') throw new Error(`${url}: 不是 .mst 文件`);
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
  const base = 8 + headerLen;
  const layers = new Map();
  const group = new THREE.Group();
  let tris = 0;
  for (const L of header.layers) {
    const pos = new Float32Array(buf, base + L.posOffset, L.vertexCount * 3);
    const nrm = new Float32Array(buf, base + L.nrmOffset, L.vertexCount * 3);
    const col = new Uint8Array(buf, base + L.colOffset, L.vertexCount * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geom.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.layer = L.name;
    mesh.userData.vertexCount = L.vertexCount;
    group.add(mesh);
    layers.set(L.name, mesh);
    tris += L.vertexCount / 3;
  }
  return { header, group, layers, tris, url };
}

async function loadMap(relPath) {
  const url = '/out/' + relPath;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`读取 ${url} 失败 (${r.status})`);
  return parseMst(await r.arrayBuffer(), url);
}

// ---------- 场景装配 ----------

const groupA = new THREE.Group();
const groupB = new THREE.Group();
const markerGroup = new THREE.Group();
scene.add(groupA, groupB, markerGroup);

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
    // CSS2D 标签的 DOM 节点不会随父对象脱离场景自动消失，必须手动移除
    if (o.isCSS2DObject && o.element && o.element.parentNode) {
      o.element.parentNode.removeChild(o.element);
    }
  });
  g.clear();
}

// 释放一张已加载的地图（网格 + 标记 + 标签）
function disposeMap(m) {
  if (!m) return;
  disposeGroup(m.group);
  m.group.removeFromParent();
}

function clearPick() {
  if (state.pickMarker) {
    scene.remove(state.pickMarker);
    state.pickMarker.geometry.dispose();
    state.pickMarker.material.dispose();
    state.pickMarker = null;
  }
  readoutEl.classList.add('hidden');
}

async function setPair(pair) {
  state.pair = pair;
  state.offset = pair.offset || [0, 0, 0];
  loadingEl.textContent = `加载 ${pair.from} / ${pair.to} …`;
  loadingEl.classList.remove('hidden');

  disposeMap(state.A);
  disposeMap(state.B);
  disposeGroup(markerGroup);
  clearPick();
  state.A = state.B = null;
  state.fitted = false;

  try {
    const [a, b] = await Promise.all([
      loadMap(state.index.maps[pair.from].mst),
      loadMap(state.index.maps[pair.to].mst),
    ]);
    state.A = a;
    state.B = b;
    groupA.add(a.group);
    groupB.add(b.group);
    // 默认：按 pair 的 yaw 旋转 B，并平移使两图 landmark 重合（?yaw= 可临时覆盖）
    const yawParam = PARAMS.get('yaw');
    const yaw = yawParam !== null && Number.isFinite(Number(yawParam)) ? Number(yawParam) : (pair.yaw || 0);
    groupB.rotation.z = (yaw * Math.PI) / 180;
    state.yaw = yaw;
    const yawSelect = document.getElementById('yawSelect');
    if (yawSelect) yawSelect.value = String(yaw);
    setShift(defaultShift(pair, yaw), true);
    applyTint();
    applyDrawOrder('A');
    applyDrawOrder('B');
    buildDepthProxies('A');
    buildDepthProxies('B');
    buildLayerToggles();
    applyDepthMode();
    buildMarkers();
    setOpacity('A', Number(document.getElementById('opacityA').value));
    setOpacity('B', Number(document.getElementById('opacityB').value));
    applyClip();
    updatePairInfo();
    fitView();
    applyViewParams();
    loadingEl.classList.add('hidden');
  } catch (e) {
    loadingEl.textContent = `错误: ${e.message}`;
    console.error(e);
  }
}

function applyTint() {
  for (const key of ['A', 'B']) {
    const m = state[key];
    if (!m) continue;
    for (const mesh of m.layers.values()) {
      mesh.material.color.copy(TINT[key]);
      mesh.material.needsUpdate = true;
    }
  }
}

function setShift(v, silent) {
  state.shift = v.slice();
  groupB.position.set(v[0], v[1], v[2]);
  if (!silent) updateOffsetInputs();
  updatePairInfo();
}

function setOpacity(which, v) {
  const m = state[which];
  if (!m) return;
  for (const mesh of m.layers.values()) {
    const base = LAYER_OPACITY[mesh.userData.layer] ?? 1;
    mesh.material.opacity = v * base;
    mesh.material.depthWrite = mesh.material.opacity > 0.98;
    mesh.material.transparent = true;
  }
}

// 固定图层绘制顺序：同层内 B 永远画在 A 之后（×2 + side），
// clip / props 这类诊断层画在两张图的世界几何之后，避免随相机转动闪烁。
function applyDrawOrder(which) {
  const m = state[which];
  if (!m) return;
  const side = which === 'B' ? 1 : 0;
  for (const [name, mesh] of m.layers) {
    mesh.renderOrder = (LAYER_DRAW_ORDER[name] ?? 50) * 2 + side;
  }
}

function setWireframe(which, on) {
  const m = state[which];
  if (!m) return;
  for (const mesh of m.layers.values()) {
    mesh.material.wireframe = on;
    mesh.material.needsUpdate = true;
  }
}

// 每个遮挡层生成一个只写深度的影子网格（几何共享，不占额外显存）。
// 绘制顺序在颜色层之后、clip/props 之前，打开后才可见。
function buildDepthProxies(which) {
  const m = state[which];
  if (!m) return;
  const side = which === 'B' ? 1 : 0;
  m.depthProxies = [];
  for (const [name, mesh] of m.layers) {
    if (!DEPTH_OCCLUDER_LAYERS.has(name)) continue;
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      transparent: true,
    });
    const proxy = new THREE.Mesh(mesh.geometry, material);
    proxy.renderOrder = OCCLUDER_DRAW_ORDER * 2 + side;
    proxy.userData.source = mesh;
    proxy.visible = false;
    m.group.add(proxy);
    m.depthProxies.push(proxy);
  }
}

// 只有 props 层可见时才需要深度影子；clip 始终是覆盖层。
function depthActive() {
  return state.depthMode && state.layerVisible.get('props') !== false;
}

// 深度遮挡模式：props 被世界几何挡住；clip 仍保持盖在最上层（它本来就嵌在墙里）。
function applyDepthMode() {
  const on = state.depthMode;
  for (const key of ['A', 'B']) {
    const m = state[key];
    if (!m) continue;
    const clip = m.layers.get('clip');
    if (clip) {
      clip.material.depthTest = !on;
      clip.material.needsUpdate = true;
    }
    for (const proxy of m.depthProxies || []) {
      proxy.visible = depthActive() && proxy.userData.source.visible;
    }
  }
  const toggle = document.getElementById('propsDepth');
  if (toggle) toggle.checked = on;
}

function allLayerNames() {
  const names = [];
  for (const m of [state.A, state.B]) {
    if (!m) continue;
    for (const n of m.layers.keys()) if (!names.includes(n)) names.push(n);
  }
  // 固定顺序
  const order = ['world', 'disp', 'detail', 'props', 'clip', 'nodraw', 'water', 'sky'];
  names.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return names;
}

function buildLayerToggles() {
  const box = document.getElementById('layerToggles');
  box.innerHTML = '';
  const only = PARAMS.get('layers') ? PARAMS.get('layers').split(',') : null;
  const names = allLayerNames();
  for (const name of names) {
    if (only) {
      state.layerVisible.set(name, only.includes(name));
    } else if (!state.layerVisible.has(name)) {
      // 默认：nodraw/clip/sky/props 关闭；clip 与 props 需要时手动打开（密集地图会很花）
      state.layerVisible.set(name, !['nodraw', 'clip', 'sky', 'props'].includes(name));
    }
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" ${state.layerVisible.get(name) ? 'checked' : ''}/> ${LAYER_LABEL[name] || name}`;
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      state.layerVisible.set(name, input.checked);
      applyLayerVisibility();
    });
    box.appendChild(label);
  }
  applyLayerVisibility();
}

function applyLayerVisibility() {
  for (const key of ['A', 'B']) {
    const m = state[key];
    if (!m) continue;
    for (const [name, mesh] of m.layers) {
      mesh.visible = state.layerVisible.get(name) !== false;
    }
    // 隐藏某个遮挡层时，它的深度影子也要一起隐藏
    for (const proxy of m.depthProxies || []) {
      proxy.visible = depthActive() && proxy.userData.source.visible;
    }
  }
}

// ---------- 标记 ----------

function markerDot(color, radius = 28) {
  const g = new THREE.SphereGeometry(radius, 12, 8);
  const m = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const mesh = new THREE.Mesh(g, m);
  // 必须画在 props（90/91）与 clip（80/81）之后
  mesh.renderOrder = 200;
  return mesh;
}

function makeLabel(text, cls) {
  const div = document.createElement('div');
  div.className = `marker-label ${cls || ''}`;
  div.textContent = text;
  return new CSS2DObject(div);
}

function buildMarkers() {
  disposeGroup(markerGroup);
  if (!state.A || !state.B) return;
  const pair = state.pair;

  // 两图的 landmark：对齐后应重合
  for (const key of ['A', 'B']) {
    const m = state[key];
    const lm = m.header.markers?.landmarks || [];
    for (const l of lm) {
      const highlight = l.name === pair.landmark;
      const dot = markerDot(highlight ? 0xffe066 : 0x7788aa, highlight ? 34 : 18);
      dot.position.fromArray(l.origin);
      dot.userData.marker = true;
      m.group.add(dot);
      if (highlight) {
        const label = makeLabel(`${key === 'A' ? 'A' : 'B'} · ${l.name}`, key === 'B' ? 'b' : '');
        label.position.copy(dot.position).add(new THREE.Vector3(0, 0, 60));
        label.userData.marker = true;
        m.group.add(label);
      }
    }
    // 出生点
    const spawns = m.header.markers?.spawns || [];
    for (const s of spawns) {
      const dot = markerDot(s.classname.includes('start') ? 0x6cf08a : 0x5fa8ff, 14);
      dot.position.fromArray(s.origin);
      dot.userData.marker = true;
      m.group.add(dot);
    }
    // changelevel 触发点
    for (const c of m.header.markers?.changelevels || []) {
      if (!c.origin) continue;
      const dot = markerDot(0xff6bd6, 12);
      dot.position.fromArray(c.origin);
      dot.userData.marker = true;
      m.group.add(dot);
    }
  }

  const showSpawns = document.getElementById('showSpawns');
  const applyMarkerVis = () => {
    for (const key of ['A', 'B']) {
      const m = state[key];
      if (!m) continue;
      m.group.traverse((o) => {
        if (o.userData.marker) o.visible = showSpawns.checked;
      });
    }
  };
  showSpawns.onchange = applyMarkerVis;
  applyMarkerVis();
}

// ---------- UI ----------

function fmt(v) {
  return `${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}`;
}

function updatePairInfo() {
  const p = state.pair;
  if (!p) return;
  document.getElementById('nameA').textContent = p.from;
  document.getElementById('nameB').textContent = p.to;
  const info = document.getElementById('pairInfo');
  if (p.error) {
    info.innerHTML = `<b>偏移计算失败</b>\n${p.error}`;
  } else {
    const auto = p.yaw ? `  <span class="dim">（landmark 自动识别 ${p.yaw}°）</span>` : '';
    info.innerHTML =
      `landmark: <b>${p.landmark}</b>` +
      (p.note ? `\n<span class="dim">${p.note}</span>` : '') +
      `\n旋转: <b>${state.yaw}°</b>${state.yaw === (p.yaw || 0) ? auto : ''}` +
      `\n偏移 B-A: <b>${fmt(p.offset)}</b>`;
  }
  document.getElementById('offsetInfo').innerHTML = state.yaw
    ? `B 旋转 <b>${state.yaw}°</b>，平移 <b>${fmt(state.shift)}</b>\n` +
      `A 坐标 = lmA + Rz(${state.yaw}°) · (B 坐标 - lmB)`
    : `B 平移: <b>${fmt(state.shift)}</b>\n` +
      `对齐后 A 坐标 = B 坐标 - 偏移`;
  updateOffsetInputs();
}

function updateOffsetInputs() {
  document.getElementById('shiftX').value = state.shift[0].toFixed(1);
  document.getElementById('shiftY').value = state.shift[1].toFixed(1);
  document.getElementById('shiftZ').value = state.shift[2].toFixed(1);
}

const btnAlign = document.getElementById('alignBtn');
const btnZero = document.getElementById('zeroBtn');
btnAlign.onclick = () => setShift(defaultShift(state.pair, state.yaw), true);
btnZero.onclick = () => setShift([0, 0, 0], true);

// 手动旋转（0/90/180/270）。切换时按 landmark 重新对齐。
document.getElementById('yawSelect').addEventListener('change', (e) => {
  const yaw = Number(e.target.value) || 0;
  state.yaw = yaw;
  groupB.rotation.z = (yaw * Math.PI) / 180;
  setShift(defaultShift(state.pair, yaw), true);
  updatePairInfo();
});

for (const id of ['shiftX', 'shiftY', 'shiftZ']) {
  document.getElementById(id).addEventListener('change', () => {
    setShift([
      Number(document.getElementById('shiftX').value) || 0,
      Number(document.getElementById('shiftY').value) || 0,
      Number(document.getElementById('shiftZ').value) || 0,
    ], true);
  });
}

document.getElementById('opacityA').addEventListener('input', (e) => setOpacity('A', Number(e.target.value)));
document.getElementById('opacityB').addEventListener('input', (e) => setOpacity('B', Number(e.target.value)));
document.getElementById('wireA').addEventListener('change', (e) => setWireframe('A', e.target.checked));
document.getElementById('wireB').addEventListener('change', (e) => setWireframe('B', e.target.checked));
document.getElementById('propsDepth').addEventListener('change', (e) => {
  state.depthMode = e.target.checked;
  applyDepthMode();
});

// 剖切
const clipEnabled = document.getElementById('clipEnabled');
const clipZ = document.getElementById('clipZ');
const clipLowEnabled = document.getElementById('clipLowEnabled');
const clipZLow = document.getElementById('clipZLow');
clipPlane.constant = Number(clipZ.value);
clipPlaneLow.constant = -Number(clipZLow.value);

function applyClip() {
  const planes = [];
  if (state.clipEnabled) planes.push(clipPlane);
  if (state.clipLowEnabled) planes.push(clipPlaneLow);
  for (const key of ['A', 'B']) {
    const m = state[key];
    if (!m) continue;
    for (const mesh of m.layers.values()) {
      mesh.material.clippingPlanes = planes;
      mesh.material.needsUpdate = true;
    }
    // 深度影子也要参与剖切，否则切口以上的几何仍会挡住 props
    for (const proxy of m.depthProxies || []) {
      proxy.material.clippingPlanes = planes;
      proxy.material.needsUpdate = true;
    }
  }
}

clipEnabled.addEventListener('change', () => {
  state.clipEnabled = clipEnabled.checked;
  applyClip();
  updateClipInfo();
});
clipZ.addEventListener('input', () => {
  clipPlane.constant = Number(clipZ.value);
  updateClipInfo();
});
// 下界：保留 Z ≥ 阈值，与上界可同时使用
clipLowEnabled.addEventListener('change', () => {
  state.clipLowEnabled = clipLowEnabled.checked;
  applyClip();
  updateClipInfo();
});
clipZLow.addEventListener('input', () => {
  clipPlaneLow.constant = -Number(clipZLow.value);
  updateClipInfo();
});
function updateClipInfo() {
  const parts = [];
  if (state.clipEnabled) parts.push(`Z ≤ ${Number(clipZ.value).toFixed(0)}`);
  if (state.clipLowEnabled) parts.push(`Z ≥ ${Number(clipZLow.value).toFixed(0)}`);
  document.getElementById('clipInfo').textContent = parts.length
    ? `只显示 ${parts.join(' 且 ')} 的部分`
    : '未启用';
}

// ---------- 视角 ----------

function combinedBounds() {
  const box = new THREE.Box3();
  const localBox = (mins, maxs) => new THREE.Box3(
    new THREE.Vector3(mins[0], mins[1], mins[2]),
    new THREE.Vector3(maxs[0], maxs[1], maxs[2]),
  );
  if (state.A) box.union(localBox(state.A.header.bounds.mins, state.A.header.bounds.maxs));
  if (state.B) {
    // B 先绕 Z 旋转再平移（与 groupB 的变换一致）
    const b = localBox(state.B.header.bounds.mins, state.B.header.bounds.maxs);
    const m = new THREE.Matrix4()
      .makeRotationZ((state.yaw * Math.PI) / 180)
      .setPosition(state.shift[0], state.shift[1], state.shift[2]);
    b.applyMatrix4(m);
    box.union(b);
  }
  return box;
}

function fitView() {
  const box = combinedBounds();
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 4096;
  const dist = maxDim * 1.15;
  camera.position.set(center.x - dist * 0.55, center.y - dist * 0.85, center.z + dist * 0.62);
  controls.target.copy(center);
  camera.near = Math.max(1, maxDim / 2000);
  camera.far = maxDim * 30;
  camera.updateProjectionMatrix();
  controls.update();
  // 剖切滑块范围
  clipZ.min = Math.floor(box.min.z - 128);
  clipZ.max = Math.ceil(box.max.z + 128);
  clipZLow.min = clipZ.min;
  clipZLow.max = clipZ.max;
  if (!state.clipEnabled) clipZ.value = clipZ.max;
  if (!state.clipLowEnabled) clipZLow.value = clipZLow.min;
  clipPlane.constant = Number(clipZ.value);
  clipPlaneLow.constant = -Number(clipZLow.value);
  updateClipInfo();
  // 网格高度
  grid.position.z = Math.floor(box.min.z / 64) * 64 - 8;
  state.fitted = true;
}

// URL 参数：view=top（俯视）、cam=x,y,z、target=x,y,z（方便脚本截图）
function applyViewParams() {
  const view = PARAMS.get('view');
  const targetParam = PARAMS.get('target');
  const camParam = PARAMS.get('cam');
  if (view === 'top') {
    const box = combinedBounds();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(size.x, size.y) * 1.15;
    // 不要改 camera.up（OrbitControls 在构造时已缓存 up 的四元数）；
    // 给一个极小的 Y 偏移避开正上方 lookAt 的奇异点，视觉上仍是俯视。
    camera.position.set(c.x, c.y - h * 0.002, c.z + h);
    controls.target.copy(c);
    controls.update();
  }
  if (targetParam) {
    const t = targetParam.split(',').map(Number);
    if (t.length === 3) controls.target.set(t[0], t[1], t[2]);
  }
  if (camParam) {
    const c = camParam.split(',').map(Number);
    if (c.length === 3) camera.position.set(c[0], c[1], c[2]);
  }
  controls.update();
  const pick = PARAMS.get('pick');
  if (pick) {
    const a = pick.split(',').map(Number);
    if (a.length === 3 && a.every(Number.isFinite)) {
      const p = new THREE.Vector3(a[0], a[1], a[2]);
      placePickMarker(p);
      showReadout(p, '坐标定位');
    }
  }
}

// ---------- 拾取 ----------

// ---------- 键盘移动（WASD 平移 / QE 升降 / Shift 加速 / Ctrl 减速） ----------
const pressed = new Set();
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

// 飞行速度滑块（记住上次设置）
const flySpeedEl = document.getElementById('flySpeed');
let flySpeed = 0.35;
try {
  const raw = localStorage.getItem('mapstitch.flySpeed');
  const saved = raw === null ? NaN : Number(raw);
  if (Number.isFinite(saved) && saved >= 0.05 && saved <= 2) flySpeed = saved;
} catch { /* localStorage 不可用 */ }
flySpeedEl.value = String(flySpeed);

function updateFlyInfo() {
  document.getElementById('flyInfo').textContent =
    `×${flySpeed.toFixed(2)}　Shift 加速 ×2.5 · Ctrl 减速 ×0.4`;
}
flySpeedEl.addEventListener('input', () => {
  flySpeed = Number(flySpeedEl.value);
  try { localStorage.setItem('mapstitch.flySpeed', String(flySpeed)); } catch { /* ignore */ }
  updateFlyInfo();
});
updateFlyInfo();

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  // 滑块/复选框获得焦点时仍允许 WASD（它们不会接收文字输入）
  if (el.tagName === 'INPUT') return el.type !== 'range' && el.type !== 'checkbox';
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) {
    pressed.add(k);
    e.preventDefault();
  }
  if (e.key === 'Shift') pressed.add('shift');
  if (e.key === 'Control') pressed.add('control');
  if (k === 'f') fitView();
});
window.addEventListener('keyup', (e) => {
  pressed.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => pressed.clear());

// 每帧沿相机朝向平移（同时移动 camera 与 target，保持观察角度）
function moveCamera(dt) {
  if (pressed.size === 0) return;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.z = 0; // 只在水平面内前后移动，避免低头时钻地
  if (forward.lengthSq() < 1e-8) {
    forward.copy(controls.target).sub(camera.position);
    forward.z = 0;
  }
  if (forward.lengthSq() < 1e-8) forward.set(0, 1, 0);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1)).normalize();

  const move = new THREE.Vector3();
  if (pressed.has('w')) move.add(forward);
  if (pressed.has('s')) move.sub(forward);
  if (pressed.has('d')) move.add(right);
  if (pressed.has('a')) move.sub(right);
  if (pressed.has('e')) move.z += 1;
  if (pressed.has('q')) move.z -= 1;
  if (move.lengthSq() === 0) return;

  // 速度随观察距离缩放；滑块给基础倍率，Shift 加速、Ctrl 减速
  const dist = camera.position.distanceTo(controls.target);
  let mult = flySpeed;
  if (pressed.has('shift')) mult *= 2.5;
  if (pressed.has('control')) mult *= 0.4;
  const speed = Math.max(32, dist * 0.5) * mult;
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  controls.target.add(move);
}
window.__mapstitch.moveCamera = moveCamera;

// ---------- 右键自由视角（第一人称式转头，不改相机位置） ----------
// 左键仍是 OrbitControls 的环绕；右键只旋转摄像机朝向，并把 controls.target
// 沿新朝向放到原距离上，保证之后左键环绕/中键平移仍然正常。
const LOOK_SENSITIVITY = 0.0028;
let lookDrag = null;

function lookBy(dx, dy) {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  let yaw = Math.atan2(dir.y, dir.x);
  let pitch = Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1));
  // 鼠标右移 = 右转，下移 = 低头
  yaw -= dx * LOOK_SENSITIVITY;
  pitch = THREE.MathUtils.clamp(
    pitch - dy * LOOK_SENSITIVITY,
    -Math.PI / 2 + 0.02,
    Math.PI / 2 - 0.02,
  );
  const forward = new THREE.Vector3(
    Math.cos(pitch) * Math.cos(yaw),
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
  );
  const dist = Math.max(1, camera.position.distanceTo(controls.target));
  controls.target.copy(camera.position).addScaledVector(forward, dist);
  camera.lookAt(controls.target);
  controls.update();
}
window.__mapstitch.lookBy = lookBy;

const viewEl = renderer.domElement;
viewEl.addEventListener('contextmenu', (e) => e.preventDefault());
viewEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // 阻止中键自动滚动

viewEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  e.preventDefault();
  lookDrag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  try { viewEl.setPointerCapture(e.pointerId); } catch { /* 合成事件可能不支持捕获 */ }
});
viewEl.addEventListener('pointermove', (e) => {
  if (!lookDrag || e.pointerId !== lookDrag.pointerId) return;
  const dx = e.clientX - lookDrag.x;
  const dy = e.clientY - lookDrag.y;
  lookDrag.x = e.clientX;
  lookDrag.y = e.clientY;
  if (dx || dy) lookBy(dx, dy);
});
const endLook = (e) => {
  if (!lookDrag || e.pointerId !== lookDrag.pointerId) return;
  lookDrag = null;
  try { viewEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
};
viewEl.addEventListener('pointerup', endLook);
viewEl.addEventListener('pointercancel', endLook);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  if (moved > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = [];
  for (const key of ['A', 'B']) {
    const m = state[key];
    if (!m) continue;
    for (const mesh of m.layers.values()) if (mesh.visible) targets.push(mesh);
  }
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return;
  const p = hits[0].point.clone();
  placePickMarker(p);
  showReadout(p, hits[0].object.userData.layer);
});

function placePickMarker(p) {
  if (state.pickMarker) {
    scene.remove(state.pickMarker);
    state.pickMarker.geometry.dispose();
    state.pickMarker.material.dispose();
  }
  const mk = markerDot(0xfff1a8, 16);
  mk.position.copy(p);
  state.pickMarker = mk;
  scene.add(mk);
}

document.getElementById('locBtn').addEventListener('click', () => {
  const get = (id) => Number(document.getElementById(id).value) || 0;
  const p = new THREE.Vector3(get('locX'), get('locY'), get('locZ'));
  placePickMarker(p);
  showReadout(p, '坐标定位');
});

async function showReadout(p, layer) {
  // 反变换：显示坐标 = Rz(yaw) * B坐标 + 平移  =>  B坐标 = Rz(-yaw) * (显示坐标 - 平移)
  const d = [p.x - state.shift[0], p.y - state.shift[1], p.z - state.shift[2]];
  const q = rotZ(d, -state.yaw);
  const bLocal = new THREE.Vector3(q[0], q[1], q[2]);
  const base = [
    `<span class="dim">图层:</span> ${LAYER_LABEL[layer] || layer}`,
    `<span class="a">A 坐标:</span> ${fmt([p.x, p.y, p.z])}`,
    `<span class="b">B 坐标:</span> ${fmt([bLocal.x, bLocal.y, bLocal.z])}`,
    state.yaw
      ? `<span class="dim">B 坐标 = lmB + Rz(-${state.yaw}°) · (A 坐标 - lmA)</span>`
      : `<span class="dim">B 落点 = A 坐标 + 偏移</span>`,
  ].join('\n');
  readoutEl.classList.remove('hidden');
  readoutEl.innerHTML = base;

  // 向本地服务查询 B 点落在什么体积里（clip = 可卡墙）
  if (!state.pair) return;
  try {
    const qs = new URLSearchParams({
      map: state.pair.to,
      x: bLocal.x, y: bLocal.y, z: bLocal.z,
    });
    const r = await fetch(`/api/point?${qs}`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.error) return;
    const clip = d.hits.find((h) => h.kind === 'clip');
    const solid = d.hits.find((h) => h.kind === 'solid');
    let line, color;
    if (clip) {
      line = `<b style="color:#ffd23f">在 clip 体积内</b> <span class="dim">#${clip.brush}，距面 ${clip.depth}</span>`;
      color = 0xffd23f;
    } else if (solid) {
      line = `<b style="color:#ff8a7a">在实体几何内</b> <span class="dim">#${solid.brush}，距面 ${solid.depth}</span>`;
      color = 0xff8a7a;
    } else {
      line = `<b style="color:#6cf08a">开阔空间</b>`;
      color = 0x6cf08a;
    }
    // prop_static 包围盒（车辆的 MDL hull 常远大于可见模型，仅供参考）
    const props = Array.isArray(d.props) ? d.props : [];
    const prop = props.find((h) => h.solid) || props[0];
    const propLine = prop
      ? `\n<span class="dim">prop 包围盒:</span> <b style="color:#7ee2a8">在 ${String(prop.model).split('/').pop().replace(/[<>&]/g, '')} 内</b> <span class="dim">${prop.solid ? '' : '非实体，'}距面 ${prop.depth}</span>`
      : '';
    readoutEl.innerHTML = `${base}\n<span class="dim">B 落点判定:</span> ${line}${propLine}`;
    if (state.pickMarker) state.pickMarker.material.color.setHex(color);
  } catch {
    // 静态服务器未开 / 地图不在 maps 目录时忽略
  }
}

// ---------- 左侧面板宽度（拖动分隔条） ----------

const panelEl = document.getElementById('panel');
const dividerEl = document.getElementById('divider');
const PANEL_MIN = 260;
const PANEL_DEFAULT = 380;
const PANEL_MAX = 760;
const PANEL_STORAGE = 'mapstitch.panelWidth';

function panelMaxWidth() {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - 280));
}

function applyPanelWidth(width, persist = false) {
  const w = Math.round(Math.max(PANEL_MIN, Math.min(panelMaxWidth(), Number(width) || PANEL_DEFAULT)));
  document.documentElement.style.setProperty('--panel-w', `${w}px`);
  if (persist) {
    try { localStorage.setItem(PANEL_STORAGE, String(w)); } catch { /* ignore */ }
  }
  return w;
}

try {
  const saved = Number(localStorage.getItem(PANEL_STORAGE));
  if (Number.isFinite(saved) && saved > 0) applyPanelWidth(saved);
} catch { /* ignore */ }

let panelDrag = null;
dividerEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  panelDrag = { startX: e.clientX, startW: panelEl.getBoundingClientRect().width };
  dividerEl.classList.add('dragging');
  document.body.classList.add('resizing');
  dividerEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});
dividerEl.addEventListener('pointermove', (e) => {
  if (!panelDrag) return;
  applyPanelWidth(panelDrag.startW + e.clientX - panelDrag.startX);
  resize();
});
const endPanelDrag = (e) => {
  if (!panelDrag) return;
  panelDrag = null;
  dividerEl.classList.remove('dragging');
  document.body.classList.remove('resizing');
  if (dividerEl.hasPointerCapture(e.pointerId)) dividerEl.releasePointerCapture(e.pointerId);
  applyPanelWidth(panelEl.getBoundingClientRect().width, true);
};
dividerEl.addEventListener('pointerup', endPanelDrag);
dividerEl.addEventListener('pointercancel', endPanelDrag);
dividerEl.addEventListener('dblclick', () => { applyPanelWidth(PANEL_DEFAULT, true); resize(); });
dividerEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const delta = e.key === 'ArrowLeft' ? -20 : 20;
  applyPanelWidth(panelEl.getBoundingClientRect().width + delta, true);
  resize();
});
window.addEventListener('resize', () => {
  applyPanelWidth(panelEl.getBoundingClientRect().width);
  resize();
});

// ---------- 主循环 ----------

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}

let last = performance.now();
let lastFrame = performance.now();
function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  moveCamera(dt);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  if (t - last > 250) {
    last = t;
    const info = renderer.info.render;
    const pair = state.pair;
    statsEl.textContent = pair
      ? `${pair.from} + ${pair.to}   ${(info.triangles / 1000).toFixed(0)}k 三角形（当前视图）`
      : '';
  }
}
resize();
requestAnimationFrame(animate);

// ---------- 官方地图 / 游戏目录 ----------

const officialUI = { building: false, gameRoot: '', index: null };

function setOfficialBusy(busy) {
  officialUI.building = busy;
  officialBuildBtn.disabled = busy || !officialUI.gameRoot;
  gameRootSaveBtn.disabled = busy;
  officialForceEl.disabled = busy;
  gameRootInput.disabled = busy;
}

function renderOfficial(game, index) {
  if (game) officialUI.gameRoot = game.root || '';
  if (index) officialUI.index = index;
  if (document.activeElement !== gameRootInput) gameRootInput.value = officialUI.gameRoot;
  const idx = officialUI.index || {};
  const lines = [];
  if (!officialUI.gameRoot) {
    lines.push('未检测到 L4D2 游戏目录。请填写路径并点“保存路径”，或设置 L4D2_GAME_DIR。');
  } else {
    lines.push(`游戏目录：${officialUI.gameRoot}`);
    if (game?.source) lines.push(`来源：${game.source}`);
    if (idx.officialMaps) {
      lines.push(`已解析 ${idx.officialMaps} 张官方地图 · ${idx.officialPairs || 0} 个官方章节对${idx.addonsTotal ? `（index 共 ${idx.pairsTotal} 对，另有 ${idx.addonsTotal} 个 addon）` : ''}`);
    } else {
      lines.push('尚未解析官方地图；点击“解析官方地图”后才会读取。');
    }
  }
  officialStatusEl.textContent = lines.join('\n');
  setOfficialBusy(officialUI.building);
}

async function saveGameDir() {
  const value = gameRootInput.value.trim();
  if (!value) { officialStatusEl.textContent = '请先填写游戏目录'; return; }
  setOfficialBusy(true);
  officialStatusEl.textContent = '保存路径…';
  try {
    const r = await fetch('/api/game-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameRoot: value }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderOfficial(data.game, data.index);
    await loadAddons();
    officialStatusEl.textContent = `已保存游戏目录：${data.game.root}\n来源：${data.game.source}\n点击“解析官方地图”才会开始解析。`;
  } catch (e) {
    officialStatusEl.textContent = `保存失败: ${e.message}`;
  } finally {
    setOfficialBusy(false);
  }
}

async function refreshIndexAfterBuild({ newPairs = [], campaigns = [], preferOfficial = false } = {}) {
  try { state.index = await fetchIndex(); } catch { state.index = { maps: {}, pairs: [], addons: [] }; }
  fillPairSelect();
  const pairs = state.index.pairs.filter((p) => !p.error);
  if (!pairs.length) {
    loadingEl.textContent = Object.keys(state.index.maps || {}).length
      ? '已解析地图，但没有可显示的相邻章节对（缺少共享 landmark）'
      : '尚未解析地图：可在左侧点击「解析官方地图」或选择附加地图';
    loadingEl.classList.remove('hidden');
    return null;
  }
  loadingEl.classList.add('hidden');
  const newKeys = new Set(newPairs.map((p) => `${p.from}|${p.to}`));
  const camps = new Set(campaigns.map((c) => c.id));
  let target = preferOfficial
    ? (pairs.find((p) => !p.addon && p.campaign === 'c1') || pairs.find((p) => !p.addon))
    : (pairs.find((p) => newKeys.has(`${p.from}|${p.to}`)) || pairs.find((p) => camps.has(p.campaign)));
  target = target || pairs[0];
  await setPair(target);
  pairSelect.value = `${target.from}|${target.to}`;
  return target;
}

async function pollOfficialJob(id) {
  try {
    const r = await fetch(`/api/job/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    officialLogEl.textContent = j.log || '';
    officialLogEl.scrollTop = officialLogEl.scrollHeight;
    if (j.status === 'running') {
      officialStatusEl.textContent = `解析官方地图… ${(j.elapsedMs / 1000).toFixed(1)}s`;
      setTimeout(() => pollOfficialJob(id), 600);
      return;
    }
    setOfficialBusy(false);
    if (j.status === 'error') {
      officialStatusEl.textContent = `解析失败: ${j.error || '未知错误'}`;
      return;
    }
    const msg = `完成：已解析 ${j.result?.officialMaps || 0} 张官方地图 · ${j.result?.officialPairs || 0} 个官方章节对`;
    await refreshIndexAfterBuild({ preferOfficial: true });
    await loadAddons();
    setOfficialBusy(false);
    officialStatusEl.textContent = `${msg}\n游戏目录：${gameRootInput.value}`;
  } catch (e) {
    setOfficialBusy(false);
    officialStatusEl.textContent = `任务状态读取失败: ${e.message}`;
  }
}

async function startOfficialBuild() {
  if (officialUI.building || !officialUI.gameRoot) return;
  setOfficialBusy(true);
  officialLogEl.classList.remove('hidden');
  officialLogEl.textContent = '';
  officialStatusEl.textContent = '提交解析任务…';
  try {
    const r = await fetch('/api/build/official', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: officialForceEl.checked }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    pollOfficialJob(data.id);
  } catch (e) {
    setOfficialBusy(false);
    officialStatusEl.textContent = `解析失败: ${e.message}`;
  }
}

officialBuildBtn.addEventListener('click', startOfficialBuild);
gameRootSaveBtn.addEventListener('click', saveGameDir);
gameRootInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveGameDir(); }
});

// ---------- 附加地图 / VPK 选择 ----------

const addonUI = { list: [], selected: new Set(), building: false };
window.__mapstitch.addons = addonUI;

function addonMetaText(a) {
  if (a.error) return '读取失败';
  if (!a.maps) return '无地图';
  const coop = a.campaigns.map((c) => c.chapters.length).join('+');
  return `${a.maps} 图${coop ? ` · ${coop} 章` : ''}${a.built ? ' · 已载入' : ''}`;
}

function updateAddonButtons() {
  const n = addonUI.selected.size;
  addonBuildBtn.disabled = addonUI.building || n === 0;
  if (!addonUI.building && addonStatusEl.dataset.busy !== '1') {
    addonStatusEl.textContent = n ? `已选 ${n} 个 addon` : '';
  }
}

function renderAddons() {
  addonListEl.innerHTML = '';
  const onlyMaps = addonOnlyMapsEl.checked;
  const items = addonUI.list.filter((a) => !onlyMaps || a.maps > 0 || a.error);
  if (!items.length) {
    const span = document.createElement('span');
    span.className = 'info';
    span.textContent = onlyMaps ? '没有检测到含地图的 addon' : '没有 addon';
    addonListEl.appendChild(span);
    updateAddonButtons();
    return;
  }
  for (const a of items) {
    const label = document.createElement('label');
    const detail = a.campaigns.map((c) => `${c.id}: ${c.chapters.join(' → ')}`).join('\n');
    label.title = `${a.source}\n${detail || '(无 missions)'}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = addonUI.selected.has(a.source);
    cb.disabled = !a.maps || Boolean(a.error) || addonUI.building;
    cb.addEventListener('change', () => {
      if (cb.checked) addonUI.selected.add(a.source);
      else addonUI.selected.delete(a.source);
      updateAddonButtons();
    });
    const name = document.createElement('span');
    name.className = 'addon-name';
    name.textContent = a.kind === 'vpk' ? a.name : `${a.name}（目录）`;
    const meta = document.createElement('span');
    meta.className = `addon-meta${a.error ? ' err' : a.built ? ' built' : ''}`;
    meta.textContent = addonMetaText(a);
    label.append(cb, name, meta);
    addonListEl.appendChild(label);
  }
  updateAddonButtons();
}

async function loadAddons() {
  addonStatusEl.dataset.busy = '1';
  addonStatusEl.textContent = '扫描 addons…';
  addonListEl.innerHTML = '<span class="info">读取 VPK 目录树…</span>';
  try {
    const r = await fetch('/api/addons', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    addonUI.list = data.addons || [];
    renderOfficial(data.game, data.index);
    const sources = new Set(addonUI.list.map((a) => a.source));
    for (const s of [...addonUI.selected]) if (!sources.has(s)) addonUI.selected.delete(s);
    renderAddons();
    const mapCount = addonUI.list.filter((a) => a.maps > 0).length;
    addonStatusEl.textContent = addonUI.selected.size
      ? `已选 ${addonUI.selected.size} 个 addon`
      : `发现 ${mapCount} 个含地图的 addon`;
  } catch (e) {
    addonListEl.innerHTML = '';
    addonStatusEl.textContent = `附加地图列表读取失败: ${e.message}`;
    if (!officialUI.gameRoot) officialStatusEl.textContent = `状态读取失败: ${e.message}`;
  } finally {
    addonStatusEl.dataset.busy = '';
  }
}

async function refreshAfterAddonBuild(result) {
  return refreshIndexAfterBuild({
    newPairs: result?.newPairs || [],
    campaigns: result?.campaigns || [],
  });
}

async function pollAddonJob(id) {
  try {
    const r = await fetch(`/api/job/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    addonLogEl.textContent = j.log || '';
    addonLogEl.scrollTop = addonLogEl.scrollHeight;
    if (j.status === 'running') {
      addonStatusEl.textContent = `解析中… ${(j.elapsedMs / 1000).toFixed(1)}s`;
      setTimeout(() => pollAddonJob(id), 600);
      return;
    }
    addonUI.building = false;
    if (j.status === 'error') {
      addonStatusEl.dataset.busy = '';
      updateAddonButtons();
      addonStatusEl.textContent = `解析失败: ${j.error || '未知错误'}`;
      return;
    }
    const names = (j.result?.addons || []).map((a) => a.name).join(' + ') || 'addon';
    const usable = j.result?.usableCount ?? (j.result?.newPairs || []).filter((p) => !p.error).length;
    const failed = j.result?.failedCount ?? 0;
    const msg = `完成：${names}，新增 ${usable} 个可用章节对${failed ? `（${failed} 个偏移失败）` : ''}`;
    await refreshAfterAddonBuild(j.result);
    await loadAddons();
    addonStatusEl.dataset.busy = '';
    updateAddonButtons();
    addonStatusEl.textContent = msg;
  } catch (e) {
    addonUI.building = false;
    addonStatusEl.dataset.busy = '';
    updateAddonButtons();
    addonStatusEl.textContent = `任务状态读取失败: ${e.message}`;
  }
}

async function startAddonBuild() {
  if (!addonUI.selected.size || addonUI.building) return;
  addonUI.building = true;
  addonStatusEl.dataset.busy = '1';
  addonLogEl.classList.remove('hidden');
  addonLogEl.textContent = '';
  updateAddonButtons();
  renderAddons();
  addonStatusEl.textContent = '提交解析任务…';
  const specs = [...addonUI.selected];
  try {
    const r = await fetch('/api/addon/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    pollAddonJob(data.id);
  } catch (e) {
    addonUI.building = false;
    addonStatusEl.dataset.busy = '';
    updateAddonButtons();
    addonStatusEl.textContent = `解析失败: ${e.message}`;
  }
}

addonOnlyMapsEl.addEventListener('change', renderAddons);
addonRefreshBtn.addEventListener('click', loadAddons);
addonBuildBtn.addEventListener('click', startAddonBuild);

// ---------- 启动 ----------

function fillPairSelect() {
  pairSelect.innerHTML = '';
  const allPairs = (state.index && state.index.pairs) || [];
  if (!allPairs.length) {
    const opt = document.createElement('option');
    opt.textContent = '（尚无章节对）';
    pairSelect.appendChild(opt);
    pairSelect.disabled = true;
    return;
  }
  pairSelect.disabled = false;
  const groups = new Map();
  for (const p of allPairs) {
    if (!groups.has(p.campaign)) groups.set(p.campaign, []);
    groups.get(p.campaign).push(p);
  }
  for (const [camp, pairs] of groups) {
    const og = document.createElement('optgroup');
    const first = pairs[0];
    const addonMeta = (state.index.addons || [])
      .find((a) => (a.campaigns || []).some((c) => c.id === camp));
    const addonName = addonMeta?.name || first.addonName;
    og.label = addonName
      ? `附加地图 ${addonName} · ${camp}`
      : `战役 ${camp}`;
    for (const p of pairs) {
      const opt = document.createElement('option');
      opt.value = `${p.from}|${p.to}`;
      opt.textContent = `${p.from}  →  ${p.to}${p.yaw ? `  (旋转 ${p.yaw}°)` : ''}${p.error ? '  (偏移失败)' : ''}`;
      og.appendChild(opt);
    }
    pairSelect.appendChild(og);
  }
  pairSelect.onchange = () => {
    const [from, to] = pairSelect.value.split('|');
    const p = state.index.pairs.find((x) => x.from === from && x.to === to);
    if (p) setPair(p);
  };
}

(async () => {
  try {
    try {
      state.index = await fetchIndex();
    } catch {
      // 还没解析过任何地图时 index.json 不存在，这是正常状态
      state.index = { maps: {}, pairs: [], addons: [] };
    }
    fillPairSelect();
    const pairs = state.index.pairs.filter((p) => !p.error);
    if (!pairs.length) {
      loadingEl.textContent = Object.keys(state.index.maps || {}).length
        ? '已解析地图，但没有可显示的相邻章节对（缺少共享 landmark）'
        : '尚未解析地图：在左侧点击「解析官方地图」，或勾选附加地图 addon';
      loadingEl.classList.remove('hidden');
      return;
    }
    // 默认选第一对；可用 ?pair=c1m1_hotel|c1m2_streets 指定
    const wanted = PARAMS.get('pair');
    // 默认优先官方战役；addon 章节仍可从下拉框或 ?pair= 选择
    const chosen = (wanted && state.index.pairs.find((p) => `${p.from}|${p.to}` === wanted))
      || pairs.find((p) => !p.addon) || pairs[0];
    await setPair(chosen);
    pairSelect.value = `${chosen.from}|${chosen.to}`;
  } catch (e) {
    loadingEl.textContent = `错误: ${e.message}`;
    console.error(e);
  }
})();

// 附加地图列表独立加载，不阻塞默认章节对
loadAddons();
