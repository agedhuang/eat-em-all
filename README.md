# Eat 'Em All — 怪诞拼贴 AR 游戏 · 项目文档 (PRD & WorkLog)

> 项目定位：Design Challenge 作品 —— 移动端优先的 Web AR 面部互动游戏
> 交付目标：面试官用手机浏览器打开链接即可上手玩，不涉及 TikTok in-app WebView 环境
> 技术栈：原生 HTML / CSS / JS + MediaPipe Face Mesh（Legacy Solutions, CDN）
> 视觉风格：新中式怪诞拼贴，高饱和度，半调网点 (Halftone)

---

## 🛠️ AI 工作流与核心工具栈 (AI Workflow & Tools)

本项目全程贯彻“AI First”工程流，大幅缩短研发周期并保证工业级交付：
*   **工程化开发：Claude Code (CLI)**
    *   *用途：* 负责 Web AR 底层逻辑、MediaPipe 接入及基于物理运动的掉落算法生成。
    *   *Skill (AI 编排)：* 采用 Markdown 预设上下文的 Vibe Coding 模式，将视觉需求转化为终端数学逻辑 (三角函数轨迹与重力算法)。
*   **视觉资产生成：即梦 AI / Midjourney**
    *   *用途：* 负责新中式怪诞风格资产量产。
    *   *Skill (AI 编排)：* 通过锁定 Prompt 关键词（粗野拼贴、半调网点）确保视觉风格高度一致，并直接剥离 Alpha 通道输出 PNG 降低后期成本。
*   **UI/UX 协同：Figma**
    *   *用途：* 游戏 UI 排版及资产命名规范制定（Figma 内部 Slash-naming 自动映射至代码端的 Kebab-case 短横线命名）。

---

## 🚀 阶段里程碑

| 阶段 | 内容 | 状态 | 日期 |
| --- | --- | --- | --- |
| M0 | 面部追踪 MVP：摄像头调用 + 张嘴检测 | ✅ 已完成 | 2026-08-02 |
| M1 | 怪诞拼贴素材层（贴纸跟随面部） | 🔀 已并入 M3 | — |
| M2 | 高阶游戏循环：独立重力 / S型飘移 / 伴星炸弹 + 单独炸弹 / 吞噬判定 | ✅ 已完成 | 2026-08-02 |
| M3 | 滤镜状态机与特效渲染：五套滤镜 + 人像抠图 + 面部变形 | ✅ 已完成 | 2026-08-03 |
| M4 | 生命周期闭环：开场 CTA / 倒计时 / 结束 / 重玩状态机 | ✅ 已完成 | 2026-08-03 |
| M5 | 性能调优、素材压缩 | ⬜ 待开始 | — |

> M1 原计划做"贴纸跟随面部"，实际在 M3 里以「跟踪型滤镜」的形式一并交付了
> （`filter-eye-*` / `filter-head-*` 跟随 landmark 做位移/缩放/旋转），
> 没有单独的 M1 阶段产物。

---

## 📝 M0 · 面部追踪 MVP（已完成）

### 交付文件
*   `index.html`: 页面骨架、移动端 meta、MediaPipe CDN 引入
*   `style.css`: 全屏铺满布局、镜像视频、中央大字与调试 UI
*   `script.js`: 摄像头调用、Face Mesh 初始化、张嘴检测与状态机

### 已实现能力
1. **移动端与相机适配**：`viewport` 设为 `user-scalable=no`, 禁用缩放；`<video>` 带 `autoplay playsinline muted`，避免 iOS Safari 劫持；`getUserMedia` 调前置摄像头，`object-fit: cover` 全屏铺满不变形。
2. **MediaPipe Face Mesh 接入**：不绘制任何网格，纯透明 canvas 预留给 UI。
3. **张嘴检测逻辑**：追踪关键点 13（上唇内侧）和 14（下唇内侧）。通过面部高度 `dist(10,152)` 进行归一化比例计算，消除远近距离影响。采用迟滞双阈值 (`> 0.075` 张嘴，`< 0.050` 闭嘴) 避免临界抖动。全局变量 `isMouthOpen` 供下一步逻辑消费。
4. **工程细节优化**：包含推理背压防内存暴涨、iOS 自动播放拦截兜底、后台页面节流。

### 本地调试方式
```bash
# 启动本地服务
python3 -m http.server 8000
# 利用内网穿透生成 HTTPS 链接，供手机扫码测试张嘴检测
npx localtunnel --port 8000
```

---

## 🎮 M2 · 掉落与吞噬（已完成）

> 设计原则：**纯加法**。M0 的摄像头调用与张嘴检测逻辑一行未改，
> 仅在 `onResults()` 内新增两处「记录嘴部中心」的钩子，其余全部是独立模块。

### 架构：双 rAF 循环

| 循环 | 频率 | 职责 |
| --- | --- | --- |
| `renderLoop()` | 受推理速度限制（约 15–30fps） | 送帧给 MediaPipe，产出 `isMouthOpen` 和嘴部坐标 |
| `gameLoop()` → `updatePhysics(dt)` | 跑满屏幕刷新率（60/120fps） | 物理、碰撞、渲染 |

拆成两个循环是有意为之：物理若被面部推理拖慢，掉落会明显卡顿。
两者通过 `isMouthOpen` / `mouthNorm` 两个全局变量解耦通信。

### 核心难点 1：坐标系换算 `videoToScreen()`

landmark 是 **0~1 的视频帧归一化坐标**，掉落物是 **CSS 屏幕像素坐标**，中间隔着两层 CSS 变换：

```
object-fit: cover  →  等比放大铺满，两侧（或上下）被裁切
transform: scaleX(-1)  →  水平镜像
```

必须在 JS 里精确复刻这两步，否则碰撞判定会整体偏移（尤其在宽高比与摄像头不一致的手机上）：

```js
const scale   = Math.max(sw / vw, sh / vh);   // cover 取较大缩放比
const offsetX = (sw - vw * scale) / 2;        // 居中裁切偏移
const x = nx * vw * scale + offsetX;
return { x: sw - x, y };                      // 最后做镜像翻转
```

### 核心难点 2：随机重力

每个组合体在生成时抽取**自己的**初速度 `vy ∈ [130, 420] px/s`，再叠加 `40 px/s²` 的重力加速度。
上下限拉到 3 倍差距，快慢节奏对比才明显。位移一律用 `dt`（秒）驱动而非「每帧固定像素」，
保证 120Hz 的 iPhone 与 60Hz 的安卓机下落速度一致。

### 生成分档：单独炸弹 / 伴星炸弹 / 普通

一次掷骰分三档，概率互斥不叠加：

```js
const roll = Math.random();
const isSoloBomb = roll < GAME.SOLO_BOMB_CHANCE;                                   // 22%
const isCombo = !isSoloBomb && roll < GAME.SOLO_BOMB_CHANCE + GAME.BOMB_COMBO_CHANCE; // 28%
// 剩下 50% 是纯普通掉落物
```

单独炸弹的中心直接就是炸弹本体、没有伴星，而且**走和普通掉落物一样的尺寸区间**
（不是伴星那个偏小的 `BOMB_SIZE`）—— 这样它在画面里的分量和别的掉落物一致，
不会一眼被认出来提前躲开。

