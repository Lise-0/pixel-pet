'use strict';

/**
 * 皮肤资源层：完全由「一个皮肤一个文件夹」驱动。
 *
 * 两个扫描根目录：
 *   assets/skins/<id>/     内置皮肤（打包后在 asar 内，只读）
 *   <userData>/skins/<id>/ 我导入的皮肤（可写，导入向导写这里）
 *
 * 每个皮肤文件夹自带：
 *   skin.json     动作、帧率、主题、画布、行为参数、触发器、元信息
 *   persona.txt   专属台词（也可在 skin.json 里用 persona 对象内嵌）
 *   *.png         这个皮肤自己的序列帧
 *
 * 没有全局清单，没有全局台词，皮肤之间不共享任何配置。
 * 新增皮肤 = 建一个文件夹（或用导入向导），点「刷新皮肤」即可出现。
 * 下划线 / 点号开头的目录（如 _TEMPLATE）视为模板或临时目录，不会被当成皮肤。
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

const ASSETS_DIR = path.join(ctx.APP_DIR, 'assets');
const BUILTIN_SKINS_DIR = path.join(ASSETS_DIR, 'skins');
const DEFAULT_SKIN_ID = 'default';

/** 用户皮肤根目录：惰性求值，避免模块加载早于 app.setPath('userData') */
function userSkinsDir() {
  try {
    if (ctx.app && typeof ctx.app.getPath === 'function') {
      return path.join(ctx.app.getPath('userData'), 'skins');
    }
  } catch (err) { /* app 尚未就绪，走下面的回退 */ }
  return path.join(ctx.DATA_DIR || ctx.APP_DIR || process.cwd(), 'skins');
}

// 仅用于皮肤 manifest 缺字段时的安全兜底（避免桌宠空白），不是可被皮肤共享的全局配置
const FALLBACK = {
  canvas: { width: 160, height: 180, groundY: 176 },
  theme: { accent: '#e2a87c', accentDeep: '#c07b45', accentSoft: '#fbe6d1' },
  behavior: {
    fatiguePerTickDay: 0.035,
    fatiguePerTickNight: 0.07,
    fatigueDragAdd: 3,
    moodDecayPerTick: 0.017,
    moodSleepyThreshold: 85,
    idleSleepAfter: 90
  },
  effects: { sleepZ: '#a9c2d6', hotDrop: '#93d9f5', angryMark: '#e2685f' },
  actions: { idle: { frames: ['idle-1.png'], fps: 2, loop: true } },
  triggers: { idlePool: ['idle'] }
};

const packCache = new Map();   // id -> { stamp, pack }

function safeJoin(dir, name) {
  if (typeof name !== 'string' || !name) return null;
  const base = path.basename(name);
  if (base !== name) return null;                 // 禁止 ../ 之类越界
  // 先 resolve 成绝对路径再比较，否则 dir 为相对路径时 startsWith 判定会失效
  const root = path.resolve(dir);
  const target = path.resolve(root, base);
  if (!target.startsWith(root + path.sep)) return null;
  return target;
}

function stamp(dir) {
  let parts = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) parts.push(name + ':' + st.mtimeMs + ':' + st.size);
      } catch (err) { /* 文件刚好被改动，忽略 */ }
    }
  } catch (err) { /* 目录不可读 */ }
  return parts.join('|');
}

/** 扫描皮肤目录；id 恒等于文件夹名，内置皮肤优先，用户皮肤不得占用内置 id */
function scanSkinDirs() {
  const result = [];
  const seen = new Set();
  const scanRoot = (root, source) => {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (source === 'builtin') console.warn('[skins] 内置皮肤目录不可用:', err.message);
      return;
    }
    entries.forEach((entry) => {
      if (!entry.isDirectory()) return;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) return;
      if (seen.has(entry.name)) return;
      const dir = path.join(root, entry.name);
      if (!fs.existsSync(path.join(dir, 'skin.json'))) return;
      seen.add(entry.name);
      result.push({ id: entry.name, dir, source });
    });
  };
  scanRoot(BUILTIN_SKINS_DIR, 'builtin');
  scanRoot(userSkinsDir(), 'user');
  return result;
}

