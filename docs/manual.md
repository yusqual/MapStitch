# MapStitch 使用手册

> 适用版本：MapStitch 0.1.0（2026-11-14）
> 相关文档：[调研与实现记录](research.md) · [剩余需求分析](roadmap.md) · [项目说明](../README.md)

## 1. 这个工具解决什么问题

L4D2 换关时，角色坐标会按固定偏移搬到下一章：

```
B 坐标 = A 坐标 + offset        offset = B 的 landmark - A 的 landmark
```

"电击器传点"利用的是：玩家卡在墙里 10 秒后会被传送到最近队友处，若队友在过关点，
传送的同时立即结算电击器复活。玩家本体留在原地，下一章加载后其坐标被加上 offset，
可能正好落在下一章的某个可用位置（或墙里/夹缝里）。

MapStitch 把相邻两章按 offset 叠到同一个世界坐标里，并提供两件事：

1. **看**：两张图的几何、地形、门、clip 体积在同一空间里的相对位置；
2. **查**：给一个上一章坐标，直接告诉你下一章落点在实体、clip 体积还是开阔空间。

## 2. 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows（Steam 路径自动检测；Linux/macOS 有常见路径回退） |
| Node.js | 18+，实测 v24.22.1 |
| 浏览器 | 支持 WebGL2 与 importmap 的现代浏览器（Edge / Chrome） |
| 游戏 | 本机安装 L4D2；官方图分散在 `left4dead2/maps`、`left4dead2_dlc1/2/3/maps`、`update/maps` |

**游戏目录不再写死。** 启动时会按以下顺序查找：

1. 命令行 `--game-dir <目录>`（仅 CLI）；
2. 环境变量 `L4D2_GAME_DIR`；
3. 页面里保存的 `.mapstitch.json`（git 忽略）；
4. Steam 自动检测：Windows 注册表的 `SteamPath` / `InstallPath`，再解析
   `steamapps/libraryfolders.vdf`，支持安装在自定义 Steam 库目录；
5. 常见默认路径（`Program Files*/Steam`、Linux/macOS 的 Steam 目录）。

检测到后在页面「官方地图 → 游戏目录」里显示，也可以直接改成任意安装路径并保存。
只想手动指定地图目录时，仍可使用 `--maps-dir <dir>`（可重复）或 `L4D2_MAPS_DIR`。例如：

```bash
node src/cli.js pairs c14 --game-dir "D:/Steam/steamapps/common/Left 4 Dead 2"
set L4D2_GAME_DIR=D:\Steam\steamapps\common\Left 4 Dead 2
```

官方图会扫描 5 个目录（共 57 张 c1–c14 地图）。

## 3. 安装与启动

```bash
cd MapStitch
npm install                    # 安装 three.js；lzma-native 为可选依赖

node src/cli.js serve          # 默认 http://localhost:8123/
# 打开页面后点「解析官方地图」（不会在服务启动时自动解析）
```

也可以提前在命令行解析（约 3 秒）：

```bash
node src/cli.js build --all
```

`build` 的产物在 `out/`：

- `out/maps/<map>.mst` — 分层三角网格（约 1–5 MB/图）
- `out/index.json` — 地图元数据、landmark、出生点，以及 c1–c14 的 43 个相邻章节对
- `out/cache/<addon>/` — 从 VPK 解包出的 `.bsp` 缓存（见下）

改过解析代码或想重新导出时加 `--force`。只导出个别章节也可以，index 会与已有内容合并：

```bash
node src/cli.js build --campaign c2
node src/cli.js build c1m1_hotel c1m2_streets --force
```

### DLC 章节（c6–c14）

官方 DLC 图分布在下面这些目录，`build --all` 现在会自动合并，不需要单独指定：

| 目录 | 战役 |
|---|---|
| `left4dead2/maps` | c1–c5 |
| `left4dead2_dlc1/maps` | c6 |
| `left4dead2_dlc2/maps` | c7、c8 |
| `left4dead2_dlc3/maps` | c9–c13 |
| `update/maps` | c14 |