碰撞、爆炸红闪、三件套滤镜、游戏结束全部自动复用，因为它的 `type` 和 `assetKey`
就是 `bomb`，走的是同一条分支。

> ⚠️ 当前含炸弹的组合体占到 **50%**，而吃到炸弹直接结束游戏 —— 密度偏狠，
> 真机手感不对就调低 `SOLO_BOMB_CHANCE`。

### 🐛 横向分布：可用区间曾塌成正中一条窄带

现象：掉落物"大部分挤在屏幕中间"。原因在这行边距计算：

```js
const margin = centerSize / 2 + orbitRadius + drift + 8;   // ❌
baseX: rand(margin, Math.max(margin + 1, sw - margin)),
```

它把**公转半径和飘移幅度也预留进边距**了。390 宽的手机上，伴星炸弹组合体的
margin ≈ 34 + 94 + 55 + 8 = **191**，可用区间变成 `[191, 199]` —— **只剩 8px，正好在正中**。
而那个 `Math.max(margin + 1, …)` 兜底让区间退化时不报错，把问题彻底藏住了。

各类组合体的实测区间（屏宽 390）：

| 类型 | 旧区间 | 宽度 |
| --- | --- | --- |
| 纯普通（无飘移） | [42, 348] | 306px |
| 纯普通（最大飘移） | [97, 293] | 196px |
| 伴星炸弹（最大公转 + 最大飘移） | [191, 199] | **8px** |

**修法**：边距只按「中心掉落物本体」算，伴星和飘移允许探出屏幕边缘一点 ——
视觉上完全可接受，而且伴星探出去时玩家也吃不到（嘴在屏幕内），不影响公平性。

### 泳道洗牌：让分布真的铺开

修完边距后区间是整屏了，但**纯随机仍会成团** —— 连着三四个落在同一片区域，
肉眼看着还是"挤在一起"。所以加了洗牌袋：

```js
SPAWN_LANES: 5,
// 把可用区间切成 5 条泳道，每轮洗牌后逐条用完再重洗 ——
// 保证一轮内每条泳道恰好用到一次，泳道内部仍随机，所以不显得机械
```

⚠️ **顺序很重要**：必须**先算出可用区间、再在区间内切泳道**。
反过来（先按整屏切泳道、再把越界的夹回边界）会让两侧泳道的一大半被夹到同一个值，
边缘各堆出一根柱子 —— 实测两侧密度是中间的 2 倍。

修正后 3000 次生成的分布（屏宽 390，每格 30px）：

```
  30-60  ████████████████████████████████ 230
  60-90  ████████████████████████████████████████ 287
 90-120  ████████████████████████████████████████ 287
120-150  ████████████████████████████████████████ 286
150-180  ████████████████████████████████████ 263
180-210  ████████████████████████████████████████ 289
210-240  █████████████████████████████████████ 265
240-270  ████████████████████████████████████████ 289
270-300  ██████████████████████████████████████ 272
300-330  ████████████████████████████████████████ 288
330-360  ██████████████████████████████████ 244
```

首尾各 30px 为空是刻意的 —— 那是掉落物自身的半径，再往外本体就出画了。

### 核心难点 3：伴星炸弹的圆周运动

组合体 = 居中的普通掉落物 + 绕其公转的炸弹。**世界坐标 = 组合体中心 + 圆周偏移**：

```js
e.orbit.angle += e.orbit.speed * dt;                    // 角度随时间线性推进 → 匀速
e.x = g.x + Math.cos(e.orbit.angle) * e.orbit.radius;
e.y = g.y + Math.sin(e.orbit.angle) * e.orbit.radius;
```

而 `g.y` 本身在持续下落，`g.x` 在做正弦飘移 —— 三者叠加出「螺旋下坠」的轨迹。
生成时的左右安全边距会把公转半径和飘移幅度算进去，防止炸弹转出屏幕。

### 碰撞与反馈

- 判定中心：landmark 13 与 14 的**中点**，经 `videoToScreen()` 换算 + 指数平滑（推理帧率低于渲染帧率，不插值会抖）。
- 触发条件：`距离 < 40px` **且** `isMouthOpen === true` **且** `hasFace`。
- 普通掉落物 → `.eaten`：先放大 1.25 再缩到 0.1，160ms（"被吸进去"的顿挫感）。
- 炸弹 → `.blasted` 原地爆开 + `#redFlash` 全屏红闪一次 + `navigator.vibrate(120)`。**无分数计算。**

### 工程细节 / 踩坑记录

- **CSS 动画与 JS 定位冲突**：掉落物做成「外层 div 定位 + 内层 img 表演」双层结构。
  若把缩放写在同一元素上，`transform` 会被覆盖；改用独立 `scale` 属性又会与 `translate3d` 相乘，
  导致物体缩小时朝屏幕左上角飞走。分层是唯一干净解。
- **动画重播**：连续吃到炸弹时，`classList.remove('flash')` 后必须 `void el.offsetWidth` 强制回流，
  浏览器才会认定这是一次全新动画。
- **穿透防护**：`dt` 上限 0.05s。切后台回来时若不钳制，物体单帧位移会超过 40px 判定半径直接穿过嘴。
- **性能**：定位一律走 `transform: translate3d`（GPU 合成，不触发布局重排），场上组合体上限 12 个。
- **图片预加载**：`preloadAssets()` 提前把 5 张 PNG 塞进缓存，避免首批掉落物闪白。

### 可调参数速查（`script.js` 顶部 `GAME`）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `HIT_RADIUS_R` | `0.075` | 判定半径 ÷ 屏宽。判定圈直径 = 这个值 × 2，圈和判定永远同一个数 |
| `ITEM_SIZE_MIN_R` / `MAX_R` | `0.115` / `0.175` | 掉落物直径 ÷ 屏宽 |
| `BOMB_SIZE_R` | `0.105` | 伴星炸弹直径 ÷ 屏宽 |
| `UI_MAX_WIDTH` | `560` | 尺寸换算时屏宽的上限，桌面上不至于巨大 |
| `SOLO_BOMB_CHANCE` | `0.22` | 单独炸弹出现概率 |
| `BOMB_COMBO_CHANCE` | `0.28` | 伴星炸弹出现概率 |
| `COUNTDOWN_SECONDS` | `15` | 倒计时起始秒数 |
| `FALL_SPEED_MIN/MAX` | `130 / 420` | 随机重力区间，差距越大节奏越乱 |
| `ORBIT_RADIUS_MIN_R` / `MAX_R` | `0.17` / `0.24` | 炸弹公转半径 ÷ 屏宽 |
| `ORBIT_SPEED_MIN/MAX` | `1.6 / 3.2` | 公转角速度（弧度/秒） |
| `DRIFT_AMPLITUDE_MAX_R` | `0.14` | S 型飘移摆幅 ÷ 屏宽，设 `0` 可关闭 |
| `SPAWN_MIN_MS` / `MAX_MS` | `140` / `340` | 生成间隔，调小 = 更密 |
| `SPAWN_LANES` | `5` | 横向泳道数，越多越均匀（也越机械） |
| `SPAWN_EDGE_PAD_R` | `0.015` | 左右安全边距 ÷ 屏宽 |

