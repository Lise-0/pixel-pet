'use strict';

const api = window.pet;
const $ = (id) => document.getElementById(id);

let settings = null;
let skins = [];
let pomodoroRunning = false;
let syncing = false;
let clockTimer = null;          // 时钟定时器句柄
let liveStateTimer = null;      // 状态拉取定时器句柄
let previewRaf = 0;             // 预览动画帧句柄

/* ---------------- 状态趋势采样 ---------------- */
// 每次状态拉取记一个点，存 localStorage 让关掉主页再打开也能看到趋势。
// 24 点 × 5 秒 = 最近 2 分钟。
const TREND_KEY = 'pixelpet.stateTrend.v1';
const TREND_MAX = 24;
let stateTrend = { mood: [], fatigue: [] };

function loadStateTrend() {
  try {
    const raw = localStorage.getItem(TREND_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    // 没有/非法的采样时间就不能判断新鲜度，宁可丢掉也不载入任意久远的历史。
    // 失效时连内存里的旧曲线一起清掉，避免调用方重复加载时看到半成品。
    if (!d || !Number.isFinite(d.at) || Date.now() - d.at >= 30 * 60 * 1000 ||
        !Array.isArray(d.mood) || !Array.isArray(d.fatigue)) {
      stateTrend = { mood: [], fatigue: [] };
      return;
    }
    // 两条曲线必须按同一批采样点成对还原：分别 filter 会丢掉不同索引，
    // 让心情与疲劳的数据点永久错位。
    const n = Math.min(d.mood.length, d.fatigue.length);
    const mood = [];
    const fatigue = [];
    for (let i = Math.max(0, n - TREND_MAX); i < n; i++) {
      const m = Number(d.mood[i]);
      const f = Number(d.fatigue[i]);
      if (Number.isFinite(m) && Number.isFinite(f)) { mood.push(m); fatigue.push(f); }
    }
    stateTrend = { mood, fatigue };
  } catch (err) {
    stateTrend = { mood: [], fatigue: [] };   // 存储不可用/内容损坏则用空历史
  }
}

function pushStateTrend(mood, fatigue) {
  if (!Number.isFinite(mood) || !Number.isFinite(fatigue)) return;
  const now = Date.now();
  // 采样间隔过短就只更新最后一个点，避免换肤/设置变更时刷入重复点
  if (pushStateTrend.lastAt && now - pushStateTrend.lastAt < 3000) {
    if (stateTrend.mood.length && stateTrend.fatigue.length) {
      stateTrend.mood[stateTrend.mood.length - 1] = mood;
      stateTrend.fatigue[stateTrend.fatigue.length - 1] = fatigue;
    }
    drawStateTrend();
    return;
  }
  pushStateTrend.lastAt = now;
  stateTrend.mood.push(mood);
  stateTrend.fatigue.push(fatigue);
  if (stateTrend.mood.length > TREND_MAX) stateTrend.mood.shift();
  if (stateTrend.fatigue.length > TREND_MAX) stateTrend.fatigue.shift();
  try {
    localStorage.setItem(TREND_KEY, JSON.stringify({ mood: stateTrend.mood, fatigue: stateTrend.fatigue, at: now }));
  } catch (err) { /* 存储不可用时仅保留内存历史 */ }
  drawStateTrend();
}

/**
 * 按设备像素比初始化图表画布：尺寸仅在变化时重设（避免每帧清空上下文状态），
 * 返回可直接以 CSS 像素坐标绘制的 2D 上下文。两处图表共用，避免重复的 DPR 样板代码。
 */
function setupChartCanvas(cv, fallbackWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || fallbackWidth;
  const pw = Math.round(w * dpr);
  const ph = Math.round(cssHeight * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, cssHeight);
  return { c, w, h: cssHeight };
}

function drawStateTrend() {
  const cv = $('stateTrend');
  if (!cv) return;
  const { c, w, h } = setupChartCanvas(cv, 220, 44);

  // 淡色参考线：25% / 50% / 75%
  c.strokeStyle = 'rgba(150,125,100,.12)';
  c.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((p) => {
    const y = Math.round(h - p * h) + 0.5;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  });

  const drawLine = (arr, color) => {
    if (arr.length < 2) return;
    const step = (w - 4) / (TREND_MAX - 1);
    const startX = w - 2 - (arr.length - 1) * step;   // 右对齐，最新点贴右边
    c.strokeStyle = color;
    c.lineWidth = 1.6;
    c.lineJoin = 'round';
    c.beginPath();
    arr.forEach((v, i) => {
      const x = startX + i * step;
      const y = h - 2 - (Math.max(0, Math.min(100, v)) / 100) * (h - 4);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    });
    c.stroke();
    // 末端小圆点突出当前值
    const last = arr[arr.length - 1];
    c.fillStyle = color;
    c.beginPath();
    c.arc(w - 2, h - 2 - (Math.max(0, Math.min(100, last)) / 100) * (h - 4), 2, 0, Math.PI * 2);
    c.fill();
  };
  const css = getComputedStyle(document.documentElement);
  drawLine(stateTrend.mood, css.getPropertyValue('--mood').trim() || '#e8a06b');
  drawLine(stateTrend.fatigue, css.getPropertyValue('--fatigue').trim() || '#8fb4cf');
}

/* ---------------- Tab 切换 ---------------- */
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

/* ---------------- 桌宠实时预览 ---------------- */
const preview = {
  canvas: null,
  ctx: null,
  frames: [],
  fps: 2,
  rate: 1,
  gen: 0,
  CW: 160,
  CH: 180,
  GROUND_Y: 176
};

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function buildPreview(skin) {
  const gen = ++preview.gen;
  if (!preview.canvas) {
    preview.canvas = $('previewCanvas');
    preview.ctx = preview.canvas.getContext('2d');
  }
  let pack = null;
  try {
    pack = await api.readSkin(skin);
  } catch (err) {
    console.warn('[home] 预览素材读取失败', err);
  }
  if (gen !== preview.gen) return;
  if (!pack) { preview.frames = []; return; }

  // 画布尺寸、待机帧、播放速度全部来自这款皮肤自己的 skin.json
  const cv = pack.canvas || {};
  preview.CW = Number(cv.width) || 160;
  preview.CH = Number(cv.height) || 180;
  preview.GROUND_Y = Number(cv.groundY) || 176;
  preview.canvas.width = preview.CW;
  preview.canvas.height = preview.CH;
  preview.ctx.imageSmoothingEnabled = false;

  const idle = pack.actions.idle || Object.values(pack.actions)[0] || {};
  preview.fps = Number(idle.fps) || 2;
  const names = (idle.frames || []).filter((n) => pack.frames[n]);
  const imgs = await Promise.all(names.map((n) => loadImage(pack.frames[n])));
  if (gen !== preview.gen) return;
  preview.frames = imgs.filter(Boolean);
  drawPreview(0);
}

function drawPreview(seconds) {
  const c = preview.ctx;
  if (!c || !preview.frames.length) return;
  c.clearRect(0, 0, preview.CW, preview.CH);
  const img = preview.frames[Math.floor(seconds * preview.fps * (preview.rate || 1)) % preview.frames.length];
  const dx = Math.round((preview.CW - img.width) / 2);
  const dy = Math.round(preview.GROUND_Y - img.height);
  c.drawImage(img, dx, dy);
}

function previewLoop(now) {
  previewRaf = requestAnimationFrame(previewLoop);
  if (document.hidden || !preview.frames.length) return;
  drawPreview(now / 1000);
}

/* ---------------- 状态与技能展示 ---------------- */
function renderPetInfo() {
  if (!settings) return;
  const state = settings.state || {};
  const mood = Number(state.mood) || 0;
  const fatigue = Number(state.fatigue) || 0;
  const affection = Number(state.affection) || 0;

  $('barMood').style.width = mood + '%';
  $('valMood').textContent = Math.round(mood);
  $('barFatigue').style.width = fatigue + '%';
  $('valFatigue').textContent = Math.round(fatigue);
  $('barAffection').style.width = Math.min(100, affection) + '%';
  $('valAffection').textContent = Math.round(affection);
  pushStateTrend(mood, fatigue);

  $('statAffection').textContent = Math.round(affection);
  const activeSkin = skins.find((s) => s.id === (settings.pet && settings.pet.skin));
  $('petName').textContent = activeSkin ? activeSkin.name : '我的伙伴';
  $('petDesc').textContent = activeSkin && activeSkin.desc ? activeSkin.desc : '正在陪你工作～';
  $('statSkin').textContent = skins.length || 1;

  // 主题色也由当前皮肤自己决定
  if (activeSkin && activeSkin.theme) {
    const root = document.documentElement.style;
    if (activeSkin.theme.accent) root.setProperty('--accent', activeSkin.theme.accent);
    if (activeSkin.theme.accentDeep) root.setProperty('--accent-deep', activeSkin.theme.accentDeep);
    if (activeSkin.theme.accentSoft) root.setProperty('--accent-soft', activeSkin.theme.accentSoft);
  }

  // 一句随状态变化的心情描述
  const moodEl = $('petMoodText');
  if (moodEl) {
    let text;
    if (fatigue > 75) text = '有点困了，想眯一会儿…';
    else if (mood >= 80) text = '今天心情特别好！';
    else if (mood >= 50) text = '状态不错，陪着你呢。';
    else text = '有点低落，摸摸头就好啦。';
    moodEl.textContent = text;
  }
}

/* ---------------- 实时状态拉取 ---------------- */
// 桌宠的 saveState 只静默写盘、不广播 settings:changed，
// 所以主页自己定时拉取，心情/疲劳/好感才不会停在打开主页那一刻。
// 只合并 state 字段，不碰 pet/window/system 等，避免覆盖用户正在编辑的设置。
let liveStateInFlight = false;
async function refreshLiveState() {
  if (document.hidden || !settings || liveStateInFlight) return;
  liveStateInFlight = true;
  try {
    const latest = await api.getSettings();
    if (latest && latest.state) {
      settings.state = Object.assign({}, settings.state, latest.state);
      renderPetInfo();
    }
  } catch (err) { /* 拉取失败时保留当前显示 */ }
  finally {
    liveStateInFlight = false;
  }
}

/* ---------------- 皮肤网格 ---------------- */
function renderSkins() {
  const grid = $('skinGrid');
  const current = (settings && settings.pet && settings.pet.skin) || 'default';
  grid.innerHTML = '';
  skins.forEach((skin) => {
    const card = document.createElement('div');
    const canRemove = skin.source === 'user' && !skin.builtin;
    card.className = 'skin-card' + (skin.id === current ? ' selected' : '');
    const thumb = skin.thumb
      ? `<img src="${skin.thumb}" alt="" />`
      : `<span class="placeholder">🐱</span>`;
    card.innerHTML = `
      ${skin.id === current ? '<span class="check">✓</span>' : ''}
      ${skin.builtin ? '<span class="badge">内置</span>' : ''}
      <button class="skin-edit" title="编辑这个皮肤的名字、动作和台词">✎</button>
      ${canRemove ? '<button class="skin-remove" title="把这个皮肤移到回收站">×</button>' : ''}
      <div class="skin-thumb">${thumb}</div>
      <div class="skin-name">${escapeHtml(skin.name)}</div>
      <div class="skin-desc">${escapeHtml(skin.desc || '点击换上这款皮肤')}</div>
      <div class="skin-meta">${skin.actionCount || 0} 个动作 · ${skin.frameCount || 0} 帧${canRemove ? ' · 我导入的' : ''}</div>
    `;
    card.addEventListener('click', () => {
      if (skin.id === current) return;
      api.patchSettings({ pet: { skin: skin.id } });
    });
    const editBtn = card.querySelector('.skin-edit');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.SkinWizard) window.SkinWizard.openForEdit(skin.id);
      });
    }
    const removeBtn = card.querySelector('.skin-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`把「${skin.name}」移到回收站？\n它的整个皮肤文件夹都会被移走。`)) return;
        const result = await api.skinRemove(skin.id);
        if (!result || !result.ok) { window.alert((result && result.error) || '移除失败'); return; }
        await refreshSkins(true);
      });
    }
    grid.appendChild(card);
  });
  if (!skins.length) grid.innerHTML = '<div class="loading">暂未找到可用皮肤</div>';
}

