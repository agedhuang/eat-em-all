/**
 * Eat 'Em All — 怪诞拼贴 AR 游戏
 * MVP 阶段：移动端摄像头调用 + MediaPipe Face Mesh 张嘴检测
 *
 * 检测原理：
 *   取面部 Landmark 13（上嘴唇内侧）与 14（下嘴唇内侧），
 *   计算两点的像素距离，再除以「面部高度」做归一化，
 *   这样无论用户离镜头远近、屏幕比例如何，阈值都保持稳定。
 */

// ===================== 配置区 =====================
const CONFIG = {
  // 上嘴唇内侧 / 下嘴唇内侧
  LIP_UPPER_INNER: 13,
  LIP_LOWER_INNER: 14,
  // 面部高度参考点：额头顶端(10) 与 下巴尖(152)，用于归一化
  FACE_TOP: 10,
  FACE_BOTTOM: 152,

  // 张嘴阈值（嘴唇间距 / 面部高度）。
  // 双阈值形成迟滞区间（hysteresis），避免临界点疯狂闪烁。
  OPEN_THRESHOLD: 0.075,   // 大于此值 → 判定张嘴
  CLOSE_THRESHOLD: 0.050,  // 小于此值 → 判定闭嘴

  // 期望的摄像头分辨率（移动端竖屏，浏览器会自动就近匹配）
  VIDEO_WIDTH: 640,
  VIDEO_HEIGHT: 480,

  // 左下角的调试文字：未开局时显示启动耗时明细，开局后显示张嘴比例。
  // 上线关掉。排查加载慢 / 张嘴阈值不准时改回 true 即可（手机上看不了控制台，
  // 这块屏幕文字是唯一的诊断出口）。
  DEBUG: false,
};

// ===================== DOM 引用 =====================
const videoEl     = document.getElementById('camera');
const overlayEl   = document.getElementById('overlay');
const statusEl    = document.getElementById('status');
const startBtnEl  = document.getElementById('startBtn');
const debugEl     = document.getElementById('debug');
const countdownNumEl = document.getElementById('countdownNum');
const countdownEl = document.getElementById('countdown');
const ctaStartEl  = document.getElementById('ctaStart');
const hintEl      = document.getElementById('hint');

// ===================== 全局状态 =====================
/** 当前是否处于张嘴状态（后续游戏逻辑的核心开关） */
let isMouthOpen = false;
/** 当前帧的张嘴比例，供调试与后续判定强度使用 */
let mouthRatio = 0;
/** 是否已经检测到人脸 */
let hasFace = false;

let faceMesh = null;
let mediaStream = null;
let rafId = null;
let isSending = false; // 防止上一帧还没推理完就塞入下一帧

// ===================== 工具函数 =====================
function setStatus(text) {
  if (!text) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.textContent = text;
}

/** 让 canvas 的像素尺寸与视频真实分辨率对齐（预留给后续贴纸绘制） */
function resizeOverlay() {
  if (!videoEl.videoWidth) return;
  overlayEl.width = videoEl.videoWidth;
  overlayEl.height = videoEl.videoHeight;
}

/** 计算两个 landmark 在「视频像素空间」中的欧氏距离（消除画面宽高比影响） */
function pixelDistance(a, b, width, height) {
  const dx = (a.x - b.x) * width;
  const dy = (a.y - b.y) * height;
  return Math.hypot(dx, dy);
}

// ===================== 摄像头启动 =====================
async function startCamera() {
  // 安全上下文检查：getUserMedia 只在 https 或 localhost 下可用
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('当前浏览器不支持摄像头，或页面不是 HTTPS / localhost 环境');
    return false;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user', // 前置摄像头
        width:  { ideal: CONFIG.VIDEO_WIDTH },
        height: { ideal: CONFIG.VIDEO_HEIGHT },
      },
    });
  } catch (err) {
    console.error('[camera] getUserMedia 失败:', err);
    if (err.name === 'NotAllowedError') {
      setStatus('摄像头权限被拒绝，请在浏览器设置中允许后刷新页面');
    } else if (err.name === 'NotFoundError') {
      setStatus('没有找到可用的摄像头设备');
    } else {
      setStatus('摄像头启动失败：' + err.name);
    }
    return false;
  }

  videoEl.srcObject = mediaStream;

  // 等待视频元数据就绪，拿到真实分辨率
  await new Promise((resolve) => {
    if (videoEl.readyState >= 1) return resolve();
    videoEl.onloadedmetadata = () => resolve();
  });

  try {
    // iOS 上 autoplay 偶尔仍会被拦截，这里显式 play() 并在失败时引导用户手势
    await videoEl.play();
  } catch (err) {
    console.warn('[camera] 自动播放被拦截，等待用户手势:', err);
    setStatus('请点击下方按钮开启相机');
    startBtnEl.classList.remove('hidden');
    startBtnEl.onclick = async () => {
      await videoEl.play();
      startBtnEl.classList.add('hidden');
      setStatus('');
    };
  }

  resizeOverlay();
  return true;
}