调试时把 `CONFIG.DEBUG` 设为 `true`，屏幕上会画出嘴部判定圆圈（张嘴变粉色实心），
可以直观看出判定点有没有对准嘴巴。上线前记得改回 `false`。

---

## 🎨 M3 · 滤镜状态机与特效渲染（已完成）

> 目标：吃到特定掉落物 → 激活对应的前景相框滤镜，且**一旦触发永久保持**。
> 同样是纯加法，M0 的面部追踪与 M2 的物理碰撞逻辑均未改动。

### 图层顺序（最终形态）

| z-index | 元素 | 说明 |
| --- | --- | --- |
| 0 | `#camera` / `#overlay` | 视频流（镜像）。**始终保留不隐藏** —— 滤镜的透明区域露出的就是它 |
| **1** | **`#filter-bg-layer`** | **`filter-bg-*` 背景滤镜 —— 在人物后面** |
| **2** | **`#personLayer`** | **人像抠图画布（背景透明）** |
| **3** | **`#eyeLayer`** | **眼睛膨胀特效** |
| **4** | **`#fxLayer`** | **皮肤焦黑（按面部轮廓 multiply）** |
| **5** | **`#filter-layer`** | **前景滤镜 —— 眼睛贴图 / 眼泪 / 头饰，在人物前面** |
| 10 | `#dropLayer` | 掉落物与炸弹 |
| 20 | `#redFlash` | 炸弹红闪 |
| 30 | `#mouthOpenText` / `#mouthMarker` / `#debug` | 文字与调试判定圈 |

滤镜层全部设 `pointer-events: none`，这是硬性要求 —— 它们全屏铺满，
若能接收事件会挡住下方一切交互（包括 iOS 那个"点击开始"兜底按钮）。

### 命名约定 `filter-<槽位>-<名字>`：同时决定图层与互斥关系

项目会有多类滤镜（背景 / 眼部贴图 / 皮肤 / 头饰），它们的图层位置不同，
且**同一位置同时只能有一个**。这两件事都从文件名解析，不需要额外配置字段：

```js
function parseFilterSlot(file) {
  const m = /^filter-([a-z0-9]+)-/i.exec(file);
  return m ? m[1].toLowerCase() : `_${file}`;  // 不符约定 → 独占专属槽位，不误替换
}
// slot === 'bg' → #filter-bg-layer（人物后面）+ 自动启动人像抠图
// 其他 slot     → #filter-layer（人物前面）
```

**槽位互斥**：吃了火锅得到 `filter-bg-hotpot`，再吃竹子 → `filter-bg-bamboo` 顶掉火锅，
两张背景不会叠在一起。以后 `filter-eye-*` 之间、`filter-head-*` 之间同理，
加新素材只要名字取对，替换逻辑一行都不用改。

```js
const activeSlots = new Map();  // slot → { key, el }

const current = activeSlots.get(slot);
if (current && current.key === key) return;  // 同一张已生效，幂等返回
container.appendChild(frame);                 // 新帧后 append → 天然叠在上面
if (current) retireFilterFrame(current.el);   // 旧帧淡出后自行移除 → 交叉溶解
activeSlots.set(slot, { key, el: frame });
```

用 `Map` 按槽位记录（而非用 `Set` 记录"哪些 key 激活过"）是这个规则的关键：
幂等判断必须是「同一张已在生效」，而不是「这张曾经激活过」——
否则火锅→竹林→火锅的顺序下，第二次的火锅会被误判为已激活而不生效。

### 人像分割抠图（背景滤镜的核心）

背景滤镜若直接盖在视频上，相框会糊在脸上。必须把人抠出来放到背景**前面**：

- 模型：`@mediapipe/selfie_segmentation`（**按需加载** —— 只有背景滤镜被激活时才初始化，
  没吃到火锅前完全不消耗算力）。
- 在 `renderLoop()` 中紧跟 Face Mesh 之后同帧运行，共用一份 `isSending` 背压保护。

合成原理靠 canvas 混合模式，三步：

```js
personCtx.clearRect(0, 0, w, h);
personCtx.filter = `blur(2.5px)`;                    // 羽化遮罩边缘，去锯齿
personCtx.drawImage(results.segmentationMask, ...);   // 1. 人形区域不透明
personCtx.filter = 'none';
personCtx.globalCompositeOperation = 'source-in';     // 2. 只保留重叠像素
personCtx.drawImage(results.image, ...);              // 3. 于是只剩人形内的视频像素
```

得到一张背景透明的人像，盖在相框之上。

### Alpha 通道：三明治结构，原始视频不隐藏

滤镜素材本身带 Alpha 通道，**透明区域必须露出用户真实的环境**。
所以原始视频始终保留在最底层，三层夹心：

```
z0  #camera      完整视频        ← 相框透明处露出的就是它（真实环境）
z1  相框(带Alpha) 不透明处盖住视频
z2  #personLayer 人像抠图        ← 盖在相框之上，人永远不被遮挡
```

早期版本曾在背景滤镜激活后把视频 `opacity: 0` 隐藏，那是错的 ——
一旦隐藏，Alpha 通道的透明区域就只剩纯黑，环境全丢。
保留视频还顺带带来一个好处：万一分割模型加载失败，画面只是没有抠图效果，人不会整个消失。

### 素材铺陈：`GAME.FILTER_FIT`

| 值 | 行为 |
| --- | --- |
| **`cover`** | **铺满整个屏幕，超出部分裁掉 —— 当前默认** |
| `contain` | 等比缩放到完整装下为止（左右或上下先顶到边就停），多余方向留白 |

在 `GAME.FILTER_FIT` 里切换，CSS 的 `.filter-frame` 只是兜底默认值。
注意人像层 `#personLayer` 用的是 `object-fit: cover` 且**不可改** ——
它必须与 `<video>` 的几何严格一致，否则抠出的人会错位。两者互不相干。

### 抠图的两个坑

1. **几何必须与 `<video>` 完全一致**：`#personLayer` 的 canvas 缓冲区尺寸对齐
   `videoWidth/videoHeight`，CSS 用同样的 `object-fit: cover` + `transform: scaleX(-1)`。
   任何一项不一致，抠出的人就会和原画面错位。
   注意人像层用的是 `cover`（必须和 video 对齐），滤镜层用的是 `contain`（视觉需求），两者互不相干。
2. **先抠到再显示**：只有 `onSegResults` 成功产出第一帧后才给 `#personLayer` 加 `.is-active`，
   否则会先闪一下空白画布。

### 关键设计：按「语义 key」而非文件名匹配

滤镜触发**不**匹配文件名或扩展名，而是匹配资产的语义标识：

```js
NORMAL_ASSETS: [
  { key: 'hotpot', file: 'asset-drop-hotpot.png' },  // ← 换成 .webp 只改 file
  ...
],
FILTERS: {
  hotpot: 'filter-bg-hotpot.webp',                   // ← 映射表，加滤镜只加一行
},
```

实体创建时记下 `assetKey`，碰撞成功后 `activateFilter(e.assetKey)`。
**这样 PNG→WebP 的格式迁移不会碰到任何触发逻辑**，也不会出现"改了文件名忘了改判断"的 404 类故障。
映射表里没有的 key 会被静默忽略，所以吃竹子/金元宝/蘑菇不会有任何副作用。

### 滤镜状态机实现

