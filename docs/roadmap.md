# 剩余需求分析与验证记录

> 日期：2026-11-14
> 状态：**① 创意工坊 VPK 已实现**；② 180° 旋转、③ prop_static 仍未实现
> 相关内容：[调研与实现记录](research.md) · [使用手册](manual.md)

本文记录三项待做功能的工作量、依赖、风险，以及在本机实际验证到的事实。
凡是标“实测”的结论都来自本次对游戏文件和 BSP 的检查，不是推测。

## 0. 结论速览

| 项目 | 代码量 | 工作量 | 前置依赖 | 风险 |
|---|---:|---:|---|---|
| ① 创意工坊 VPK 解包 + 地图发现/配对 | 300–450 行 | **0.5–1 天** | 无 | 低（**已完成**） |
| ② 180° 旋转换关 | 100–200 行 | **0.25–0.5 天** | 无 | 低（已有测试用例） |
| ③ prop_static 包围盒 | 350–500 行 | **0.75–1.5 天** | ① 的 VPK 读取 | 中 |

推荐顺序：**① → ② → ③**。总计约 **1.5–3 个工作日**（①和③的 VPK 代码可复用）。

---

## 1. 本机地图布局（实测）

官方图不是只放在 `left4dead2/maps`，DLC 图分散在多个游戏目录：

| 目录 | 战役 | 地图数 |
|---|---|---:|
| `left4dead2/maps` | c1–c5 | 23 |
| `left4dead2_dlc1/maps` | c6（Cold Stream） | 3 |
| `left4dead2_dlc2/maps` | c7、c8 | 8 |
| `left4dead2_dlc3/maps` | c9–c13 | 21 |
| `update/maps` | c14 | 2 |
| **合计** | c1–c14 | **57** |

验证结果：

- 对每个目录运行 `node src/cli.js pairs --maps-dir <目录>` 都能正常算出偏移。
- c14 只有两张图：`c14m1_junkyard → c14m2_lighthouse`，landmark `cp_landmark`，偏移 `(5344, -11392, 576)`。
- 实现①后，`build --all` 默认合并以上 5 个目录（57 张图、43 个相邻对），index 中每张图记录绝对 `source`。

临时加载 DLC 的方法（现版本可用，但不是最终方案）：

```bash
node src/cli.js build --campaign c6 --maps-dir "C:/.../left4dead2_dlc1/maps"
node src/cli.js serve --port 8125 --maps-dir "C:/.../left4dead2_dlc1/maps"
```

`build --campaign` 会与已有 index 合并，不会清掉 c1–c5。注意 `/api/point` 的落点判定使用的是
`serve --maps-dir` 指向的单个目录，所以检查 DLC 图时需要为对应目录单独起服务。

---

## 2. 创意工坊 / 附加地图（已实现）

### 2.1 VPK 格式（实测）

- 本机 `left4dead2/addons/*.vpk` **全部是 VPK v1**，地图数据内嵌（`archiveIndex = 32767`）。
- 官方 `pak01_dir.vpk` 也是 v1，数据分在 `pak01_000…00N.vpk` 里，通过目录项的 `archiveIndex` 选择分卷。
- **必须处理 preload 字节**：VPK 目录项 18 字节之后紧跟着 `preloadBytes` 长度的数据。
  忽略它会从第一个有 preload 的文件开始解析错位。实测官方 `pak01_dir.vpk`：
  不跳过 preload 时只解析出 17,646 个条目；正确处理后有 **22,273** 个。
- 官方 VPK 内 MDL 数量（正确处理 preload 后）：base 3,333、update 487、dlc1 177、dlc2 943、dlc3 908。
- 本地没有 `steamapps/workshop/content/550` 目录，地图都以 `.vpk` 形式放在 `left4dead2/addons/`。
  实现时仍应同时支持 `addons/*.vpk`、`addons/*/`（散装目录）和 `workshop/content/550/*/`。

### 2.2 只加载选中的地图

速通场景通常只打一张图/一个战役，不应该默认扫描并解包所有 addons。
设计建议：

