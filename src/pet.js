'use strict';

/**
 * PixelPet 渲染进程
 * 形象、动作、帧率、台词、主题与行为参数全部来自当前皮肤文件夹里的
 * skin.json + persona.txt + PNG（由主进程以 dataURL 注入，避免 file:// 画布污染）。
 * 这里没有任何按皮肤写死的映射，换皮肤即整套替换。
 */

const api = window.pet;
const canvas = document.getElementById('pet-canvas');
const ctx = canvas.getContext('2d');
const bubbleEl = document.getElementById('bubble');
const timerEl = document.getElementById('pomodoro-timer');

// 画布逻辑尺寸由皮肤 manifest 的 canvas 段决定，loadSkin() 时重新应用
let CW = 160;
let CH = 180;
let GROUND_Y = 176;          // 角色脚底对齐线（画布逻辑坐标）

function applyCanvasSize() {
  canvas.width = CW;
  canvas.height = CH;
  ctx.imageSmoothingEnabled = false;
  fitCanvas();
}
applyCanvasSize();

/** 按画布比例等比缩放并居中显示；窗口比例被改动时也不会把宠物拉扁 */
function fitCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return;
  const scale = Math.min(w / CW, h / CH);
  canvas.style.width = `${Math.round(CW * scale)}px`;
  canvas.style.height = `${Math.round(CH * scale)}px`;
}

window.addEventListener('resize', fitCanvas);
fitCanvas();

const frames = {};        // 文件名 -> { img, mask, bbox }
let lastDraw = null;      // 当前帧绘制信息，用于像素级点击检测

const DEFAULT_BEHAVIOR = {
  // 速率调到几十秒~几分钟可见：一个 tick = 10 秒
  fatiguePerTickDay: 0.8,        // 白天约 +4.8/分钟
  fatiguePerTickNight: 1.5,      // 夜间约 +9/分钟
  fatigueRecoverPerTick: 1.2,    // 离开后约 -7.2/分钟
  fatigueSleepRecoverPerTick: 2.5, // 打盹中约 -15/分钟，比自然增长快，能真正缓过来
  fatigueDragAdd: 3,
  moodBaseline: 70,              // 心情自然基准，缓慢向它靠拢
  moodDecayPerTick: 0.3,         // 长时间没人陪时额外下降
  moodSleepyThreshold: 85,
  idleSleepAfter: 90
};

/** 老皮肤/内置皮肤的 manifest 里写的是旧版极慢速率，抬到保底线，避免数值看起来永远不动 */
function enforceBehaviorFloor(b) {
  ['fatiguePerTickDay', 'fatiguePerTickNight', 'fatigueRecoverPerTick', 'fatigueSleepRecoverPerTick', 'moodDecayPerTick'].forEach((k) => {
    b[k] = Math.max(Number(b[k]) || 0, DEFAULT_BEHAVIOR[k]);
  });
  return b;
}

let settings = null;
let stateLoaded = false;
let skinPack = null;     // 当前皮肤的完整 manifest（actions / triggers / effects / canvas / theme）
let persona = {};        // 当前皮肤专属台词
let actionConfig = {};   // 当前皮肤动作表
let behavior = Object.assign({}, DEFAULT_BEHAVIOR);
let lastExpr = '';       // 上一次绘制的动作，用于切换动作时重置序列帧
let exprSince = 0;

let mood = 70;
let fatigue = 20;
let affection = 0;
let lastDaily = '';
let lastInteraction = Date.now();

let overrideExpr = null;
let dragging = false;
let following = false;
let followMoving = false;   // 跟随时是否正在移动（决定跑还是待机）
let followSpeed = 0.5;      // 跟随时速度档位 0~1，用于让跑动帧率跟随位移速度
let locked = false;
let forcePassthrough = false;
let roamEnabled = true;
let roamTimer = null;
let facing = 1;          // 1 朝右，-1 朝左（素材本身朝右）
let actionRate = 1;      // 动作频率倍率（设置项 pet.actionRate），越小动作越慢

let hit = false;
let lastPointer = { x: -1, y: -1 };   // 最近一次鼠标位置，用于穿透状态重算
let ignoring = null;
let down = null;
let longTimer = null;
let moved = false;
let followClickAt = 0;       // 跟随点击专用防抖

let bubbleTimer = null;
let hoverTimer = null;
let pomodoro = null;
let pomodoroTimer = null;
let pomodoroBlipTimer = null;
let audioCtx = null;
let lastDrawTime = 0;
let systemIdleSeconds = 0;
let hasSystemIdle = false;
const reactionCooldown = {};

/* ---------------- 素材加载 ---------------- */