```js
const activeFilters = new Set();   // 只增不删 —— 语义就是"永久保持"

function activateFilter(key) {
  const file = GAME.FILTERS[key];
  if (!file) return;                  // 无对应滤镜
  if (activeFilters.has(key)) return; // 已激活，幂等返回
  activeFilters.add(key);
  // 建一个 .filter-frame 子元素，background-image + cover + center 铺满
}
```

用 `Set` 而不是布尔变量的两个理由：**天然幂等**（这个函数在物理循环的调用路径上，
同一滤镜反复吃到必须只生效一次，绝不能重复建 DOM）；以及后续加多种滤镜时不用改结构。

渲染用 `background-size: cover` + `background-position: center`，
与 `<video>` 的 `object-fit: cover` 行为一致，任何屏幕比例下都铺满且不变形。
入场带 0.42s 的淡入 + 轻微回缩动画（`scale 1.06 → 1`），有"相框套上来"的感觉。

### 资产格式现状

| 目录 | 格式 | 说明 |
| --- | --- | --- |
| `assets/fallenObjects/` | **仍是 PNG** | 5 个掉落物，各 20–27KB，体积可接受 |
| `assets/filter/` | 已全部 WebP | 见下表 |

掉落物迁到 WebP 时，只需改 `GAME.NORMAL_ASSETS` 里的 `file` 字段和 `BOMB_ASSET`，
触发逻辑一行都不用动（语义 key 与文件名解耦）。

滤镜素材体积（移动端首屏关注点）：

```
filter-eye-bomb       4KB
filter-eye-gold      48KB
filter-eye-mushroom  48KB
filter-head-gold    104KB
filter-head-bomb    236KB
filter-bg-bamboo    320KB
filter-bg-hotpot    636KB   ← 偏重，建议压到 300KB 以内
```

`preloadFilters()` 会提前把它们塞进缓存（避免吃到时才开始加载），
并对每张图挂 `onerror` —— 文件名写错会立刻在控制台报出来，不用靠肉眼发现"怎么没效果"。

### 眼睛膨胀搞怪特效

激活 `eye` 槽位时触发眼部区域膨胀，**贴图同步放大**。
由 `bulgeOnActivate` 按素材控制：

| 素材 | 触发膨胀 | 贴图跟着放大 |
| --- | --- | --- |
| `filter-eye-mushroom` | ✅ | ✅ 墨镜一起变大 |
| `filter-eye-gold` | ✅ | ✅ 元宝一起变大 |
| `filter-eye-bomb` | ❌ 反而会强制关闭 | ❌ |

炸弹关掉膨胀的原因：膨胀是对视频重采样放大，眼部本就模糊，放大后糊得更明显，
配上眼泪反而更难看。

⚠️ 光把 `bulgeOnActivate` 设 `false` **不够** —— 那只是"不触发"，
而膨胀一旦开启就是永久保持的。先吃蘑菇再吃炸弹，眼周会一直挂着放大效果。
所以标了 `bulgeOnActivate: false` 的素材会额外调用 `cancelEyeBulge()` 强制关闭：

```js
if (trackCfg.bulgeOnActivate === false) cancelEyeBulge();
else triggerEyeBulge();
```

`cancelEyeBulge()` 里要顺手清一次画布 —— `updateFaceFx` 在所有特效都不激活时会直接
`return`，不清的话上一帧放大的眼睛会**冻在画面上不走**。

**放大原理**：不是逐像素的鱼眼形变（那在移动端太贵），而是「局部放大镜」：
取以瞳孔为中心、半径 `r/scale` 的一小块源画面，拉伸绘制到 `2r×2r` 的离屏画布上，
再用 `destination-in` + 径向渐变把边缘羽化成软圆，最后整块贴回。
只处理眼周小块区域，不是全屏运算，手机上开销很低。

```js
bulgeCtx.drawImage(videoEl, cx - half, cy - half, half*2, half*2, 0, 0, d, d); // 源小目标大 = 放大
bulgeCtx.globalCompositeOperation = 'destination-in';
bulgeCtx.fillStyle = radialGradient(...);  // 羽化，否则会露出生硬的圆形剪贴痕
```

**Q 弹手感**靠 `easeOutBack` —— 结尾冲过头再弹回来；到位后叠加一个正弦"呼吸"持续轻微起伏。
眼镜的放大倍数是在跟踪平滑**之后**才乘上去的，否则回弹过冲会被插值抹平，弹性就没了。

**关键坑：抠图模式下必须用 `source-atop`**。特效分两条渲染路径：

| 状态 | 画在哪 | 为什么 |
| --- | --- | --- |
| 背景滤镜未激活 | 独立的 `#eyeLayer` | 直接盖在原视频上，天然无缝 |
| 背景滤镜已激活 | `onSegResults` 里用 `source-atop` 画进 `#personLayer` | 被人形遮罩裁掉 |

第二条路径若用普通的 `source-over` 画在独立层上，放大的眼周补丁会**连带真实环境一起
糊到背景滤镜上**，脸旁边露出一块圆形的穿帮。`source-atop` 限定只画在已有的人形像素上。

皮肤焦黑走的是同一条管线（都属于「重绘视频画面」），合并在 `drawFaceFx(ctx)` 里，
**焦黑排在膨胀之后** —— 反过来的话膨胀会把已熏黑的脸再放大贴一遍，眼周会冒出两个没熏黑的圆斑。

### 滤镜命名规范（后续素材必须遵守）

| 前缀（槽位） | 图层 | 渲染模式 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| `filter-bg-*` | 背景层（人后） | 全屏静态 | 替换背景，自动触发人像抠图 | ✅ hotpot / bamboo |
| `filter-eye-*` | 前景层（人前） | 跟踪双眼 | 眼部贴图，默认触发眼睛膨胀 | ✅ mushroom / gold / bomb |
| `filter-head-*` | 前景层（人前） | 跟踪头顶 | 头饰 | ✅ gold / bomb |
| `fx-skin-*` | 独立画布 | 程序化 | 皮肤特效（焦黑） | ✅ bomb |

同栏（同槽位）内的素材互相替换，跨栏可以共存 ——
即「一个背景 + 一个眼部贴图 + 一个头饰」是合法状态。

### 一个掉落物 → 多个滤镜

吃金元宝会同时戴上元宝眼和皇冠，所以 `FILTERS` 的值统一是**数组**，
每个文件按自己的文件名进各自的槽位、各自独立替换：

```js
FILTERS: {
  mushroom: ['filter-eye-mushroom.webp'],
  gold:     ['filter-eye-gold.webp', 'filter-head-gold.webp'],            // 眼部 + 头饰
  bomb:     ['filter-head-bomb.webp', 'filter-eye-bomb.webp', 'fx-skin-burn'], // 三件套
},
```

幂等判断的粒度也随之从 key 下沉到 **file**（`current.file === file`）——
否则「蘑菇墨镜 → 元宝眼 → 蘑菇墨镜」这类顺序会误判。

### 眼部两种构图：`span` 与 `pair`

同一槽位的素材构图可能完全不同：蘑菇墨镜是**一张图横跨双眼**，
金元宝是**单个物件、左右眼各贴一个**。用 `mode` 区分，两者的 `widthFactor` 都以瞳距为基准：

