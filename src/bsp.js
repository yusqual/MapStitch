// l4d2bsp.js — 最小可用的 L4D2 BSP v21 读取器。
//
// 关键结论（对 c1m1_hotel.bsp 逐字节验证，并与其他官方图交叉验证）：
//   * L4D2 的 v21 头在 version 后有 4 字节字段，lump 表从 offset 12 开始（标准 Source 是 8）。
//   * L4D2 的 lump 枚举比 Source 2007 在 26 号之后整体前移 4：
//     22..25 的 PORTALS/CLUSTERS/PORTALVERTS/CLUSTERPORTALS 在 L4D2 中不存在。
//     于是 DISPINFO=26（不是 30）、DISP_VERTS=33（不是 37）、GAME_LUMP=35、PAKFILE=40、
//     TEXDATA_STRING_DATA=43、TEXDATA_STRING_TABLE=44、FACES_HDR=58、MAP_FLAGS=59。
//   * 官方图的 lump 均未压缩；创意工坊图可能是 LZMA（magic "LZMA"），需要可选依赖 lzma-native。
//   * dtexdata_t 32 字节（nameStringTableID @12），dtexinfo_t 72 字节（texdata @68），
//     dbrushside_t 8 字节（planenum, texinfo, dispinfo, bevel），dbrush_t 12 字节。
//   * ddispinfo_t 176 字节：startPosition @0，dispVertStart @12，power @20。
//   * ddispvert_t 20 字节：vec @0，dist @12；顶点位移 = vec * dist。
//   * dface_t 56 字节：planenum@0, firstedge@4, numedges@8, texinfo@10, dispinfo@12。

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const LUMP = {
  ENTITIES: 0,
  PLANES: 1,
  TEXDATA: 2,
  VERTEXES: 3,
  VISIBILITY: 4,
  NODES: 5,
  TEXINFO: 6,
  FACES: 7,
  LIGHTING: 8,
  OCCLUSION: 9,
  LEAFS: 10,
  FACEIDS: 11,
  EDGES: 12,
  SURFEDGES: 13,
  MODELS: 14,
  WORLDLIGHTS: 15,
  LEAFFACES: 16,
  LEAFBRUSHES: 17,
  BRUSHES: 18,
  BRUSHSIDES: 19,
  AREAS: 20,
  AREAPORTALS: 21,
  DISPINFO: 26,
  ORIGINALFACES: 27,
  PHYSDISP: 28,
  PHYSCOLLIDE: 29,
  VERTNORMALS: 30,
  VERTNORMALINDICES: 31,
  DISP_LIGHTMAP_ALPHAS: 32,
  DISP_VERTS: 33,
  DISP_LIGHTMAP_SAMPLE_POSITIONS: 34,
  GAME_LUMP: 35,
  LEAFWATERDATA: 36,
  PRIMITIVES: 37,
  PRIMVERTS: 38,
  PRIMINDICES: 39,
  PAKFILE: 40,
  CLIPPORTAL: 41,
  CUBEMAPS: 42,
  TEXDATA_STRING_DATA: 43,
  TEXDATA_STRING_TABLE: 44,
  OVERLAYS: 45,
  LEAFMINDISTTOWATER: 46,
  FACE_MACRO_TEXTURE_INFO: 47,
  DISP_TRIS: 48,
  PHYSCOLLIDESURFACE: 49,
  WATEROVERLAYS: 50,
  LEAF_AMBIENT_INDEX_HDR: 51,
  LEAF_AMBIENT_INDEX: 52,
  LIGHTING_HDR: 53,
  WORLDLIGHTS_HDR: 54,
  LEAF_AMBIENT_LIGHTING_HDR: 55,
  LEAF_AMBIENT_LIGHTING: 56,
  XZIPPAKFILE: 57,
  FACES_HDR: 58,
  MAP_FLAGS: 59,
};

// 面表面的常见 flag（dtexinfo_t.flags）
export const SURF = {
  LIGHT: 0x1,
  SKY2D: 0x2,
  SKY: 0x4,
  WARP: 0x8,
  TRANS: 0x10,
  NODRAW: 0x20,
  HINT: 0x40,
  SKIP: 0x80,
  NOLIGHT: 0x100,
  BUMPLIGHT: 0x200,
  NOSHADOWS: 0x400,
  NODECALS: 0x800,
  NOCHOP: 0x1000,
  HITBOX: 0x2000,
};