function makeFrame(name, source) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let mask = null;
      let bbox = { x: 0, y: 0, w: img.width, h: img.height };
      try {
        const off = document.createElement('canvas');
        off.width = img.width;
        off.height = img.height;
        const octx = off.getContext('2d', { willReadFrequently: true });
        octx.drawImage(img, 0, 0);
        const data = octx.getImageData(0, 0, img.width, img.height).data;
        mask = new Uint8Array(img.width * img.height);
        let minX = img.width;
        let minY = img.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < img.height; y += 1) {
          for (let x = 0; x < img.width; x += 1) {
            if (data[(y * img.width + x) * 4 + 3] > 24) {
              mask[y * img.width + x] = 1;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= 0) bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      } catch (err) {
        // 画布被污染时退化为整图包围盒
      }
      frames[name] = { img, mask, bbox };
      resolve();
    };
    img.onerror = () => resolve();
    img.src = source;
  });
}

let spriteGeneration = 0;          // 防止快速换肤时旧加载覆盖新加载
let currentSkin = null;

/** 整套加载一个皮肤：动作表、帧率、台词、行为参数、画布尺寸、主题与全部序列帧 */
async function loadSkin(skin) {
  const generation = ++spriteGeneration;
  let pack = null;
  try {
    pack = await api.readSkin(skin);
  } catch (err) {
    console.warn('[pet] 皮肤资源读取失败', err);
  }
  if (generation !== spriteGeneration) return;
  if (!pack || !pack.frames || !Object.keys(pack.frames).length) {
    console.warn('[pet] 皮肤不可用:', skin);
    return;
  }

  currentSkin = pack.id;
  skinPack = pack;
  persona = pack.persona || {};
  actionConfig = pack.actions || {};
  behavior = enforceBehaviorFloor(Object.assign({}, DEFAULT_BEHAVIOR, pack.behavior || {}));

  const cv = pack.canvas || {};
  CW = Number(cv.width) || 160;
  CH = Number(cv.height) || 180;
  GROUND_Y = Number(cv.groundY) || 176;
  applyCanvasSize();

  Object.keys(frames).forEach((name) => delete frames[name]);
  await Promise.all(Object.keys(pack.frames).map((name) => makeFrame(name, pack.frames[name])));
  if (generation !== spriteGeneration) return;
  lastExpr = '';
  console.log('[pet] skin loaded:', currentSkin, Object.keys(frames).length, '帧 /', Object.keys(actionConfig).length, '动作');
}

/* ---------------- 配置与初始化 ---------------- */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 离开时长优先取系统输入空闲时间，避免"一直在工作但没摸猫"被当成离开 */
function awayMs() {
  const useSystemIdle = settings && settings.system && settings.system.monitor !== false && hasSystemIdle;
  return useSystemIdle ? systemIdleSeconds * 1000 : Date.now() - lastInteraction;
}

async function init() {
  settings = await api.getSettings();
  await loadSkin(settings.pet && settings.pet.skin);
  requestAnimationFrame(loop);

  applySettings(settings);
  api.setIgnoreMouse(true);

  setInterval(tickState, 10000);
  setInterval(persistState, 10000);
  setInterval(watchIdle, 10000);
  setInterval(maybeRoam, 4000);

  api.onSettings(applySettings);
  api.onCommand(handleCommand);
  api.onMetrics(handleMetrics);
  api.onDragEnded(onDragEndedFromMain);
  api.onFollowEnded(onFollowEndedFromMain);
  if (api.onFollowStarted) api.onFollowStarted(onFollowStartedFromMain);
  if (api.onFollowMotion) api.onFollowMotion(onFollowMotion);
  api.onWanderEnded((info) => stopWalk(!!(info && info.edge)));

  window.addEventListener('beforeunload', persistStateOnUnload);
}

function applySettings(next) {
  settings = next;

  // 皮肤变化时重新加载序列帧（首次由 init 加载，这里只处理后续切换）
  const nextSkin = (next.pet && next.pet.skin) || 'default';
  if (currentSkin !== null && nextSkin !== currentSkin) {
    loadSkin(nextSkin).catch((err) => console.warn('[pet] 换肤失败', err));
  }
  // 状态只从存档读取一次，之后的设置变更不能覆盖运行中的心情/疲劳。
  // next 的各顶层段做空值兜底：旧版存档/配置迁移时可能缺字段，避免解引用崩溃。
  const st = next.state || {};
  if (!stateLoaded) {
    stateLoaded = true;
    mood = clamp(Number(st.mood) || 0, 0, 100);
    fatigue = clamp(Number(st.fatigue) || 0, 0, 100);
    affection = Number(st.affection) || 0;
    lastDaily = st.lastDaily || '';
  }
  const rate = next.pet && Number(next.pet.actionRate);
  actionRate = rate > 0 ? rate : 1;
  const win = next.window || {};
  locked = !!win.locked;
  forcePassthrough = !!win.passthrough;
  roamEnabled = !next.system || next.system.roam !== false;
  if (!roamEnabled || locked) stopWalk(false);
  updateIgnore();
}