```js
FILTER_TRACK: {
  eye: { anchor: 'eyes', mode: 'span', widthFactor: 2.35, ... },  // 槽位默认
},
FILTER_TRACK_BY_FILE: {
  'filter-eye-gold': { mode: 'pair', widthFactor: 1.05 },         // 按素材覆盖
},
```

⚠️ **覆盖表的键必须写「不带扩展名」的文件名**。曾经写成 `filter-eye-gold.png`，
素材转成 webp 后键对不上，配置静默退回槽位默认的 `span` —— 变成一个大元宝横跨双眼。
这类 bug 不报错、只是效果不对，极难排查。现在做了两道防线：
`getTrackOverride()` 先按全名再按去扩展名的名字查，且启动时会自检并 `console.warn`
匹配不到任何素材的键。

`pair` 模式下一个滤镜会生成两个 DOM part，所以外面套了一层 `.filter-track-group`
作为「整体替换 / 整体淡出」的抓手，实际的 transform 写在每个 part 上。

### 头饰的水平偏移 `offsetXFactor`

素材的**几何中心不一定是"头"的中心**。爆炸头那张图毛发团在画面左侧、
粉色「完」星在右上，只按垂直方向定位会明显偏。所以锚点支持两个方向的偏移，
**都是沿着脸的坐标系**（歪头时跟着转，不是屏幕绝对方向）：

```js
cx: anchor.x + B.upx * off + B.rx * offX,   // off 正=向上，offX 正=向右
```

`faceBasis()` 同时给出 `up`（头顶方向）和 `r`（沿眼线的右方向）两个单位向量。

### 程序化特效 `fx-*`：皮肤焦黑

"皮肤变黑"没有图片素材，是纯运算的。但它**沿用同一套命名约定**
`fx-<槽位>-<名字>`，于是槽位互斥、替换、永久保持这些逻辑一行都不用为它开特例：

```js
bomb: ['filter-head-bomb.webp', 'filter-eye-bomb.webp', 'fx-skin-burn'],
```

激活时在 `#filter-layer` 里建一个 `display:none` 的空占位 div 当作槽位抓手，
真正的绘制在独立的 `#fxLayer` 画布上。

**画法**：面部轮廓内填**纯黑**，直接在目标画布上 `fill()`，不需要离屏画布。

```js
ctx.globalAlpha = cfg.strength * skinBurn.t;
ctx.filter = `blur(${cfg.feather}px)`;   // 蒙版模糊 = 羽化边
ctx.fillStyle = '#000';
// …描路径…
ctx.fill('evenodd');
```

> **走过的弯路**：中间做过一版「带滤镜重绘视频」——
> `ctx.filter = 'brightness(0.40) saturate(0.42) …'` 把面部区域重画一遍，
> 理论上能保留鼻梁高光、颧骨阴影，脸更立体。
> 但真机（iPad）上高光基本看不出来，而且 `ctx.filter` 要 Safari 17 才支持、
> 老设备会退化成平涂。既然要的就是纯黑剪影，直接填色更简单也更可控 ——
> **立体感全靠挖空的眼睛和嘴来交代**。离屏画布和 `fallbackColor` 一并删掉了。

**眼睛和嘴要挖空**，否则整张脸糊成一坨看不出五官。做法是蒙版路径里追加双眼环和
唇环三个子路径，用 `evenodd` 填充规则让内层环被自动抠掉：

```js
burnCtx.globalCompositeOperation = 'destination-in';
burnCtx.filter = `blur(${cfg.feather}px)`;   // 蒙版本身模糊 = 羽化边
burnCtx.beginPath();
traceRing(burnCtx, lm, FACE_OVAL, ...);                        // 外环
traceRing(burnCtx, lm, EYE_RING_L, ..., cfg.eyeHoleExpand);    // 内环 → 被抠掉
traceRing(burnCtx, lm, EYE_RING_R, ..., cfg.eyeHoleExpand);
traceRing(burnCtx, lm, LIPS_RING,  ..., cfg.mouthHoleExpand);
burnCtx.fill('evenodd');
```

挖空范围要比真实五官**略大一圈**（`traceRing` 的 `expand` 沿质心放大），
不然眼睑和唇边会残留一道黑边，看着像描了眼线。

**位置**：因为要重绘视频，就必须处理镜像和 cover 裁切 —— 所以它和眼睛膨胀
共用「视频像素空间」的画布（`#eyeLayer` / `personLayer`），几何交给 CSS。
`drawFaceFx()` 里**焦黑排在膨胀之后**：反过来的话膨胀会把已熏黑的脸再放大贴一遍，
眼周会冒出两个没熏黑的圆斑。

> 嘴部曾试过「画 ∩ 形黑色曲线」和「条带重采样液化」两版，观感都不对，已删除。
> 嘴部不做任何变形。

### 眼泪：`followsBulge` 开关

```js
'filter-eye-bomb': {
  mode: 'pair',          // 单滴眼泪 → 左右眼各挂一滴
  widthFactor: 0.3,      // 很小，约瞳距的 0.3
  offsetFactor: 0.5,     // 正数向下 → 挂在眼睛下方
  followsBulge: false,   // 眼泪本身不跟着放大，否则会变成两个大水球
  bulgeOnActivate: true, // 但眼睛照旧膨胀（和吃蘑菇一致）
},
```

`bulgeOnActivate`（是否触发眼睛膨胀）和 `followsBulge`（贴图是否跟着一起放大）
是两个独立开关 —— 眼泪需要前者开、后者关。

### 头饰锚点 `computeHeadAnchors()`

- **位置**：以额顶 landmark 10 为基点，沿「头顶方向」上移 `offsetFactor × 面部宽度`
- **宽度**：按太阳穴间距（127 ↔ 356）缩放 —— 头饰贴合的是头宽，不是瞳距
- **倾角**：**仍复用眼线** —— 太阳穴点在转头时抖动比虹膜大得多

眼镜和皇冠共用 `faceBasis()` 解算出的同一个倾角，两者永远不会出现角度不一致的穿帮。

### 两种渲染模式：全屏静态 vs 跟踪面部

槽位是否跟踪由 `GAME.FILTER_TRACK` 决定，**在表里的跟踪，不在表里的退化成全屏静态**：

```js
FILTER_TRACK: {
  eye: {
    anchor: 'eyes',      // 锚定双眼连线
    widthFactor: 2.35,   // 贴图宽度 ÷ 瞳距（素材 587px 宽、瞳距约 250px）
    offsetFactor: 0.02,  // 沿垂直于眼线方向微调，正数向下，单位同为瞳距倍数
    aspect: 587 / 253,   // 图片加载完会用真实宽高比覆盖
  },
},
TRACK_SMOOTHING: 0.004,  // 越小越跟手越抖，越大越稳越拖
```

新增头饰时，只要在这张表里加一个 `head: { anchor: 'xxx', ... }` 并写一个对应的
`computeXxxAnchor()` 即可，`activateFilter` / 槽位互斥 / 淡入淡出全部复用。

### 双眼锚点解算

用**虹膜中心 468 / 473**（`refineLandmarks: true` 才有的 478 点模型）而非眼角 33/263 ——
眼角会随眨眼和表情漂移，虹膜中心明显更稳。模型退化到 468 点时自动回落到眼角。