/** 重新扫描 assets/skins/：新建文件夹、改动作或改台词后无需重启程序 */
async function refreshSkins(reloadPet) {
  try {
    skins = (await api.listSkins()) || [];
  } catch (err) {
    console.warn('[home] 皮肤列表读取失败', err);
    return;
  }
  renderSkins();
  renderPetInfo();
  if (reloadPet) {
    api.command({ type: 'skin:reload' });
    buildPreview(settings && settings.pet && settings.pet.skin);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/* ---------------- 外观滑块 ---------------- */
// 界面用百分比/整数展示，写入设置时再换算回 0.5~2 等小数
const RANGE_ROWS = [
  { id: 'qScale', val: 'qScaleVal', suffix: '%', key: 'scale', fallback: 1, mul: 100 },
  { id: 'qOpacity', val: 'qOpacityVal', suffix: '%', key: 'opacity', fallback: 1, mul: 100 },
  { id: 'qVolume', val: 'qVolumeVal', suffix: '', key: 'volume', fallback: 60, mul: 1 },
  { id: 'qActionRate', val: 'qActionRateVal', suffix: '%', key: 'actionRate', fallback: 1, mul: 100 },
  { id: 'qFollowLoose', val: 'qFollowLooseVal', suffix: '%', key: 'followLoose', fallback: 70, mul: 1 }
];
const rangeBusy = new Map();    // 用户正在拖动：设置广播不能回写覆盖，否则滑块会往回跳
const rangeTimers = new Map();  // 拖动期间节流提交，避免每个 input 都发 IPC 并重设窗口尺寸

/** 刷新数值标签与轨道填充，返回经 step 吸附后的真实值 */
function paintRange(el, valId, suffix) {
  const v = Number(el.value);
  if (valId) $(valId).textContent = v + suffix;
  const min = Number(el.min), max = Number(el.max);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct.toFixed(1) + '%');
  return v;
}

/** 用设置值同步滑块；先让浏览器按 step 吸附，再用吸附后的值显示，保证标签与滑块位置一致 */
function syncRange(el, raw, valId, suffix) {
  el.value = String(raw);
  return paintRange(el, valId, suffix);
}

/* ---------------- 快捷设置 ---------------- */
function syncSettingsUI() {
  if (!settings) return;
  syncing = true;
  const p = settings.pet || {};
  RANGE_ROWS.forEach((r) => {
    if (rangeBusy.get(r.id)) return;   // 拖动期间跳过回写
    const num = p[r.key] == null ? r.fallback : Number(p[r.key]);
    const safe = Number.isFinite(num) ? num : r.fallback;
    syncRange($(r.id), Math.round(safe * r.mul), r.val, r.suffix);
  });
  preview.rate = p.actionRate == null ? 1 : Number(p.actionRate) || 1;

  $('qLock').checked = !!settings.window.locked;
  const followBtn = $('quickFollow');
  if (followBtn) {
    followBtn.disabled = !!settings.window.locked;
    followBtn.title = settings.window.locked ? '位置已锁定，无法跟随鼠标' : '开始/停止跟随鼠标';
  }
  $('qPassthrough').checked = !!settings.window.passthrough;
  $('qRoam').checked = settings.system.roam !== false;
  $('qMonitor').checked = settings.system.monitor !== false;
  $('qIdleReminder').checked = settings.system.idleReminder !== false;
  $('qAutoStart').checked = !!settings.system.autoStart;
  const homeCfg = settings.home || {};
  $('qShowHome').checked = homeCfg.showOnStartup !== false;
  $('qFocus').value = settings.pomodoro.focus;
  $('qBreak').value = settings.pomodoro.break;
  const notifyEl = $('qNotify');
  if (notifyEl) notifyEl.checked = settings.pomodoro.notify !== false;
  $('toggleVisible').textContent = settings.window.visible === false ? '显示宠物' : '隐藏宠物';
  syncing = false;
}

function bindSettings() {
  const range = (id, valId, suffix, apply) => {
    const el = $(id);
    const cancelPending = () => {
      const timer = rangeTimers.get(id);
      if (timer) { clearTimeout(timer); rangeTimers.delete(id); }
    };
    const commit = (v) => { cancelPending(); apply(v); };

    el.addEventListener('pointerdown', () => rangeBusy.set(id, true));
    el.addEventListener('input', () => {
      const v = paintRange(el, valId, suffix);   // 本地立即反馈：数值 + 轨道填充
      if (syncing) return;
      cancelPending();
      // 拖动过程中节流：一次拖拽最多少量提交，避免主进程反复 setBounds 导致桌宠闪动
      rangeTimers.set(id, setTimeout(() => {
        rangeTimers.delete(id);
        apply(v);
      }, 160));
    });
    el.addEventListener('change', () => {
      const v = paintRange(el, valId, suffix);
      rangeBusy.set(id, false);
      commit(v);                                 // 松手立即落定最终值
    });
    el.addEventListener('pointerup', () => rangeBusy.set(id, false));
    el.addEventListener('pointercancel', () => rangeBusy.set(id, false));
    el.addEventListener('blur', () => rangeBusy.set(id, false));
    paintRange(el, valId, suffix);               // 初始化轨道填充
  };
  range('qScale', 'qScaleVal', '%', (v) => api.patchSettings({ pet: { scale: v / 100 } }));
  range('qOpacity', 'qOpacityVal', '%', (v) => api.patchSettings({ pet: { opacity: v / 100 } }));
  range('qVolume', 'qVolumeVal', '', (v) => api.patchSettings({ pet: { volume: v } }));
  range('qActionRate', 'qActionRateVal', '%', (v) => {
    preview.rate = v / 100;
    api.patchSettings({ pet: { actionRate: v / 100 } });
  });
  range('qFollowLoose', 'qFollowLooseVal', '%', (v) => api.patchSettings({ pet: { followLoose: v } }));

  const toggle = (id, key) => {
    $(id).addEventListener('change', (e) => api.patchSettings(key(e.target.checked)));
  };
  toggle('qLock', (v) => ({ window: { locked: v } }));
  toggle('qPassthrough', (v) => ({ window: { passthrough: v } }));
  toggle('qRoam', (v) => ({ system: { roam: v } }));
  toggle('qMonitor', (v) => ({ system: { monitor: v } }));
  toggle('qIdleReminder', (v) => ({ system: { idleReminder: v } }));
  toggle('qAutoStart', (v) => ({ system: { autoStart: v } }));
  toggle('qShowHome', (v) => ({ home: { showOnStartup: v } }));

  const number = (id, key, min, max) => {
    $(id).addEventListener('change', (e) => {
      const value = Math.min(max, Math.max(min, Number(e.target.value) || min));
      e.target.value = value;
      if (!syncing) api.patchSettings({ pomodoro: { [key]: value } });
    });
  };
  number('qFocus', 'focus', 1, 120);
  number('qBreak', 'break', 1, 60);
  const notifyEl = $('qNotify');
  if (notifyEl) {
    notifyEl.addEventListener('change', (e) => {
      if (!syncing) api.patchSettings({ pomodoro: { notify: e.target.checked } });
    });
  }
}

function bindButtons() {
  $('closeBtn').addEventListener('click', () => window.close());
  $('toggleVisible').addEventListener('click', async () => {
    await api.command({ type: 'toggle-visible' });
    settings = await api.getSettings();
    syncSettingsUI();
    updateQuickButtons();
  });
  // 设置就在本页，直接切到“设置”Tab
  $('openSettings').addEventListener('click', () => switchTab('settings'));
  $('openAssets').addEventListener('click', () => api.command({ type: 'open-assets-dir' }));
  $('openBuiltin').addEventListener('click', () => api.command({ type: 'open-builtin-skins-dir' }));
  $('refreshSkins').addEventListener('click', () => refreshSkins(true));
  $('importSkinBtn').addEventListener('click', () => {
    stopFollowForPage();
    if (window.SkinWizard) window.SkinWizard.open();
  });
  $('qPomodoroBtn').addEventListener('click', () => {
    api.command({ type: pomodoroRunning ? 'pomodoro:stop' : 'pomodoro:start' });
  });
  $('qOpenData').addEventListener('click', () => api.command({ type: 'open-data-dir' }));
  $('qReset').addEventListener('click', async () => {
    if (!window.confirm('恢复默认会清空心情、好感度与所有设置，继续吗？')) return;
    await api.command({ type: 'reset' });
    settings = await api.getSettings();
    syncSettingsUI();
    renderPetInfo();
    refreshFocusStats();
  });

  // 关于页快捷互动
  $('quickFollow').addEventListener('click', () => api.command({ type: 'follow:toggle' }));
  const greetings = ['嗨，我在呢！', '看到你啦～', '今天也要加油哦。', '摸摸头，精神好～'];
  $('quickGreet').addEventListener('click', () => {
    api.command({ type: 'say', text: greetings[Math.floor(Math.random() * greetings.length)] });
  });
  $('quickFocus').addEventListener('click', () => {
    api.command({ type: pomodoroRunning ? 'pomodoro:stop' : 'pomodoro:start' });
  });
  $('quickHide').addEventListener('click', async () => {
    await api.command({ type: 'toggle-visible' });
    settings = await api.getSettings();
    syncSettingsUI();
    updateQuickButtons();
  });
}

/** 进入任何页面/Tab 都停止鼠标跟随，避免主控台打开后桌宠还在满屏跑 */
function stopFollowForPage() {
  try { api.command({ type: 'follow:stop' }); } catch (err) { /* 忽略 */ }
}

/** 切换到指定 Tab（供页内按钮与托盘跳转共用） */
function switchTab(name) {
  const wizard = $('wizardLayer');
  if (wizard && !wizard.hidden) return;   // 向导进行中不响应托盘的跳转请求
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  stopFollowForPage();
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  const panel = $('panel-' + name);
  if (panel) panel.classList.add('active');
  if (name === 'skin') refreshSkins(false);   // 每次进入换肤页重新扫描文件夹
}

/** 顶栏时钟与问候语，每分钟刷新 */
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const clockEl = $('clockText');
  if (clockEl) clockEl.textContent = `${hh}:${mm}`;
  const greetEl = $('greetText');
  if (greetEl) {
    const h = now.getHours();
    greetEl.textContent = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';
  }
}