// ===================== Face Mesh 初始化 =====================
function initFaceMesh() {
  faceMesh = new FaceMesh({
    // 模型与 wasm 资源同样走 CDN
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`,
  });

  faceMesh.setOptions({
    maxNumFaces: 1,            // MVP 只追踪一张脸，性能最优
    refineLandmarks: true,     // 精修唇部/眼部关键点，让 13/14 更准
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  faceMesh.onResults(onResults);
}

// ===================== 每帧结果回调 =====================
function onResults(results) {
  // 能进到这里就说明 wasm + 模型都已加载完并跑出结果了。
  // 这是唯一可靠的"模型就绪"信号 —— new FaceMesh() 只是建对象，
  // 真正的下载和初始化发生在第一次 send() 的内部。
  if (!trackingReady) {
    trackingReady = true;
    bootMark('firstFrame');
    checkReady();
  }

  const faces = results.multiFaceLandmarks;

  if (!faces || faces.length === 0) {
    hasFace = false;
    mouthNorm.valid = false;  // [M2] 丢脸时让碰撞判定立即失效，避免用旧坐标误吃
    latestLandmarks = null;   // [M3] 跟踪型滤镜同步隐藏，避免贴图停在半空
    updateMouthUI(false);
    if (CONFIG.DEBUG) debugEl.textContent = 'no face';
    return;
  }

  hasFace = true;
  const landmarks = faces[0];
  latestLandmarks = landmarks; // [M3] 供跟踪型滤镜（眼镜/头饰）在物理循环里取用

  const w = videoEl.videoWidth  || CONFIG.VIDEO_WIDTH;
  const h = videoEl.videoHeight || CONFIG.VIDEO_HEIGHT;

  const upperLip = landmarks[CONFIG.LIP_UPPER_INNER];
  const lowerLip = landmarks[CONFIG.LIP_LOWER_INNER];

  // [M2] 记录「嘴部判定中心」= 13 与 14 的中点（仍是视频归一化坐标，
  //      具体换算成屏幕像素放在物理循环里做，这样窗口尺寸变化也能自适应）
  mouthNorm.x = (upperLip.x + lowerLip.x) / 2;
  mouthNorm.y = (upperLip.y + lowerLip.y) / 2;
  mouthNorm.valid = true;

  // 1) 上下内唇的开合距离
  const mouthGap = pixelDistance(
    landmarks[CONFIG.LIP_UPPER_INNER],
    landmarks[CONFIG.LIP_LOWER_INNER],
    w, h
  );

  // 2) 面部高度作为归一化基准（人离镜头越近，这个值越大）
  const faceHeight = pixelDistance(
    landmarks[CONFIG.FACE_TOP],
    landmarks[CONFIG.FACE_BOTTOM],
    w, h
  );

  mouthRatio = faceHeight > 0 ? mouthGap / faceHeight : 0;

  // 3) 迟滞判定：张开用高阈值，闭合用低阈值，中间区维持原状态
  let next = isMouthOpen;
  if (!isMouthOpen && mouthRatio > CONFIG.OPEN_THRESHOLD) {
    next = true;
  } else if (isMouthOpen && mouthRatio < CONFIG.CLOSE_THRESHOLD) {
    next = false;
  }
  updateMouthUI(next);

  if (CONFIG.DEBUG) {
    // 还没开局时，这块地方先用来显示启动耗时明细，方便真机上定位加载瓶颈
    debugEl.textContent = gameState === 'init'
      ? bootSummary()
      : `ratio ${mouthRatio.toFixed(3)} | ${isMouthOpen ? 'OPEN' : 'closed'}`;
  }

  // MVP 阶段不绘制面部网格，overlay 保持纯净
  // 后续拼贴素材可在这里通过 overlayEl.getContext('2d') 绘制
}

/** 更新张嘴状态（判定圈的配色由 updateMouthMarker 每帧同步） */
function updateMouthUI(open) {
  if (open === isMouthOpen) return;
  isMouthOpen = open;
}

// ===================== 主渲染循环 =====================
async function renderLoop() {
  // 视频有新帧且上一帧推理已完成时才送入模型，避免堆积掉帧
  if (videoEl.readyState >= 2 && !isSending) {
    isSending = true;
    try {
      await faceMesh.send({ image: videoEl });
      // [M3] 背景滤镜激活后，同一帧顺带跑一次人像分割（未激活时是空操作）
      await runSegmentation();
    } catch (err) {
      console.error('[faceMesh] 推理失败:', err);
    }
    isSending = false;
  }
  rafId = requestAnimationFrame(renderLoop);
}

// ===================== 入口 =====================
async function main() {
  if (typeof FaceMesh === 'undefined') {
    setStatus('MediaPipe 库加载失败，请检查网络后刷新');
    return;
  }

  // 模型要下 5MB 出头（wasm 1.7MB + 模型数据 3.4MB，均已 gzip）。
  // 必须在请求摄像头「之前」就把下载踢起来 ——
  // 权限弹窗停留多久完全取决于玩家手速，那段时间不该白等。
  // initialize() 就是把原本藏在首次 send() 内部的加载提前显式触发。
  initFaceMesh();
  const modelLoading = faceMesh.initialize
    ? faceMesh.initialize().catch((e) => console.error('[BOOT] 模型加载失败:', e))
    : Promise.resolve();

  setStatus('正在请求摄像头权限…');
  const ok = await startCamera();
  if (!ok) return;

  bootMark('camera');
  setStatus('正在加载面部追踪模型…');
  await modelLoading;
  bootMark('model');

  renderLoop();

  // 模型首帧加载需要一点时间，给个短暂提示后隐藏状态条
  setTimeout(() => setStatus(''), 1500);
}

// 页面切到后台时释放算力，回到前台再恢复
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    stopGameLoop(); // [M2] 物理循环一并暂停
  } else if (!rafId && faceMesh) {
    renderLoop();
    // init 态还没开局，别把物理循环拉起来
    if (gameState !== 'init') startGameLoop();
  }
});

// 屏幕旋转 / 尺寸变化时同步 canvas
window.addEventListener('resize', resizeOverlay);


/* =====================================================================
 *  M2 · 掉落与吞噬（以下均为新增模块，不改动上方任何面部追踪逻辑）
 *
 *  三个核心难点：
 *   1. 坐标系换算：landmark 是「视频帧归一化坐标」，掉落物是「屏幕像素坐标」，
 *      中间隔着 object-fit:cover 的裁切和 scaleX(-1) 的镜像 → videoToScreen()
 *   2. 独立重力：每个掉落物生成时抽一个自己的下落速度，制造节奏差
 *   3. 伴星炸弹：炸弹用 cos/sin 绕中心掉落物做匀速圆周运动，
 *      整个组合体再整体下落 → 世界坐标 = 组合体中心 + 圆周偏移
 * ===================================================================== */

// ===================== M2 配置区 =====================
const GAME = {
  // ---- 素材 ----
  // key 是「语义标识」，滤镜触发靠它匹配，与文件名/格式解耦。
  // 以后 PNG 换成 WebP，只改 file 字段即可，触发逻辑一行都不用动。
  ASSET_DIR: './assets/fallenObjects/',
  NORMAL_ASSETS: [
    { key: 'bamboo',   file: 'asset-drop-bamboo.webp'   },
    { key: 'gold',     file: 'asset-drop-gold.webp'     },
    { key: 'hotpot',   file: 'asset-drop-hotpot.webp'   },
    { key: 'mushroom', file: 'asset-drop-mushroom.webp' },
  ],
  BOMB_ASSET: 'asset-drop-bomb.webp',

  // ---- 生成节奏 ----
  SPAWN_MIN_MS: 140,        // 两次生成之间的最短间隔
  SPAWN_MAX_MS: 340,        // 最长间隔
  // 上限也要一起抬高，否则生成再快也会被这个数卡住，密度上不去
  MAX_GROUPS: 34,           // 屏幕上同时存在的组合体上限（性能保护）
  // 横向分布：把屏幕切成若干泳道，用「洗牌袋」轮流取 ——
  // 纯随机会成团，肉眼看着就是"都挤在中间"。泳道数越多越均匀、也越机械
  SPAWN_LANES: 5,
  SPAWN_EDGE_PAD_R: 0.015,  // 左右安全边距 ÷ 屏宽，只保证本体不贴边
  // 下面两个概率互斥、共用一次掷骰，剩余的部分才是纯普通掉落物。
  // 当前 = 32% 单独炸弹 + 34% 伴星炸弹 + 34% 普通
  SOLO_BOMB_CHANCE: 0.24,   // 生成「单独一颗炸弹」的概率
  BOMB_COMBO_CHANCE: 0.24,  // 生成「伴星炸弹组合体」的概率

  // ---- 随机重力（px / 秒）----
  // 上下限拉得比较开，才能让不同物品的下落节奏产生明显快慢差异
  FALL_SPEED_MIN: 130,
  FALL_SPEED_MAX: 420,
  GRAVITY_ACCEL: 40,        // 轻微加速度，越掉越快，手感更"重"

  // ---- S 型横向飘移（不需要可设 DRIFT_AMPLITUDE_MAX_R: 0）----
  DRIFT_AMPLITUDE_MIN_R: 0, // 横向摆幅 ÷ 屏宽
  DRIFT_AMPLITUDE_MAX_R: 0.14,
  DRIFT_FREQ_MIN: 0.4,      // 摆动频率 Hz
  DRIFT_FREQ_MAX: 1.0,

  /* ---- 尺寸：全部按屏幕宽度的比例给，不写死 px ----
     写死 px 的话，同一个 100px 在 390 宽的手机上占 26%、在桌面上只占 7%，
     手机端会显得特别大。所以统一改成"占屏宽的比例"，由 uiPx() 换算。
     宽屏用 UI_MAX_WIDTH 封顶，否则桌面上会大到离谱。 */
  UI_MAX_WIDTH: 560,        // 尺寸换算时屏宽的上限
  ITEM_SIZE_MIN_R: 0.115,   // 掉落物直径 ÷ 屏宽
  ITEM_SIZE_MAX_R: 0.175,
  BOMB_SIZE_R: 0.105,       // 伴星炸弹直径 ÷ 屏宽
  SPIN_SPEED_MAX: 60,       // 掉落物自转角速度上限（度 / 秒），与尺寸无关

  // ---- 伴星炸弹的圆周运动 ----
  ORBIT_RADIUS_MIN_R: 0.17, // 公转半径 ÷ 屏宽
  ORBIT_RADIUS_MAX_R: 0.24,
  ORBIT_SPEED_MIN: 1.6,     // 角速度（弧度 / 秒），约 0.25 圈/秒
  ORBIT_SPEED_MAX: 3.2,     // 约 0.5 圈/秒

  // ---- 吞噬判定 ----
  // 判定半径 ÷ 屏宽。嘴部判定圈的直径 = 这个值 × 2，
  // 圈和判定永远是同一个数，圈变小判定也跟着变小
  HIT_RADIUS_R: 0.075,
  DESPAWN_MARGIN: 140,      // 掉出屏幕下方这么多像素后回收

  // ---- 倒计时 ----
  COUNTDOWN_SECONDS: 30,    // 从多少秒开始倒数

  // ---- 底部提示文案（★ 改文字就在这里 ★）----
  HINTS: {
    loading: 'loading',
    failed: 'loading failed — check network and reload',
    start: 'press anywhere to START',
    restart: 'press anywhere to RESTART',
  },
  // 素材 + 模型都没就绪超过这么久，就认定失败并提示刷新（秒）
  READY_TIMEOUT: 30,

  // ---- M3 滤镜 ----
  // 「吃到某个 key 的掉落物 → 激活对应滤镜」的映射表。
  // 表里没有的 key 不触发任何滤镜，之后加新滤镜只要在这里加一行。
  //
  // 命名约定 `filter-<槽位>-<名字>` 同时决定「图层」和「互斥关系」：
  //   filter-bg-*   → 背景层（人物后面，自动启动人像抠图）
  //   filter-eye-*  → 前景层（人物前面）
  //   filter-head-* → 前景层
  // 同一槽位同时只能有一个滤镜生效，新的会替换旧的。
  // 一个掉落物可以同时激活多个滤镜（吃金元宝 → 元宝眼 + 皇冠），
  // 所以值统一写成数组。它们各自按文件名进自己的槽位、各自独立替换。
  FILTER_DIR: './assets/filter/',
  FILTERS: {
    hotpot:   ['filter-bg-hotpot.webp'],
    bamboo:   ['filter-bg-bamboo.webp'],
    mushroom: ['filter-eye-mushroom.webp'],
    gold:     ['filter-eye-gold.webp', 'filter-head-gold.webp'],
    // `fx-` 开头的不是图片，是程序化特效（见 PROCEDURAL_FX），
    // 但它一样走 `fx-<槽位>-<名字>` 的命名，所以能复用槽位互斥的全套逻辑
    bomb:     ['filter-head-bomb.webp', 'filter-eye-bomb.webp', 'fx-skin-burn'],
  },

  // 滤镜素材的铺陈方式（仅作用于全屏型滤镜）：
  //   'cover'   —— 铺满整个屏幕，超出部分裁掉
  //   'contain' —— 等比缩放到完整装下为止（左右或上下先顶到边就停），多余方向留白
  FILTER_FIT: 'cover',

  // 跟踪型滤镜的槽位配置。
  // 出现在这张表里的槽位 → 贴图跟随面部关键点做位移/缩放/旋转；
  // 不在表里的槽位 → 退化成全屏静态铺满（如背景 bg）。
  FILTER_TRACK: {
    eye: {
      anchor: 'eyes',      // 锚定双眼连线
      mode: 'span',        // 'span' = 一张图横跨双眼；'pair' = 每只眼睛各一张
      widthFactor: 2.0,   // 贴图宽度 ÷ 瞳距。素材本身 587px 宽、瞳距约 250px → 2.35
      offsetFactor: 0.02,  // 沿"垂直于眼线"方向微调，正数向下，单位同样是瞳距的倍数
      followsBulge: true,  // 眼睛膨胀时贴图跟着一起变大
      bulgeOnActivate: true, // 激活时触发眼睛膨胀。眼泪这类"负面"素材可按文件关掉
    },
    head: {
      anchor: 'head',      // 锚定额顶 + 面部宽度
      widthFactor: 2.4,   // 贴图宽度 ÷ 太阳穴间距。皇冠要比头略宽才不显小气
      offsetFactor: 0.34,  // 沿"头顶方向"上移，单位为太阳穴间距的倍数
      followsBulge: false, // 皇冠不参与眼睛膨胀
    },
  },

  // 按「素材」覆盖上面的槽位默认值。
  // 同一槽位的不同素材构图差别很大（横跨式墨镜 vs 单个元宝），必须能分别配。
  //
  // 键写「不带扩展名」的文件名 —— 这样 png ↔ webp 换格式时不会因为
  // 键对不上而静默退回槽位默认值（那种 bug 不报错，只是效果不对，很难查）。
  FILTER_TRACK_BY_FILE: {
    'filter-eye-gold': {
      mode: 'pair',        // 元宝是单个的 → 左右眼各贴一个
      widthFactor: 0.7,   // 'pair' 模式下宽度仍以瞳距为基准
      offsetFactor: 0.0,
    },
    'filter-eye-bomb': {
      mode: 'pair',        // 单滴眼泪 → 左右眼各挂一滴
      widthFactor: 0.3,    // 眼泪很小，约瞳距的 0.3
      offsetFactor: 0.5,   // 正数向下 → 挂在眼睛下方
      followsBulge: false, // 眼泪不跟着眼睛一起膨胀，否则会变成两个大水球
      // 炸弹不触发眼睛膨胀：膨胀是对视频重采样放大，眼部本就模糊，
      // 放大后糊得更明显，配上眼泪反而更难看
      bulgeOnActivate: false,
    },
    'filter-head-bomb': {
      widthFactor: 2.8,    // 爆炸头要盖住整个脑袋，比皇冠大不少
      offsetFactor: 0.25,  // 正 = 向上。素材重心偏下，上移量比皇冠小
      // 正 = 向屏幕右。这张图的毛发团在画面左侧、粉色「完」星在右上，
      // 图片几何中心并不是"头"的中心，所以要把整张图往右推一点才正
      offsetXFactor: 0.28,
    },
  },

  // 程序化特效（不是图片素材）。命名同样走 `fx-<槽位>-<名字>`，
  // 这样它们也能享受槽位互斥、替换、永久保持的同一套逻辑。
  PROCEDURAL_FX: {
    'fx-skin-burn': {
      // 纯黑剪影，不保留高光。
      //
      // 曾经做过"带滤镜重绘视频"的版本（brightness/saturate 压暗，保留明暗层次），
      // 但真机上高光基本看不出来，而且 ctx.filter 要 Safari 17 才支持、
      // 老设备会退化。既然要的就是纯黑，直接填色更简单也更可控 ——
      // 立体感全靠挖空的眼睛和嘴来交代。
      color: '#000',
      strength: 1,              // 不透明度 0~1
      // 0 = 硬边纯黑剪影（要的就是抽象感）。想要柔边就填个 px 值
      feather: 0,
      duration: 0.45,           // 渐显时长（秒）
      // 眼睛和嘴要留出来不涂黑。挖空范围比真实五官略大一圈，
      // 否则眼睑和唇边会残留一道黑边，看着像描了眼线
      eyeHoleExpand: 1.55,
      mouthHoleExpand: 1.25,
    },
  },

  // 跟踪平滑强度：越小越跟手但越抖，越大越稳但越"拖"。取值 0~1
  TRACK_SMOOTHING: 0.004,

  // ---- 眼睛膨胀搞怪特效（吃到蘑菇时触发）----
  EYE_BULGE: {
    maxScale: 1.9,       // 眼部区域最大放大倍数
    glassesScale: 1.5,   // 眼镜同步放大倍数
    radiusFactor: 0.44,  // 放大圆半径 ÷ 瞳距。调大 = 连带脸颊一起鼓
    feather: 0.55,       // 从半径的这个比例开始向外羽化，避免生硬的圆形切边
    duration: 0.62,      // 膨胀动画时长（秒），带回弹过冲
    pulse: 0.055,        // 到位后持续"呼吸"的幅度，0 = 关闭
    pulseSpeed: 2.2,     // 呼吸频率
  },

  // ---- 人像分割（背景滤镜专用）----
  SEG_MODEL: 0.5,        // 0 = general(256×256 更准) / 1 = landscape(144×256 更快)
  SEG_FEATHER: 1,    // 遮罩边缘羽化半径(px)，消除生硬的锯齿描边；0 = 关闭
  SEG_FRAME_SKIP: 0,   // 每隔几帧跑一次分割，机器发烫可调成 1（隔帧）
};

// ===================== M2 DOM 引用 =====================
const stageEl        = document.getElementById('stage');
const filterBgLayerEl = document.getElementById('filter-bg-layer');
const filterLayerEl  = document.getElementById('filter-layer');
const personCanvasEl = document.getElementById('personLayer');
const personCtx      = personCanvasEl.getContext('2d');
const eyeCanvasEl    = document.getElementById('eyeLayer');
const eyeCtx         = eyeCanvasEl.getContext('2d');
const dropLayerEl    = document.getElementById('dropLayer');
const redFlashEl    = document.getElementById('redFlash');
const mouthMarkerEl = document.getElementById('mouthMarker');

// ===================== M2 全局状态 =====================
/** 嘴部中心（视频归一化坐标）。由 onResults() 每次推理后写入 */
const mouthNorm = { x: 0.5, y: 0.5, valid: false };
/** 嘴部中心（屏幕像素坐标），物理循环里每帧换算 + 平滑 */
const mouthPos = { x: 0, y: 0, ready: false };
/** 最近一帧完整的面部关键点，跟踪型滤镜（眼镜/头饰）从这里取锚点 */
let latestLandmarks = null;

/** 当前场上所有「组合体」。单个掉落物也视为只有一个成员的组合体 */
const groups = [];

/**
 * 游戏状态机。只有这一个真值来源，避免多个布尔标志互相打架。
 *   'init'    —— 页面刚打开，显示 CTA，倒计时和生成都不跑
 *   'playing' —— 正在玩
 *   'over'    —— 已结束（倒计时归零或吃到炸弹）
 *
 * 注意 'over' 状态下物理循环「不停」—— 滤镜还要继续跟着头动，
 * 只是不再生成、不再吞噬。
 */
let gameState = 'init';

/** CTA 开场图是否已经用掉。用掉后永不再现，restart 直接进游戏 */
let ctaConsumed = false;

/* ---- 启动耗时打点。加载慢时用来定位是哪一段在拖，别靠猜 ---- */
const bootT0 = (typeof performance !== 'undefined' && performance.now)
  ? performance.now() : 0;
const bootMarks = {};
function bootMark(name) {
  bootMarks[name] = Math.round(
    ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : 0) - bootT0
  );
}
/** 一行摘要，控制台和屏幕上都用它 —— 手机上看不了控制台 */
function bootSummary() {
  const m = bootMarks;
  const f = (k) => (m[k] === undefined ? '…' : m[k] + 'ms');
  return `图片 ${f('images')} | 相机 ${f('camera')} | 模型 ${f('model')} | 首帧 ${f('firstFrame')} | 就绪 ${f('ready')}`;
}

/**
 * 开局门禁。三者全齐才允许点击开始 ——
 * 否则会出现"游戏都开始了、掉落物图还是白的、面部追踪还没上线"的情况。
 */
let imagesReady = false;   // 所有图片素材（掉落物 + 滤镜）已下载
let trackingReady = false; // Face Mesh 已吐出第一帧结果（= 模型真的加载完了）
let readyToPlay = false;   // 上面两个都齐了

/** 倒计时剩余秒数（浮点，显示时向上取整） */
let countdownLeft = GAME.COUNTDOWN_SECONDS;
/** 上一次写进 DOM 的整数秒，避免每帧都碰 DOM */
let countdownShown = -1;

let gameRafId = null;
let lastFrameTs = 0;
let spawnTimer = 0;      // 距离下次生成还剩多少毫秒
let elapsed = 0;         // 累计运行时间（秒），用于 S 型飘移的相位

// ===================== 通用小工具 =====================
const rand    = (min, max) => min + Math.random() * (max - min);

/**
 * 比例 → 像素。基准是屏幕宽度，但用 UI_MAX_WIDTH 封顶 ——
 * 不封顶的话桌面上（1440 宽）所有东西都会大到荒谬。
 */
function uiPx(ratio) {
  const w = Math.min(stageEl.clientWidth || 390, GAME.UI_MAX_WIDTH);
  return w * ratio;
}

/** 当前的吞噬判定半径（px）。判定圈直径就是它的两倍 */
function hitRadius() {
  return uiPx(GAME.HIT_RADIUS_R);
}
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 坐标系换算：视频帧归一化坐标 (0~1) → 屏幕像素坐标
 *
 * 必须复刻 CSS 的两个变换，否则碰撞判定会整体偏移：
 *   1. object-fit: cover —— 等比放大到铺满，两侧（或上下）被裁掉
 *   2. transform: scaleX(-1) —— 水平镜像
 */
function videoToScreen(nx, ny) {
  const sw = stageEl.clientWidth;
  const sh = stageEl.clientHeight;
  const vw = videoEl.videoWidth  || CONFIG.VIDEO_WIDTH;
  const vh = videoEl.videoHeight || CONFIG.VIDEO_HEIGHT;

  // cover：取较大的缩放比，保证两个方向都铺满
  const scale   = Math.max(sw / vw, sh / vh);
  const renderW = vw * scale;
  const renderH = vh * scale;
  // 居中裁切产生的偏移（负值 = 被裁掉的部分）
  const offsetX = (sw - renderW) / 2;
  const offsetY = (sh - renderH) / 2;

  const x = nx * renderW + offsetX;
  const y = ny * renderH + offsetY;

  return { x: sw - x, y }; // 水平镜像
}

// ===================== 实体生成 =====================

/** 创建一个掉落物 DOM（外层定位 div + 内层表演 img），并返回实体对象 */
function createEntity(type, size, orbit) {
  // 抽取素材：炸弹固定，普通掉落物随机
  const asset = type === 'bomb'
    ? { key: 'bomb', file: GAME.BOMB_ASSET }
    : pick(GAME.NORMAL_ASSETS);

  const el = document.createElement('div');
  el.className = 'drop-item' + (type === 'bomb' ? ' is-bomb' : '');
  el.style.width  = size + 'px';
  el.style.height = size + 'px';

  const img = document.createElement('img');
  img.src = GAME.ASSET_DIR + asset.file;
  img.draggable = false;
  img.alt = '';
  el.appendChild(img);

  dropLayerEl.appendChild(el);

  return {
    el,
    img,
    type,                                  // 'normal' | 'bomb'
    assetKey: asset.key,                   // [M3] 语义标识，用于匹配滤镜
    size,
    radius: size / 2,
    orbit,                                 // null 表示位于组合体中心
    spin: rand(-GAME.SPIN_SPEED_MAX, GAME.SPIN_SPEED_MAX),
    angleDeg: rand(0, 360),
    x: 0,
    y: 0,
    alive: true,
  };
}

/* ---- 横向泳道洗牌袋 ---- */
let laneBag = [];

/**
 * 取下一个生成用的横坐标。
 *
 * 用「洗牌袋」而不是纯随机：把屏幕切成 SPAWN_LANES 条泳道，
 * 每轮把所有泳道洗牌后逐个用完再重新洗 —— 保证每一轮里每条泳道都恰好用到一次，
 * 不会连着好几个都落在同一片区域。泳道内部仍是随机位置，所以不显得机械。
 *
 * @param half 掉落物半径，用来保证本体不贴边
 */
function nextLaneX(half) {
  const n = Math.max(1, GAME.SPAWN_LANES);
  if (laneBag.length === 0) {
    laneBag = Array.from({ length: n }, (_, i) => i);
    // Fisher–Yates 洗牌
    for (let i = laneBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [laneBag[i], laneBag[j]] = [laneBag[j], laneBag[i]];
    }
  }
  const lane = laneBag.pop();

  const sw = stageEl.clientWidth;
  const pad = uiPx(GAME.SPAWN_EDGE_PAD_R) + half;
  // 先求出「本体不出画」的可用区间，再在这个区间里切泳道。
  // 顺序反了的话（先按整屏切泳道、再把越界的夹回来），
  // 两侧泳道会有一大半被夹到同一个边界值上，边缘各堆出一根柱子。
  const lo = pad;
  const hi = Math.max(pad + 1, sw - pad);
  const laneW = (hi - lo) / n;
  return rand(lo + lane * laneW, lo + (lane + 1) * laneW);
}

/**
 * 生成一个组合体，三选一：
 *  - 单独炸弹：中心就是一颗炸弹，没有伴星
 *  - 伴星炸弹：中心 1 个普通物品 + 1 个绕其做圆周运动的炸弹
 *  - 普通掉落：中心 1 个普通物品
 */
function spawnGroup() {
  if (groups.length >= GAME.MAX_GROUPS) return;

  // 一次掷骰分三档，概率互斥不会叠加
  const roll = Math.random();
  const isSoloBomb = roll < GAME.SOLO_BOMB_CHANCE;
  const isCombo = !isSoloBomb && roll < GAME.SOLO_BOMB_CHANCE + GAME.BOMB_COMBO_CHANCE;

  const centerSize = rand(uiPx(GAME.ITEM_SIZE_MIN_R), uiPx(GAME.ITEM_SIZE_MAX_R));

  // 单独炸弹的中心直接就是炸弹本体，走和普通掉落物一样的尺寸区间，
  // 这样它在画面里的分量和别的掉落物一致，不会一眼就被认出来躲开
  const entities = [
    createEntity(isSoloBomb ? 'bomb' : 'normal', centerSize, null),
  ];

  // 组合体的左右安全边距：有伴星时要把公转半径也算进去，否则炸弹会转出屏幕
  let orbitRadius = 0;
  if (isCombo) {
    orbitRadius = rand(uiPx(GAME.ORBIT_RADIUS_MIN_R), uiPx(GAME.ORBIT_RADIUS_MAX_R));
    entities.push(
      createEntity('bomb', uiPx(GAME.BOMB_SIZE_R), {
        radius: orbitRadius,
        angle: rand(0, Math.PI * 2),                              // 随机初相位
        speed: rand(GAME.ORBIT_SPEED_MIN, GAME.ORBIT_SPEED_MAX)
                 * (Math.random() < 0.5 ? -1 : 1),                // 随机正反转
      })
    );
  }

  const drift = rand(uiPx(GAME.DRIFT_AMPLITUDE_MIN_R), uiPx(GAME.DRIFT_AMPLITUDE_MAX_R));

  groups.push({
    // 组合体中心的世界坐标。
    //
    // 边距只按「中心掉落物本体」算，不再把公转半径和飘移幅度也预留进去 ——
    // 那样算出来的边距能达到半个屏宽，可用区间会塌成正中间一条窄带
    // （实测伴星炸弹最窄只剩 8px，于是 34% 的组合体全生成在屏幕正中）。
    // 伴星和飘移允许探出屏幕边缘一点，视觉上完全可接受。
    baseX: nextLaneX(centerSize / 2),
    x: 0,
    y: -(centerSize / 2 + orbitRadius + 20),   // 从屏幕上方边界外开始掉
    // 每个组合体自带一份随机重力 —— 这是"下落节奏快慢差异"的来源
    vy: rand(GAME.FALL_SPEED_MIN, GAME.FALL_SPEED_MAX),
    // S 型横向飘移参数
    driftAmp: drift,
    driftFreq: rand(GAME.DRIFT_FREQ_MIN, GAME.DRIFT_FREQ_MAX),
    driftPhase: rand(0, Math.PI * 2),
    entities,
  });
}

// ===================== 吞噬反馈 =====================

/** 吃到普通掉落物：快速缩小消失 */
function eatEntity(entity) {
  entity.alive = false;
  entity.el.classList.add('eaten');
  entity.img.addEventListener('animationend', () => entity.el.remove(), { once: true });
}

/** 吃到炸弹：原地爆开 + 全屏红闪一次 */
function explodeEntity(entity) {
  entity.alive = false;
  entity.el.classList.add('blasted');
  entity.img.addEventListener('animationend', () => entity.el.remove(), { once: true });
  triggerRedFlash();

  // 有震动能力的设备补一下触觉反馈（iOS Safari 不支持，会被忽略）
  if (navigator.vibrate) navigator.vibrate(120);
}

/**
 * 游戏结束：停止生成与吞噬，清场，弹出结算。
 *
 * 刻意「不」停掉物理循环和面部推理 —— 结束后玩家的鬼脸（爆炸头 / 眼泪 /
 * 液化嘴）还要继续跟着头动，这才是这个游戏最值得截图的一刻。
 */
function triggerGameOver(reason = 'bomb') {
  if (gameState !== 'playing') return;
  gameState = 'over';

  // 注意：这里「不」直接清空 groups。
  // 本函数是从 updatePhysics 遍历 groups 的过程中调用的，
  // 当场清空会让外层倒序循环下一轮取到 undefined 直接崩。
  // 真正的清场交给循环结束后的 clearAllDrops()。

  // 倒计时藏掉，理由和判定圈一样：结束后的主角是玩家脸上那堆滤镜。
  // 而且它就在屏幕顶部正中，和头饰滤镜（皇冠 / 爆炸头）抢的是同一块位置。
  // 重玩不用管 —— startRound() 里本来就会把它放出来。
  countdownEl.classList.add('hidden');

  // 结束态的提示文案。CTA 开场图不再出现，只换这一行文字
  setHint(GAME.HINTS.restart);
  console.log('[GAME] 游戏结束，原因:', reason === 'timeup' ? '时间到' : '吃到炸弹');
}

/**
 * 倒计时。游戏结束后冻住不再走。
 * 只在整数秒变化时才写 DOM —— 每帧都写会白白触发文本重排。
 */
function updateCountdown(dt) {
  if (gameState !== 'playing') return;

  countdownLeft = Math.max(0, countdownLeft - dt);

  const shown = Math.ceil(countdownLeft);
  if (shown !== countdownShown) {
    countdownShown = shown;
    countdownNumEl.textContent = String(shown);
  }

  // 归零 → 复用吃到炸弹的那套结束逻辑
  if (countdownLeft <= 0) triggerGameOver('timeup');
}

/** 清空场上所有掉落物（走"被吃掉"的缩小动画，不是硬删） */
function clearAllDrops() {
  for (const g of groups) {
    for (const e of g.entities) {
      if (!e.alive) continue;
      e.alive = false;
      e.el.classList.add('eaten');
      e.img.addEventListener('animationend', () => e.el.remove(), { once: true });
    }
  }
  groups.length = 0;
}

/** 全屏红闪：靠增删 class 触发一次性 CSS 动画 */
function triggerRedFlash() {
  redFlashEl.classList.remove('flash');
  // 强制回流，让浏览器认定这是一次全新的动画（否则连续触发不会重播）
  void redFlashEl.offsetWidth;
  redFlashEl.classList.add('flash');
}

// ===================== 物理主循环 =====================

/**
 * @param {number} dt 距上一帧的时间，单位「秒」
 *
 * 用 dt 而不是「每帧固定位移」来驱动，
 * 这样 120Hz 的 iPhone 和 60Hz 的安卓机下落速度才一致。
 */
function updatePhysics(dt) {
  const sw = stageEl.clientWidth;
  const sh = stageEl.clientHeight;

  // ---------- 1. 刷新嘴部判定中心 ----------
  if (mouthNorm.valid) {
    const p = videoToScreen(mouthNorm.x, mouthNorm.y);
    if (mouthPos.ready) {
      // 指数平滑：面部推理帧率低于渲染帧率，插值一下让判定点不抖
      const k = 1 - Math.pow(0.001, dt); // 与帧率无关的平滑系数
      mouthPos.x += (p.x - mouthPos.x) * k;
      mouthPos.y += (p.y - mouthPos.y) * k;
    } else {
      mouthPos.x = p.x;
      mouthPos.y = p.y;
      mouthPos.ready = true;
    }
  } else {
    mouthPos.ready = false;
  }

  // ---------- 1.5 倒计时 ----------
  // 放在 canEat 之前：倒计时可能在本帧归零并结束游戏，
  // 顺序反了的话归零那一帧玩家还能再吃到一个东西
  updateCountdown(dt);

  // 只有「游戏中 + 检测到脸 + 判定点有效 + 正在张嘴」时才可能吃到东西
  const canEat = gameState === 'playing' && hasFace && mouthPos.ready && isMouthOpen === true;
  const hitR = hitRadius();  // 每帧算一次就够，屏幕尺寸不会帧内变化

  // ---------- 2. 定时生成 ----------
  spawnTimer -= dt * 1000;
  if (gameState === 'playing' && spawnTimer <= 0) {
    spawnGroup();
    spawnTimer = randInt(GAME.SPAWN_MIN_MS, GAME.SPAWN_MAX_MS);
  }

  // ---------- 3. 逐个组合体更新 ----------
  // 倒序遍历，方便边遍历边 splice 删除
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];

    // 3.1 整体下落：随机初速 + 轻微重力加速度
    g.vy += GAME.GRAVITY_ACCEL * dt;
    g.y  += g.vy * dt;

    // 3.2 S 型横向飘移（正弦摆动）
    g.x = g.baseX + Math.sin(elapsed * g.driftFreq * Math.PI * 2 + g.driftPhase) * g.driftAmp;

    let aliveCount = 0;

    for (const e of g.entities) {
      if (!e.alive) continue;
      aliveCount++;

      // 3.3 世界坐标 = 组合体中心 + 圆周偏移
      if (e.orbit) {
        // 匀速圆周运动：角度随时间线性推进，坐标由 cos / sin 解算
        e.orbit.angle += e.orbit.speed * dt;
        e.x = g.x + Math.cos(e.orbit.angle) * e.orbit.radius;
        e.y = g.y + Math.sin(e.orbit.angle) * e.orbit.radius;
      } else {
        e.x = g.x;
        e.y = g.y;
      }

      // 3.4 碰撞判定：实体中心到嘴部中心的绝对距离
      if (canEat) {
        const dx = e.x - mouthPos.x;
        const dy = e.y - mouthPos.y;
        const dist = Math.hypot(dx, dy);

        if (dist < hitR) {
          if (e.type === 'bomb') {
            explodeEntity(e);
            // [M3] 炸弹的滤镜三件套（爆炸头 + 眼泪 + 嘴部液化）
            activateFilter(e.assetKey);
            triggerGameOver('bomb');
          } else {
            eatEntity(e);
            // [M3] 按资产类型激活对应滤镜（没有对应滤镜的资产会被静默忽略）
            activateFilter(e.assetKey);
          }
          aliveCount--;
          continue; // 已经死掉，不用再写 transform
        }
      }

      // 3.5 写回视觉位置（GPU 合成，不触发布局重排）
      e.angleDeg += e.spin * dt;
      e.el.style.transform =
        `translate3d(${e.x.toFixed(1)}px, ${e.y.toFixed(1)}px, 0) ` +
        `translate(-50%, -50%) rotate(${e.angleDeg.toFixed(1)}deg)`;
    }

    // 3.6 回收：整组掉出屏幕，或成员已全部被吃掉
    const offScreen = g.y - GAME.DESPAWN_MARGIN > sh;
    if (aliveCount === 0 || offScreen) {
      for (const e of g.entities) {
        // 被吃掉的走 CSS 动画自行移除；掉出屏幕的直接删
        if (e.alive) e.el.remove();
      }
      groups.splice(gi, 1);
    }
  }

  // ---------- 3.7 游戏结束后清场 ----------
  // 必须放在 groups 遍历「之后」——遍历途中改数组会让倒序循环取到 undefined
  if (gameState !== 'playing' && groups.length) clearAllDrops();

  // ---------- 4. 面部特效 + 跟踪型滤镜 ----------
  // 顺序要紧：先推进膨胀动画，眼镜的放大倍数才拿得到当前帧的值
  updateFaceFx(dt);
  updateTrackedFilters(dt);

  // ---------- 5. 嘴部判定圈 ----------
  updateMouthMarker();
}

/**
 * 嘴部判定圈。已经是正式 UI（不再受 CONFIG.DEBUG 控制）：
 * 从 init 态就跟着 CTA 一起出现，唯一不显示的情况是游戏结束。
 * 配色由 CSS 的 .is-open 切换 —— 闭嘴粉红虚线，张嘴蓝色实线 + 25% 填充。
 */
function updateMouthMarker() {
  // 结束态藏掉：这时候的主角是玩家脸上那堆滤镜，不该再有判定框干扰
  if (gameState === 'over' || !mouthPos.ready) {
    mouthMarkerEl.classList.add('hidden');
    return;
  }

  const d = hitRadius() * 2;
  mouthMarkerEl.classList.remove('hidden');
  mouthMarkerEl.classList.toggle('is-open', isMouthOpen);
  mouthMarkerEl.style.width  = d + 'px';
  mouthMarkerEl.style.height = d + 'px';
  mouthMarkerEl.style.transform =
    `translate3d(${mouthPos.x.toFixed(1)}px, ${mouthPos.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
}

// ===================== M3 · 滤镜状态机 =====================

/**
 * 已激活的滤镜集合。
 * 用 Set 而非布尔变量：一是天然幂等（同一滤镜反复吃到只生效一次），
 * 二是后续加多种滤镜时不用改结构。
 * 语义是「一旦触发就永久保持」，所以只增不删。
 */
/**
 * 当前每个槽位上生效的滤镜：slot → { key, el }
 *
 * 用 Map 按「槽位」记录而不是用 Set 记录「哪些 key 激活过」，
 * 因为规则是同槽位互斥：吃了火锅背景再吃竹林背景，竹林要替换掉火锅，
 * 而不是两张背景叠在一起。
 */
const activeSlots = new Map();

/**
 * 从文件名解析槽位：`filter-bg-hotpot.webp` → 'bg'
 *
 * 命名约定 `filter-<槽位>-<名字>` 同时承担两个职责：决定渲染在哪一层，
 * 以及决定和谁互斥。加新素材只要名字取对，逻辑一行都不用改。
 * 不符合约定的文件名会退化成「独占一个专属槽位」，不会误替换别人。
 */
function parseFilterSlot(file) {
  // `fx-` 前缀是程序化特效，但槽位规则完全一致
  const m = /^(?:filter|fx)-([a-z0-9]+)-/i.exec(file);
  return m ? m[1].toLowerCase() : `_${file}`;
}

/** 是否是程序化特效（非图片素材） */
function isProceduralFx(file) {
  return file.startsWith('fx-');
}

/**
 * 取某个素材的跟踪参数覆盖值。
 * 先按完整文件名查，再按去掉扩展名的名字查 ——
 * 后者是主用法，保证 png ↔ webp 换格式时配置不会静默失效。
 */
function getTrackOverride(file) {
  const map = GAME.FILTER_TRACK_BY_FILE || {};
  const base = file.replace(/\.[^.]+$/, '');
  return map[file] || map[base] || {};
}

/**
 * 激活指定 key 的滤镜。
 * @param {string} key 被吃掉实体的 assetKey，如 'hotpot'
 *
 * 注意这个函数是从物理循环里每帧调用的路径上进来的，
 * 所以必须保证：查不到映射 / 同一张已在生效 → 立刻返回，绝不重复建 DOM。
 */
function activateFilter(key) {
  const files = GAME.FILTERS[key];
  if (!files) return;                      // 该资产没有配置滤镜
  // 一个 key 可能带多个滤镜（元宝 = 眼部 + 头饰），逐个按自己的槽位激活
  for (const file of files) applyFilterFile(key, file);
}

/** 激活单个滤镜文件 */
function applyFilterFile(key, file) {
  const slot = parseFilterSlot(file);
  const current = activeSlots.get(slot);
  if (current && current.file === file) return; // 同一张已在生效，保持现状

  const isBg = slot === 'bg';
  const isFx = isProceduralFx(file);
  // 槽位默认值 + 按素材的覆盖值
  const slotCfg = isFx ? null : GAME.FILTER_TRACK[slot];
  const trackCfg = slotCfg
    ? { ...slotCfg, ...getTrackOverride(file) }
    : null;
  const container = isBg ? filterBgLayerEl : filterLayerEl;
  const url = `${GAME.FILTER_DIR}${file}`;

  let el;
  if (isFx) {
    // ---- 程序化特效：没有图片，建一个空占位元素纯粹作为槽位抓手 ----
    // 这样"替换 / 淡出 / 幂等"的逻辑不用为它开特例
    el = document.createElement('div');
    el.className = 'filter-fx';
    el.dataset.fx = file;
    container.appendChild(el);
    activateProceduralFx(file);
  } else if (trackCfg) {
    // ---- 跟踪型 ----
    // 'pair' 模式要左右眼各一张图，所以外面再套一层 group：
    // group 只作为「整体替换 / 整体淡出」的抓手，实际定位写在每个 part 上。
    el = document.createElement('div');
    el.className = 'filter-track-group';
    container.appendChild(el);

    const partCount = trackCfg.mode === 'pair' ? 2 : 1;
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      // 双层结构：外层 div 由 JS 每帧写 transform，内层 img 播放淡入动画
      const partEl = document.createElement('div');
      partEl.className = 'filter-tracked is-lost'; // 先隐藏，等拿到锚点再显示
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      partEl.appendChild(img);
      el.appendChild(partEl);
      parts.push({ el: partEl, img, smoothed: null });
    }

    const rec = {
      key, file, el, parts,
      cfg: trackCfg,
      aspect: 1,          // 先给个占位值，图片加载完立刻用真实宽高比覆盖
      ready: false,
    };
    trackedFrames.set(slot, rec);

    // 宽高比从图片本身读，不写在配置里 —— 少一处需要人工同步的数据
    const firstImg = parts[0].img;
    const applyAspect = () => {
      if (firstImg.naturalHeight > 0) {
        rec.aspect = firstImg.naturalWidth / firstImg.naturalHeight;
        rec.ready = true;
      }
    };
    if (firstImg.complete) applyAspect();
    else firstImg.addEventListener('load', applyAspect, { once: true });
  } else {
    // ---- 全屏型：静态铺满，无需逐帧更新 ----
    el = document.createElement('div');
    el.className = 'filter-frame';
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize  = GAME.FILTER_FIT;
    container.appendChild(el);
  }

  el.dataset.filter = key;
  el.dataset.slot = slot;

  // 顶掉同槽位的旧滤镜（后 append 的天然叠在上面，配合旧帧淡出即为交叉溶解）
  if (current) {
    retireFilterFrame(current.el);
    console.log(`[M3] 滤镜替换: ${current.file} → ${file} (槽位 ${slot})`);
  } else {
    console.log(`[M3] 滤镜已激活: ${file} (槽位 ${slot}${isBg ? ' · 背景层' : ' · 前景层'})`);
  }

  activeSlots.set(slot, { key, file, el });

  // 背景滤镜需要把人从画面里抠出来盖在它上面，这里才按需启动分割模型
  if (isBg) enableSegmentation();
  // 眼部滤镜默认触发眼睛膨胀。
  // 明确标了 bulgeOnActivate: false 的素材不仅不触发，还要把之前
  // （吃蘑菇/元宝时）开启的膨胀强制关掉 —— 否则被炸之后眼周还挂着放大效果。
  if (slot === 'eye' && trackCfg) {
    if (trackCfg.bulgeOnActivate === false) cancelEyeBulge();
    else triggerEyeBulge();
  }
}

/** 让被顶掉的滤镜淡出后自行移除，避免直接 remove 造成的生硬跳变 */
function retireFilterFrame(el) {
  // 跟踪型滤镜要先摘出更新列表，否则会继续被写 transform
  const slot = el.dataset.slot;
  const rec = trackedFrames.get(slot);
  if (rec && rec.el === el) trackedFrames.delete(slot);
  // 程序化特效同槽位被顶掉时要关掉，否则会残留
  if (el.dataset.fx) deactivateProceduralFx(el.dataset.fx);
  // 已被隐藏（丢脸）的贴图不会播放淡出动画，直接摘掉隐藏类让它能正常淡出
  el.querySelectorAll('.filter-tracked.is-lost')
    .forEach((n) => n.classList.remove('is-lost'));

  el.classList.add('is-leaving');
  // 动画挂在内层 img 上时事件会冒泡上来，两种结构都能接住
  el.addEventListener('animationend', () => el.remove(), { once: true });
  // 兜底：万一动画事件没触发（元素被提前隐藏等），超时强制清理
  setTimeout(() => el.remove(), 800);
}

// ===================== M3 · 跟踪型滤镜（贴合面部）=====================

/** 正在跟踪的滤镜：slot → { key, file, el, parts[], cfg, aspect, ready } */
const trackedFrames = new Map();

// 虹膜中心（需 refineLandmarks: true 才有，共 478 点）。
// 用虹膜而不是眼角，是因为眼角会随眨眼/表情漂移，虹膜中心明显更稳。
const LM_IRIS_L = 468;
const LM_IRIS_R = 473;
// 退化方案：模型只给 468 点时用外眼角
const LM_EYE_L = 33;
const LM_EYE_R = 263;
// 头部锚点：额顶中心 + 左右太阳穴（用来量面部宽度）
const LM_FOREHEAD = 10;
const LM_TEMPLE_L = 127;
const LM_TEMPLE_R = 356;

/**
 * 面部基准坐标系：眼线的中点、长度、倾角，以及「头顶方向」单位向量。
 * 所有跟踪型滤镜都从这里派生，保证眼镜和皇冠的倾角完全一致。
 * @returns {{p, q, cx, cy, dist, angle, upx, upy} | null} 屏幕像素空间
 */
function faceBasis(lm) {
  const a = lm[LM_IRIS_L] || lm[LM_EYE_L];
  const b = lm[LM_IRIS_R] || lm[LM_EYE_R];
  if (!a || !b) return null;

  let p = videoToScreen(a.x, a.y);
  let q = videoToScreen(b.x, b.y);

  // 画面是镜像的，哪个 landmark 落在屏幕左边并不固定。
  // 强制按屏幕 x 排序，保证 dx > 0 —— 否则 atan2 会得到 ±180° 的反向解，贴图上下翻转。
  if (p.x > q.x) [p, q] = [q, p];

  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;

  return {
    p, q, dist,
    cx: (p.x + q.x) / 2,
    cy: (p.y + q.y) / 2,
    angle: Math.atan2(dy, dx) * 180 / Math.PI, // 头歪多少度，贴图就跟着歪多少度
    // 「头顶方向」= 眼线法向量取向上的那一侧（屏幕 y 轴向下，故取负）
    upx:  dy / dist,
    upy: -dx / dist,
    // 「屏幕右方向」= 沿眼线。歪头时会跟着转，所以水平偏移也是贴着脸走的
    rx: dx / dist,
    ry: dy / dist,
  };
}

/**
 * 双眼锚点。
 *  - 'span'：一张图横跨双眼（墨镜）→ 返回 1 个锚点
 *  - 'pair'：每只眼睛各一张（元宝）→ 返回 2 个锚点
 * 两种模式的宽度都以瞳距为基准，所以同一个 widthFactor 语义一致。
 */
function computeEyeAnchors(lm, cfg) {
  const B = faceBasis(lm);
  if (!B) return null;

  const width = B.dist * cfg.widthFactor;
  const off = B.dist * (cfg.offsetFactor || 0);
  const offX = B.dist * (cfg.offsetXFactor || 0);
  // offsetFactor 为正表示「向下」，所以沿 up 的反方向偏移
  const ox = -B.upx * off + B.rx * offX;
  const oy = -B.upy * off + B.ry * offX;

  if (cfg.mode === 'pair') {
    return [
      { cx: B.p.x + ox, cy: B.p.y + oy, width, angle: B.angle },
      { cx: B.q.x + ox, cy: B.q.y + oy, width, angle: B.angle },
    ];
  }
  return [{ cx: B.cx + ox, cy: B.cy + oy, width, angle: B.angle }];
}

/**
 * 头饰锚点：以额顶(10) 为基点，沿「头顶方向」上移，宽度按太阳穴间距缩放。
 *
 * 宽度基准不用瞳距而用太阳穴间距(127↔356)，因为头饰要贴合的是头的宽度；
 * 倾角仍复用眼线 —— 太阳穴点在转头时抖动比虹膜大得多。
 */
function computeHeadAnchors(lm, cfg) {
  const B = faceBasis(lm);
  const top = lm[LM_FOREHEAD];
  const tl = lm[LM_TEMPLE_L];
  const tr = lm[LM_TEMPLE_R];
  if (!B || !top || !tl || !tr) return null;

  const pl = videoToScreen(tl.x, tl.y);
  const pr = videoToScreen(tr.x, tr.y);
  const faceW = Math.hypot(pr.x - pl.x, pr.y - pl.y);
  if (faceW < 1) return null;

  const anchor = videoToScreen(top.x, top.y);
  const off = faceW * (cfg.offsetFactor || 0);       // 正 = 向上
  const offX = faceW * (cfg.offsetXFactor || 0);     // 正 = 向屏幕右

  return [{
    cx: anchor.x + B.upx * off + B.rx * offX,
    cy: anchor.y + B.upy * off + B.ry * offX,
    width: faceW * cfg.widthFactor,
    angle: B.angle,
  }];
}

/** 按配置分发到对应的锚点解算器 */
function computeAnchors(lm, cfg) {
  if (cfg.anchor === 'eyes') return computeEyeAnchors(lm, cfg);
  if (cfg.anchor === 'head') return computeHeadAnchors(lm, cfg);
  return null;
}

// ===================== M3 · 程序化特效：皮肤焦黑 =====================

/**
 * FaceMesh 面部轮廓（FACEMESH_FACE_OVAL）的有序环。
 * 必须按顺序连成闭合路径，乱序会画出自交的星形。
 */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

// 要从焦黑里挖空的区域：双眼与嘴。同样必须是有序环。
const EYE_RING_L = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
const EYE_RING_R = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
];
const LIPS_RING = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
  409, 270, 269, 267, 0, 37, 39, 40, 185,
];

/** 焦黑特效状态。t 从 0 渐变到 1 后保持 */
const skinBurn = { active: false, t: 0 };

function activateProceduralFx(file) {
  if (file !== 'fx-skin-burn' || skinBurn.active) return;
  skinBurn.active = true;
  skinBurn.t = 0;
  eyeCanvasEl.classList.add('is-active'); // 与眼睛膨胀共用同一块画布
  console.log('[M3] 程序化特效已激活: 皮肤焦黑');
}

function deactivateProceduralFx(file) {
  if (file === 'fx-skin-burn') skinBurn.active = false;
}

/**
 * 把一圈 landmark 描成路径（视频像素空间，可带平移偏移）。
 * @param expand 相对该环质心的放大倍数 —— 挖空区域要比真实五官略大一圈，
 *               否则眼睑和唇边会残留一道黑边，看着像描了眼线
 */
function traceRing(ctx, lm, ring, vw, vh, offX, offY, expand = 1) {
  const pts = [];
  let sx = 0, sy = 0;
  for (const idx of ring) {
    const p = lm[idx];
    if (!p) return false;
    const x = p.x * vw - offX;
    const y = p.y * vh - offY;
    pts.push({ x, y });
    sx += x;
    sy += y;
  }
  const cx = sx / pts.length;
  const cy = sy / pts.length;

  ctx.moveTo(cx + (pts[0].x - cx) * expand, cy + (pts[0].y - cy) * expand);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(cx + (pts[i].x - cx) * expand, cy + (pts[i].y - cy) * expand);
  }
  ctx.closePath();
  return true;
}