```js
let p = videoToScreen(a.x, a.y);   // 换算到屏幕像素空间（含 cover 裁切 + 镜像）
let q = videoToScreen(b.x, b.y);
if (p.x > q.x) [p, q] = [q, p];    // ← 关键：强制按屏幕 x 排序

const dist  = Math.hypot(dx, dy);
const width = dist * cfg.widthFactor;                  // 缩放：按瞳距
const angle = Math.atan2(dy, dx) * 180 / Math.PI;      // 旋转：头歪多少贴图歪多少
const cx = (p.x + q.x) / 2 + nx * dist * offsetFactor; // 位移：瞳孔中点 + 法向微调
```

**那行排序是必须的**：画面镜像后，哪个 landmark 落在屏幕左边并不固定。
不排序的话 `atan2` 会得到 ±180° 的反向解，墨镜会突然上下翻转。

### 跟踪平滑

`updateTrackedFilters()` 跑在物理循环（60/120fps）上，而面部推理只有 15–30fps，
不插值贴图会一顿一顿的。用与帧率无关的指数平滑：

```js
const k = 1 - Math.pow(GAME.TRACK_SMOOTHING, dt);
s.cx += (anchor.cx - s.cx) * k;
let da = anchor.angle - s.angle;      // 角度走最短弧
if (da >  180) da -= 360;
if (da < -180) da += 360;
s.angle += da * k;
```

角度必须走最短弧插值，否则 `+179° → -179°` 时贴图会整圈甩过去。
丢失人脸时加 `.is-lost` 隐藏并**清空平滑状态**，否则找回人脸时贴图会从旧位置滑过来。
隐藏用 `visibility` 而非 `display: none` —— 后者会重置内层 img 的淡入动画，每次转头都重播一次。

目前前景滤镜是「全屏静态铺满」，能满足皮肤质感这类整屏叠加的效果；
但眼部贴图和头饰需要**跟随面部关键点做位置/缩放/旋转变换**，那是下一阶段的工作。

### 可调参数（`script.js` 的 `GAME`）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `FILTER_FIT` | `'cover'` | 全屏型滤镜铺陈方式，可改 `'contain'` |
| `FILTER_TRACK.eye.widthFactor` | `2.35` | 墨镜宽度 ÷ 瞳距，嫌大就调小 |
| `FILTER_TRACK.eye.offsetFactor` | `0.02` | 墨镜上下位置，正数向下 |
| `FILTER_TRACK.head.widthFactor` | `1.42` | 皇冠宽度 ÷ 太阳穴间距 |
| `FILTER_TRACK.head.offsetFactor` | `0.34` | 皇冠上移距离，戴太低就调大 |
| `FILTER_TRACK_BY_FILE['filter-eye-gold']` | `mode:'pair', widthFactor:1.05` | 元宝单只大小；改 `mode:'span'` 可变成一个大元宝横跨双眼 |
| `TRACK_SMOOTHING` | `0.004` | 跟踪平滑，抖就调大、拖就调小 |
| `EYE_BULGE.maxScale` | `1.9` | 眼睛放大倍数 |
| `EYE_BULGE.glassesScale` | `1.5` | 眼镜同步放大倍数 |
| `EYE_BULGE.radiusFactor` | `0.44` | 放大圆半径 ÷ 瞳距，调大会连脸颊一起鼓 |
| `EYE_BULGE.feather` | `0.55` | 边缘羽化起点，看到圆形切边就调小 |
| `EYE_BULGE.pulse` | `0.055` | 到位后的呼吸幅度，`0` 关闭 |
| `FILTER_TRACK_BY_FILE['filter-head-bomb']` | `widthFactor:3.4, offsetFactor:0.18` | 爆炸头大小与高度 |
| `FILTER_TRACK_BY_FILE['filter-eye-bomb']` | `widthFactor:0.3, offsetFactor:0.5` | 眼泪大小与下垂距离 |
| `FILTER_TRACK_BY_FILE['filter-head-bomb'].offsetXFactor` | `0.28` | 爆炸头水平位置，正=向右 |
| `PROCEDURAL_FX['fx-skin-burn'].color` | `#000` | 脸的颜色，纯黑无高光 |
| `PROCEDURAL_FX['fx-skin-burn'].strength` | `1` | 不透明度 0~1，想透出点皮肤就调低 |
| `PROCEDURAL_FX['fx-skin-burn'].feather` | `14` | 轮廓羽化半径 px |
| `PROCEDURAL_FX['fx-skin-burn'].eyeHoleExpand` | `1.55` | 眼睛挖空范围，残留黑边就调大 |
| `PROCEDURAL_FX['fx-skin-burn'].mouthHoleExpand` | `1.25` | 嘴巴挖空范围 |
| `SEG_MODEL` | `1` | `0`=general(256×256, 更准) / `1`=landscape(144×256, 更快) |
| `SEG_FEATHER` | `2.5` | 遮罩边缘羽化半径 px，调大边缘更柔和；`0` 关闭 |
| `SEG_FRAME_SKIP` | `0` | 隔帧运行分割，机器发烫时设 `1` 可省一半算力 |

## ⏱️ M4 · 生命周期闭环与 UI 状态机（已完成）

### 倒计时 UI

底图 + 数字，`position: fixed` 水平居中、垂直靠上，从 **30 秒**倒数。
**init 态不显示** —— 首屏只露 CTA，第一次点击后才出现，之后（含 `over` 态）一直保持可见。

| 文件 | 用途 |
| --- | --- |
| `assets/countdown-bg.png` | 爆炸星形底图，320×328 |
| `font/MichauxTest-Regular.otf` | 数字字体，内部族名 **`Michaux Test`** |

**位置与大小只由 CSS 变量控制**，`#countdown` 里那五行改完就行：

```css
--cd-size: 34vw;       /* 整体大小。用 vw 才会随屏幕宽度缩放 */
--cd-top: 16px;        /* 距顶部（刘海安全区自动叠加，不用自己算） */
--cd-dx: 0px;          /* 水平微调，相对屏幕中线，正数往右 */
--cd-num-ratio: 0.54;  /* 数字大小 = 底图宽 × 这个比例 */
--cd-num-dy: 0.026;    /* 数字在底图内的上下微调，比例值，正数往下 */
```

#### 🐛 `aspect-ratio` 在老 iOS 上不生效

原来用 `aspect-ratio: 320 / 328` 撑高度，桌面 Chrome 正常，**手机上底图却比数字还小**。

原因：`aspect-ratio` 要 **Safari 15** 才支持。不支持时该声明被忽略，
而 `#countdown` 是 `display: flex`、没有显式高度 —— 高度于是塌成 flex 子项
（那个数字）的高度，`background-size: contain` 再把底图缩到那个高度。

改成显式 calc，所有浏览器行为一致：

```css
height: calc(var(--cd-size) * 328 / 320);
```

> 排查时顺手做了一次兼容性盘点：`inset: 0`（Safari 14.1）在项目里用了 17 处，
> 而掉落物层 `#dropLayer` 是 `inset: 0` + `overflow: hidden` 且没有显式宽高 ——
> 若 `inset` 不生效，这层会塌成 0 尺寸把所有掉落物裁掉。既然掉落物正常显示，
> 说明测试设备 `inset` 是支持的，也就把 iOS 版本圈定在 **14.x**
> （`inset` 需 14.1，`aspect-ratio` 需 15），和症状完全吻合。

