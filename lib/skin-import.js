'use strict';

/**
 * 皮肤导入后端：负责「选文件 → 读懂素材 → 安全落盘 → 移除」。
 *
 * 图像处理（拆帧、去背、缩放）放在渲染层用 canvas 完成，
 * 主进程只做文件 IO，这样可以不引入任何图像编解码依赖。
 *
 * 写入目标恒为 <userData>/skins/<id>/：
 * 打包后 assets/ 位于只读 asar 内，写进去会失败；
 * 内置皮肤与用户皮肤分开存放也更干净。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ctx = require('./context');
const config = require('./config');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const MAX_FILE = 12 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;
const MAX_FILES = 80;
const MAX_FRAMES = 64;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function safeName(name) {
  let base = String(name || '').replace(/\\/g, '/').split('/').pop() || 'file';
  base = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!base || base === '.' || base === '..') base = 'file';
  return base.slice(0, 80);
}

function num(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && SAFE_COLOR.test(value.trim()) ? value.trim() : fallback;
}

function str(value, fallback, max) {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max) : fallback;
}

/* ---------------- 轻量 zip 读取（store / deflate，够用于皮肤分享包） ---------------- */
function readZip(file) {
  const buf = fs.readFileSync(file);
  const floor = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是有效的 zip 压缩包');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    // zip 中文名常为 GBK；UTF-8 标志位（bit 11）未置位时按 GBK 解
    let name;
    try {
      name = (flags & 0x800) ? rawName.toString('utf8') : new TextDecoder('gbk').decode(rawName);
    } catch (err) { name = rawName.toString('utf8'); }
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || name.startsWith('__MACOSX') || name.includes('..')) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const from = localOff + 30 + lNameLen + lExtraLen;
    if (from + compSize > buf.length) continue;
    // 声明值只做快筛；真正的安全边界是解压时传给 zlib 的 maxOutputLength。
    // 伪造一个极小的 uncompSize 能绕过声明值检查，但绕不过 zlib 的输出硬上限，
    // 从而避免 inflateRawSync 在“解压后才校验”之前一次性分配数百 MB 打爆主进程。
    const budget = MAX_TOTAL - total;
    if (uncompSize > budget) throw new Error('压缩包解压后超过 60MB，已停止读取');
    if (method === 0 && compSize > budget) throw new Error('压缩包解压后超过 60MB，已停止读取');
    // 不支持的压缩算法（bzip2/lzma）：直接跳过，不预占预算
    if (method !== 0 && method !== 8) continue;
    total += uncompSize;
    let data;
    try {
      if (method === 0) {
        // store 模式不解压：长度就是 compSize，前面已校验不越界、不超预算
        data = buf.subarray(from, from + compSize);
      } else {
        // 关键修复：让 zlib 在解压时就按剩余预算封顶，伪造的微小 uncompSize 不再有意义
        data = zlib.inflateRawSync(buf.subarray(from, from + compSize), { maxOutputLength: budget });
      }
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('压缩包解压后超过 60MB，已停止读取');
      }
      total -= uncompSize;                // 解压失败：回退预占，合法大包不该被前面坏条目拖累
      continue;
    }
    total += data.length - uncompSize;  // 用真实长度修正累计值
    if (total > MAX_TOTAL) throw new Error('压缩包解压后超过 60MB，已停止读取');
    out.push({ name, buffer: Buffer.from(data) });
    if (out.length >= MAX_FILES) break;
  }
  if (!out.length) throw new Error('压缩包里没有可用的文件');
  return out;
}

/** 若所有条目共享同一层目录前缀（如 MySkin/skin.json），把它剥掉 */
function stripPrefix(entries) {
  const parts = entries.map((e) => e.name.replace(/\\/g, '/').split('/').filter(Boolean));
  if (!parts.length || parts.some((p) => p.length < 2)) return entries;
  const first = parts[0][0];
  if (!parts.every((p) => p[0] === first)) return entries;
  return entries.map((e, i) => ({ name: parts[i].slice(1).join('/'), buffer: e.buffer }));
}

