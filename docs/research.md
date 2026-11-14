# MapStitch — L4D2 跨章节地图拼接可视化工具 · 调研文档

> 调研日期：2026-11-14
> 状态：已按路线 B 实现（自研 BSP 解析 + three.js 查看器），见 §8 与 README.md。
> 后续开发建议新开会话，并将本文档作为上下文起点。

## 1. 项目目标

L4D2 速通中有一种"电击器传点"操作：

- 上一章节中，玩家 A 去过关点，玩家 B 死亡，玩家 C 卡在 B 尸体旁的墙里；
- 游戏机制：玩家卡在墙里 10s 后自动传送到最近队友位置；处于过关点时立刻完成未完成的动作（打包治疗、电击器复活）；
- 让 C 在第 9s 对 B 使用电击器 → C 在 1s 后传送到过关点并立刻结算复活，触发过关；B 仍复活在原位置 `(x1, y1, z1)`；
- 下一关加载后，由于章节间坐标偏移，B 的位置变为 `(x2, y2, z2)`，可能恰好落在下一关地图的某个可用位置。

**痛点**：游戏同时只能加载一张地图，无法直观观察相邻两章在应用偏移后哪些位置重叠（即哪些点可以用这个操作）。

**目标**：读取相邻章节的地图文件，应用坐标偏移，把两张地图拼接成一张可视化整体，方便观察重叠部分，筛选可用点位。

## 2. 已有基础（本项目的前置成果）

以下工具已完成并验证，位于同一工作区：

| 文件 | 作用 |
|---|---|
| `../tools/l4d2_map_offset.js` | 离线读取 BSP 实体块计算相邻章节偏移量。已对本机 5 个官方战役全部验证。支持 `--all --json` 批量输出。 |
| `../scripting/l4d2_transition_offset.sp` | SourceMod 运行时偏移计算插件（枚举活实体 `info_landmark`）。 |
| Speedrun-Tas-Tools 的 `sm_printspawn` | 新图加载后自动输出生还者出生坐标，可交叉验证。 |

**关键技术经验**（开发时直接复用）：

1. **L4D2 的 BSP v21 头格式特殊**：lump 表从 offset **12** 开始（标准 Source 是 8，前面多一个 4 字节字段）。已在本机 `c1m1_hotel.bsp` 逐字节验证。
2. **实体块（lump 0）是明文文本**，无需反编译即可读取；几何 lump 是二进制，但同样按 lump 表定位。
3. **部分 lump 可能 LZMA 压缩**（数据以 `"LZMA"` magic 开头，13+5+8 字节头：4 字节 magic + 4 字节解压后大小 + 5 字节 props + 8 字节大小）。实体块一般不压缩；创意工坊图的几何 lump 也可能压缩，解析器要处理。Node 侧需 `npm install lzma-native`，Python 侧有现成库。
4. **不能依赖 `info_changelevel`**（Valve 官方图经常指错方向/写错地图名）；求两图 `info_landmark` targetname 交集更稳，多候选时用 changelevel 的 landmark 键消歧。
5. **偏移公式**：`offset = 下一图 landmark 坐标 - 上一图 landmark 坐标`；`新图坐标 = 旧图坐标 + offset`。
6. 零偏移真实存在（c1m3→c1m4、c4m4→c4m5 等是同一世界切分的地图）。

本机环境：游戏路径 `C:/Users/<用户名>/Home/Programs/Steam/steamapps/common/Left 4 Dead 2`（官方图在 `left4dead2/maps/` 下是散装 .bsp）；本机有 Node v24；本地代理 `127.0.0.1:<代理端口>`。

## 3. 需要读取的地图数据（分层）

游戏逻辑实体天然与几何分离（不同 lump），"不需要逻辑实体"自动满足。