/**
 * 皮肤焦黑：面部轮廓内填纯黑，并把眼睛和嘴挖空。
 *
 * 直接在目标画布上填路径，不再需要离屏画布 ——
 * 之前那版要把视频重绘一遍才能挂滤镜，现在只是填色，一次 fill 就够了。
 *
 * 挖空靠 evenodd 填充规则：外层是面部轮廓，内层是双眼和唇环，
 * 内环会被自动抠掉，于是五官保持原样、只有皮肤变黑。
 *
 * 与眼睛膨胀共用「视频像素空间」的画布，镜像和 cover 裁切交给 CSS。
 */
function drawSkinBurn(ctx) {
  if (!skinBurn.active) return;

  const cfg = GAME.PROCEDURAL_FX['fx-skin-burn'];
  const lm = latestLandmarks;
  if (!lm) return;

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;

  ctx.save();
  ctx.globalAlpha = cfg.strength * skinBurn.t;
  // 蒙版本身模糊一下就是羽化边，避免生硬的剪影轮廓。
  // Safari 17 以下不支持 ctx.filter，那就是硬边 —— 功能不受影响
  if (supportsCtxFilter && cfg.feather > 0) {
    ctx.filter = `blur(${cfg.feather}px)`;
  }
  ctx.fillStyle = cfg.color;

  ctx.beginPath();
  if (!traceRing(ctx, lm, FACE_OVAL, vw, vh, 0, 0)) { ctx.restore(); return; }
  traceRing(ctx, lm, EYE_RING_L, vw, vh, 0, 0, cfg.eyeHoleExpand);
  traceRing(ctx, lm, EYE_RING_R, vw, vh, 0, 0, cfg.eyeHoleExpand);
  traceRing(ctx, lm, LIPS_RING,  vw, vh, 0, 0, cfg.mouthHoleExpand);
  ctx.fill('evenodd');

  ctx.restore();
}