- CLI 增加 `--addon <vpk或目录>` / 查看器增加“选择附加地图”入口；
- 只解包被选中的战役所引用的 `.bsp`（以及后续 prop_static 需要的 MDL）；
- 解包结果缓存到 `out/cache/<addon名>/`，按文件 mtime/size 失效；
- 多分卷 VPK 按 `*_dir.vpk` 分组，`archiveIndex` → `*_NNN.vpk`，内嵌（32767）直接读 dir 文件。

### 2.3 missions 文本（实测）

拆包后的 addon 一般在 `missions/<战役名>.txt` 描述章节顺序。结构：

```
"mission"
{
    "Name" "AmidTheRuins"
    ...
    "modes"
    {
        "coop"
        {
            "1" { "Map" "atr01_trailer_park" "DisplayName" "1: Trailer Park" ... }
            "2" { "Map" "atr02_outskirts" ... }
            ...
        }
        "versus" { ... }
        "survival" { ... }
    }
}
```

已检查的四个 addon：

| VPK | missions 文件 | coop 章节 |
|---|---|---|
| Amid The Ruins | `missions/amidtheruins.txt` | atr01–atr05 |
| Journey to Splash Mountain | `missions/jtsm.txt` | splash1–splash6 |
| 地图ssv | `missions/ssv1.txt` | ssv1、map_x、bgking_v2（含占位名） |
| Black Mesa Hazardous Environment | `missions/bmhev.txt` | bmhev_01–05（另有 `_vs` 变体） |

注意点：

- 同一个 txt 里还有 versus/survival/scavenge 的章节列表，**只取 `coop`**，并按数字键 `1..N` 排序。
- 可能出现占位地图名（例如 ssv 的 `map_x`），必须与 VPK/目录里实际存在的 `.bsp` 取交集。
- 不是所有 addon 都带 missions（官方 DLC 的 VPK 目录就没有）；需要回退方案。

官方 DLC 的章节定义在 **VPK 里**，例如 `update/pak01_dir.vpk` 的 `missions/campaign6.txt`、
`campaign13.txt`、`campaign14.txt`（archiveIndex 3 → `pak01_003.vpk`）。同样能解析出 coop 顺序。
所以实现应同时支持“missions 文本在 VPK 内”和“missions 文本已解包到目录”两种情况。

### 2.4 地图配对算法建议

优先级从高到低：

1. 读 missions 的 `coop` 章节列表，按顺序组成战役；
2. 过滤掉实际不存在的 `.bsp`（占位名）；
3. 对相邻两图检查是否共享 `info_landmark`（现有 `calcOffset` 已做），不通过就尝试反向/跳过；
4. 没有 missions 时，用 `trigger_changelevel`/`info_changelevel` 的 `map` + `landmark` 连链
   （实测 atr/splash 的实体数据完整）；
5. 最后允许命令行手动指定 `build <from> <to>`。

### 2.5 工作量（①）

| 子任务 | 代码量 |
|---|---:|
| VPK v1 读取（含 preload、分卷、内嵌） | ~180 行 |
| addon/workshop 扫描与缓存、只解选中战役 | ~120 行 |
| missions 解析 + coop 过滤 + 占位名过滤 | ~70 行 |
| 配对（missions / changelevel / 手动）与 index 生成 | ~80 行 |

约 0.5–1 天。无新增依赖。可选 VPKEdit 用来人工对照。

### 2.6 实现记录（2026-11-14）

代码：`src/vpk.js`（VPK v1）、`src/addon.js`（发现/missions/配对/缓存），CLI 增加
`addons`、`vpk`、`pairs --addon`、`build --addon`（可重复）。验证结果：

- **preload**：官方 `left4dead2/pak01_dir.vpk` 解析出 **22,273** 条，其中 5,116 条带 preload
  （合计 2,953,680 B）；与 roadmap 早先记录的 17,646 / 22,273 修正值一致。
- **分卷/内嵌**：抽样 33 个条目（含 split archive 与 preload）按 VPK 目录项的 CRC 校验全部通过；
  从 `pak01_008.vpk` 读出的 `hospital_bed.mdl` hull 为 `(-24.43,-50.56,-1.94)..(23.60,50.47,29.57)`，
  与 §4.2 实测一致。
