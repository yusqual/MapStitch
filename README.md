# MapStitch

L4D2 跨章节地图拼接可视化工具。读取相邻两章 BSP，按 `info_landmark` 计算坐标偏移，把两张图叠加到同一个世界坐标里，用来观察"电击器传点"后下一章落点周围有什么。

![拼接示例](docs/screenshot-stitch.png)

![点击读坐标与 B 落点判定](docs/screenshot-check.png)

完整操作说明见 **[使用手册](docs/manual.md)**；实现细节与技术结论见 [调研/实现记录](docs/research.md)；
创意工坊 VPK 已实现，剩余 180° 旋转与 prop_static 的工作量、验证结论和设计建议见 [剩余需求分析](docs/roadmap.md)。

## 快速开始

```bash
cd MapStitch
npm install            # 只装 three.js（可选 lzma-native 用于创意工坊压缩图）

node src/cli.js build --all     # 解析 c1–c14 全部官方图（含 DLC 目录），导出 out/maps/*.mst + out/index.json
node src/cli.js serve           # 打开 http://localhost:8123/
```

全量 57 张官方图约 3 秒。修改代码或想重新导出时加 `--force`。

创意工坊 / addon 地图只加载选中的那一个，VPK 自动解包到 `out/cache/`。
也可以直接在页面左侧「附加地图 / VPK」勾选并解析，无需命令行：

```bash
node src/cli.js addons --inspect                 # 列出 addons，显示地图数与 coop 章节
node src/cli.js build --addon "Amid The Ruins"   # 解析 missions 的 coop 顺序并加入 index
node src/cli.js build --addon "Journey to Splash Mountain - Part 1" \
                       --addon "Journey to Splash Mountain - Part 2"
```

## 查看器操作

| 操作 | 说明 |
|---|---|
| 左键拖动 | 环绕旋转 |
| 中键拖动 | 平移 |
| 右键拖动 | 原地自由视角（只转朝向，不移动相机） |
| 滚轮 | 缩放 |
| `WASD` | 前后左右移动（速度随观察距离缩放） |
| `Q` / `E` | 下降 / 上升 |
| `Shift` / `Ctrl` | 按住加速 ×2.5 / 减速 ×0.4 |
| `F` | 重置视角 |

左侧"飞行 → 速度"滑块控制基础倍率（默认 ×0.35，设置会记住）。注意浏览器会抢占
`Ctrl+W`（关闭标签页），微调建议直接用滑块。
| 点击表面 | 读取 A / B 两套坐标，并给出 B 落点是否为 clip / solid / 开阔空间 |
| 章节过渡 | 选择相邻章节对（自动加载并计算偏移） |
| 不透明度 | 分别调 A / B，把另一张图"透视"过去 |
| 线框 | 单图线框模式 |
| 偏移 | B 的平移量，默认 `-offset` 使 landmark 重合；可手动微调 |
| 图层 | 世界几何 / 地形位移面 / 门实体 / clip 体积 / nodraw / 水面 / 天空盒 |
| 坐标定位 | 输入 A 坐标放标记，适合把游戏里 `sm_printspawn` 的坐标贴进来 |
| 剖切 | 沿 Z 轴切开，方便看楼层内部 |

颜色：**蓝 = 上一章（A）**，**橙 = 下一章（B）**，黄色 = clip 体积，红棕 = nodraw。

坐标约定与游戏一致：X 东、Y 北、Z 上。B 的几何默认平移 `-offset`，因此 landmark 处两图重合；此时显示的任一点 `p` 满足：

```
B 坐标 = p - B平移量        （默认 B平移量 = -offset，即 B坐标 = p + offset）
```

这与游戏里的换关规则 `下一章坐标 = 上一章坐标 + offset` 一致。

## 命令行

```
node src/cli.js pairs [campaign]                 只算偏移表（秒级，只读实体块）
node src/cli.js pairs --addon "Amid The Ruins"   只看选中 addon 的偏移（不解包）
node src/cli.js build --all                      导出全部官方战役（c1–c14，含 DLC 目录）
node src/cli.js build --campaign c2              只导出某个战役
node src/cli.js build --addon <vpk或目录>         解包选中 addon 并合并进 index（可重复）
node src/cli.js build c1m1_hotel c1m2_streets    只导出指定相邻两章
node src/cli.js serve [--port 8123]              启动可视化
node src/cli.js check c1m1_hotel c1m2_streets 2136 4472 1248
                                                 查一个 A 点传到 B 后落在什么体积里
node src/cli.js info c1m1_hotel                  单图 lump / 统计信息
node src/cli.js addons [filter] [--inspect]      列出 addons / 创意工坊内容
node src/cli.js vpk <file.vpk> [prefix] [--missions]
                                                 列 VPK 目录树，核对 preload/分卷
```