#### 尺寸随屏幕宽度

CTA 和倒计时都改用 `vw`，宽屏用 media query 封顶（不用 `min()`，对老浏览器更稳、
断点也一眼可见）：

```css
@media (min-width: 600px) {
  #ctaStart  { --cta-width: 420px; }
  #countdown { --cd-size: 190px; }
}
```

实际渲染尺寸：

| 屏宽 | 倒计时底图 | 数字字号 | CTA 宽 |
| --- | --- | --- | --- |
| 375（iPhone SE） | 128×131 | 69px | 278px |
| 390（iPhone 12） | 133×136 | 72px | 289px |
| 430（Pro Max） | 146×150 | 79px | 318px |
| ≥600（桌面） | 190×195 | 103px | 420px |

字号和位移都是按 `--cd-size` 的比例算的，所以**改一个 `--cd-size`，底图和数字一起等比缩放**，
不会出现"图大了字没跟上"。

#### 为什么 `--cd-num-ratio` 要 0.5 以上

底图是爆炸星形，四周全是尖刺和透明留白。实测像素：

```
图片 320×328
中心行净空宽 209px = 整图宽的 65%
中心列净空高 202px = 整图高的 62%
黄色区中心相对图片几何中心偏移: y +2.6%   ← --cd-num-dy 的来源
```

字号是按**整图宽**算的，而字实际只能落在那 65% 的净空里，所以比例必须给大，
看起来才和黄色区域相称。上限约 `0.6`，再大两位数（15、14）会顶到尖刺内侧。

#### 计时精度

已验证：用 45–62fps 抖动模拟，计时与真实时间一致（15 秒档实测 **15.010 秒**），跳秒整齐（1.00 / 2.01 / 3.01 …）。
`dt` 取自真实时间戳、单一 rAF 循环；唯一的钳制是上限 0.05s，那只会让计时变慢不会变快。

只在整数秒变化时才写 DOM（`countdownShown` 缓存），每帧都写会白白触发文本重排。
数字用 `tabular-nums` 等宽，30 → 29、10 → 9 位数变化时不会左右跳。

### 开局门禁：等模型和素材都就绪

真机（iOS 14 / A8 级设备）上暴露的问题：**游戏都开始了，模型还没加载完、掉落物图还是白的**。
MediaPipe 的 `new FaceMesh()` 只是建对象，wasm 和模型的真正下载发生在**第一次 `send()` 内部**，
所以"构造完了"完全不等于"能用了"。

三个条件全齐才放开点击：

| 条件 | 就绪信号 |
| --- | --- |
| 摄像头 | `getUserMedia` 成功、`video.play()` 完成 |
| **面部模型** | **`onResults` 第一次被调用** —— 唯一可靠的信号 |
| 图片素材 | 掉落物 + 滤镜 + 倒计时底图全部 `onload` |

```js
// 唯一的防线在点击处
if (!readyToPlay) return;
```

加载期间底部提示显示 `loading 42%`（进度比单纯转圈更让人愿意等），
就绪后自动换成 `press anywhere to start`。

两个细节：

- **图片加载失败也算完成**（`onerror` 同样 resolve）。缺一张素材是"效果不对"，
  把玩家永久卡在 loading 才是"根本没法玩"。失败的 URL 会打到控制台。
- **30 秒兜底**（`GAME.READY_TIMEOUT`）：超时未就绪就把提示换成
  `loading failed — check network and reload`，并在控制台打出是哪一项没齐 ——
  不给解释地永远转圈是最糟的。

### 状态机

只有 `gameState` 一个真值来源，避免多个布尔标志互相打架：

```
init ──点击──> playing ──倒计时归零 / 吃到炸弹──> over ──点击──> playing
                 ↑                                            │
                 └────────────────────────────────────────────┘
```

| 状态 | 倒计时 | 生成 | 吞噬 | 物理循环 | UI |
| --- | --- | --- | --- | --- | --- |
| `init` | 停 | 停 | 停 | **不启动** | CTA + "press anywhere to start" |
| `playing` | 走 | 开 | 开 | 跑 | 无提示 |
| `over` | 冻在 0 | 停 | 停 | **继续跑** | "press anywhere to restart" |

`over` 状态下物理循环刻意不停 —— 滤镜还要继续跟着头动，玩家才能截图。
`updatePhysics` 里只用 `gameState === 'playing'` 门禁掉生成和吞噬。

### 事件监听：全程只绑一次

```js
function bindGlobalTap() {
  document.addEventListener('pointerdown', () => {
    if (!startBtnEl.classList.contains('hidden')) return;   // iOS 兜底按钮优先
    if (gameState === 'init' || gameState === 'over') startRound();
  });
}
```

**没有 addEventListener / removeEventListener 的来回切换** —— 那种写法一旦某条分支
漏了 remove 就会重复绑定，越玩越多。这里一个监听器管整个生命周期，靠状态分支。
已验证：跑完 init → playing → over → restart 全流程，`pointerdown` 监听器数恒为 1。

用 `pointerdown` 而非 `click`：移动端响应更快，不受 300ms 点击延迟影响。

### 底部提示文字

文案集中在 `GAME.HINTS`，改字只动这一处：

```js
HINTS: {
  start: 'press anywhere to start',
  restart: 'press anywhere to restart',
},
```

样式在 `#hint`，全部走 CSS 变量：

```css
--hint-bottom: 12%;          /* 距底部 */
--hint-size: 15px;           /* 字号 */
--hint-stroke: 2px;          /* 描边粗细 */
--hint-stroke-color: #000;   /* 描边颜色 */
--hint-pulse-scale: 1.09;    /* 呼吸放大倍数 */
--hint-pulse-time: 1.7s;     /* 一次呼吸时长 */
```

用**描边**而非 `text-shadow`，同样配 `paint-order: stroke fill`
（否则 `-webkit-text-stroke` 是居中描边，会往字里啃掉一半，笔画明显变细）。

⚠️ **呼吸动画的坑**：`#hint` 靠 `transform: translateX(-50%)` 居中，
关键帧里**必须带上这段 translate**，否则动画会整体覆盖 transform，文字直接跳到屏幕右半边：

```css
@keyframes hintBreathe {
  0%, 100% { transform: translateX(-50%) scale(1); }
  50%      { transform: translateX(-50%) scale(var(--hint-pulse-scale)); }
}
```

### 嘴部判定圈（正式 UI）

原本是 `CONFIG.DEBUG` 下的调试圆圈，现已升级为正式 UI：
**从 init 态就跟 CTA 一起显示，唯一不显示的情况是 `over` 态**
（那一刻的主角是玩家脸上的滤镜，不该再有判定框干扰）。

```css
--mm-border: 3px;
--mm-closed: #FF0077;                     /* 闭嘴 → 粉红虚线 */
--mm-open: #00FBFF;                       /* 张嘴 → 蓝色实线 */
--mm-open-fill: rgba(0, 251, 255, 0.25);  /* 张嘴填充 25% */
```