- **官方 missions 实际在 `update/pak01_dir.vpk`**（不是 base pak）：campaign1–14 全部可解析；
  `build --all` 得到 57 张图、43 个相邻对，c14 偏移 `(5344,-11392,576)` 与 §1 一致。
- **addon**：Amid The Ruins（atr01–05，4 对）、地图ssv（`map_x` 被过滤，只剩 ssv1）、
  Journey Part1+Part2（splash1–5，4 对；Part1 的 missions 只写到 splash5，splash6 无换关实体，
  因此不进 coop 链）。解包缓存 `out/cache/<addon>-<hash>/maps/`，重跑命中缓存；
  解出的 `.bsp` 字节大小与早先临时解包结果完全一致。
- **端到端**：`serve` 通过 index 的 `source` 解析 addon 缓存与 DLC 目录，`/api/point` 对
  `atr01_trailer_park`、`c14m1_junkyard` 均正常返回；headless Edge 打开
  `?pair=atr01_trailer_park|atr02_outskirts` 后加载完成且下拉框包含 addon 分组。

设计补充（与 §2.4 的差异）：

- 为了“只看偏移”时也很快，配对直接读 VPK 内的 BSP 头 + 实体 lump（必要时 LZMA 解压），
  不解包整张图；确定章节后再只解包这些 `.bsp`。
- 多分卷 addon 用重复 `--addon` 显式组合，仍然不扫描全部 addons；同名 addon 优先 `.vpk` 原件。
  查看器左侧新增入口：`GET /api/addons` 列表 + `POST /api/addon/build` 后台子进程构建 +
  `GET /api/job/<id>` 轮询日志，完成后自动刷新章节下拉。
- missions 末尾若还有未收录但由 changelevel 指向的图，会向后补链；splash6 因没有换关实体而无法补。

---

## 3. 180° 旋转换关

### 3.1 触发规则（实测，已修正早先结论）

在 `left4dead2/bin/server.dll` 里找到字面量：

```
InfoChangelevel ... coldstream3_coldstream4 ... Landmark name '%s' too long ... Map name '%s' too long ... PlayerTransition
```

这证明 L4D2 的换关代码把 **landmark 名 `coldstream3_coldstream4`** 作为 180° 旋转的开关
（Valve 文档的 Cold Stream 提示也是这个字符串）。它**不是**通用的 `地图A_地图B` 规则，
早先调研文档里的说法需要修正。

### 3.2 本机测试用例

`c13m3_memorialbridge → c13m4_cutthroatcreek`：

| 项 | 值 |
|---|---|
| landmark | `coldstream3_coldstream4` |
| A 坐标 | `(6314.5, -6065.6, 402)` |
| B 坐标 | `(-3616, -9356, 376)` |
| 平移偏移 | `(-9930.5, -3290.4, -26)` |
| 旋转 | 180°（绕 landmark） |

这解决了“没有旋转测试素材”的问题，可以直接用这对图验收。

### 3.3 几何接缝不能用来检测

尝试过“比较 A 附近几何与 B 变换后的最近距离，谁的误差小选谁”。对照组
c13m2→c13m3（已知普通平移）反而给出 180° 更贴合的结果，说明相邻地图的过渡区几何
并不保证在合并坐标系里重合，该方法不可靠。**检测应基于精确 landmark 名 + 手动覆盖。**

### 3.4 实现要点

变换公式（B 的局部坐标 → 显示坐标）：

```
显示位置 = lmA + Rz(yaw) * (pB - lmB)
```

- 查看器：给 B 的 group 设置 `quaternion = Rz(yaw)`，`position = lmA - Rz(yaw) * lmB`；
- 点击读数与 `/api/point`：反变换 `pB = lmB + Rz(-yaw) * (显示点 - lmA)`；
- UI：自动检测（landmark 名精确等于 `coldstream3_coldstream4`，大小写不敏感）+ 手动 0/90/180/270；
- 偏移输入框在旋转模式下要改为“旋转角 + 平移量”，避免语义混乱。

