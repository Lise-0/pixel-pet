'use strict';

/**
 * 开机自启设置：把「随系统启动」的设置写进 Electron 的登录项。
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
}

module.exports = { attach };