| 数据 | 所在 lump | 必要性 | 说明 |
|---|---|---|---|
| 世界几何（墙/地板/安全室） | FACES / SURFEDGES / VERTEXES | **必须** | 已三角化的最终渲染面；"卡墙"的墙就是它 |
| 位移面（地形） | DISPINFO + DISP_VERTS | **必须** | 野外章节大面积 displacement，不解析则满地洞。2^n 次幂细分网格 + 每顶点位移 |
| 空气墙 playerclip | BRUSHES + BRUSHSIDES | 建议 | **不在渲染面里**（tools/playerclip 是 nodraw）。按 contents 标志（`CONTENTS_PLAYERCLIP` 等）过滤，半透明渲染正好显示"哪里能卡人" |
| 3D 天空盒 | 同几何 lumps（side flags 标记） | 可选 | 缩放 1/16，不影响重叠判断，可跳过 |
| prop_static（静态模型） | GAME_LUMP | 可选 | BSP 里只有坐标+模型索引，模型本体在 VPK 的 MDL 里；画包围盒（AABB）即可 |
| 贴图 VTF | TEXDATA（仅材质名） | 不需要 | 按材质名着色即可判断重叠 |

## 4. 三条实现路线

### 路线 A：BSPSource 反编译 + Blender（工作量最小，推荐先走）