export const CONTENTS = {
  EMPTY: 0,
  SOLID: 0x1,
  WINDOW: 0x2,
  AUX: 0x4,
  GRATE: 0x8,
  SLIME: 0x10,
  WATER: 0x20,
  MIST: 0x40,
  OPAQUE: 0x80,
  MOVEABLE: 0x4000,
  AREAPORTAL: 0x8000,
  PLAYERCLIP: 0x10000,
  MONSTERCLIP: 0x20000,
  ORIGIN: 0x1000000,
  MONSTER: 0x2000000,
  DEBRIS: 0x4000000,
  DETAIL: 0x8000000,
  TRANSLUCENT: 0x10000000,
  LADDER: 0x20000000,
  HITBOX: 0x40000000,
};

function cstring(buf, offset, end) {
  let s = '';
  const stop = end === undefined ? buf.length : end;
  while (offset < stop && buf[offset] !== 0) s += String.fromCharCode(buf[offset++]);
  return s;
}

// "key" "value" 形式的实体文本解析（与 tools/l4d2_map_offset.js 同一套规则）
export function parseEntities(text) {
  const ents = [];
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };
  const readString = () => {
    skipWs();
    if (text[i] !== '"') throw new Error(`实体文本格式错误 @${i}`);
    i++;
    let s = '';
    while (i < n) {
      if (text[i] === '\\' && text[i + 1] === '"') { s += '"'; i += 2; continue; }
      if (text[i] === '"') { i++; return s; }
      s += text[i++];
    }
    throw new Error('实体文本未闭合');
  };
  while (true) {
    skipWs();
    if (i >= n) break;
    if (text[i] !== '{') throw new Error(`实体块应以 { 开头 @${i}`);
    i++;
    const ent = {};
    while (true) {
      skipWs();
      if (i >= n) throw new Error('实体块未闭合');
      if (text[i] === '}') { i++; break; }
      const k = readString();
      const v = readString();
      if (!(k in ent)) ent[k] = v;
    }
    ents.push(ent);
  }
  return ents;
}

// 单个 lump 的 LZMA 解压：4 magic + 4 解压后大小 + 5 props + 8 (size) + 数据
export function decompressLump(data, label = 'lump') {
  let LZMA;
  try {
    LZMA = require('lzma-native');
  } catch {
    throw new Error(`${label}: lump 为 LZMA 压缩；请先 npm install lzma-native`);
  }
  const props = data.subarray(13, 18);
  const payload = data.subarray(13 + 5 + 8);
  return Buffer.from(LZMA.decompress(Buffer.concat([props, payload]), 'alone'));
}

export function parseEntityLump(data, label = 'entities') {
  if (!data || data.length === 0) return [];
  let buf = data;
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'LZMA') buf = decompressLump(buf, label);
  return parseEntities(buf.toString('latin1').replace(/\0+$/, ''));
}

export class Bsp {
  constructor(file) {
    this.file = file;
    this.buf = fs.readFileSync(file);
    this.lumps = [];
    this.cache = new Map();
    this._parseHeader();
  }

  _parseHeader() {
    const b = this.buf;
    if (b.length < 8 + 64 * 16) throw new Error(`${this.file}: 文件太小`);
    const ident = b.readUInt32LE(0);
    if (ident !== 0x50534256) throw new Error(`${this.file}: 不是 VBSP (magic=0x${ident.toString(16)})`);
    this.version = b.readInt32LE(4);
    // L4D2 v21 的额外 4 字节字段；标准 Source 的 lump 表从 8 开始。
    this.lumpBase = this.version >= 21 ? 12 : 8;
    for (let i = 0; i < 64; i++) {
      const o = this.lumpBase + i * 16;
      this.lumps.push({ ofs: b.readInt32LE(o), len: b.readInt32LE(o + 4), ver: b.readInt32LE(o + 8) });
    }
  }

  lump(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const l = this.lumps[index];
    if (!l || l.len <= 0) return Buffer.alloc(0);
    let data = this.buf.subarray(l.ofs, l.ofs + l.len);
    if (data.length >= 4 && data.toString('latin1', 0, 4) === 'LZMA') {
      data = this._decompressLzma(data);
    }
    this.cache.set(index, data);
    return data;
  }

