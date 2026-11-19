'use strict';

/**
 * 开机自启设置。
 * 原先寄居在 lib/settings-window.js 里（独立设置窗口已并入主控台、成为死代码），
 * 这里单独抽出，保留唯一仍在使用的能力，避免为它留着整套废弃窗口代码。
 */
const ctx = require('./context');

function attach({ app } = {}) {
  const electronApp = app || ctx.app;

  function applyAutoStart(enabled) {
    try {
      electronApp.setLoginItemSettings({
        openAtLogin: !!enabled,
        path: process.execPath,
        args: electronApp.isPackaged ? [] : [electronApp.getAppPath()]
      });
    } catch (err) {
      console.warn('[autostart] 设置失败:', err.message);
    }
  }

  ctx.applyAutoStart = applyAutoStart;
  return { applyAutoStart };
}

module.exports = { attach };