1. 用 [BSPSource (ata4/bspsrc)](https://github.com/ata4/bspsrc) 把 BSP 反编译为 VMF。Java 实现，**官方明确支持 L4D2**（也支持 CS:GO、Portal 2；不支持 GoldSrc 和 Source 2）。支持批量与拖拽，发布包含 `bspsrc-windows.zip`（需 Java 22+）。
2. 自写 VMF→OBJ 转换器（几百行）：VMF 是文本格式，把 solid（plane 表达）转成网格。
3. 用 **Blender**（免费）打开两张 OBJ，将下一图按偏移平移，半透明叠加观察。

优点：Blender 白送自由视角、剖切、测量、透明度、逐层显隐，查看器侧零开发；BSPSource 替我们处理了 displacement 等难点。
缺点：反编译有失真（反编译器 FAQ：面可能被拆分、areaportal 位置不准等），但**几何位置基本准确**，对本用途够用；VMF 的 plane→顶点重建略繁琐。

### 路线 B：自写 BSP 解析器直接出网格（可控性最高）

直接解析 BSP 的 FACES/SURFEDGES/VERTEXES（已是编译后的三角面，比 VMF 更直接，无需 plane→brush 凸包重建）+ displacement + clip brushes，导出 OBJ/glTF，再用 Blender 或 **three.js** 网页查看。

three.js 可做交互式偏移滑块——实时拖动图 B 看重叠变化，这是 Blender 做不到的体验。预估 1000–1500 行。语言不限：Node 本机现成；Python 有现成 BSP 解析库可参考；Rust/Go 也可。

⚠️ [bspguy](https://github.com/wootguy/bspguy) 这类现成"地图拼接"工具只支持 **GoldSrc** 引擎（及其 fork [newbspguy](https://github.com/Psycrow101/newbspguy) 加了 BSP2/2PSB 支持，仍非 Source），对 L4D2 v21 无效，只能参考合并思路。

### 路线 C：游戏内验证（ground truth）

拼接图只能看几何；最终"能不能卡进去"取决于引擎碰撞、navmesh、prop 实际体积。Speedrunner Tools 已有 VScript 画线、nodraw_brush 基础设施，可在图 B 里把图 A 感兴趣的点（换算后）画 beam 标记、传送实测。

**建议闭环：A/B 找候选点位 → C 游戏内最终验证。**

## 5. 难点清单

1. **Displacement 地形**：最大坑。dispinfo 的 2^n 幂细分网格 + 每顶点位移，有固定套路但不平凡。路线 A 由 BSPSource 处理。
2. **clip/nodraw 不在渲染面里**：需解析 BRUSHES/BRUSHSIDES 按 contents 标志过滤。
3. **旋转情况**：L4D2 的换关代码（`left4dead2/bin/server.dll`）硬编码了 landmark 名 **`coldstream3_coldstream4`**，带这个名字的 `info_landmark` 会让过渡实体绕 landmark 旋转 180°。它不是通用的 `地图A_地图B` 规则——早先此处写法有误。官方图里 `c13m3_memorialbridge → c13m4_cutthroatcreek` 就用了它，可作为测试用例。叠加时是旋转矩阵而非纯平移；检测应以精确名字 + 手动覆盖为准（几何接缝打分不可靠，见 [roadmap](roadmap.md) §3）。
4. **Z 轴朝上**：Source 是 Z-up；OBJ/Blender 导出注意坐标轴，别让地图躺倒。
5. **LZMA 压缩 lump**：见 §2 第 3 条。
6. **面数**：一张 L4D2 图几十万三角形。Blender 无压力；three.js 需合并 geometry / 分块才流畅。
7. **创意工坊地图在 VPK 中**：需先用 VPKEdit 等解出 .bsp（官方图散装无此问题）。
8. **多 landmark 歧义**：如 c4（c4m2/c4m3 共享 `c4_truckstop` 和 `landmark_c4m1`）。本项目直接复用 `l4d2_map_offset.js` 的消歧逻辑。

## 6. 推进顺序

1. **第一步**：下载 BSPSource（需 Java）反编译 1–2 个战役（如 c1、c2），检查 VMF 实际结构。
2. **第二步**：写 VMF→OBJ 转换脚本，Blender 中按偏移叠加验证 c1m1+c1m2。
3. **第三步**：跑通后评估是否升级路线 B（自研解析 + three.js 交互式滑块、自动枚举候选卡墙点）。
4. **第四步**：与路线 C（游戏内实测）形成闭环。

## 7. 参考链接

- [ata4/bspsrc — Source 引擎地图反编译器（支持 L4D2）](https://github.com/ata4/bspsrc)
- [Valve Wiki — BSPSource](https://developer.valvesoftware.com/wiki/BSPSource)
- [wootguy/bspguy — GoldSrc 地图拼接工具（仅参考思路）](https://github.com/wootguy/bspguy)
- [Valve Wiki — bspguy](https://developer.valvesoftware.com/w/index.php?title=Bspguy)
- [Valve Wiki — trigger_changelevel（landmark 机制）](https://developer.valvesoftware.com/wiki/Zh/Trigger_changelevel)
- [Valve Wiki — info_changelevel（180° 旋转规则）](https://developer.valvesoftware.com/wiki/Zh/Info_changelevel)
- [twhl — Level Transitions 深度指南](https://twhl.info/wiki/page/VERC%3A_In_Depth%3A_Level_Transitions/4602)
- 本工作区偏移工具：`../tools/l4d2_map_offset.js`（`node l4d2_map_offset.js --all --json` 可直接产出本项目所需的偏移表）

## 8. 实现记录（2026-11-14，路线 B）

本机没有 Java/Python，BSPSource 路线（A）不可用，因此直接实现了路线 B 的 Node 版本，并发现官方 Lump 表与 Source 2007 不同：

### 8.1 Lump 索引修正（关键）

L4D2 v21 的 lump 枚举在 26 号之后整体比 Source 2007 **前移 4**（少了 PORTALS/CLUSTERS/PORTALVERTS/CLUSTERPORTALS）：

| Lump | Source 2007 | L4D2 实测 |
|---|---|---|
| DISPINFO | 30 | **26** |
| ORIGINALFACES | 31 | 27 |
| DISP_VERTS | 37 | **33** |
| GAME_LUMP | 39 | 35 |
| PAKFILE | 44 | **40** |
| TEXDATA_STRING_DATA / TABLE | 47 / 48 | **43 / 44** |
| FACES_HDR / MAP_FLAGS | 62 / 63 | 58 / 59 |

验证方式：各 lump 用结构体大小整除、内容特征（PK zip、prps 四字节、字符串表偏移）、以及 dipinfo 与 face 的交叉引用。

### 8.2 位移面网格映射（关键）

`dispinfo.startPosition` 是网格 `(0,0)` 角的世界坐标。网格 `(0,0)` 对应 **face 顶点中离 startPosition 最近的那个**（`baseI`），
快速索引 `i` 沿 face 顶点顺序的 `baseI+3`，行索引 `j` 沿 `baseI+1`；顶点位置 = 四角双线性插值 + `dispVec * dist`。
该项用相邻位移面共享边重合验证（`tools/check_disp.js`）：c1/c2/c3/c5 多数图 RMS < 1 单位。

### 8.3 clip 体积

`tools/clip` 面不在 FACES lump 里。从 `BRUSHES`/`BRUSHSIDES` 的平面重建凸多面体：
对每个侧面取大四边形，被其它所有平面裁剪，内部满足 `dot(n,p)-d <= 0`。
brush→model 归属用每个 dmodel 的 BSP 树遍历叶节点（NODES/LEAFS/LEAFBRUSHES）得到，从而给 brush 实体的局部坐标补上实体 origin。
官方图每张有 200–620 个 clip brush，是"卡墙"判断的核心数据。

### 8.4 产物

- `out/maps/<map>.mst`：分层三角网格（位置/法线 Float32 + 颜色 Uint8）
- `out/index.json`：地图元数据、landmark、出生点、18 个相邻章节对的偏移
- `web/`：three.js 交互查看器（偏移滑块、透明度、线框、图层、Z 剖切、点击读坐标）
- `src/cli.js check`：给定 A 坐标，输出 B 坐标及所在 solid/clip/water brush（含穿透深度）

### 8.5 未做

prop_static 包围盒、180° 旋转换关。创意工坊 VPK 解包已于同日实现（见 §8.8）。
2026-11-14 晚做过一轮可行性验证，结论和具体做法见 **[剩余需求分析](roadmap.md)**：

- 官方地图实际分布在 `left4dead2/maps`（c1–c5）、`left4dead2_dlc1/2/3/maps`（c6–c13）、`update/maps`（c14），共 57 张；
  现有查看器默认只索引 c1–c5。
- 本地 addon 均为 VPK v1；解析目录树时**必须跳过 preload 字节**，否则官方 `pak01_dir.vpk` 会从 17,646 条开始错位（正确值 22,273）。
- addon 的 `missions/<战役>.txt` 中 `modes → coop → "1..N" → Map` 给出章节顺序；官方 DLC 的 missions 在 VPK 内。
- 旋转触发是 `server.dll` 里硬编码的 `coldstream3_coldstream4`，测试用例 c13m3→c13m4。
- `prps` 静态道具数据未压缩；布局为 名字表(128B/条) → leaf 数组 → 72B/条的 prop 数组；MDL 的 `hull_min/max` 在 104/116 字节处，已从 VPK 实测取出。

### 8.6 查看器交互与修复记录（同日续）

**点击即判定落点。** 查看器点击任意表面后，前端把当前显示位置换算成 B 的局部坐标
（`B_local = 显示点 - B平移量`，默认平移量 = `-offset`），再请求本地服务的
`GET /api/point?map=<map>&x=&y=&z=`。服务端复用 `brushesAtPoint()`，返回该点所在的
solid / clip / water brush 及到最近面的距离。右上角读数面板同时显示 A/B 两套坐标与判定结果。

**鼠标映射调整。** 左键保持 OrbitControls 环绕；中键改为平移
（`controls.mouseButtons.MIDDLE = MOUSE.PAN`）；右键设为 `null`，由自定义
`lookBy(dx, dy)` 实现原地自由视角：从相机方向解出 yaw/pitch，按像素增量旋转并夹紧俯仰角，
再把 `controls.target` 沿新方向放到原距离上，从而不改变相机位置、后续左键环绕/中键平移仍正常。
右键拖动使用 pointer capture；同时屏蔽右键菜单和中键自动滚动。
CDP 实测：中键拖动使 camera 与 target 同步移动；右键拖动 camera 位移 0、朝向变化 ~0.24 rad、观察距离不变。

**键盘移动。** 增加 WASD 水平平移、Q/E 升降、Shift 加速、Ctrl 减速；每帧同时移动
`camera.position` 与 `controls.target`，保持观察角度。速度 =
`max(32, 观察距离 × 0.5) × 滑块倍率 × 修饰键`，其中滑块默认 ×0.35、范围 ×0.05–×2，
存 localStorage；Shift ×2.5、Ctrl ×0.4。焦点在 input/select/textarea 时禁用，窗口失焦时清空按键状态。
注意浏览器会抢占 Ctrl+W（关闭标签页），精细调速应以滑块为主，UI 中已提示。
顺带修掉俯视参数里的隐患：不能直接改 `camera.up`（OrbitControls 构造时已缓存 up 的四元数），
改为给相机极小的 Y 偏移来避开正上方 `lookAt` 的奇异点。

**URL 参数（便于脚本截图与复现）。**

| 参数 | 作用 |
|---|---|
| `pair=c1m1_hotel\|c1m2_streets` | 直接打开指定章节对 |
| `layers=world,disp,detail,clip` | 只显示指定图层 |
| `view=top` | 俯视 |
| `cam=x,y,z` / `target=x,y,z` | 相机位置 / 注视点 |
| `pick=x,y,z` | 按 A 坐标放置标记并触发落点判定 |

**已修 Bug：切换章节后旧 landmark 标签残留。**
原因：`disposeGroup(groupA)` 只 `clear()` 了 `groupA` 的直接子节点（地图容器 group），
而 CSS2D 标签挂在地图容器内部；容器脱离场景不会触发子对象的 `removed` 事件，
DOM 里的 `.marker-label` 因而一直保留并累积。
修复：新增 `disposeMap()`，遍历整棵子树手动移除 `CSS2DObject.element`，再清理网格、摘下 group；
同时清理上一次的点击标记并隐藏读数面板。
验证：用 Edge CDP（`--remote-debugging-port`）连续切换两对章节，读取
`document.querySelectorAll('.marker-label')`，标签始终只有当前图的两个，未累积。

### 8.7 位移面接缝回归数据

`node tools/check_disp.js <maps目录>` 对 c1–c5 全部官方图跑一遍（RMS 单位：Source 单位）：

| 地图 | disp | pairs | RMS | 备注 |
|---|---|---|---|---|
| c1m1_hotel | 43 | 40 | 0.42 | |
| c2m2_fairgrounds | 295 | 323 | 0.12 | |
| c2m5_concert | 170 | 202 | 0.25 | |
| c3m4_plantation | 1328 | 1986 | 0.27 | |
| c5m2_park | 739 | 841 | 0.03 | |
| c5m4_quarter | 714 | 938 | 0.12 | |
| c4m2_sugarmill_a | 478 | 745 | 94.6* | *少量重叠/重复位移面造成的伪相邻 |

脚本用"bad pairs（RMS > 5）/ 总 pairs < 15%"作为通过标准；伪相邻集中在
`c4m2/c4m3`、`c5m5` 等有重叠 displacement brush 的图，不影响整体曲面。

### 8.8 创意工坊 VPK 与地图发现（2026-11-14 同日实现）

新增 `src/vpk.js` 与 `src/addon.js`，CLI 增加 `addons` / `vpk` / `pairs --addon` /
`build --addon`（可重复）。关键实现与验证：

- **VPK v1**：目录项 18 字节后紧跟 `preloadBytes`，必须跳过；`archiveIndex=32767` 的内嵌数据
  从 `12 + treeSize` 起算，其它值读同目录 `<base>_NNN.vpk`。官方 `pak01_dir.vpk` 解析出
  22,273 条（5,116 条带 preload）；抽样 33 条（含分卷与 preload）用目录项 CRC32 校验全部通过。
- **不解包算偏移**：直接读 VPK 条目里的 BSP 头 + 实体 lump（`bsp.js` 导出 `parseEntityLump`/
  `decompressLump`），确定章节后才用 8 MB 分块把 `.bsp` 写到 `out/cache/<addon>-<hash>/maps/`。
  缓存按 VPK（含分卷）的 mtime/size 失效。
- **missions**：自写 KeyValues 解析，只取 `modes → coop → 数字键 → Map`；与 VPK 内实际 `.bsp`
  取交集，ssv 的 `map_x` 等占位名被过滤。官方 missions 实际全在 `update/pak01_dir.vpk`
  （campaign1–14），base pak 只有 campaign1–5。
- **配对**：missions 顺序优先；末尾若有 changelevel 指向的未收录图则向后补链；无 missions 时
  用 `trigger_changelevel`/`info_changelevel` 连链，再退化为名称排序。多分卷 addon 用重复
  `--addon` 显式组合（JTSM Part1+2 → splash1–5）。
- **index / serve**：每张图记录绝对 `source`；`build --all` 默认合并 `left4dead2/maps`、
  `left4dead2_dlc1/2/3/maps`、`update/maps`（57 图、43 对）。`serve` 用 `source` 解析
  addon 缓存和 DLC 目录，`/api/point` 无需再为每个目录单独起服务。
- **查看器入口**：页面左侧「附加地图 / VPK」通过 `GET /api/addons` 列出本机 addon
  （地图数/coop 章节/是否已载入），`POST /api/addon/build` 启动子进程执行
  `build --addon`，前端轮询 `/api/job/<id>` 显示日志与进度；完成后重新拉取 index、
  刷新章节下拉并切到新战役的第一对。
- **实测**：Amid The Ruins 4 对、splash1–5 4 对、ssv 仅注册 ssv1；解包字节数与早先临时结果一致；
  headless Edge 打开 `?pair=atr01_trailer_park|atr02_outskirts` 正常加载；页面勾选
  “地图 MOD测试地图” 后成功构建并报告 1 对偏移失败，重新构建 AtR 后自动切换到 atr01→atr02。

### 8.9 游戏目录检测与官方图按需解析（2026-11-14 同日续）

- **不再写死游戏路径**：新增 `src/gamepath.js`。优先级为 `--game-dir` / `L4D2_GAME_DIR`
  > 页面保存的 `.mapstitch.json`（git 忽略）> Steam 自动检测 > 常见路径。
  Steam 检测走 Windows 注册表 `SteamPath` / `InstallPath`，再解析
  `steamapps/libraryfolders.vdf` 的 `"path"` 条目，因此安装在自定义库目录也能找到；
  Linux/macOS 有 `~/.steam` / `~/Library/Application Support/Steam` 回退。
  本机实测自动识别为 `…/Steam/steamapps/common/Left 4 Dead 2`（来源 `Steam 库`）。
- **serve 不自动解析**：启动只打印检测到的游戏目录并提供静态页面/API。页面新增
  「解析官方地图」按钮 → `POST /api/build/official` → 子进程执行
  `build --all --merge`（保留已解析 addon），完成后刷新 index 并切到 c1m1。
- **页面可改路径**：`POST /api/game-dir` 校验并保存 `.mapstitch.json`，接受游戏根目录、
  `left4dead2` 或 `left4dead2/maps` 三种写法；保存后需再点一次解析官方地图。
- **无 index 启动**：`index.json` 不存在时页面不再报错，而是显示“尚未解析地图”，
  官方按钮与 addon 列表仍可用（用临时 `--out` 目录实测）。