章节顺序优先读取官方 VPK（`update/pak01_dir.vpk`）里的 `missions/campaign*.txt` 的 coop 列表；
读不到时按目录里的 `cNmM_*` 文件名排序。index 里每张图都记录了绝对 `source` 路径，
所以 `serve` 不需要 `--maps-dir` 也能对任意 DLC 图做 `/api/point` 落点判定。

### 创意工坊 / addon 地图

也可以直接在查看器页面完成：左侧「附加地图 / VPK」列出本机含地图的 addon（地图数、
coop 章节、是否已载入），勾选后点「解析并加入」。服务端会在后台执行同样的
`build --addon`，下方实时显示日志与进度；完成后自动刷新章节下拉并切到新战役的第一对。
多分卷 addon 同时勾选即可（例如 Journey Part 1 + Part 2）。命令行方式仍保留：

先列出本机 addons 与创意工坊内容（只做元数据扫描，不打开全部 VPK）：

```bash
node src/cli.js addons                    # 名称、类型、大小、路径
node src/cli.js addons --inspect 地图      # 顺带读 VPK 目录树，显示地图数与 coop 章节数
```

只加载选中的一个 addon（VPK 或已解包目录均可；同名时优先 `.vpk` 原件）：

```bash
node src/cli.js build --addon "Amid The Ruins"
node src/cli.js build --addon "地图ssv"
node src/cli.js build --addon "C:/.../addons/dune"        # 散装目录
```

章节顺序来自 addon 内的 `missions/<战役>.txt`：只取 `modes → coop → "1..N" → Map`，
并与 VPK 里实际存在的 `.bsp` 取交集，`map_x` 之类的占位名会被过滤。没有 missions 时
回退到 `trigger_changelevel` / `info_changelevel` 的 map+landmark 连链；两者都没有时按名称排序。

多分卷 addon 可以重复 `--addon`，例如 Journey to Splash Mountain 的地图分在两个 VPK 里：

```bash
node src/cli.js build --addon "Journey to Splash Mountain - Part 1" \\
                       --addon "Journey to Splash Mountain - Part 2"
```

只解包选中战役引用的 `.bsp`，缓存到 `out/cache/<addon名>-<hash>/maps/`，
按 VPK 的 mtime/size 自动失效；`--force` 强制重解。`serve` 启动后会按 index 里的
`source` 路径找到缓存文件，点击判定端到端可用。

只想看偏移、不解包：

```bash
node src/cli.js pairs --addon "Amid The Ruins"
node src/cli.js pairs --addon "A.vpk" --addon "B.vpk"
```

查看器下拉框里 addon 章节会显示为「附加地图 <addon 名> · <战役 id>」；也可以直接用
`?pair=atr01_trailer_park|atr02_outskirts` 打开。

## 4. 界面说明

打开页面后默认选中第一个章节对（c1m1 → c1m2），两张图自动对齐到 landmark。

| 区域 | 说明 |
|---|---|
| 官方地图 | 显示检测到的游戏目录；可修改并保存；点「解析官方地图」才会读取 57 张官方图 |
| 附加地图 / VPK | 勾选 addon 后「解析并加入」，见上一节 |
| 章节过渡 | 官方 43 个相邻章节对 + 已解析 addon 的章节对，切换后自动加载并重算偏移 |
| 上一章 / 下一章 | 分别调不透明度与线框。把 B 调低可以"透视"到 A 的几何 |
| 偏移 | 显示 `B - A` 的偏移量；下方 X/Y/Z 是 B 的**平移量**，默认 `-offset` |
| 对齐 landmark | 把 B 平移回 `-offset`，两图 landmark 重合 |
| 不平移 | B 使用原始坐标，便于核对游戏内坐标 |
| 飞行 | 速度滑块：WASD 移动的基础倍率（×0.05–×2，默认 ×0.35，自动记住） |
| 图层 | 世界几何 / 地形位移面 / 门实体 / clip 体积 / nodraw / 水面 / 天空盒 |
| 坐标定位 | 输入 A 坐标放置黄色标记，自动显示 B 坐标与落点判定 |
| 剖切 | 勾选后只显示 `Z ≤ 阈值` 的部分，滑块控制高度 |
| 右上角读数 | 点击表面后显示图层、A 坐标、B 坐标、B 落点判定 |