// ===================== M3 · 眼睛膨胀搞怪特效 =====================

/** 膨胀动画状态。t 从 0 走到 1 后停住（特效和滤镜一样永久保持） */
const eyeFx = { active: false, t: 0 };

/** 离屏画布：每只眼睛的放大补丁先画在这里羽化，再贴回主画布 */
const bulgeScratch = document.createElement('canvas');
const bulgeCtx = bulgeScratch.getContext('2d');

/** 触发膨胀（吃到蘑菇 → 激活 eye 槽位时调用） */
function triggerEyeBulge() {
  if (eyeFx.active) return;
  eyeFx.active = true;
  eyeFx.t = 0;
  eyeCanvasEl.classList.add('is-active');
}

/**
 * 强制关闭眼睛膨胀。
 * 关掉后如果这块画布上没有别的特效了，要顺手清一次 ——
 * updateFaceFx 在两个特效都不激活时会直接 return，不清的话
 * 上一帧放大的眼睛会冻在画面上不走。
 */
function cancelEyeBulge() {
  if (!eyeFx.active) return;
  eyeFx.active = false;
  eyeFx.t = 0;
  if (eyeCanvasEl.width) {
    eyeCtx.clearRect(0, 0, eyeCanvasEl.width, eyeCanvasEl.height);
  }
  if (!skinBurn.active) eyeCanvasEl.classList.remove('is-active');
}