/* ---------------- 自由走动 ---------------- */

function maybeRoam() {
  if (!api || !settings || !roamEnabled || document.hidden) return;
  if (locked || dragging || down || pomodoro || hit) return;
  if (overrideExpr || roamTimer) return;
  if (Date.now() - lastInteraction < 8000) return;
  if (Math.random() > 0.45) return;
  startWalk();
}

function startWalk() {
  if (roamTimer) return;
  facing = Math.random() < 0.5 ? -1 : 1;
  const duration = 1600 + Math.random() * 2400;
  lastInteraction = Date.now();
  setOverride('walk', duration);
  api.wanderStart(facing, 45 + Math.random() * 30);
  roamTimer = setTimeout(() => stopWalk(false), duration);
}

function stopWalk(edge) {
  const walking = !!roamTimer || (overrideExpr && overrideExpr.name === 'walk');
  if (!walking) return;
  if (roamTimer) {
    clearTimeout(roamTimer);
    roamTimer = null;
  }
  if (overrideExpr && overrideExpr.name === 'walk') overrideExpr = null;
  if (api) api.wanderStop();
  if (edge) {
    facing = -facing;
    setOverride('wave', 900);
  }
}

/* ---------------- 鼠标穿透 ---------------- */

function overPet(clientX, clientY) {
  if (!lastDraw) return false;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const gx = (clientX - rect.left) / (rect.width / CW);
  const gy = (clientY - rect.top) / (rect.height / CH);
  const view = lastDraw;
  const px = view.mirror ? CW - gx : gx;
  const ix = Math.floor(px - view.dx);
  const iy = Math.floor(gy - view.dy);
  if (ix < 0 || iy < 0 || ix >= view.w || iy >= view.h) return false;

  const frame = frames[view.name];
  if (frame && frame.mask) {
    for (let oy = -2; oy <= 2; oy += 1) {
      for (let ox = -2; ox <= 2; ox += 1) {
        const x = ix + ox;
        const y = iy + oy;
        if (x >= 0 && y >= 0 && x < view.w && y < view.h && frame.mask[y * view.w + x]) return true;
      }
    }
    return false;
  }
  const bbox = frame ? frame.bbox : { x: 0, y: 0, w: view.w, h: view.h };
  return ix >= bbox.x - 2 && ix <= bbox.x + bbox.w + 2 &&
         iy >= bbox.y - 2 && iy <= bbox.y + bbox.h + 2;
}

function updateIgnore() {
  if (dragging || following) return; // 跟随期间穿透由主进程按全局鼠标位置控制
  const shouldIgnore = forcePassthrough || !hit;
  if (shouldIgnore !== ignoring) {
    ignoring = shouldIgnore;
    api.setIgnoreMouse(shouldIgnore);
  }
}

/* ---------------- 交互识别 ---------------- */

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  stopWalk(false);
  // 同时记录视口坐标（命中判定用）与屏幕绝对坐标（拖拽判定用）。
  // 跟随时窗口会持续移动，clientX/clientY 相对窗口会漂移，若用它判拖拽会把“点击停止”误判成拖拽。
  down = { x: event.clientX, y: event.clientY, sx: event.screenX, sy: event.screenY, long: false };
  moved = false;
  try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
  clearTimeout(longTimer);
  longTimer = setTimeout(() => {
    if (!down || moved) return;
    down.long = true;
    lastInteraction = Date.now();
    setOverride('happy', 1600);
    bubble(say('longpress', '放开啦，好痒——'), 1800);
    blip(520, 0.06);
    changeMood(4);
  }, 1000);
});

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.showContextMenu();
});

document.addEventListener('pointermove', (event) => {
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
  hit = overPet(event.clientX, event.clientY);
  updateIgnore();

  if (hit) scheduleHover();

  if (!down || moved) return;
  // 用屏幕绝对坐标判定拖拽：跟随/走动时窗口在移动，clientX 会随之漂移导致误判。
  const moveDist = Math.hypot(
    event.screenX - (down.sx == null ? down.x : down.sx),
    event.screenY - (down.sy == null ? down.y : down.sy)
  );
  if (moveDist > 8) {
    if (locked) {
      // 锁定时虽不拖动，但必须标记为已移动并取消长按计时，
      // 否则长按回调仍会触发 happy 动作和气泡（点击彩蛋已被 locked 屏蔽，长按漏了）。
      moved = true;
      clearTimeout(longTimer);
      return;
    }
    moved = true;
    clearTimeout(longTimer);
    if (following) api.followStop();   // 请主进程停止跟随，状态由它回推
    dragging = true;
    api.dragStart();
    setOverride('drag', 3600000);
    bubble(say('drag', '别晃，头晕……'), 1500);
    changeFatigue(Number(behavior.fatigueDragAdd) || 3);
  }
});