  _decompressLzma(data) { return decompressLump(data, this.file); }

  // ---------- entities ----------
  get entities() {
    if (!this._entities) {
      this._entities = parseEntityLump(this.lump(LUMP.ENTITIES), this.file);
    }
    return this._entities;
  }

  // ---------- 基本结构 ----------
  count(name) {
    const sizes = {
      PLANES: 20, VERTEXES: 12, EDGES: 4, SURFEDGES: 4, FACES: 56, TEXINFO: 72,
      TEXDATA: 32, MODELS: 48, BRUSHES: 12, BRUSHSIDES: 8, DISPINFO: 176,
      DISP_VERTS: 20, DISP_TRIS: 8, CUBEMAPS: 16, OVERLAYS: 352,
      NODES: 32, LEAFS: 32, LEAFBRUSHES: 2, LEAFFACES: 2,
    };
    const size = sizes[name];
    if (!size) throw new Error(`count(${name}) 未定义结构大小`);
    return (this.lump(LUMP[name]).length / size) | 0;
  }

  vertex(i) {
    const b = this.lump(LUMP.VERTEXES);
    const o = i * 12;
    return [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)];
  }

  plane(i) {
    const b = this.lump(LUMP.PLANES);
    const o = i * 20;
    return {
      normal: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
      dist: b.readFloatLE(o + 12),
      type: b.readInt32LE(o + 16),
    };
  }

  face(i) {
    const b = this.lump(LUMP.FACES);
    const o = i * 56;
    return {
      planenum: b.readUInt16LE(o),
      side: b[o + 2],
      onNode: b[o + 3],
      firstedge: b.readInt32LE(o + 4),
      numedges: b.readInt16LE(o + 8),
      texinfo: b.readInt16LE(o + 10),
      dispinfo: b.readInt16LE(o + 12),
      surfaceFogVolumeID: b.readInt16LE(o + 14),
      styles: [b[o + 16], b[o + 17], b[o + 18], b[o + 19]],
      area: b.readFloatLE(o + 24),
      origFace: b.readInt32LE(o + 44),
      numPrims: b.readUInt16LE(o + 48),
      firstPrimID: b.readUInt16LE(o + 50),
    };
  }

  // 按 surfedge 顺序返回面的顶点坐标
  faceVertexIndices(faceIndex) {
    const f = this.face(faceIndex);
    const se = this.lump(LUMP.SURFEDGES);
    const edges = this.lump(LUMP.EDGES);
    const out = new Array(f.numedges);
    for (let k = 0; k < f.numedges; k++) {
      const surfedge = se.readInt32LE((f.firstedge + k) * 4);
      const ei = Math.abs(surfedge);
      out[k] = surfedge >= 0 ? edges.readUInt16LE(ei * 4) : edges.readUInt16LE(ei * 4 + 2);
    }
    return out;
  }

  faceVertices(faceIndex) {
    return this.faceVertexIndices(faceIndex).map((vi) => this.vertex(vi));
  }

  model(i) {
    const b = this.lump(LUMP.MODELS);
    const o = i * 48;
    return {
      mins: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
      maxs: [b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)],
      origin: [b.readFloatLE(o + 24), b.readFloatLE(o + 28), b.readFloatLE(o + 32)],
      headnode: b.readInt32LE(o + 36),
      firstface: b.readInt32LE(o + 40),
      numfaces: b.readInt32LE(o + 44),
    };
  }

  // ---------- 材质 ----------
  _buildMaterials() {
    const td = this.lump(LUMP.TEXDATA);
    const sd = this.lump(LUMP.TEXDATA_STRING_DATA);
    const st = this.lump(LUMP.TEXDATA_STRING_TABLE);
    const n = (td.length / 32) | 0;
    const strings = new Array((st.length / 4) | 0);
    for (let i = 0; i < strings.length; i++) {
      const off = st.readInt32LE(i * 4);
      strings[i] = off >= 0 ? cstring(sd, off) : '';
    }
    const materials = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      const id = td.readInt32LE(o + 12);
      materials[i] = {
        name: strings[id] || `texdata_${i}`,
        reflectivity: [td.readFloatLE(o), td.readFloatLE(o + 4), td.readFloatLE(o + 8)],
        width: td.readInt32LE(o + 16),
        height: td.readInt32LE(o + 20),
      };
    }
    this._materials = materials;
    this._texinfoTexdata = new Int32Array((this.lump(LUMP.TEXINFO).length / 72) | 0);
    const ti = this.lump(LUMP.TEXINFO);
    for (let i = 0; i < this._texinfoTexdata.length; i++) {
      this._texinfoTexdata[i] = ti.readInt32LE(i * 72 + 68);
    }
    this._texinfoFlags = new Int32Array(this._texinfoTexdata.length);
    for (let i = 0; i < this._texinfoFlags.length; i++) {
      this._texinfoFlags[i] = ti.readInt32LE(i * 72 + 64);
    }
  }

  get materials() { if (!this._materials) this._buildMaterials(); return this._materials; }
  get texinfoTexdata() { if (!this._texinfoTexdata) this._buildMaterials(); return this._texinfoTexdata; }
  get texinfoFlags() { if (!this._texinfoFlags) this._buildMaterials(); return this._texinfoFlags; }

  materialForFace(face) { return this.materials[this.texinfoTexdata[face.texinfo]] || { name: '?', reflectivity: [0.5, 0.5, 0.5] }; }
  flagsForFace(face) { return this.texinfoFlags[face.texinfo] || 0; }

  // ---------- displacements ----------
  dispInfo(i) {
    const b = this.lump(LUMP.DISPINFO);
    const o = i * 176;
    return {
      startPosition: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
      dispVertStart: b.readInt32LE(o + 12),
      dispTriStart: b.readInt32LE(o + 16),
      power: b.readInt32LE(o + 20),
      minTess: b.readInt32LE(o + 24),
      elevation: b.readFloatLE(o + 28),
      mapFace: b.readUInt16LE(o + 44),
    };
  }

  dispVert(i) {
    const b = this.lump(LUMP.DISP_VERTS);
    const o = i * 20;
    return {
      vec: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
      dist: b.readFloatLE(o + 12),
      alpha: b.readFloatLE(o + 16),
    };
  }

  // ---------- BSP 树 ----------
  node(i) {
    const b = this.lump(LUMP.NODES);
    const o = i * 32;
    return {
      planenum: b.readInt32LE(o),
      children: [b.readInt32LE(o + 4), b.readInt32LE(o + 8)],
      firstface: b.readUInt16LE(o + 24),
      numfaces: b.readUInt16LE(o + 26),
      area: b.readInt16LE(o + 28),
    };
  }

  leaf(i) {
    const b = this.lump(LUMP.LEAFS);
    const o = i * 32;
    return {
      contents: b.readInt32LE(o),
      cluster: b.readInt16LE(o + 4),
      area: b.readInt16LE(o + 6),
      firstleafbrush: b.readUInt16LE(o + 24),
      numleafbrushes: b.readUInt16LE(o + 26),
    };
  }

  leafBrush(i) { return this.lump(LUMP.LEAFBRUSHES).readUInt16LE(i * 2); }

  // 遍历某个 model 的 BSP 树，收集其叶节点里的 brush 编号
  modelBrushes(headnode) {
    const out = [];
    if (headnode < 0 || headnode >= this.count('NODES')) return out;
    const seenNodes = new Set();
    const stack = [headnode];
    while (stack.length) {
      const n = stack.pop();
      if (n < 0) {
        const li = -n - 1;
        const leaf = this.leaf(li);
        for (let k = 0; k < leaf.numleafbrushes; k++) out.push(this.leafBrush(leaf.firstleafbrush + k));
        continue;
      }
      if (seenNodes.has(n)) continue;
      seenNodes.add(n);
      const node = this.node(n);
      for (const c of node.children) stack.push(c);
    }
    return out;
  }

  // ---------- brushes ----------
  brush(i) {
    const b = this.lump(LUMP.BRUSHES);
    const o = i * 12;
    return { firstside: b.readInt32LE(o), numsides: b.readInt32LE(o + 4), contents: b.readInt32LE(o + 8) };
  }

  brushSide(i) {
    const b = this.lump(LUMP.BRUSHSIDES);
    const o = i * 8;
    return {
      planenum: b.readUInt16LE(o),
      texinfo: b.readInt16LE(o + 2),
      dispinfo: b.readInt16LE(o + 4),
      bevel: b.readInt16LE(o + 6),
    };
  }
}

export function loadBsp(file) { return new Bsp(file); }