/** 同步快捷按钮的文案与高亮状态 */
function updateQuickButtons() {
  const focus = $('quickFocus');
  if (focus) {
    focus.classList.toggle('running', pomodoroRunning);
    const b = focus.querySelector('b');
    const s = focus.querySelector('small');
    if (b) b.textContent = pomodoroRunning ? '停止专注' : '开始专注';
    if (s) s.textContent = pomodoroRunning ? '再点一次结束' : '一起安静一会儿';
  }
  const hide = $('quickHide');
  if (hide && settings) {
    const hidden = settings.window && settings.window.visible === false;
    const b = hide.querySelector('b');
    const s = hide.querySelector('small');
    if (b) b.textContent = hidden ? '显示宠物' : '隐藏宠物';
    if (s) s.textContent = hidden ? '让它回来陪你' : '让它休息一下';
  }
}

/* ---------------- 番茄钟统计 ---------------- */
function renderFocusStats(summary) {
  if (!summary) return;
  const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  set('statPomodoro', summary.todayMinutes || 0);
  set('focusTodayCount', summary.todayCount || 0);
  set('focusTotalCount', summary.totalCount || 0);
  set('focusWeekMinutes', summary.days ? summary.days.reduce((s, d) => s + (d.minutes || 0), 0) : 0);
  set('focusStreak', `坚持 ${summary.streak || 0} 天`);

  const cv = $('focusChart');
  if (!cv || !summary.days) return;
  const { c, w, h } = setupChartCanvas(cv, 320, 90);

  const days = summary.days;
  const max = Math.max(25, ...days.map((d) => d.minutes || 0));
  const pad = { l: 24, r: 6, t: 8, b: 20 };
  const chartH = h - pad.t - pad.b;
  const chartW = w - pad.l - pad.r;
  const slot = chartW / days.length;
  const barW = Math.min(26, slot * 0.6);

  c.strokeStyle = 'rgba(150,125,100,.14)';
  c.lineWidth = 1;
  [0, 0.5, 1].forEach((p) => {
    const y = Math.round(pad.t + chartH * p) + 0.5;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke();
  });
  c.font = '10px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#999';
  c.textAlign = 'right';
  [max, max / 2, 0].forEach((v, i) => {
    c.fillText(String(Math.round(v)), pad.l - 5, pad.t + chartH * (i / 2) + 3);
  });

  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#e8a06b';
  days.forEach((d, i) => {
    const x = pad.l + slot * i + (slot - barW) / 2;
    const mins = d.minutes || 0;
    const bh = mins > 0 ? Math.max(3, (mins / max) * chartH) : 0;
    c.fillStyle = mins > 0 ? accent : 'rgba(150,125,100,.18)';
    if (bh > 0) {
      c.beginPath();
      c.roundRect(x, pad.t + chartH - bh, barW, bh, 3);
      c.fill();
    }
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#999';
    c.textAlign = 'center';
    const date = new Date(d.key + 'T00:00:00');
    c.fillText(i === days.length - 1 ? '今天' : `${date.getMonth() + 1}/${date.getDate()}`, x + barW / 2, h - 5);
  });
}