function parsePersona(text) {
  const groups = {};
  let current = 'idle';
  (text || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const matched = s.match(/^\[(.+)\]$/);
    if (matched) {
      current = matched[1].trim();
      groups[current] = groups[current] || [];
      return;
    }
    groups[current] = groups[current] || [];
    groups[current].push(s);
  });
  return groups;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[skins] skin.json 解析失败:', file, err.message);
    return null;
  }
}

function normalizeActions(raw) {
  const actions = {};
  const source = raw && typeof raw === 'object' ? raw : {};
  Object.keys(source).forEach((key) => {
    const item = source[key];
    if (!item || typeof item !== 'object') return;
    const frames = Array.isArray(item.frames)
      ? item.frames.filter((n) => typeof n === 'string' && n)
      : [];
    if (!frames.length) return;
    const fps = Number(item.fps);
    actions[key] = {
      frames,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 2,
      loop: item.loop !== false,
      mirror: !!item.mirror,
      bob: Number.isFinite(Number(item.bob)) ? Number(item.bob) : 0,
      // 散步时是否让窗口横向漂移。坐立/舔爪这类原地帧配横移会像「站着被拖走」，
      // 皮肤可显式关掉；默认开启，未配置的皮肤保持原来的边走边移。
      drift: item.drift !== false
    };
  });
  if (!Object.keys(actions).length) return JSON.parse(JSON.stringify(FALLBACK.actions));
  return actions;
}

function normalizeTriggers(raw) {
  const result = {};
  const source = raw && typeof raw === 'object' ? raw : {};
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (key === 'idlePool') {
      if (Array.isArray(value) && value.length) result.idlePool = value.filter((v) => typeof v === 'string');
    } else if (typeof value === 'string' && value) {
      result[key] = value;
    }
  });
  return result;
}

/** 按文件名统计皮肤目录里的 PNG 帧数（不解码）。清单与完整包共用，口径一致。 */
function countPngFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png')).length;
  } catch (err) {
    return 0;
  }
}

function readFrames(dir) {
  const frames = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png')).sort();
  } catch (err) {
    console.warn('[skins] 帧目录不可读:', dir, err.message);
    return frames;
  }
  names.forEach((name) => {
    const full = safeJoin(dir, name);
    if (!full) return;
    try {
      frames[name] = 'data:image/png;base64,' + fs.readFileSync(full).toString('base64');
    } catch (err) { /* 单张损坏不影响其它帧 */ }
  });
  return frames;
}