function finishPointer() {
  clearTimeout(longTimer);
  if (dragging) {
    dragging = false;
    api.dragEnd();
    overrideExpr = null;
    lastInteraction = Date.now();
    updateIgnore();
  } else if (down && !down.long) {
    handleClick();
  }
  down = null;
}

document.addEventListener('pointerup', finishPointer);
document.addEventListener('pointercancel', finishPointer);

/** 鼠标移出窗口或窗口失焦时重置命中态，避免透明窗口吞掉桌面点击 */
function clearHit() {
  if (!hit) return;
  hit = false;
  updateIgnore();
}
document.addEventListener('mouseleave', clearHit);
document.addEventListener('pointerleave', clearHit);
window.addEventListener('blur', clearHit);

function onDragEndedFromMain() {
  dragging = false;
  overrideExpr = null;
  lastInteraction = Date.now();
  setOverride('happy', 700);
  updateIgnore();
}

/* ---------------- 追随鼠标 ---------------- */

/**
 * 进入跟随的本地表现。由主进程 follow:started 事件驱动——
 * 主进程是跟随状态的唯一真相源，渲染层只是镜像，绝不自己改 following 再反向通知。
 */
function onFollowStartedFromMain() {
  if (following || locked) return;
  following = true;
  followMoving = false;
  followSpeed = 0.5;
  stopWalk(false);
  facing = 1;
  // 跟随时窗口只显示角色本身：清掉可能残留的台词气泡，并阻止之后自动气泡再冒出来。
  // 气泡的深棕边框在 0.5 倍缩放的小窗口里像一块“选中黑框”，是之前误报的主要来源。
  clearTimeout(hoverTimer);
  hideBubble();
  // 跟随过程不弹气泡：小窗口里 2px 深色硬边框的气泡几乎横跨半屏，
  // 看起来像人物背后贴了块黑色长方形。跟随时保持画面干净，只保留轻提示音。
  blip(720, 0.09);
  changeMood(3);
}

/** 主进程推送的跟随运动状态：朝向 + 是否在跑 */
function onFollowMotion(info) {
  if (!following || !info) return;
  if (typeof info.dir === 'number') facing = info.dir;
  if (typeof info.moving === 'boolean') followMoving = info.moving;
  if (typeof info.speed === 'number') followSpeed = Math.min(1, Math.max(0, info.speed));
  // 从跑切到停时，速度档位归位，避免下次起步沿用旧速度
  if (info.moving === false) followSpeed = 0.5;
}

function onFollowEndedFromMain() {
  // 主进程因锁定/隐藏/重置，或响应渲染层停止而触发：无论本地 following 是否已复位，
  // 都要把穿透状态交还渲染层并强制重算，否则会残留“窗口可点/穿透”的错状态。
  following = false;
  followMoving = false;
  // 跟随时点番茄钟：startPomodoro 会先请求停跟随并立即设好 read override，
  // 而本回推是异步 IPC、晚于 override 到达。此刻不能把刚设的专注陪伴动作清掉，
  // 否则专注期间宠物会回退到待机/睡觉。
  const focusOverride = pomodoro && pomodoro.phase === 'focus'
    && overrideExpr && overrideExpr.name === 'read';
  if (!focusOverride) overrideExpr = null;
  lastInteraction = Date.now();
  // 停止跟随也保持画面干净，不把跟随时压住的气泡延迟放出来
  hideBubble();
  // 主进程已把窗口设回默认穿透；清掉本地缓存，强制按当前命中重新下发
  ignoring = null;
  hit = overPet(lastPointer.x, lastPointer.y);
  updateIgnore();
  // 停止同样不弹气泡（原因见 onFollowStartedFromMain），保留轻提示音并落盘
  blip(560, 0.08);
  persistStateSoon();
}

function handleClick() {
  // 位置锁定期间点击不再请求跟随，避免出现“窗口移动但动作不变”的假跟随
  if (locked) return;
  const now = Date.now();

  // 单击切换“追随鼠标”：只向主进程发切换请求，状态由主进程裁决并回推，
  // 不再本地改 following（本地改再反向通知会与主控台按钮/托盘形成双状态源冲突）。
  if (now - followClickAt < 320) return;
  followClickAt = now;
  lastInteraction = now;
  touchAffection();

  api.followToggle();
  persistStateSoon();
  // 说明：旧的“连点 3/5 次开心/生气”彩蛋与单击切换跟随冲突（每次点击都会切换状态），
  // 已让位于跟随主交互；摸头长按、拖拽等其它彩蛋仍然保留。
}

function scheduleHover() {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (dragging || overrideExpr) return;
    setOverride('hover', 1400);
  }, 3000);
}