/**
 * 画出所有「基于重绘视频画面」的面部特效。
 *
 * 顺序有讲究：焦黑放在膨胀「之后」。
 * 反过来的话，膨胀会把已经熏黑的脸再放大一遍贴上去，
 * 眼周就会冒出两个没被熏黑的圆斑。
 */
function drawFaceFx(ctx) {
  drawEyeBulge(ctx);
  drawSkinBurn(ctx);
}

/** easeOutBack：结尾会冲过头再弹回来，是"Q 弹"手感的来源 */
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/**
 * 当前的膨胀强度 0~1。
 * 到位后叠加一个正弦"呼吸"，让它一直轻微起伏，比静止不动更搞怪。
 */
function getBulgeAmount() {
  if (!eyeFx.active) return 0;
  const base = easeOutBack(Math.min(eyeFx.t, 1));
  const cfg = GAME.EYE_BULGE;
  if (eyeFx.t < 1 || cfg.pulse <= 0) return base;
  return base * (1 + cfg.pulse * Math.sin(elapsed * cfg.pulseSpeed));
}

/** 眼镜的同步放大倍数 */
function getGlassesScale() {
  return 1 + getBulgeAmount() * (GAME.EYE_BULGE.glassesScale - 1);
}

/**
 * 把一个圆形区域内的画面放大后贴回去。
 *
 * 做法：先把「以眼睛为中心、半径 r/scale」的一小块源画面，
 * 拉伸绘制到 2r×2r 的离屏画布上（这一步就是放大），
 * 再用 destination-in + 径向渐变把边缘羽化成软圆，最后整块贴回主画布。
 *
 * 只处理眼睛周围的小块区域，不是全屏运算，手机上开销很低。
 */