左侧面板宽度可拖动中间的分隔条调整（默认 380px，双击分隔条恢复默认，宽度会记住）。

**鼠标与键盘：**

| 操作 | 说明 |
|---|---|
| 左键拖动 | 环绕旋转（围绕当前注视点） |
| 中键拖动 | 平移（相机与注视点一起移动） |
| 右键拖动 | 自由视角：原地旋转摄像机朝向，位置不变 |
| 滚轮 | 缩放 |
| `W` / `S` | 沿视线水平方向前进 / 后退 |
| `A` / `D` | 左右平移 |
| `Q` / `E` | 下降 / 上升 |
| `Shift`（按住） | 加速 ×2.5 |
| `Ctrl`（按住） | 减速 ×0.4 |
| `F` | 重置视角 |

按住 WASD 会连续移动，速度随当前观察距离自动缩放（拉远时移动更快），并乘以左侧
"飞行 → 速度"滑块的倍率（默认 ×0.35，范围 ×0.05–×2，设置会记住）。觉得太快就把滑块往左拉。

> 注意：浏览器会抢占 `Ctrl+W`（关闭标签页），按 Ctrl 减速时尽量避免同时按 W；
> 精细调整推荐直接改速度滑块。

焦点在坐标输入框或下拉框里时，键盘移动自动禁用，不会误触。

### 颜色约定

| 颜色 | 含义 |
|---|---|
| 蓝色 | 上一章（A）的材质色 |
| 橙色 | 下一章（B）的材质色 |
| 黄色（半透明） | clip 体积 —— 玩家碰撞体过不去，卡墙判断的关键 |
| 红棕色 | nodraw 面（不可见但参与碰撞） |
| 蓝色半透明 | 水面 |
| 黄点 / 绿点 / 粉点 | landmark / 出生点 / changelevel 触发点 |

### 落点判定

点击（或坐标定位）后，读数面板给出：

```
B 落点判定: 在 clip 体积内 #39，距面 0
B 落点判定: 在实体几何内 #11，距面 3.2
B 落点判定: 开阔空间
```

- **clip 体积内**：落点被碰撞体挤住，是"卡住"的理想情况；
- **实体几何内**：落点在墙/地板内部，可能被引擎推出或卡住，需要游戏内实测；
- **开阔空间**：会正常站立，通常不是目标点位。

标记点会根据判定变色（黄 = clip，红 = solid，绿 = 开阔）。

## 5. 典型工作流：筛一个电击器点位

**第 1 步：拿到上一章的卡墙坐标。**
游戏内用 `sm_printspawn` 或插件输出坐标，例如 `(-1392, 5488, 1184)`。

**第 2 步：在查看器里定位。**
把坐标填进"坐标定位"（X/Y/Z），点"放置标记"。页面会自动显示：

```
A 坐标: -1392.0, 5488.0, 1184.0
B 坐标: -1024.0, 6144.0, 448.0
B 落点判定: 在 clip 体积内 #39，距面 0
```

**第 3 步：目视检查。**
打开"clip 体积"图层，用剖切看该点周围的结构；调低 A 的不透明度确认 B 的几何关系。

**第 4 步：批量验证。**
没有界面时也可以直接用命令行：

```bash
node src/cli.js check c1m1_hotel c1m2_streets -1392 5488 1184
```