/* ---------------- 素材检视 ---------------- */
function createInspector() {
  const items = [];
  const warnings = [];
  let total = 0;
  let dropped = false;

  function push(name, buffer) {
    if (buffer.length > MAX_FILE) { warnings.push(safeName(name) + ' 超过 12MB，已跳过'); return; }
    if (items.length >= MAX_FILES || total + buffer.length > MAX_TOTAL) {
      dropped = true;
      return;
    }
    total += buffer.length;
    items.push({ name, buffer });
  }

  function addFile(full, label) {
    let st;
    try { st = fs.statSync(full); } catch (err) { return; }
    if (!st.isFile()) return;
    if (st.size > MAX_FILE) { warnings.push(safeName(label) + ' 超过 12MB，已跳过'); return; }
    const ext = path.extname(full).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      // 图片素材正常放行
    } else if (ext === '.json') {
      // JSON 只认 manifest：其它 JSON 不消费，也不该被读取
      if (path.basename(full).toLowerCase() !== 'skin.json') return;
    } else if (ext === '.txt') {
      // 台词文件允许任意文件名（manifest.persona 可指定，如 dialog.txt）。
      // 这里只积攒在 items 中；真正外带由 finish() 按 manifest 声明决定，
      // 未声明的 .txt（如 secrets.txt）绝不会出现在 inspect 返回值里。
    } else return;
    try { push(label, fs.readFileSync(full)); } catch (err) { /* 读不到就跳过 */ }
  }

  function addDir(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const entry of entries) {
      if (items.length >= MAX_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1 && !entry.name.startsWith('.')) addDir(full, depth + 1);
      } else if (entry.isFile()) {
        addFile(full, entry.name);
      }
    }
  }

  const normalize = () => {
    const used = new Set();
    const result = [];
    items.forEach((item) => {
      let name = safeName(item.name);
      if (used.has(name)) {
        const ext = path.extname(name);
        const base = name.slice(0, name.length - ext.length);
        let i = 2;
        while (used.has(`${base}-${i}${ext}`)) i++;
        name = `${base}-${i}${ext}`;
      }
      used.add(name);
      result.push({ name, buffer: item.buffer });
    });
    return result;
  };

  return {
    addFile, addDir, push, warnings,
    finish(label) {
      if (dropped) warnings.push('素材数量或体积超过上限，多余文件已忽略');
      const list = normalize();
      const images = [];
      let manifestText = null;
      const textFiles = new Map();   // 小写文件名 -> 文本，暂存供 persona 选取
      list.forEach((item) => {
        const ext = path.extname(item.name).toLowerCase();
        if (IMAGE_EXT.has(ext)) {
          images.push({
            name: item.name,
            dataUrl: `data:${mimeOf(item.name)};base64,${item.buffer.toString('base64')}`
          });
        } else if (item.name.toLowerCase() === 'skin.json') {
          manifestText = item.buffer.toString('utf8').replace(/^\uFEFF/, '');
        } else if (ext === '.txt') {
          textFiles.set(item.name.toLowerCase(), item.buffer.toString('utf8').replace(/^\uFEFF/, ''));
        }
      });
      // manifest.persona 可以是字符串指定台词文件名（如 "dialog.txt"）；
      // 只外带它指向的那一份，其余 .txt（secrets.txt 等）绝不进入返回值。
      const wantPersona = (() => {
        try {
          const m = manifestText ? JSON.parse(manifestText) : null;
          if (m && typeof m.persona === 'string' && m.persona) return path.basename(m.persona).toLowerCase();
        } catch (err) { /* manifest 非法时交给渲染层报错 */ }
        return 'persona.txt';
      })();
      const personaText = textFiles.get(wantPersona) || null;
      if (!images.length && !manifestText) throw new Error('没有找到图片帧或 skin.json，无法导入');
      return {
        ok: true,
        kind: manifestText ? 'pack' : (images.length === 1 ? 'sheet' : 'frames'),
        label: label || '素材',
        images,
        manifestText,
        personaText,
        warnings
      };
    }
  };
}