function drawMagnifiedCircle(ctx, cx, cy, r, scale) {
  const d = Math.max(8, Math.round(r * 2));
  if (bulgeScratch.width !== d) {
    bulgeScratch.width = d;
    bulgeScratch.height = d;
  }

  bulgeCtx.clearRect(0, 0, d, d);

  // 源区域比目标小 scale 倍 → 贴回去就是放大了 scale 倍
  const half = r / scale;
  bulgeCtx.drawImage(videoEl, cx - half, cy - half, half * 2, half * 2, 0, 0, d, d);

  // 羽化边缘：硬圆边会露出明显的"剪贴"痕迹
  bulgeCtx.globalCompositeOperation = 'destination-in';
  const g = bulgeCtx.createRadialGradient(
    d / 2, d / 2, (d / 2) * GAME.EYE_BULGE.feather,
    d / 2, d / 2, d / 2
  );
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  bulgeCtx.fillStyle = g;
  bulgeCtx.fillRect(0, 0, d, d);
  bulgeCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(bulgeScratch, cx - r, cy - r, d, d);
}

/**
 * 在指定画布上画出两只放大的眼睛。
 * 坐标用「视频像素空间」，与 #personLayer / #eyeLayer 的 canvas 缓冲区一致，
 * 镜像和 cover 裁切交给 CSS 处理，这里不用管。
 */