输出包含 B 坐标、命中的每个 brush（solid/clip/water）、所属实体与穿透深度。

**第 5 步：游戏内实测。**
查看器只能判断"点落在什么体积里"，最终是否真的能被卡住还取决于碰撞、推挤、
移动方向和 tick 时序。建议在本地服务器/练习模式复现确认。

## 6. 命令行参考

### `pairs [campaign]`

只读实体块（addon 图只读 VPK 内的实体 lump），秒级输出偏移表：

```bash
node src/cli.js pairs
node src/cli.js pairs c3
node src/cli.js pairs --addon "Amid The Ruins"
```

### `build`

```bash
node src/cli.js build --all [--force] [--merge]
node src/cli.js build --campaign c1 [--force]
node src/cli.js build <from> <to> [landmark] [--force]
node src/cli.js build --addon <vpk或目录> [--addon ...] [--force]
```

`--out <dir>` 指定输出目录（默认 `MapStitch/out`），`--game-dir <dir>` 指定安装目录，
`--maps-dir <dir>` 指定官方地图目录（可重复）。
`build --all` 默认重建官方部分（会清掉 index 里的 addon）；加 `--merge` 则保留已有 addon，
页面上的「解析官方地图」按钮用的就是 `--all --merge`。
不带 `--addon` 时只处理官方图；带 `--addon` 时只解包选中的 addon 并合并进 index。

### `addons` / `vpk`

```bash
node src/cli.js addons [filter] [--inspect]   # 列出 addons 与 workshop/content/550
node src/cli.js vpk <file.vpk> [path前缀] [--missions]
```

`vpk` 会打印条目数、`preload` 条目统计与目录项（内嵌/分卷），用来核对 VPK 解析；
`--missions` 额外解析 VPK 内所有 missions 的 coop 章节顺序。官方 `pak01_dir.vpk` 的正确条目数是 22,273。

### `serve`

```bash
node src/cli.js serve [--port 8123] [--out <dir>]
```

`serve` 本身**不会解析任何地图**，只提供页面和 `/api/point`；官方图与 addon 都由页面按钮
按需解析。端口被占用时换一个：

```bash
node src/cli.js serve --port 8124
```

### `check`

```bash
node src/cli.js check <上一章> <下一章> <x> <y> <z>
```

示例输出：

```
landmark c1m1_c1m2_landmark  偏移 (B - A) = (368.0, 656.0, -736.0)

A 点 (-1392.0, 5488.0, 1184.0):
  开阔空间（不在任何 solid/clip/water brush 内）

B 点 = A + 偏移 = (-1024.0, 6144.0, 448.0):
  [solid] brush #11，世界几何，距最近面 0.0
  [clip ] brush #39，世界几何，距最近面 0.0

判定: B 点落在 clip 体积内 —— 卡墙传点后大概率被卡住，可用。
```

### `info`

```bash
node src/cli.js info c1m1_hotel
```

输出 BSP 版本、世界范围、面/位移/brush 数量、landmark 坐标。

### 校验位移面

```bash
node tools/check_disp.js "C:/.../left4dead2/maps"
```

对每张图检查相邻位移面共享边是否重合，RMS 应接近 0（少量重叠面除外）。

## 7. 坐标与偏移的方向

- 坐标系与游戏一致：X 东、Y 北、Z 上。
- 设 `offset = landmark_B - landmark_A`。
- 查看器默认把 B 平移 `-offset`，所以两张图的 landmark 完全重合；屏幕上的点 `p` 满足：
  `B 坐标 = p - B平移量`，默认即 `B 坐标 = p + offset`。
- 这与游戏内"下一章坐标 = 上一章坐标 + offset"完全一致。
- 若手动改过平移量，读数面板会用当前平移量重新换算，不必手动算。

## 8. 常见问题

**页面提示 `读取 index.json 失败 (404)`**
先运行 `node src/cli.js build --all`，并确认是从 `MapStitch` 目录启动 `serve`。