function setOverride(name, ms) {
  overrideExpr = { name, until: Date.now() + ms };
}

/* ---------------- 状态机 ---------------- */

function changeMood(delta) {
  mood = clamp(mood + delta, 0, 100);
}

function changeFatigue(delta) {
  fatigue = clamp(fatigue + delta, 0, 100);
}

function touchAffection() {
  const today = new Date().toDateString();
  if (lastDaily === today) return;
  lastDaily = today;
  affection += 1;
  api.saveState({ affection, lastDaily });
}

function tickState() {
  if (!settings) return;
  const hour = new Date().getHours();
  const night = hour >= 23 || hour < 6;
  const now = Date.now();
  // 打盹中（sleep 表现生效）：疲劳由自然增长改为缓慢恢复，让"睡一觉"真的能缓过来。
  // 否则用户一直不离开电脑时疲劳只会涨不会降，顶到 100 后永远卡在睡觉动作。
  const napping = !!(overrideExpr && overrideExpr.name === 'sleep' && now < overrideExpr.until);
  if (napping) {
    fatigue = clamp(fatigue - behavior.fatigueSleepRecoverPerTick, 0, 100);
    mood = clamp(mood + 0.4, 0, 100);   // 眯一会儿，心情也略微回升
  } else {
    fatigue = clamp(fatigue + (night ? behavior.fatiguePerTickNight : behavior.fatiguePerTickDay), 0, 100);
  }

  const away = awayMs();
  // 心情：随时间缓慢向基准漂移 + 轻微起伏，让数值一直"活着"（几十秒可见）。
  // 基准随一天中的时段起伏：白天偏高、深夜偏低；久坐不互动会额外下拉。
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const dayBias = Math.sin((h - 8) / 24 * Math.PI * 2) * 8;   // ±8 的昼夜起伏
  const moodTarget = clamp((Number(behavior.moodBaseline) || 70) + dayBias, 20, 95);
  mood = clamp(mood + (moodTarget - mood) * 0.08 + (Math.random() - 0.5) * 2.0, 0, 100);
  if (away > 10 * 60 * 1000) {
    mood = clamp(mood - behavior.moodDecayPerTick, 0, 100);
  }
  if (away > 3 * 60 * 1000) {
    fatigue = clamp(fatigue - behavior.fatigueRecoverPerTick, 0, 100);
  }

  const sleepy = fatigue > behavior.moodSleepyThreshold;
  // 跟随时只表现跑/停，不让"困了/打盹"气泡和 override 插进来抢画面。
  // 越累越想睡；因为打盹会恢复疲劳，疲劳会在困倦线附近起伏，而不是卡死在 100。
  if (!napping && !following && sleepy && !dragging && !overrideExpr) {
    const napChance = fatigue > 95 ? 0.5 : 0.3;
    if (Math.random() < napChance) {
      setOverride('sleep', 15000);
      bubble(say('sleep', '呼……打个盹。'), 2500);
    }
  }
}

function watchIdle() {
  if (following) return;
  const idleMs = awayMs();
  if (idleMs > 30000 && !dragging && !overrideExpr && Math.random() < 0.3) {
    setOverride('sleep', 8000);
    if (Math.random() < 0.5) bubble(say('sleep', '打个小盹……'), 2200);
  }
}

function persistStateSoon() {
  clearTimeout(persistStateSoon.timer);
  persistStateSoon.timer = setTimeout(persistState, 1200);
}

function currentStateSnapshot() {
  return {
    mood: Math.round(mood * 10) / 10,
    fatigue: Math.round(fatigue * 10) / 10,
    affection,
    lastDaily,
    lastInteract: lastInteraction
  };
}

function persistState() {
  if (!settings) return;
  api.saveState(currentStateSnapshot());
}

/** 页面卸载时用同步通知落盘，避免 invoke 来不及返回导致最后状态丢失 */
function persistStateOnUnload() {
  if (!settings || !api.saveStateSync) return;
  api.saveStateSync(currentStateSnapshot());
}

/* ---------------- 系统联动 ---------------- */

/** 从存档重新读取心情/疲劳/好感等状态（供 state:reload 命令调用） */
async function reloadState() {
  try {
    const next = await api.getSettings();
    stateLoaded = false;
    applySettings(next);
  } catch (err) {
    console.warn('[pet] 状态重载失败', err);
  }
}

function react(key, exprName, text, cooldownMs) {
  if (dragging || following) return false;
  // 番茄钟的 read override 覆盖整个专注时段，系统事件（CPU/电量/久坐）的短时
  // override 不能打断它，否则专注画面会突然变成 hot/sleep 再回退，前后矛盾。
  if (pomodoro || (overrideExpr && overrideExpr.until > Date.now())) return false;
  const now = Date.now();
  if (reactionCooldown[key] && now - reactionCooldown[key] < cooldownMs) return false;
  reactionCooldown[key] = now;
  setOverride(exprName, 6000);
  if (text) bubble(text, 3500);
  return true;
}