function drawEyeBulge(ctx) {
  const scale = 1 + getBulgeAmount() * (GAME.EYE_BULGE.maxScale - 1);
  if (scale <= 1.001) return;

  const lm = latestLandmarks;
  if (!lm) return;
  const a = lm[LM_IRIS_L] || lm[LM_EYE_L];
  const b = lm[LM_IRIS_R] || lm[LM_EYE_R];
  if (!a || !b) return;

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;

  const ax = a.x * vw, ay = a.y * vh;
  const bx = b.x * vw, by = b.y * vh;
  const ipd = Math.hypot(bx - ax, by - ay);
  if (ipd < 4) return;

  const r = ipd * GAME.EYE_BULGE.radiusFactor;
  drawMagnifiedCircle(ctx, ax, ay, r, scale);
  drawMagnifiedCircle(ctx, bx, by, r, scale);
}

/**
 * 每帧推进特效动画并刷新独立的 #eyeLayer 画布。
 *
 * 注意分两条路径：
 *  - 背景滤镜已激活（人像抠图在跑）→ 变形在 onSegResults 里用 source-atop
 *    画进 personLayer，这样会被人形遮罩裁掉，不会在背景图上糊出一块真实环境。
 *  - 否则 → 画在这块独立画布上，直接盖在原视频之上，天然无缝。
 */
function updateFaceFx(dt) {
  if (!eyeFx.active && !skinBurn.active) return;

  if (eyeFx.active && eyeFx.t < 1) {
    eyeFx.t = Math.min(1, eyeFx.t + dt / GAME.EYE_BULGE.duration);
  }
  if (skinBurn.active && skinBurn.t < 1) {
    skinBurn.t = Math.min(1, skinBurn.t + dt / GAME.PROCEDURAL_FX['fx-skin-burn'].duration);
  }

  if (segMasking) {
    // 交给 personLayer 那条路径，这块画布留空即可
    if (eyeCanvasEl.width) eyeCtx.clearRect(0, 0, eyeCanvasEl.width, eyeCanvasEl.height);
    return;
  }

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  if (eyeCanvasEl.width !== vw || eyeCanvasEl.height !== vh) {
    eyeCanvasEl.width = vw;
    eyeCanvasEl.height = vh;
  }

  eyeCtx.clearRect(0, 0, vw, vh);
  drawFaceFx(eyeCtx);
}

/**
 * 每帧更新所有跟踪型滤镜的位置 / 尺寸 / 角度。
 * 由 updatePhysics() 调用 —— 跑在渲染帧率上，而面部推理帧率更低，
 * 所以必须做插值平滑，否则贴图会一顿一顿的。
 */
function updateTrackedFilters(dt) {
  if (trackedFrames.size === 0) return;

  const lm = latestLandmarks;
  const k = 1 - Math.pow(GAME.TRACK_SMOOTHING, dt); // 与帧率无关的平滑系数
  const bulge = getGlassesScale();

  for (const rec of trackedFrames.values()) {
    const anchors = lm ? computeAnchors(lm, rec.cfg) : null;

    // 丢脸 / 解算失败 / 图片还没加载完 → 隐藏，并清掉平滑状态，
    // 否则下次找回人脸时贴图会从旧位置"滑"过来
    if (!anchors || !rec.ready) {
      for (const part of rec.parts) {
        part.el.classList.add('is-lost');
        part.smoothed = null;
      }
      continue;
    }

    // 膨胀倍数在平滑「之后」再乘上去，这样回弹过冲不会被插值抹平，弹性更明显
    const grow = rec.cfg.followsBulge ? bulge : 1;

    for (let i = 0; i < rec.parts.length; i++) {
      const part = rec.parts[i];
      const anchor = anchors[i];
      if (!anchor) continue;

      if (!part.smoothed) {
        part.smoothed = { ...anchor };          // 首帧直接吸附，不做插值
      } else {
        const s = part.smoothed;
        s.cx    += (anchor.cx    - s.cx)    * k;
        s.cy    += (anchor.cy    - s.cy)    * k;
        s.width += (anchor.width - s.width) * k;
        // 角度要走最短弧插值，否则 +179° → -179° 时贴图会整圈甩过去
        let da = anchor.angle - s.angle;
        if (da >  180) da -= 360;
        if (da < -180) da += 360;
        s.angle += da * k;
      }

      const s = part.smoothed;
      const w = s.width * grow;
      const h = w / rec.aspect;

      part.el.classList.remove('is-lost');
      part.el.style.width  = w.toFixed(1) + 'px';
      part.el.style.height = h.toFixed(1) + 'px';
      part.el.style.transform =
        `translate3d(${s.cx.toFixed(1)}px, ${s.cy.toFixed(1)}px, 0) ` +
        `translate(-50%, -50%) rotate(${s.angle.toFixed(2)}deg)`;
    }
  }
}

// ===================== M3 · 人像分割（背景抠图）=====================

let selfieSeg = null;
let segEnabled = false;    // 是否需要跑分割（只有背景滤镜激活后才为 true）
let segMasking = false;    // 是否已经切到"抠图渲染"模式
let segFrameCount = 0;

// Safari 17 以下不支持 canvas ctx.filter，羽化会被跳过（不影响功能）
const supportsCtxFilter =
  typeof CanvasRenderingContext2D !== 'undefined' &&
  'filter' in CanvasRenderingContext2D.prototype;