function inspect(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).slice(0, MAX_FILES);
  if (!list.length) throw new Error('没有选择任何素材');
  const ins = createInspector();
  const first = list[0];
  let label = safeName(first);
  try {
    if (list.length === 1 && fs.statSync(first).isDirectory()) {
      ins.addDir(first, 0);
    } else if (list.length === 1 && path.extname(first).toLowerCase() === '.zip') {
      stripPrefix(readZip(first)).forEach((e) => ins.push(e.name, e.buffer));
    } else {
      list.forEach((p) => {
        if (path.extname(p).toLowerCase() === '.zip') {
          stripPrefix(readZip(p)).forEach((e) => ins.push(e.name, e.buffer));
        } else {
          ins.addFile(p, path.basename(p));
        }
      });
    }
  } catch (err) {
    if (err && /zip|60MB/.test(err.message)) throw err;
    throw new Error('读取素材失败：' + err.message);
  }
  return ins.finish(label);
}

/* ---------------- 落盘 ---------------- */
function decodePng(dataUrl, name) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error(`帧 ${name} 不是 PNG 数据`);
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > MAX_FILE) throw new Error(`帧 ${name} 体积异常`);
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`帧 ${name} 不是有效的 PNG 图片`);
  }
  return buf;
}

function normalizeFrames(rawFrames) {
  const list = Array.isArray(rawFrames) ? rawFrames.slice(0, MAX_FRAMES) : [];
  if (!list.length) throw new Error('至少要有 1 张帧图片');
  const used = new Set();
  const rename = new Map();
  const frames = list.map((item, i) => {
    let name = safeName(item && item.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.png$/i.test(name)) {
      name = `frame-${String(i + 1).padStart(2, '0')}.png`;
    } else {
      name = name.replace(/\.PNG$/, '.png');
    }
    let candidate = name;
    let k = 2;
    while (used.has(candidate)) candidate = name.replace(/\.png$/, `-${k++}.png`);
    used.add(candidate);
    if (candidate !== item.name) rename.set(String(item.name), candidate);
    return { name: candidate, buffer: decodePng(item.dataUrl, candidate) };
  });
  return { frames, rename, names: frames.map((f) => f.name) };
}

function cleanActions(raw, names, rename) {
  const valid = new Set(names);
  const mapName = (n) => (rename.has(n) ? rename.get(n) : n);
  const out = {};
  Object.keys(raw && typeof raw === 'object' ? raw : {}).slice(0, 40).forEach((key) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) return;
    const item = raw[key];
    if (!item || typeof item !== 'object') return;
    const frames = (Array.isArray(item.frames) ? item.frames : [])
      .map((n) => mapName(String(n)))
      .filter((n) => valid.has(n))
      .slice(0, 32);
    if (!frames.length) return;
    const entry = {
      frames,
      fps: num(item.fps, 2, 0.2, 60),
      loop: item.loop !== false
    };
    if (item.mirror) entry.mirror = true;
    const bob = num(item.bob, 0, 0, 20);
    if (bob) entry.bob = bob;
    out[key] = entry;
  });
  if (!out.idle) {
    const first = Object.keys(out)[0];
    out.idle = first
      ? { frames: out[first].frames.slice(0, 2), fps: 2, loop: true }
      : { frames: [names[0]], fps: 2, loop: true };
  }
  return out;
}

function cleanTriggers(raw, actions) {
  const keys = Object.keys(actions);
  const out = {};
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(source.idlePool)) {
    const pool = source.idlePool.filter((v) => keys.includes(v)).slice(0, 12);
    if (pool.length) out.idlePool = pool;
  }
  if (!out.idlePool) out.idlePool = ['idle'];
  Object.keys(source).forEach((key) => {
    if (key === 'idlePool' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) return;
    const v = String(source[key]);
    if (keys.includes(v)) out[key] = v;
  });
  // 触发器兜底：桌宠的事件名尽量都指向一个真实存在的动作
  const fallback = keys[0];
  ['longpress', 'pomodoro', 'cpu', 'mem', 'sit', 'battery'].forEach((key) => {
    if (!out[key]) out[key] = actions[key] ? key : fallback;
  });
  return out;
}