function handleMetrics(metrics) {
  if (!settings || !settings.system || settings.system.monitor === false) return;
  hasSystemIdle = true;
  systemIdleSeconds = Number(metrics.idleSeconds) || 0;

  const batteryLow = !!metrics.onBattery &&
    typeof metrics.batteryLevel === 'number' && metrics.batteryLevel <= 20;

  if (batteryLow) {
    react('battery', 'sleep', say('battery', '电量好低……要不要充个电？'), 5 * 60 * 1000);
  } else if (metrics.cpu > 80) {
    react('cpu', 'hot', say('cpu', '电脑好烫，我也热……'), 90000);
  } else if (metrics.mem > 0.85) {
    react('mem', 'wave', say('mem', '好多东西，我帮你搬一搬！'), 90000);
  }

  if (settings.system.idleReminder !== false && systemIdleSeconds >= 3600) {
    react('sit', 'wave', say('sit', '坐太久啦，站起来动一动吧～'), 30 * 60 * 1000);
  }
}

/* ---------------- 番茄钟 ---------------- */

function handleCommand(cmd) {
  if (!cmd) return;
  if (cmd.type === 'pomodoro:start') startPomodoro();
  else if (cmd.type === 'pomodoro:stop') stopPomodoro(false);
  else if (cmd.type === 'state:reload') reloadState();
  else if (cmd.type === 'skin:reload') loadSkin(currentSkin).catch((err) => console.warn('[pet] 皮肤重载失败', err));
  else if (cmd.type === 'say') bubble(cmd.text, 3000);
  else if (cmd.type === 'follow:toggle') api.followToggle();
}

function startPomodoro() {
  if (pomodoro) {
    bubble('番茄钟正在进行中～', 1600);
    return;
  }
  stopWalk(false);
  // resolveExpr 中 following 优先级高于 override，跟随时启动番茄钟会导致 read 动作
  // 永远不显示。开始专注前先停止跟随，状态由主进程 follow:ended 回推。
  if (following && api.followStop) api.followStop();
  facing = 1;
  const focusMin = Math.max(1, Number(settings.pomodoro.focus) || 25);
  pomodoro = { phase: 'focus', endAt: Date.now() + focusMin * 60000, minutes: focusMin };
  setOverride('read', focusMin * 60000);
  renderPomodoroTimer();
  bubble(`一起专注 ${focusMin} 分钟吧！`, 3200);
  blip(660, 0.12);
  api.reportPomodoro({ running: true, phase: 'focus', remain: focusMin * 60000 });
  pomodoroTimer = setInterval(pomodoroTick, 1000);
}

function stopPomodoro(finished) {
  if (pomodoroTimer) {
    clearInterval(pomodoroTimer);
    pomodoroTimer = null;
  }
  clearTimeout(pomodoroBlipTimer);
  pomodoroBlipTimer = null;
  pomodoro = null;
  overrideExpr = null;
  renderPomodoroTimer();
  api.reportPomodoro({ running: false, phase: 'idle', remain: 0 });
  if (!finished) bubble('番茄钟已停止。', 1800);
}

function pomodoroTick() {
  if (!pomodoro) return;
  const remain = Math.max(0, pomodoro.endAt - Date.now());
  renderPomodoroTimer();
  api.reportPomodoro({ running: true, phase: pomodoro.phase, remain });
  if (remain > 0) return;

  if (pomodoro.phase === 'focus') {
    const breakMin = Math.max(1, Number(settings.pomodoro.break) || 5);
    // 上报专注完成：主进程负责落盘统计与系统通知
    if (api.reportPomodoroComplete) {
      api.reportPomodoroComplete({ phase: 'focus', minutes: pomodoro.minutes || 25, at: Date.now() });
    }
    pomodoro = { phase: 'break', endAt: Date.now() + breakMin * 60000, minutes: breakMin };
    renderPomodoroTimer();
    mood = clamp(mood + 6, 0, 100);
    affection += 3;
    lastInteraction = Date.now();
    persistState();
    bubble(say('pomodoro', '专注结束，休息一下！'), 4200);
    setOverride('happy', 4000);
    blip(880, 0.12);
    clearTimeout(pomodoroBlipTimer);
    pomodoroBlipTimer = setTimeout(() => blip(1180, 0.12), 160);
  } else {
    if (api.reportPomodoroComplete) {
      api.reportPomodoroComplete({ phase: 'break', minutes: pomodoro.minutes || 5, at: Date.now() });
    }
    stopPomodoro(true);
    bubble('休息结束，继续加油！', 3000);
    setOverride('happy', 2500);
  }
}