### 3.5 工作量（②）

约 100–200 行、0.25–0.5 天。测试用 c13m3→c13m4；同时回归 c1–c5 的普通平移对。

---

## 4. prop_static 包围盒

### 4.1 数据布局（实测，已修正“需要 LZ4”的担心）

L4D2 的 `prps` 静态道具数据在官方图和本机 addon 上都**没有压缩**。布局：

```
int nameCount;
char names[nameCount][128];
int leafCount;
uint16 leafIndices[leafCount];
int propCount;
StaticPropLump_t props[propCount];   // 72 字节/条
```

已确认的字段：

| 字段 | 偏移 | 说明 |
|---|---:|---|
| `origin` | 0 | Vector，实测世界坐标合理 |
| `angles` | 12 | QAngle，实测 yaw 合理 |
| `propType` | 24 | u16，取值 0..187，与 188 个模型名一一对应 |
| `solid` / `flags` | 26 / 27 | u8 |
| 其余字段 | 28+ | skin、fade、lighting origin 等，渲染包围盒不需要 |

c1m1 实测：188 个模型名、3140 个 leaf 索引、1748 个 prop；ssv1：11 个模型名、400 leaf、61 prop。

### 4.2 MDL 包围盒（实测）

从 `pak01_dir.vpk` 查到 `models/props_unique/hospital/hospital_bed.mdl`
（archiveIndex 8 → `pak01_008.vpk`），按偏移取出后：

```
IDST, version 49
hull_min @104 = (-24.4, -50.6, -1.9)
hull_max @116 = ( 23.6,  50.5, 29.6)
```

得到包围盒后按 `angles` 旋转即可。个别模型 `hull_min == hull_max`（无碰撞盒）时，
回退到固定小盒或 `view_bbmin/view_bbmax`。

### 4.3 实现拆分

| 子任务 | 代码量 |
|---|---:|
| `prps` 解析（名字表、leaf、prop 数组） | ~80 行 |
| MDL 查找（复用①的 VPK 读取）+ studiohdr hull | ~100 行 |
| OBB 生成与 `props` 图层渲染/开关 | ~100 行 |
| 可选：点是否在 prop OBB 内，纳入落点判定 | ~50 行 |

风险：

- 模型查找顺序（addon 覆盖官方；目录优先于 VPK）；
- 某些 prop 缺少 hull；
- 部分 addon 地图的 sprp 可能压缩（本机样本没有），遇到再处理，不需要提前引入 lz4js；
- 只需 origin/angles/hull，不需要解析完整 MDL/VVD/VTX。

### 4.4 工作量（③）

约 350–500 行。完成①后约 0.75–1 天；从零开始约 1–1.5 天。

---

## 5. 验收标准建议

**① VPK / 地图发现**

- ✅ `--addon "Amid The Ruins.vpk"` 只解包并注册 atr01–atr05，不触碰其它 addon；
- ✅ 查看器按 missions 的 coop 顺序列出 4 个相邻对；
- ✅ 构建、加载、点击判定端到端可用（headless Edge + `/api/point` 已验证）；
- ✅ 支持 `*_dir.vpk` + 分卷（官方 `pak01_dir.vpk` 22,273 条 + CRC 抽样通过）。

**② 旋转**

- c13m3→c13m4 在 180° 下过渡区目视连续，手动切回 0° 能明显看出接缝错误；
- c1–c5 所有对回归无变化；
- 点击读数在旋转模式下换算正确。

**③ prop_static**

- 每张图的 prop 数量与 `prps` 的 `propCount` 一致；
- 医院床等有 hull 的模型显示为正确尺寸的盒子；
- `props` 图层可开关；
- （可选）`check` 能报告“落在 prop 包围盒内”。

---

## 6. 暂不做

- VPK v2（L4D2 用不到）；
- sprp 的 LZ4 解压（本机样本未压缩，遇到再加）；
- 完整 prop 网格/材质（只做包围盒）；
- 默认扫描全部 addons（与使用方式冲突，按需加载）。