function buildManifest(payload, names, actions) {
  const behavior = payload.behavior && typeof payload.behavior === 'object' ? payload.behavior : {};
  const effects = payload.effects && typeof payload.effects === 'object' ? payload.effects : {};
  const theme = payload.theme && typeof payload.theme === 'object' ? payload.theme : {};
  const canvas = payload.canvas && typeof payload.canvas === 'object' ? payload.canvas : {};
  const width = num(canvas.width, 160, 32, 512);
  const height = num(canvas.height, 180, 32, 512);
  const triggers = cleanTriggers(payload.triggers, actions);
  const manifest = {
    id: payload.id,
    name: str(payload.name, payload.id, 40) || payload.id,
    desc: str(payload.desc, '我的专属小伙伴。', 120),
    version: 1,
    author: str(payload.author, '我', 40),
    builtin: false,
    source: 'imported',
    order: 9,
    thumb: names.includes(payload.thumb) ? payload.thumb : (actions.idle.frames[0] || names[0]),
    theme: {
      accent: color(theme.accent, '#e2a87c'),
      accentDeep: color(theme.accentDeep, '#c07b45'),
      accentSoft: color(theme.accentSoft, '#fbe6d1')
    },
    canvas: {
      width,
      height,
      groundY: num(canvas.groundY, height - 4, 1, height)
    },
    behavior: {
      fatiguePerTickDay: num(behavior.fatiguePerTickDay, 0.035, 0.001, 1),
      fatiguePerTickNight: num(behavior.fatiguePerTickNight, 0.07, 0.001, 1),
      fatigueDragAdd: num(behavior.fatigueDragAdd, 3, 0, 20),
      moodDecayPerTick: num(behavior.moodDecayPerTick, 0.017, 0.001, 1),
      moodSleepyThreshold: num(behavior.moodSleepyThreshold, 85, 10, 100),
      idleSleepAfter: num(behavior.idleSleepAfter, 90, 10, 600)
    },
    effects: {
      sleepZ: color(effects.sleepZ, '#a9c2d6'),
      hotDrop: color(effects.hotDrop, '#93d9f5'),
      angryMark: color(effects.angryMark, '#e2685f')
    },
    actions,
    triggers
  };
  if (payload.personaText && String(payload.personaText).trim()) manifest.persona = 'persona.txt';
  return manifest;
}