async function refreshFocusStats() {
  try {
    const summary = await api.getPomodoroStats();
    renderFocusStats(summary);
  } catch (err) { /* 统计不可用时保留上次显示 */ }
}

function renderPomodoro(status) {
  pomodoroRunning = !!status.running;
  $('qPomodoroBtn').textContent = pomodoroRunning ? '停止专注' : '开始专注';
  updateQuickButtons();
  if (!status.running) {
    $('qPomodoroStatus').textContent = '未开始';
    return;
  }
  const remain = Math.max(0, status.remain || 0);
  const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
  $('qPomodoroStatus').textContent = (status.phase === 'focus' ? '专注中 ' : '休息中 ') + mm + ':' + ss;
}

/* ---------------- 初始化 ---------------- */
async function init() {
  settings = await api.getSettings();
  skins = (await api.listSkins()) || [];

  loadStateTrend();
  initTabs();
  bindSettings();
  bindButtons();
  syncSettingsUI();
  renderPetInfo();
  renderSkins();
  updateClock();
  clockTimer = setInterval(updateClock, 30000);
  // 桌宠状态是静默存档的，主页定时拉取以保持三条状态条实时更新
  refreshLiveState();
  liveStateTimer = setInterval(refreshLiveState, 5000);
  updateQuickButtons();

  await buildPreview(settings.pet && settings.pet.skin);
  previewRaf = requestAnimationFrame(previewLoop);

  // 页面销毁时停掉定时器和动画帧，便于热重载/嵌入场景回收
  window.addEventListener('beforeunload', () => {
    clearInterval(clockTimer);
    clearInterval(liveStateTimer);
    cancelAnimationFrame(previewRaf);
  });

  try {
    $('dataPath').textContent = await api.dataPath();
  } catch (err) { /* 路径读取失败时保留默认文案 */ }

  try {
    const status = await api.getPomodoro();
    if (status) renderPomodoro(status);
  } catch (err) { /* 状态不可用时保持默认显示 */ }
  refreshFocusStats();

  api.onSettings((next) => {
    const prevSkin = settings && settings.pet && settings.pet.skin;
    settings = next;
    syncSettingsUI();
    renderPetInfo();
    updateQuickButtons();
    const nowSkin = next.pet && next.pet.skin;
    if (nowSkin !== prevSkin) {
      renderSkins();
      buildPreview(nowSkin);
    }
  });
  api.onPomodoroStatus(renderPomodoro);
  if (api.onPomodoroStats) api.onPomodoroStats(renderFocusStats);
  if (api.onGotoTab) api.onGotoTab((tab) => switchTab(tab));
  // 所有 IPC 监听注册完成后回执主进程，主进程此时才补发可能待跳转的 Tab，
  // 避免首次打开时消息早于监听器注册而丢失。
  if (api.homeReady) api.homeReady();

  // 向导完成导入后：重扫皮肤目录，并按用户勾选决定是否立刻换上新皮肤
  document.addEventListener('skins:changed', async (event) => {
    try {
      await refreshSkins(true);
      const detail = event.detail || {};
      if (detail.activate && detail.id) {
        await api.patchSettings({ pet: { skin: detail.id } });
      }
    } catch (err) {
      console.warn('[home] 皮肤变更处理失败', err);
    }
  });
}

init().catch((err) => {
  console.error('[home] 初始化失败', err);
  $('petDesc').textContent = '读取信息失败，请重启程序。';
});
