'use strict';

const fs = require('fs');
const path = require('path');
const ctx = require('./context');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(patch || {}).forEach((key) => {
    const pv = patch[key];
    const bv = base[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) &&
        bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  });
  return out;
}

/** 调试日志写到用户数据目录（安装目录通常只读，写 __dirname 会静默失败） */
function debugLog(message) {
  if (!ctx.DEBUG) return;
  try {
    const file = path.join(ctx.DATA_DIR || ctx.APP_DIR, 'pixelpet-debug.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch (err) {
    // 日志失败不影响运行
  }
}

function isWritable(dir) {
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return false;
  }
}

/** 优先标准用户数据目录，被安全软件限制写入时逐级回退 */
function resolveDataDir(app) {
  const candidates = [
    path.join(app.getPath('appData'), 'PixelPetData'),
    path.join(app.getPath('home'), '.local', 'share', 'PixelPetData'),
    path.join(app.getPath('temp'), 'PixelPetData')
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // accessSync 在 Windows 上查不出 ACL 拒绝，必须真实写一次
      if (isWritable(dir)) return dir;
    } catch (err) {
      continue;
    }
  }
  return app.getPath('temp');
}

module.exports = { clamp, deepMerge, debugLog, resolveDataDir };