function saveSkin(payload) {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const id = String(p.id || '').trim().toLowerCase();
    if (!SAFE_ID.test(id)) return { ok: false, error: '皮肤 ID 只能用小写字母、数字、- 和 _，且以字母或数字开头（最多 32 位）' };
    if (config.scanSkinDirs().some((d) => d.id === id && d.source === 'builtin')) {
      return { ok: false, error: `「${id}」是内置皮肤，换一个 ID 吧` };
    }

    const root = config.userSkinsDir();
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, id);
    if (fs.existsSync(target) && !p.overwrite) {
      return { ok: false, code: 'EXISTS', error: `已经有一个叫「${id}」的皮肤了` };
    }

    const { frames, names, rename } = normalizeFrames(p.frames);
    const actions = cleanActions(p.actions, names, rename);
    const fixed = Object.assign({}, p, { id, thumb: rename.get(String(p.thumb)) || p.thumb });
    const manifest = buildManifest(fixed, names, actions);
    const personaText = p.personaText ? String(p.personaText).slice(0, 20000) : '';

    // 先写临时目录，全部成功后再替换，避免中途失败留下半套皮肤
    const tmp = path.join(root, `.tmp-${id}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      frames.forEach((f) => fs.writeFileSync(path.join(tmp, f.name), f.buffer));
      fs.writeFileSync(path.join(tmp, 'skin.json'), JSON.stringify(manifest, null, 2), 'utf8');
      if (personaText.trim()) fs.writeFileSync(path.join(tmp, 'persona.txt'), personaText, 'utf8');
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }

    let backup = null;
    if (fs.existsSync(target)) {
      backup = path.join(root, `.old-${id}-${Date.now()}`);
      fs.renameSync(target, backup);
    }
    // 第一段：替换主目录。只有这一步失败才需要回滚旧备份。
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      if (backup && fs.existsSync(backup)) fs.renameSync(backup, target);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // 第二段：清理旧备份。新皮肤已经就位，这里失败不能回滚（target 已非空，
    // 反向 rename 会再次抛错并把"导入成功"误报成失败），只记录日志留待下次清理。
    if (backup) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (err) {
        console.warn('[skin-import] 旧备份清理失败，已保留:', backup, err.message);
      }
    }

    config.invalidate(id);
    return {
      ok: true,
      id,
      dir: target,
      frameCount: frames.length,
      actionCount: Object.keys(actions).length,
      personaGroups: (personaText.match(/^\[[^\]]+\]/gm) || []).length
    };
  } catch (err) {
    console.warn('[skin-import] 导入失败:', err.message);
    return { ok: false, error: err.message };
  }
}

async function removeSkin(id, shell) {
  try {
    const key = String(id || '');
    if (!SAFE_ID.test(key)) return { ok: false, error: '皮肤 ID 不合法' };
    const found = config.scanSkinDirs().find((d) => d.id === key);
    if (!found) return { ok: false, error: '找不到这个皮肤' };
    if (found.source !== 'user') return { ok: false, error: '内置皮肤不能移除' };
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(found.dir, 'skin.json'), 'utf8')); } catch (err) { /* 按用户皮肤处理 */ }
    if (manifest.builtin) return { ok: false, error: '这个皮肤被标记为内置，不能移除' };
    await shell.trashItem(found.dir);       // 进回收站，不做彻底删除
    config.invalidate(key);
    return { ok: true, id: key };
  } catch (err) {
    return { ok: false, error: '移除失败：' + err.message };
  }
}

/* ---------------- 装配 ---------------- */
function create({ dialog, shell }) {
  async function pick(mode) {
    if (!dialog) return { canceled: true, error: '文件对话框不可用' };
    const common = { title: '选择皮肤素材' };
    const opts = {
      sheet: { properties: ['openFile'], filters: [{ name: '精灵图 / 图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] },
      frames: { properties: ['openFile', 'multiSelections'], filters: [{ name: '序列帧图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] },
      folder: { properties: ['openDirectory'] },
      zip: { properties: ['openFile'], filters: [{ name: '皮肤压缩包', extensions: ['zip'] }] }
    }[mode] || { properties: ['openFile'] };
    const parent = ctx.homeWindow && !ctx.homeWindow.isDestroyed() ? ctx.homeWindow : undefined;
    const result = await dialog.showOpenDialog(Object.assign({}, common, opts, parent ? { parent } : {}));
    return { canceled: !!result.canceled, paths: result.filePaths || [] };
  }

  function inspectSafe(paths) {
    try { return inspect(paths); }
    catch (err) { return { ok: false, error: err.message }; }
  }

  function openDir() {
    const dir = config.userSkinsDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir).catch((e) => console.warn('[skin-import] 打开目录失败', e.message));
    return dir;
  }

  function openBuiltinDir() {
    shell.openPath(config.BUILTIN_SKINS_DIR).catch((e) => console.warn('[skin-import] 打开内置目录失败', e.message));
    return config.BUILTIN_SKINS_DIR;
  }

  return {
    pick,
    inspect: inspectSafe,
    save: saveSkin,
    remove: (id) => removeSkin(id, shell),
    openDir,
    openBuiltinDir,
    userDir: () => config.userSkinsDir()
  };
}

module.exports = { create, inspect, readZip };