function readPersona(dir, manifest) {
  // 支持三种写法：内嵌对象 / 指定台词文件名 / 默认 persona.txt
  if (manifest.persona && typeof manifest.persona === 'object' && !Array.isArray(manifest.persona)) {
    const groups = {};
    Object.keys(manifest.persona).forEach((key) => {
      const lines = manifest.persona[key];
      groups[key] = Array.isArray(lines) ? lines.filter((v) => typeof v === 'string') : (typeof lines === 'string' ? [lines] : []);
    });
    return groups;
  }
  const file = safeJoin(dir, typeof manifest.persona === 'string' && manifest.persona ? manifest.persona : 'persona.txt');
  if (!file || !fs.existsSync(file)) return {};
  try {
    return parsePersona(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[skins] 台词读取失败:', file, err.message);
    return {};
  }
}

function buildPack(id, dir, source) {
  const manifest = readJson(path.join(dir, 'skin.json'));
  if (!manifest) return null;
  const frames = readFrames(dir);
  const actions = normalizeActions(manifest.actions);
  const triggers = normalizeTriggers(manifest.triggers);
  const canvasCfg = manifest.canvas && typeof manifest.canvas === 'object' ? manifest.canvas : {};
  const themeCfg = manifest.theme && typeof manifest.theme === 'object' ? manifest.theme : {};
  const behaviorCfg = manifest.behavior && typeof manifest.behavior === 'object' ? manifest.behavior : {};
  const effectsCfg = manifest.effects && typeof manifest.effects === 'object' ? manifest.effects : {};

  const thumbName = typeof manifest.thumb === 'string' ? manifest.thumb : 'idle-1.png';
  const thumb = frames[thumbName] || frames['idle-1.png'] || Object.values(frames)[0] || '';

  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

  return {
    id,
    name: String(manifest.name || id),
    desc: String(manifest.desc || ''),
    version: manifest.version == null ? 1 : manifest.version,
    author: String(manifest.author || ''),
    builtin: !!manifest.builtin,
    source: source || (manifest.builtin ? 'builtin' : 'user'),
    order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 99,
    thumb,
    theme: Object.assign({}, FALLBACK.theme, themeCfg),
    canvas: {
      width: num(canvasCfg.width, 160),
      height: num(canvasCfg.height, 180),
      groundY: num(canvasCfg.groundY, 176)
    },
    behavior: Object.assign({}, FALLBACK.behavior, behaviorCfg),
    effects: Object.assign({}, FALLBACK.effects, effectsCfg),
    actions,
    triggers,
    persona: readPersona(dir, manifest),
    frames,
    frameCount: countPngFiles(dir),
    actionCount: Object.keys(actions).length
  };
}

/** 读取单个皮肤的完整资源包；文件内容变化会自动重建（无需重启） */
function readSkin(id) {
  const wanted = typeof id === 'string' && id ? id : DEFAULT_SKIN_ID;
  const dirs = scanSkinDirs();
  const found = dirs.find((d) => d.id === wanted) || dirs.find((d) => d.id === DEFAULT_SKIN_ID) || dirs[0];
  if (!found) return null;
  const key = found.id;
  const current = stamp(found.dir);
  const cached = packCache.get(key);
  if (cached && cached.stamp === current) return cached.pack;
  const pack = buildPack(key, found.dir, found.source);
  if (pack) packCache.set(key, { stamp: current, pack });
  return pack;
}

/**
 * 只读取 manifest 指定的那一张缩略图（含兜底），不解码皮肤里的其它帧。
 * 这是 listSkins 与 buildPack 共用的取图逻辑，二者结果保持一致。
 */
function readThumb(dir, manifest) {
  const wanted = typeof manifest.thumb === 'string' && manifest.thumb ? manifest.thumb : 'idle-1.png';
  const candidates = [wanted, 'idle-1.png'];
  try {
    // 与 buildPack/readFrames 一致：按文件名排序后取第一张，避免清单缩略图
    // 与桌宠实际使用的兜底帧不是同一张（无 thumb 字段且无 idle-1.png 时触发）。
    const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png')).sort();
    if (names[0]) candidates.push(names[0]);
  } catch (err) { /* 目录不可读时忽略兜底候选 */ }
  for (const name of candidates) {
    const full = safeJoin(dir, name);
    if (!full) continue;
    try {
      return 'data:image/png;base64,' + fs.readFileSync(full).toString('base64');
    } catch (err) { /* 该候选损坏，尝试下一个 */ }
  }
  return '';
}

/** 皮肤清单用的轻量元数据：仅读 skin.json + 单张缩略图，不解码任何其它帧 */
function readSkinMeta(id, dir, source) {
  const manifest = readJson(path.join(dir, 'skin.json'));
  if (!manifest) return null;
  const themeCfg = manifest.theme && typeof manifest.theme === 'object' ? manifest.theme : {};
  const frameCount = countPngFiles(dir);
  return {
    id,
    name: String(manifest.name || id),
    desc: String(manifest.desc || ''),
    author: String(manifest.author || ''),
    builtin: !!manifest.builtin,
    source: source || (manifest.builtin ? 'builtin' : 'user'),
    order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 99,
    thumb: readThumb(dir, manifest),
    theme: Object.assign({}, FALLBACK.theme, themeCfg),
    frameCount,
    actionCount: Object.keys(normalizeActions(manifest.actions)).length
  };
}

/**
 * 皮肤清单（不含大体积帧数据），排序后交给主控台展示。
 * 只扫描一次目录、每个皮肤只读单张缩略图——早期版本这里对每个 id 调 readSkin()，
 * 会重复全目录扫描并把每款皮肤的全部 PNG 解码成 base64，皮肤一多就明显卡顿。
 */
function listSkins() {
  return scanSkinDirs()
    .map(({ id, dir, source }) => readSkinMeta(id, dir, source))
    .filter(Boolean)
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/** 删除/写入后主动清掉缓存（stamp 失效本来也会重建，显式清理更即时） */
function invalidate(id) {
  if (id) packCache.delete(id);
  else packCache.clear();
}

module.exports = {
  listSkins, readSkin, scanSkinDirs, invalidate,
  BUILTIN_SKINS_DIR, userSkinsDir
};