/** 按需初始化并启用人像分割 */
function enableSegmentation() {
  if (segEnabled) return;

  // 实例已经建过就直接复用 —— restart 后再吃背景滤镜时，
  // 重新 new 一个会泄漏旧实例并重新下载一遍模型
  if (selfieSeg) {
    segEnabled = true;
    return;
  }

  if (typeof SelfieSegmentation === 'undefined') {
    console.warn('[M3] SelfieSegmentation 未加载，背景滤镜将退化为覆盖在画面上方');
    return;
  }

  selfieSeg = new SelfieSegmentation({
    locateFile: (f) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/${f}`,
  });
  selfieSeg.setOptions({ modelSelection: GAME.SEG_MODEL });
  selfieSeg.onResults(onSegResults);

  segEnabled = true;
  console.log('[M3] 人像分割已启动');
}

/**
 * 分割结果回调：把「人」画到 personLayer 上，背景保持透明。
 *
 * 合成原理（canvas 混合模式）：
 *   1. 先画分割遮罩 —— 人形区域不透明，背景区域透明
 *   2. 切到 source-in —— 后续绘制只保留与已有像素重叠的部分
 *   3. 再画视频帧 —— 于是只有人形范围内的视频像素被留下
 * 结果就是一张背景透明的人像，下方的背景滤镜自然透出来。
 */
function onSegResults(results) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h || !results.segmentationMask) return;

  // canvas 的像素尺寸对齐视频真实分辨率，配合 CSS 的 object-fit: cover
  // 保证抠出的人和原视频严丝合缝
  if (personCanvasEl.width !== w || personCanvasEl.height !== h) {
    personCanvasEl.width = w;
    personCanvasEl.height = h;
  }

  personCtx.save();
  personCtx.clearRect(0, 0, w, h);

  // 1) 遮罩（顺带羽化边缘，否则抠图会有生硬锯齿）
  if (GAME.SEG_FEATHER > 0 && supportsCtxFilter) {
    personCtx.filter = `blur(${GAME.SEG_FEATHER}px)`;
  }
  personCtx.drawImage(results.segmentationMask, 0, 0, w, h);
  personCtx.filter = 'none';

  // 2) + 3) 只保留人形范围内的视频像素
  personCtx.globalCompositeOperation = 'source-in';
  personCtx.drawImage(results.image, 0, 0, w, h);

  // 4) 面部特效（膨胀 + 焦黑）。用 source-atop 让它只画在「已有的人形像素」上 ——
  //    否则放大的眼周补丁会连带真实环境一起糊到背景滤镜上，露出一块方圆的穿帮。
  personCtx.globalCompositeOperation = 'source-atop';
  drawFaceFx(personCtx);

  personCtx.restore();

  // 抠到第一帧后才让人像层可见。
  //
  // 原始视频始终保留在最底层不隐藏 —— 滤镜素材带 Alpha 通道，
  // 透明区域露出的就是用户真实的环境；不透明区域自然盖住视频；
  // 而这层人像又盖在相框之上，所以人永远不会被遮挡。
  // 额外的好处：万一分割模型加载失败，画面只是没有抠图效果，不会整个人消失。
  if (!segMasking) {
    personCanvasEl.classList.add('is-active');
    segMasking = true;
  }
}

/** 在面部推理之后顺带跑一次分割（由 renderLoop 调用） */
async function runSegmentation() {
  if (!segEnabled || !selfieSeg) return;

  // 隔帧运行的开关：分割比面部追踪更吃 GPU，低端机可以降频
  if (GAME.SEG_FRAME_SKIP > 0) {
    segFrameCount++;
    if (segFrameCount % (GAME.SEG_FRAME_SKIP + 1) !== 0) return;
  }

  try {
    await selfieSeg.send({ image: videoEl });
  } catch (err) {
    console.error('[M3] 人像分割失败:', err);
  }
}

/** 配置自检：覆盖表的键对不上素材时会静默失效，启动时就喊出来 */
function checkFilterConfig() {
  const files = Object.values(GAME.FILTERS).flat().filter((f) => !isProceduralFx(f));

  // 配置自检：覆盖表里的键如果对不上任何素材，效果会静默退回槽位默认值，
  // 不报错、只是看起来"不对"，极难排查 —— 所以启动时就喊出来。
  const known = new Set(files.flatMap((f) => [f, f.replace(/\.[^.]+$/, '')]));
  Object.keys(GAME.FILTER_TRACK_BY_FILE || {}).forEach((k) => {
    if (!known.has(k)) {
      console.warn(`[M3] FILTER_TRACK_BY_FILE 的键 "${k}" 匹配不到任何素材，该配置不会生效`);
    }
  });
}

/** 游戏帧循环：与面部推理循环彼此独立，物理永远跑满刷新率 */
function gameLoop(ts) {
  if (!lastFrameTs) lastFrameTs = ts;
  // dt 上限 0.05s：切后台回来或掉帧时，防止物体"瞬移"穿过嘴部漏掉碰撞
  const dt = Math.min((ts - lastFrameTs) / 1000, 0.05);
  lastFrameTs = ts;
  elapsed += dt;

  updatePhysics(dt);

  gameRafId = requestAnimationFrame(gameLoop);
}

function startGameLoop() {
  if (gameRafId) return;
  lastFrameTs = 0;
  gameRafId = requestAnimationFrame(gameLoop);
}

function stopGameLoop() {
  if (!gameRafId) return;
  cancelAnimationFrame(gameRafId);
  gameRafId = null;
}

/**
 * 开局立刻要用到的素材 —— 必须等它加载完才放开开始。
 * 掉落物 + 倒计时底图 + CTA，合计约 170KB。
 */
function criticalImageUrls() {
  return [
    ...GAME.NORMAL_ASSETS.map((a) => GAME.ASSET_DIR + a.file),
    GAME.ASSET_DIR + GAME.BOMB_ASSET,
    './assets/countdown-bg.webp',
    './assets/CTA_Start.webp',
  ];
}

/**
 * 滤镜素材 —— 合计约 1MB，但**吃到对应掉落物之前都用不上**，
 * 所以放到后台加载、不阻塞开始。最快也要一两秒才可能吃到第一个东西，
 * 那时它们基本都到了；万一没到，效果只是晚出现一瞬，不会报错。
 */
function deferredImageUrls() {
  return Object.values(GAME.FILTERS).flat()
    .filter((f) => !isProceduralFx(f))
    .map((f) => GAME.FILTER_DIR + f);
}

/**
 * 批量预加载图片，返回一个 Promise。
 *
 * 关键点：**失败也算完成**。某张图 404 不该把玩家永久卡在 loading，
 * 报到控制台就够了 —— 缺一张素材是"效果不对"，卡死是"根本没法玩"。
 */
function preloadImages(urls, onProgress) {
  let done = 0;
  return Promise.all(urls.map((url) => new Promise((resolve) => {
    const img = new Image();
    const finish = (ok) => {
      if (!ok) console.error('[preload] 素材加载失败:', url);
      done++;
      if (onProgress) onProgress(done, urls.length);
      resolve();
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  })));
}

/* =====================================================================
 *  M4 · 生命周期与 UI 状态机
 *
 *  init ──点击──> playing ──倒计时归零 / 吃到炸弹──> over ──点击──> playing
 *                    ↑                                            │
 *                    └────────────────────────────────────────────┘
 *
 *  事件监听只在启动时绑一次（见 bindGlobalTap），靠 gameState 分支，
 *  不做 addEventListener / removeEventListener 的来回切换 ——
 *  那种写法一旦某条分支漏了 remove 就会重复绑定，越玩越多。
 * ===================================================================== */

/** 设置底部提示文案。传空字符串即隐藏（CSS 的 :empty 兜着） */
function setHint(text) {
  hintEl.textContent = text || '';
}

/**
 * 清空所有已激活的滤镜与面部特效，回到素颜。
 * restart 时调用 —— 不清的话上一局的爆炸头和黑脸会带进新一局。
 */
function resetAllFilters() {
  // 1) 图片滤镜：连 DOM 一起清掉，槽位表也清空
  filterBgLayerEl.replaceChildren();
  filterLayerEl.replaceChildren();
  activeSlots.clear();
  trackedFrames.clear();

  // 2) 面部变形特效
  eyeFx.active = false;
  eyeFx.t = 0;
  skinBurn.active = false;
  skinBurn.t = 0;
  eyeCanvasEl.classList.remove('is-active');
  if (eyeCanvasEl.width) {
    eyeCtx.clearRect(0, 0, eyeCanvasEl.width, eyeCanvasEl.height);
  }

  // 3) 人像抠图：只停用、不销毁实例。
  //    销毁再重建会重新下载一遍模型，而且旧实例不好回收。
  segEnabled = false;
  segMasking = false;
  personCanvasEl.classList.remove('is-active');
  if (personCanvasEl.width) {
    personCtx.clearRect(0, 0, personCanvasEl.width, personCanvasEl.height);
  }
}

/** 开始（首次）或重新开始一局 */
function startRound() {
  // CTA 开场图只用一次：直接从 DOM 移除，物理上保证 restart 不会再冒出来
  if (!ctaConsumed) {
    ctaConsumed = true;
    if (ctaStartEl) ctaStartEl.remove();
  }

  setHint('');
  resetAllFilters();
  clearAllDrops();

  // init 态只露 CTA，倒计时是这里第一次露出来的；之后（含 over 态）一直保持可见
  countdownEl.classList.remove('hidden');

  countdownLeft = GAME.COUNTDOWN_SECONDS;
  countdownShown = -1;
  countdownNumEl.textContent = String(GAME.COUNTDOWN_SECONDS);

  spawnTimer = 0;              // 立刻开始掉，不等第一个随机间隔
  gameState = 'playing';
  startGameLoop();             // 内部有 gameRafId 守卫，重复调用安全
  console.log('[GAME] 开始新一局');
}

/**
 * 全局点击。整个生命周期只绑这一个监听器。
 * 用 pointerdown 而不是 click：移动端响应更快，也不受 300ms 点击延迟影响。
 */
function bindGlobalTap() {
  document.addEventListener('pointerdown', () => {
    // iOS 摄像头兜底按钮还在显示时，这一下是给它的，不能顺手把游戏也开了
    if (!startBtnEl.classList.contains('hidden')) return;
    // 素材或模型没就绪，点了不算 —— 这是"游戏开始了资产还没到"的唯一防线
    if (!readyToPlay) return;

    if (gameState === 'init' || gameState === 'over') startRound();
  });
}

/**
 * 素材 / 模型 / 摄像头就绪检查。三个来源各自完成后都会调它一次，
 * 全齐了才把提示从 loading 换成 start，并放开点击。
 */
function checkReady() {
  if (readyToPlay) return;
  if (!imagesReady || !trackingReady || !mediaStream) return;

  readyToPlay = true;
  bootMark('ready');
  setHint(GAME.HINTS.start);
  console.log('[BOOT] 就绪  ' + bootSummary());
}

/** loading 进度提示。数字比单纯转圈更让人愿意等 */
function showLoading(done, total) {
  if (readyToPlay) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  setHint(`${GAME.HINTS.loading} ${pct}%`);
}

// ===================== 启动 =====================
checkFilterConfig();
bindGlobalTap();
setHint(`${GAME.HINTS.loading} 0%`);

// 关键素材（掉落物 / 倒计时底图 / CTA，约 170KB）：要等它，进度条也只算它
preloadImages(criticalImageUrls(), showLoading).then(() => {
  imagesReady = true;
  bootMark('images');
  checkReady();
});

// 滤镜素材（约 1MB）：后台加载，不阻塞开始
preloadImages(deferredImageUrls()).then(() => {
  console.log('[BOOT] 滤镜素材已就绪');
});

main().then(() => {
  if (!mediaStream) return;
  // 循环要在 init 态就跑起来 —— 嘴部判定圈需要逐帧跟着嘴动。
  // 生成和吞噬都被 gameState 门禁挡着，所以这时候画面上不会有任何掉落物。
  startGameLoop();
  // 摄像头就绪只是三个条件之一，还要等图片和模型
  checkReady();
});

// 兜底：网络太差或 CDN 挂了，别把玩家永久留在 loading 上不给任何解释
setTimeout(() => {
  if (readyToPlay) return;
  console.error('[BOOT] 超时未就绪  素材:', imagesReady, ' 模型:', trackingReady,
    ' 摄像头:', !!mediaStream, '\n  ' + bootSummary());
  setHint(GAME.HINTS.failed);
}, GAME.READY_TIMEOUT * 1000);
