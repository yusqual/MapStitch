# 需求分析与实现记录

> 日期：2026-11-14（2026-11-15 补旋转与 prop_static 实现记录）
> 状态：**① 创意工坊 VPK、② 180° 旋转、③ prop_static 包围盒均已实现**
> 相关内容：[调研与实现记录](research.md) · [使用手册](manual.md)

本文记录三项待做功能的工作量、依赖、风险，以及在本机实际验证到的事实。
凡是标“实测”的结论都来自本次对游戏文件和 BSP 的检查，不是推测。

## 0. 结论速览

| 项目 | 代码量 | 工作量 | 前置依赖 | 风险 |
|---|---:|---:|---|---|
| ① 创意工坊 VPK 解包 + 地图发现/配对 | 300–450 行 | **0.5–1 天** | 无 | 低（**已完成**） |
| ② 180° 旋转换关 | 100–200 行 | **0.25–0.5 天** | 无 | 低（**已完成**） |
| ③ prop_static 包围盒 | 350–500 行 | **0.75–1.5 天** | ① 的 VPK 读取 | 中（**已完成**） |

原本推荐顺序 **① → ② → ③**，三项均已完成；实现细节见各节的“实现记录”。

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

手动指定目录的方式（`--maps-dir` 可重复）仍可用于临时调试；实现①后 `build --all`
已自动合并全部 5 个目录，index 记录绝对 `source`，`serve` 不再需要 `--maps-dir`
即可对任意 DLC 图做 `/api/point` 落点判定（见 [§2.6](#26-实现记录2026-11-14)）。

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

### 3.6 实现记录（2026-11-15）

代码改动：

- `src/offset.js`：新增 `ROTATING_LANDMARKS` / `landmarkYaw()` / `rotateZ()` /
  `aToB()` / `bToA()` / `alignShift()`；`calcOffset()` 增加第 4 个参数 `yawOverride`，
  返回 `yaw`（度）与 `autoYaw`，并在 `note` 中标注"旋转换关 / 手动覆盖"。
- `src/cli.js`：`pairs` / `build` 把 `yaw` 写进 index 的章节对；`check` 改用
  `aToB()`（普通平移时退化为 `A + offset`）；新增全局 `--yaw 0|90|180|270` 覆盖。
- `src/addon.js`：addon 配对把 `yaw` 透传到 makePair，并把旋转说明与其它 note 合并。
- `web/`：「偏移」改为「偏移 / 旋转」，新增 0/90/180/270° 下拉；`groupB` 用
  `rotation.z = yaw` + `position = lmA - Rz(yaw)·lmB`；点击读数反算
  `B = Rz(-yaw)·(显示点 - 平移)`；包围盒按旋转后的 B 计算；`?yaw=` 可临时覆盖。
- 坐标定位、`?pick=`、`/api/point` 语义不变（仍传 B 的局部坐标）。

验证（本机 `build --all --merge`，57 图 / 43 对；index 65 对）：

- `pairs c13` 自动标出 c13m3→c13m4 为 `旋转 180°`，其余对为 0°。
- `check c13m3_memorialbridge c13m4_cutthroatcreek 6314.5 -6065.6 402`：
  A 的 landmark 正好换算出 B 的 landmark `(-3616, -9356, 376)`，判定为开阔空间。
- headless Edge 截图：`?yaw=0` 时两图在 landmark 处明显脱节；`?yaw=180` 时
  B 的桥面与 A 的出口连续。`?pick=` 读数在 180° 下输出
  `B 坐标 = -3616.0, -9356.0, 376.0`，与 landmark 一致。
- 平移回归：c1m1→c1m2 的 `?pick=0,0,0` 仍输出 `B = (368, 656, -736) = A + offset`。

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

`GAME_LUMP`（lump 35）头是 `int lumpCount; dgamelump_t[16 B]`：每条的 4 字节 ID
就是 `"prps"`，随后 u16 flags、u16 version、i32 fileofs、i32 filelen。`fileofs`
是 **BSP 文件内的绝对偏移**（实测 c1m1/c5m2/atr01 均满足 `rel = 4 + count×16`）；
图被 LZMA 压缩后绝对偏移失效，但各 lump 在解压后的缓冲区里按条目顺序连续排列，
可据此回退。

`StaticPropLump_t` v9 为 72 字节，字段顺序与 Source SDK `gamebspfile.h` 一致：

| 字段 | 偏移 | 说明 |
|---|---:|---|
| `origin` | 0 | Vector，实测世界坐标合理 |
| `angles` | 12 | QAngle，实测 yaw 合理 |
| `propType` | 24 | u16，取值 0..N-1，与名字表一一对应 |
| `firstLeaf` / `leafCount` | 26 / 28 | u16；早先误把这里当成 solid/flags |
| `solid` | 30 | u8：0 = 非实体，1 = BSP，2 = BBox，6 = VPhysics（实测 c1m1 为 6/0/2） |
| `flags` | 31 | u8，静态道具标志位 |
| `skin` | 32 | i32 |
| `fadeMin` / `fadeMax` | 36 / 40 | float，实测 800–1600 |
| `lightingOrigin` | 44 | Vector（未设置时为 0 或 -1 填充） |
| `forcedFadeScale` | 56 | float，实测 1.0 |
| `minDX` / `maxDX` | 60 / 62 | u16 |
| `diffuseModulation` | 64 | color32（RGBA），默认 `ff ff ff ff` |
| `disableX360` | 68 | u8，其余为对齐填充 |

v10 追加 `flagsEx`（步长 76），v11 追加 `uniformScale`（步长 80）；基础字段偏移不变，
遇到 v11 时按 `uniformScale` 缩放 hull（L4D2 自己的图都是 v9，缩放为 1）。

c1m1 实测：188 个模型名、3140 个 leaf 索引、1748 个 prop；ssv1：11 个模型名、400 leaf、61 prop。

### 4.2 MDL 包围盒（实测）

从 `pak01_dir.vpk` 查到 `models/props_unique/hospital/hospital_bed.mdl`
（archiveIndex 8 → `pak01_008.vpk`），按偏移取出后：

```
IDST, version 49
hull_min @104 = (-24.4, -50.6, -1.9)
hull_max @116 = ( 23.6,  50.5, 29.6)
```

得到包围盒后按 `angles` 旋转即可（`AngleMatrix`：模型 X=forward、Y=left、Z=up）。
个别模型 `hull_min == hull_max`（无碰撞盒）时回退到 `view_bbmin/view_bbmax`（@128/@140）；
两者都退化的模型跳过并计入“缺模型”。

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

### 4.5 实现记录（2026-11-15）

代码：`src/props.js`（`prps` 解析、MDL hull、OBB、点查询、渲染层），
`src/geometry.js` 把 props 作为独立图层输出，`src/addon.js` 的内容对象新增
`readFile()`（addon 模型优先），CLI 的 `build` / `info` / `check` 与 `serve`
的 `/api/point` 全部接入；查看器新增「静态道具」图层与读数行。

关键实现：

- **模型查找顺序**：addon（VPK 或散装目录）→ 游戏目录散装文件 → 游戏 VPK
  （`update` > `dlc3` > `dlc2` > `dlc1` > `base`，每个目录内散装优先）。
  addon 挂载按需打开，`serve` 从 `index.addons` 的 `entries[].source` 重建。
- **MDL**：只读前 160 字节取 `hull_min/max`，按模型路径缓存；不需要解出整个 MDL。
- **图层**：每个 prop 生成 12 个三角形（36 顶点），`props` 层默认关闭；
  顶点数 = `propCount × 36`，便于和 `prps` 对账。
- **点查询**：`propsAtPoint()` 把世界点反变换到模型局部坐标，报告模型名、solid
  类型与到最近面的距离；`check` 与 `/api/point` 都会输出。
- **缓存**：`.mst` 头版本升到 2；`buildMap` 发现旧版（v1，无 props 层）时自动重建。

验证（本机）：

- `build --all`：57 张官方图全部 `缺模型 0`，1748（c1m1）–4089（c1m3）个 prop/图，
  总耗时约 7 秒（VPK 打开只发生一次）。
- `info c1m1_hotel`：188 种模型、1748 个 prop、可解析包围盒 1748；
  `tools/check_props.js c1m1_hotel -48 5008 1184.2` 显示 `.mst` 的 props 层
  `62928 顶点 = 1748 个盒子`，医院床 hull `48.03 × 101.02 × 31.51`，
  与 §4.2 的 `hospital_bed.mdl` 完全一致。
- addon：Amid The Ruins 5 张图 `缺模型 0`（378 种模型）；ssv1、City of the Dead、
  Black Mesa、viennacalling2 也基本齐全；Journey to Splash Mountain 与
  Neo Tokyo 分别缺 937–1538 / 624–988 个 prop，原因是这些 addon 依赖未安装的模型包，
  属预期行为，构建日志与 `info` 会给出数量。
- 端到端：headless Edge 打开 `?pair=c1m1_hotel|c1m2_streets&layers=world,props`，
  c1m1 医院病房的床铺显示为绿色盒子；`?pick=` 落在货架 prop 内时读数面板同时给出
  `clip 体积` 与 `prop 包围盒: 在 shelvinggrocery01.mdl 内`。

---

## 5. 验收标准建议

**① VPK / 地图发现**

- ✅ `--addon "Amid The Ruins.vpk"` 只解包并注册 atr01–atr05，不触碰其它 addon；
- ✅ 查看器按 missions 的 coop 顺序列出 4 个相邻对；
- ✅ 构建、加载、点击判定端到端可用（headless Edge + `/api/point` 已验证）；
- ✅ 支持 `*_dir.vpk` + 分卷（官方 `pak01_dir.vpk` 22,273 条 + CRC 抽样通过）。

**② 旋转**

- ✅ c13m3→c13m4 在 180° 下过渡区目视连续，手动切回 0° 能明显看出接缝错误；
- ✅ c1–c5 所有对回归无变化（`pair.yaw = 0`，读数仍为 `A + offset`）；
- ✅ 点击读数在旋转模式下换算正确（`?pick=` 输出 B 坐标与 landmark 完全一致）。

**③ prop_static**

- ✅ 每张图的 prop 数量与 `prps` 的 `propCount` 一致（props 层顶点 = `propCount × 36`，
  由 `tools/check_props.js` 对账）；
- ✅ 医院床等有 hull 的模型显示为正确尺寸的盒子（48.03 × 101.02 × 31.51）；
- ✅ `props` 图层可开关（默认关闭，`?layers=` 也可控制）；
- ✅ `check` / `/api/point` 能报告“落在 prop 包围盒内”，并给出模型名与 solid 类型。

---

## 6. 暂不做

- VPK v2（L4D2 用不到）；
- sprp 的 LZ4 解压（本机样本未压缩，遇到再加）；
- 完整 prop 网格/材质（只做包围盒）；
- 默认扫描全部 addons（与使用方式冲突，按需加载）。