> 🐛 **踩过的坑**：改配色时新规则生效不了，表现为"张嘴红、闭嘴蓝"正好反色。
> 原因是 CSS 里存在**两份 `#mouthMarker` 规则**，旧的那份排在后面，
> 同特异性下后者胜出。改样式前先 `grep -n` 确认没有重复选择器。

判定圈需要在 init 态就跟着嘴动，所以**物理循环在页面加载后就启动**
（不是等第一次点击）。生成和吞噬都被 `gameState` 门禁挡着，所以 init 态画面上不会有掉落物。

### CTA 只出现一次

```js
if (!ctaConsumed) { ctaConsumed = true; ctaStartEl.remove(); }
```

用 `remove()` 从 DOM 摘掉，不是 `display: none` ——
**物理上保证** restart 时不可能再冒出来，不依赖某个 class 有没有被正确切换。

### 重玩：清什么、不清什么

`resetAllFilters()` 分三块：

1. **图片滤镜** —— `replaceChildren()` 清空两个图层 DOM，`activeSlots` / `trackedFrames` 清空
2. **面部变形** —— `eyeFx` / `skinBurn` 状态归零，`#eyeLayer` 清画布 + 摘 `is-active`
3. **人像抠图** —— 只置 `segEnabled = false` 并隐藏图层，**不销毁 SelfieSegmentation 实例**

第 3 点是个坑：销毁再重建会**重新下载一遍模型**，旧实例也不好回收。
所以 `enableSegmentation()` 加了实例复用分支：

```js
if (selfieSeg) { segEnabled = true; return; }   // 复用已加载的实例
```

已验证：restart 后再吃背景滤镜，`new SelfieSegmentation` 累计仍只调用 1 次。

### 一处帧内顺序

倒计时推进必须排在 `canEat` 计算**之前**：

```js
updateCountdown(dt);                                    // 可能在本帧归零并结束游戏
const canEat = gameState === 'playing' && ...;          // 所以要在它之后算
```

顺序反了的话，归零那一帧玩家还能再吃到一个东西。

### 尺寸全部改成屏宽比例

写死 px 的问题：同一个 `100px` 在 390 宽的手机上占 **26%**、在桌面上只占 **7%**，
手机端会显得特别大。所以尺寸类配置统一改成"占屏宽的比例"，由 `uiPx()` 换算：

```js
function uiPx(ratio) {
  const w = Math.min(stageEl.clientWidth || 390, GAME.UI_MAX_WIDTH);
  return w * ratio;
}
```

宽屏用 `UI_MAX_WIDTH: 560` 封顶 —— 不封顶的话桌面（1440 宽）上所有东西都会大到荒谬。

| 屏宽 | 掉落物 | 伴星炸弹 | 公转半径 | 判定圈直径 |
| --- | --- | --- | --- | --- |
| 375 | 43–66px | 39px | 64–90px | 56px |
| 390 | 45–68px | 41px | 66–94px | 59px |
| 430 | 49–75px | 45px | 73–103px | 65px |
| ≥560（含桌面） | 64–98px | 59px | 95–134px | 84px |

（旧的固定值：掉落物 68–104、炸弹 62、公转 68–96、判定圈 80 —— 手机上明显偏大）

**判定圈和判定半径是同一个数**（`hitRadius()`），圈变小判定必然跟着变小，
不存在"圈小了但还是老远就吃到"的说谎情况。

> 下落速度 `FALL_SPEED_MIN/MAX` 仍是 px/秒，没有跟着屏幕缩放 ——
> 屏幕越高，从上到下的时间越长。真机上如果觉得节奏不对，这里也可以改成比例。

### 掉落密度（M4 调高）

| | M2 初版 | M4 第一轮 | 当前 |
| --- | --- | --- | --- |
| `SPAWN_MIN_MS` / `SPAWN_MAX_MS` | 700 / 1500 | 260 / 620 | **140 / 340** |
| 生成速率 | 0.91 个/秒 | 2.27 个/秒 | **4.17 个/秒** |
| `MAX_GROUPS` | 12 | 22 | **34** |
| 单独炸弹 / 伴星炸弹 | — / 28% | 22% / 28% | **32% / 34%** |
| 含炸弹占比 | 28% | 50% | **66%** |

`MAX_GROUPS` 必须跟着生成速率一起抬高，否则生成再快也会被这个上限卡住，密度上不去。

30 秒内约生成 125 个组合体，其中约 83 个带炸弹。

> 早先曾担心 50% 炸弹率会让"时间到"这条路径走不到，实测手感偏简单 ——
> 判定半径只有 40px，玩家不主动去吃很难碰上。所以两轮都在加码。
> 真机上如果反过来变成秒死，调低 `SOLO_BOMB_CHANCE` / `BOMB_COMBO_CHANCE` 即可。

---

## 🧪 验证方式

这个项目没有测试框架，但有两件事已经形成习惯：

1. **`node --check script.js`** —— 只查语法，**不查引用**。
2. **桩件运行时验证** —— 用 `vm` + 手写的 DOM/Canvas/MediaPipe 桩件加载 `script.js`，
   喂一组假 landmark，然后依次调用 `activateFilter('hotpot'/'mushroom'/'gold'/'bomb')`
   和 `updatePhysics()`，确认整条路径不抛错。

第 2 条是**血的教训**：重构时曾把 `fxCanvasEl` / `fxCtx` 两行声明连带删掉，
使用它们的代码却留着。语法检查全绿，但一吃到炸弹就 `ReferenceError`，
异常从 `updatePhysics` 冒到 `gameLoop`，**rAF 链断掉整个游戏卡死**。
`node --check` 完全查不出这类问题。

## 📋 下一步（M5）

按优先级排：

**必做**
- [ ] **真机实测**：Face Mesh + Selfie Segmentation 双模型同帧运行，中低端安卓机的帧率。
      留了 `SEG_FRAME_SKIP`（设 `1` 隔帧省一半算力）和 `SEG_MODEL`（`1` 是更快的 landscape 模型）两个降级开关，桌面上看不出问题。
- [ ] **上线前**：`CONFIG.DEBUG` 改成 `false`（关掉左下角 ratio 和嘴部判定圈）。

**待定的设计决策**
- [ ] **难度平衡**：炸弹占比 50% + 掉落密度 ×2.5，导致"时间到"几乎走不到（见 M4）

**优化**
- [ ] `filter-bg-hotpot.webp` 636KB → 压到 300KB 以内
- [ ] 掉落物 PNG → WebP（只改 `GAME.NORMAL_ASSETS` 的 `file` 字段）
- [ ] MediaPipe 模型本地化（现在走 jsDelivr CDN，国内网络可能慢或被墙）

---

## 🗂️ 文件结构

```
eat-em-all/
├── index.html                    页面骨架、图层顺序、MediaPipe CDN
├── style.css                     全部样式与图层 z-index
├── script.js                     全部逻辑（面部追踪 / 物理 / 滤镜 / 特效 / 倒计时）
├── README.md                     本文档
├── font/
│   └── MichauxTest-Regular.otf   倒计时数字字体
└── assets/
    ├── countdown-bg.png          倒计时底图
    ├── fallenObjects/            5 个掉落物（PNG）
    └── filter/                   7 个滤镜素材（WebP）
```

单文件无构建、无依赖 —— 直接起静态服务就能跑，这是为了移动端首屏和部署简单刻意保持的。