`check` 是最直接的点位筛选工具：给定上一章的坐标，输出下一章坐标以及它是否落在 solid / clip / water brush 内，并给出穿透深度。

```
B 点 = A + 偏移 = (2504.0, 5128.0, 512.0):
  [solid] brush #3506，实体 info_changelevel "c1m1_c1m2_changelevel"，距最近面 64.0
```

## 数据与实现

- `src/bsp.js` — L4D2 BSP v21 读取器（实体、几何、材质、位移、brush、BSP 树）
- `src/vpk.js` — VPK v1 读取器（跳过 preload、内嵌 `archiveIndex=32767`、分卷 `*_NNN.vpk`）
- `src/addon.js` — addon 发现、missions coop 解析、changelevel 配对、解包缓存
- `src/geometry.js` — BSP → 三角网格；分层（world / disp / sky / nodraw / water / clip / detail）
- `src/offset.js` — 相邻章节偏移计算（与 `../tools/l4d2_map_offset.js` 同一算法）+ 官方 DLC 目录合并
- `src/query.js` — 点是否在 brush 体积内（卡墙判定）
- `src/export.js` — `.mst` 二进制格式（JSON 头 + Float32 位置/法线 + Uint8 颜色）
- `src/cli.js` — 命令行入口 + 静态服务器
- `web/` — three.js 查看器（无构建步骤，importmap 直接引用 node_modules）

### 关键技术结论（均已逐字节验证）

1. **L4D2 v21 头的 lump 表从 offset 12 开始**，且枚举比 Source 2007 在 26 号之后整体前移 4：
   `DISPINFO=26`、`ORIGINALFACES=27`、`DISP_VERTS=33`、`GAME_LUMP=35`、`PAKFILE=40`、
   `TEXDATA_STRING_DATA=43`、`TEXDATA_STRING_TABLE=44`、`FACES_HDR=58`、`MAP_FLAGS=59`。
   （L4D2 没有 PORTALS/CLUSTERS/PORTALVERTS/CLUSTERPORTALS 四个 lump。）
2. **位移面网格 `(0,0)` 角 = 离 `dispinfo.startPosition` 最近的 face 顶点**。
   快速索引沿 face 顶点顺序的 `base+3`，行索引沿 `base+1`；顶点位置 = 双线性基准 + `vec * dist`。
   用相邻位移面共享边校验：c1/c2/c3/c5 接缝 RMS < 1 单位。
3. **clip 面不在 FACES lump 里**，必须从 `BRUSHES`/`BRUSHSIDES` 的平面重建凸多面体；
   brush 内部 = 对所有侧面满足 `dot(n, p) - d <= 0`。brush→model 归属通过对每个 model 的 BSP 树遍历叶节点得到。
4. brush 实体模型的顶点/平面是**相对实体 origin 的局部坐标**，渲染和点查询都要加回 origin。
5. 材质名在 `TEXDATA` + `TEXDATA_STRING_TABLE/DATA`；`dtexinfo_t` 72 字节，texdata 索引在 +68。

### 已知限制

- 不解析 prop_static（需要从 VPK 里读 MDL 包围盒）；目前用世界几何 + clip + 门实体。
- 创意工坊图的几何可能 LZMA 压缩，需要 `lzma-native`；`.bsp` 已由 `--addon` 自动解包。
- 默认只加载选中的一个 addon；多分卷 addon 用重复 `--addon` 组合。不会扫描全部 addons。
- addon 无 missions 且 changelevel 不完整时，最终章可能缺失或只能按名称排序兜底。
- 只处理平移偏移。180° 旋转由 L4D2 硬编码的 landmark 名 `coldstream3_coldstream4` 触发
  （本机 c13m3→c13m4），当前未处理。
- 位移面朝向规则在个别重叠/重复 brush 面上会出现"伪相邻"，不影响整体显示。
