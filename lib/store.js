'use strict';

const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { deepMerge, clamp } = require('./utils');

const DEFAULT_SETTINGS = {
  version: 1,
  // followLoose 与 lib/follow-params.js 的 DEFAULT_LOOSENESS 保持一致（单测会校验）
  pet: { skin: 'default', scale: 1.0, opacity: 1.0, volume: 60, actionRate: 1.0, followLoose: 70 },
  state: { mood: 70, fatigue: 20, affection: 0, lastDaily: '' },
  unlock: { actions: ['idle', 'click', 'drag', 'happy', 'angry', 'sleep'], stories: [] },
  window: { x: null, y: null, locked: false, passthrough: false, visible: true },
  system: { autoStart: false, monitor: true, idleReminder: true, roam: true },
  // lifetime 独立于 500 条明细：明细会被裁剪，累计番茄数/分钟不能跟着倒退
  pomodoro: { focus: 25, break: 5, notify: true, stats: [], lifetime: { focusMinutes: 0, focusCount: 0 } },
  home: { showOnStartup: true }
};

// 数值字段的合法范围，配置被手改坏时也能夹回安全区间
const RANGES = {
  'pet.scale': [0.5, 2],
  'pet.opacity': [0.3, 1],
  'pet.volume': [0, 100],
  'pet.actionRate': [0.3, 2],
  'pet.followLoose': [0, 100],
  'state.mood': [0, 100],
  'state.fatigue': [0, 100],
  'state.affection': [0, Number.MAX_SAFE_INTEGER],
  'pomodoro.focus': [1, 120],
  'pomodoro.break': [1, 60]
};

function sanitizeValue(template, value, keyPath) {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) return undefined;
    const itemTemplate = template[0];
    // 模板为空数组（如 unlock.stories）时无法从样本推断元素类型，
    // 此时放行任意元素，否则存档里已有的字符串会被静默清空。
    if (typeof itemTemplate === 'undefined') {
      // 番茄钟记录保留更多条（约一年的量），其余数组维持 200 上限
      const max = keyPath === 'pomodoro.stats' ? 500 : 200;
      return value.slice(0, max);
    }
    return value
      .filter((item) => typeof item === typeof itemTemplate)
      .slice(0, 200);
  }
  if (template === null) {
    if (value === null) return null;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (typeof template === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const range = RANGES[keyPath];
    return range ? clamp(value, range[0], range[1]) : value;
  }
  if (typeof template === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (typeof template === 'string') {
    return typeof value === 'string' ? value : undefined;
  }
  if (typeof template === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return sanitizeByTemplate(template, value, keyPath);
  }
  return undefined;
}

/** 递归白名单校验：只保留默认配置中存在的字段，未知字段一律丢弃 */
function sanitizeByTemplate(template, patch, prefix) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  Object.keys(patch).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(template, key)) return;
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const clean = sanitizeValue(template[key], patch[key], keyPath);
    if (clean !== undefined) out[key] = clean;
  });
  return out;
}

function sanitizePatch(patch) {
  return sanitizeByTemplate(DEFAULT_SETTINGS, patch, '');
}

/** 配置存档：原子写入 + 备份回退，避免文件损坏导致数据清空 */
class Store {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.timer = null;
  }

  readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  load() {
    const apply = (raw) => {
      // 读取时同样过白名单，历史版本里的废弃字段不会污染运行时。
      // base 必须是默认值的深拷贝：deepMerge 会直接复用未出现在 patch 中的嵌套对象引用，
      // 若拿 DEFAULT_SETTINGS 本身当 base，后续对 window.x 等的写入会永久改写默认配置，
      // 导致"恢复默认"再也回不到真正的初始值。
      const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      this.data = deepMerge(base, sanitizePatch(raw));
      // 旧版存档没有 lifetime：用已有明细一次性折算成累计基线。
      // 否则升级后 lifetime 从 0 开始，而明细已满 500 条被裁剪，累计值会长期卡住不涨。
      const life = raw && raw.pomodoro && raw.pomodoro.lifetime;
      if (!life || !Number.isFinite(life.focusMinutes) || !Number.isFinite(life.focusCount)) {
        const pom = this.data.pomodoro;
        let minutes = 0;
        let count = 0;
        (Array.isArray(pom.stats) ? pom.stats : []).forEach((e) => {
          if (e && e.phase === 'focus' && Number.isFinite(e.minutes) && e.minutes > 0) {
            minutes += e.minutes;
            count += 1;
          }
        });
        if (count) pom.lifetime = { focusMinutes: minutes, focusCount: count };
      }
    };
    try {
      apply(this.readJson(this.file));
    } catch (err) {
      try {
        apply(this.readJson(this.file + '.bak'));
        console.warn('[store] 主配置损坏，已回退到备份');
      } catch (err2) {
        console.warn('[store] 无可用配置，使用默认值');
      }
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 保存失败:', err.message);
    }
  }

  save(delay = 500) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  patch(patch) {
    const clean = sanitizePatch(patch);
    if (!Object.keys(clean).length) return;
    this.data = deepMerge(this.data, clean);
    this.save();
    // 副作用交给装配层注入，避免 store 反向依赖窗口/托盘模块
    if (ctx.onSettingsChanged) ctx.onSettingsChanged();
  }
}

module.exports = { Store, DEFAULT_SETTINGS, sanitizePatch };