**`找不到地图文件: ...bsp`**
先看页面「官方地图 → 游戏目录」是否显示正确路径；不对就直接修改并保存，或设置
`--game-dir` / `L4D2_GAME_DIR`。官方图应在 `left4dead2/maps/` 下直接是 `.bsp`。
也可以用 `--maps-dir` / `L4D2_MAPS_DIR` 单独指定地图目录。

**页面一直显示「尚未解析地图」**
这是正常的初始状态：`serve` 不会自动解析。点「解析官方地图」或勾选 addon 后才会生成
`out/index.json`。

**创意工坊地图**

不需要手工解包，直接 `build --addon "名称或路径"`。解包缓存位于 `out/cache/`；
若地图的几何 lump 是 LZMA 压缩，需要可选的 lzma-native：

```bash
npm install lzma-native
```

（安装脚本可能被 npm 拦截，需要 `npm install-scripts approve lzma-native` 或允许运行安装脚本。）

**点击后没有"B 落点判定"**
说明 `/api/point` 不可用：确认页面是通过 `node src/cli.js serve` 打开的，而不是直接双击 `index.html`。

**第一次点击卡一下**
服务端首次会读取 ~30 MB 的 BSP 并建立 brush 索引，之后有缓存。

**画面空白 / 无法旋转**
确认浏览器开启了硬件加速；也可换一个支持 WebGL2 的浏览器。

**三张以上章节相连**
查看器一次只叠加两章；需要比较 c1m2 与 c1m4 时，分别打开两个相邻对查看，
或直接对相应两章运行 `build <from> <to>` 后手动配对。

## 9. 已知限制

- 不渲染 prop_static（车辆、围栏等模型只存在于 VPK 的 MDL 中，需要额外解析）；
- 只支持平移偏移。L4D2 的 180° 旋转是 `server.dll` 里硬编码的 landmark 名 `coldstream3_coldstream4` 触发的
  （本机 c13m3→c13m4 就是这种情况），当前查看器不会自动处理；需要时请等旋转功能或手动换算；
- 默认只加载用户选中的一个 addon（可重复 `--addon` 组合多分卷），不会扫描全部 addons；
- addon 没有 missions 且 changelevel 不完整时，可能漏掉最终章或只能按名称排序兜底
  （例如 Journey to Splash Mountain Part 1 的 missions 只写到 splash5，splash6 没有换关实体）；
- 少量重叠/重复的位移面会被当成"相邻边"，不影响整体地形显示；
- 点位判定基于 BSP 的 brush 平面，没有模拟玩家碰撞体尺寸（站姿/蹲姿高度、半径），
  也未经 navmesh 与引擎物理验证，最终以游戏内实测为准。

## 10. 目录结构

```
MapStitch/
├─ src/
│  ├─ bsp.js        BSP v21 读取（lump 表、实体、几何、材质、位移、brush、BSP 树）
│  ├─ gamepath.js   L4D2 安装目录检测（Steam 注册表/库目录、环境变量、页面配置）
│  ├─ vpk.js        VPK v1 读取（preload、内嵌 32767、分卷）
│  ├─ addon.js      addon 发现、missions 解析、地图配对、解包缓存
│  ├─ geometry.js   BSP → 分层网格（含位移面与 clip 凸多面体重建）
│  ├─ offset.js     landmark 偏移计算 + 官方地图目录合并
│  ├─ query.js      点是否在 brush 体积内
│  ├─ export.js     .mst 二进制格式
│  └─ cli.js        命令行入口 + 静态服务器 + /api/point
├─ web/             three.js 查看器（index.html / main.js / style.css）
├─ tools/           check_disp.js（位移面校验）、probe_brush.js（brush 重建验证）、inspect_bsp.js
├─ docs/            research.md（调研/实现记录）、manual.md（本手册）
└─ out/             build 产物（maps/*.mst、index.json、cache/）
```