/* ---------------- 气泡与音效 ---------------- */

function bubble(text, ms = 2200) {
  // 跟随期间一律不弹气泡：它有 2px 深棕边框和浅色底，在小窗里非常像“选中黑框”
  if (!text || following) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms);
}

/** 立即收起气泡并清空计时，避免切换状态时残留深棕边框矩形 */
function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubbleEl.classList.remove('show');
  bubbleEl.textContent = '';
}

function say(action, fallback) {
  const pool = persona[action];
  // 台词池必须是字符串数组：persona.txt 若把某段误配成字符串，
  // pool.length 会非零但 pool[i] 是单个字符，冒出乱码。
  if (Array.isArray(pool) && pool.length) {
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return fallback || '';
}

/** 用 Web Audio 合成提示音，避免依赖音效素材；音量取自设置 */
function blip(freq, duration, type = 'sine', level = 0.05) {
  const volume = settings && settings.pet ? Number(settings.pet.volume) : 60;
  if (!volume) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = (volume / 100) * level;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {
    // 音效失败不影响动画
  }
}

/* ---------------- 绘制 ---------------- */

/** 事件 → 动作名：皮肤可在 triggers 里把标准事件重映射到自己的独有动作 */
function resolveAction(expr) {
  const t = skinPack && skinPack.triggers;
  const mapped = t && typeof t[expr] === 'string' ? t[expr] : expr;
  if (actionConfig[mapped]) return mapped;
  if (actionConfig[expr]) return expr;
  return 'idle';
}

/** 待机动作池：皮肤可让 idle / 打哈欠 / 伸懒腰 等动作轮流出现。
 *  每个待机动作固定展示 4.5 秒后切下一个，用本地计时而非墙上时钟：
 *  从别的动作切回待机时总是从 idle 池第一个动作开始，避免起点漂移导致
 *  偶尔连续出现同一个待机动作。 */
let idlePoolIndex = 0;
let idlePoolChangedAt = 0;
function idlePool() {
  const pool = skinPack && skinPack.triggers && skinPack.triggers.idlePool;
  return Array.isArray(pool) ? pool : null;
}
function pickIdle() {
  const pool = idlePool();
  if (!pool || pool.length < 2) return 'idle';
  const now = Date.now();
  if (!idlePoolChangedAt) idlePoolChangedAt = now;
  if (now - idlePoolChangedAt >= 4500) {
    idlePoolIndex = (idlePoolIndex + 1) % pool.length;
    idlePoolChangedAt = now;
  }
  return pool[idlePoolIndex] || 'idle';
}
/** 重置待机池轮换（离开待机表现时调用，下次回来从第一个动作开始） */
function resetIdlePool() {
  idlePoolIndex = 0;
  idlePoolChangedAt = 0;
}

function fpsOf(expr) {
  const act = actionConfig[resolveAction(expr)];
  let fps = ((act && act.fps) || 2) * actionRate;
  // 跟随时跑动帧率随位移速度缩放：追得急时迈步快，接近时放慢，和位移节奏一致。
  // 用原始状态名 expr 判断而非 resolveAction 结果：皮肤在 triggers 里把 run 重映射成
  // 自定义动作（如 dash）时，跟随加速依然生效。
  if (following && followMoving && expr === 'run') {
    fps *= 0.7 + followSpeed * 0.6;   // 0.7x ~ 1.3x
  }
  return fps;
}

function resolveExpr() {
  const now = Date.now();
  let expr;
  // 跟随时优先表现：移动中切小跑，停下切待机，不被长期 override 卡住
  if (following) expr = followMoving ? 'run' : 'idle';
  else if (overrideExpr && now < overrideExpr.until) expr = overrideExpr.name;
  else {
    if (overrideExpr) overrideExpr = null;
    if (dragging) expr = 'drag';
    else if (fatigue > behavior.moodSleepyThreshold) expr = 'sleep';
    else if (awayMs() > behavior.idleSleepAfter * 1000) expr = 'sleep';
    else expr = pickIdle();
  }
  // 离开待机池动作（进入 run/sleep/drag/override 等）时重置轮换，
  // 下次回到待机从第一个动作开始，避免起点漂移导致连续重复同一待机动作。
  const pool = idlePool();
  if (!pool || pool.indexOf(expr) < 0) resetIdlePool();
  return expr;
}

function availableFrames(expr) {
  const act = actionConfig[resolveAction(expr)] || actionConfig.idle;
  return ((act && act.frames) || []).filter((name) => frames[name]);
}

function draw(expr, t) {
  ctx.clearRect(0, 0, CW, CH);
  // 动作切换时从第一帧重新播放，也让 loop:false 的独有动作有明确的起点
  if (expr !== lastExpr) {
    lastExpr = expr;
    exprSince = t;   // 帧进度从 exprSince 重新计算即可，无需动 lastDrawTime
  }

  const list = availableFrames(expr);
  if (!list.length) {
    lastDraw = null;
    return;
  }
  const act = actionConfig[resolveAction(expr)] || {};
  const step = Math.floor(Math.max(0, t - exprSince) * fpsOf(expr));
  const frameIndex = act.loop === false ? Math.min(step, list.length - 1) : step % list.length;
  const name = list[frameIndex];
  const frame = frames[name];
  const mirror = !!act.mirror && facing < 0;
  const dx = Math.round((CW - frame.img.width) / 2);
  // 颠簸幅度由皮肤动作配置决定，配合横向位移呈现"跑起来"的感觉。
  // 按帧数在起伏序列上取模：任意帧数的 run 都能铺满完整节奏，
  // 2 帧时只用前两档、3 帧用前三档，不会出现跳变的突兀感。
  const bobMax = Number(act.bob) || 0;
  const bobPattern = [0, 0.7, 0.35, 1];
  const bobSlots = Math.min(list.length, bobPattern.length);
  const bob = bobMax ? Math.round(bobMax * bobPattern[frameIndex % bobSlots]) : 0;
  const dy = Math.round(GROUND_Y - frame.img.height) - bob;

  ctx.save();
  if (mirror) {
    ctx.translate(CW, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame.img, dx, dy);
  ctx.restore();
  lastDraw = { name, dx, dy, w: frame.img.width, h: frame.img.height, mirror };

  drawExtras(expr, frame, dx, dy, t, mirror);
}

function drawExtras(expr, frame, dx, dy, t, mirror) {
  const bbox = frame.bbox;
  if (!bbox || !bbox.w) return;
  const fx = (skinPack && skinPack.effects) || {};
  // 符号跟随角色朝向：镜像时角色脸朝左，符号应画在左侧而不是背后。
  // bbox 是未镜像的局部坐标，镜像后的右边缘对应画布上的 CW-(dx+bbox.x+bbox.w)。
  const edgeX = mirror ? CW - (dx + bbox.x + bbox.w) : dx + bbox.x + bbox.w;
  const dir = mirror ? -1 : 1;

  // 只有皮肤为该状态提供了专属动作帧时才叠加符号。
  // 若该状态回退成 idle（皮肤没配 sleep / hot / angry 动作），画面并不是这个动作，
  // 此时画 Zzz / 汗滴 / 怒气会和画面矛盾（例：奶龙站着待机却冒出睡觉符号）。
  const hasOwnAction = resolveAction(expr) !== 'idle';

  if (hasOwnAction && expr === 'sleep') {
    const x = edgeX - 6 * dir;
    const y = dy + bbox.y + 8;
    ctx.fillStyle = fx.sleepZ || '#a9c2d6';
    ctx.font = 'bold 9px "Microsoft YaHei", sans-serif';
    ctx.textAlign = mirror ? 'right' : 'left';
    ctx.fillText('z', x, y);
    ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
    ctx.fillText('z', x + 5 * dir, y - 7);
  }

  if (hasOwnAction && expr === 'hot') {
    const x = edgeX - 5 * dir;
    const y = dy + bbox.y + 6;
    ctx.fillStyle = fx.hotDrop || '#93d9f5';
    ctx.fillRect(x, y + 2, 3, 5);
    ctx.fillRect(x + 1, y, 1, 2);
  }

  if (hasOwnAction && expr === 'angry') {
    const x = edgeX + 1 * dir;
    const y = dy + bbox.y + 4 + (Math.floor(t * 6) % 2);
    ctx.fillStyle = fx.angryMark || '#e2685f';
    ctx.fillRect(x, y, 2, 2);
    ctx.fillRect(x + 3 * dir, y + 2, 2, 2);
  }
}

/** 倒计时改用 DOM 渲染，避免小字号在像素放大后发糊 */
function renderPomodoroTimer() {
  if (!pomodoro) {
    timerEl.classList.remove('show');
    return;
  }
  const remain = Math.max(0, pomodoro.endAt - Date.now());
  const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
  const text = `${mm}:${ss}`;
  if (timerEl.textContent !== text) timerEl.textContent = text;
  timerEl.classList.add('show');
}

/* ---------------- 主循环 ---------------- */

function loop(now) {
  requestAnimationFrame(loop);
  if (document.hidden) return;

  const expr = resolveExpr();
  const fps = fpsOf(expr);
  if (now - lastDrawTime < 1000 / Math.max(fps, 1)) return;
  lastDrawTime = now;

  try {
    draw(expr, now / 1000);
  } catch (err) {
    console.warn('[pet] 绘制失败', err);
  }
}

init().catch((err) => {
  console.error('[pet] 初始化失败', err);
  bubble('初始化出了点问题，但我还在。', 5000);
});
