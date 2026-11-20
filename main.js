'use strict';

const electron = require('electron');
const path = require('path');
const ctx = require('./lib/context');
const utils = require('./lib/utils');

// 先注入基础环境：config 模块在加载时会读取 APP_DIR
ctx.APP_DIR = __dirname;
ctx.DEBUG = !!process.env.PIXELPET_DEBUG;
Object.assign(ctx, {
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  ipcMain: electron.ipcMain,
  dialog: electron.dialog,
  screen: electron.screen,
  Tray: electron.Tray,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  globalShortcut: electron.globalShortcut,
  powerMonitor: electron.powerMonitor,
  shell: electron.shell,
  Notification: electron.Notification
});

ctx.DATA_DIR = utils.resolveDataDir(ctx.app);
ctx.app.setPath('userData', ctx.DATA_DIR);
const { debugLog } = utils;

// 装配各功能模块：模块把方法挂到 ctx 上，跨模块调用统一走 ctx，避免循环依赖
const { Store } = require('./lib/store');
require('./lib/window').attach();
require('./lib/metrics').attach(ctx);
require('./lib/tray').attach(ctx);
require('./lib/autostart').attach(ctx);
require('./lib/home-window').attach(ctx);
require('./lib/ipc').attach(ctx);

/** 设置变更后的统一副作用：应用设置 → 广播 → 刷新托盘 */
ctx.onSettingsChanged = () => {
  ctx.applySettings();
  ctx.broadcastSettings();
  ctx.refreshTray();
};

process.on('uncaughtException', (err) => {
  debugLog(`uncaughtException ${err && err.stack}`);
  console.error('[main] 未捕获异常:', err);
});

process.on('unhandledRejection', (reason) => {
  debugLog(`unhandledRejection ${reason && reason.stack ? reason.stack : reason}`);
  console.error('[main] 未处理的 Promise 拒绝:', reason);
});

function registerHotkeys() {
  try {
    ctx.globalShortcut.unregisterAll();
    ctx.globalShortcut.register('Alt+P', ctx.toggleVisible);
  } catch (err) {
    console.warn('[hotkey] 注册失败:', err.message);
  }
}

function quitApp() {
  ctx.store.flush();
  ctx.app.isQuitting = true;
  ctx.app.quit();
}
ctx.quitApp = quitApp;

const gotLock = ctx.app.requestSingleInstanceLock();
debugLog('gotLock=' + gotLock);
if (!gotLock) {
  debugLog('quit for single instance lock');
  ctx.app.quit();
} else {
  ctx.app.on('second-instance', () => {
    // whenReady 之前 store 还没创建，快速双击启动文件时会走到这里。
    if (!ctx.store) return;
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      ctx.petWindow.showInactive();
      ctx.store.patch({ window: { visible: true } });
    }
  });

  ctx.app.whenReady().then(() => {
    debugLog('whenReady');
    ctx.store = new Store(path.join(ctx.app.getPath('userData'), 'settings.json'));
    ctx.store.load();
    debugLog('store loaded');
    ctx.registerIpc();
    debugLog('ipc registered');
    ctx.createPetWindow();
    debugLog('pet window created');
    ctx.createTray();
    debugLog('tray created');
    if (ctx.store.data.home && ctx.store.data.home.showOnStartup !== false) {
      ctx.openHomeWindow();
      debugLog('home window opened');
    }
    registerHotkeys();

    ctx.screen.on('display-added', ctx.handleDisplaysChanged);
    ctx.screen.on('display-removed', ctx.handleDisplaysChanged);

    ctx.app.on('activate', () => {
      if (!ctx.petWindow) ctx.createPetWindow();
      else if (ctx.store.data.window.visible !== false) {
        ctx.petWindow.showInactive();
        if (ctx.resyncHoverState) ctx.resyncHoverState();
      }
      // 用户此前用托盘隐藏了宠物时，点 Dock 图标不应绕过隐藏状态把宠物显示出来
      // 却让托盘菜单/设置里的 visible 仍为 false，造成状态撕裂。
    });
  }).catch((err) => {
    debugLog('whenReady failed ' + (err && err.stack));
    console.error('[main] 启动失败:', err);
  });

  ctx.app.on('window-all-closed', () => {
    // 托盘常驻，不退出
  });

  ctx.app.on('before-quit', () => {
    debugLog('before-quit');
    if (ctx.store) ctx.store.flush();
    if (ctx.stopHoverWatch) ctx.stopHoverWatch();
    if (ctx.metricsTimer) { clearInterval(ctx.metricsTimer); ctx.metricsTimer = null; }
    if (ctx.dragTimer) { clearInterval(ctx.dragTimer); ctx.dragTimer = null; }
    if (ctx.wanderTimer) { clearInterval(ctx.wanderTimer); ctx.wanderTimer = null; }
    if (ctx.followTimer) { clearInterval(ctx.followTimer); ctx.followTimer = null; }
    if (ctx.dragSafetyTimer) { clearTimeout(ctx.dragSafetyTimer); ctx.dragSafetyTimer = null; }
    if (ctx.savePosTimer) { clearTimeout(ctx.savePosTimer); ctx.savePosTimer = null; }
    ctx.followActive = false;
    ctx.dragInfo = null;
    ctx.globalShortcut.unregisterAll();
  });
}
