'use strict';

const path = require('path');
const ctx = require('./context');
const { debugLog } = require('./utils');

function attach({ BrowserWindow }) {
  function gotoHomeTab(tab) {
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.webContents.send('home:goto-tab', tab);
    }
  }

  function createHomeWindow() {
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.show();
      ctx.homeWindow.focus();
      if (ctx.pendingHomeTab) {
        ctx.homeWindow.webContents.send('home:goto-tab', ctx.pendingHomeTab);
        ctx.pendingHomeTab = null;
      }
      return;
    }
    ctx.homeWindow = new BrowserWindow({
      width: 980,
      height: 700,
      minWidth: 840,
      minHeight: 600,
      title: 'PixelPet 主控台',
      backgroundColor: '#fbf6ee',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(ctx.APP_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    ctx.homeWindow.loadFile(path.join(ctx.APP_DIR, 'src', 'home.html'))
      .catch((err) => debugLog('home loadFile failed ' + (err && err.message)));
    ctx.homeWindow.once('ready-to-show', () => {
      if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) ctx.homeWindow.show();
    });
    ctx.homeWindow.webContents.on('did-finish-load', () => {
      if (ctx.pendingHomeTab && ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
        ctx.homeWindow.webContents.send('home:goto-tab', ctx.pendingHomeTab);
        ctx.pendingHomeTab = null;
      }
    });
    ctx.homeWindow.on('closed', () => {
      debugLog('home window closed');
      ctx.homeWindow = null;
    });
  }

  function openHomeWindow(tab) {
    // 进入任何主页面（托盘/快捷键/设置跳转）都先停止鼠标跟随，
    // 否则用户打开主控台后桌宠还在满屏跑，操作窗口很别扭。
    if (ctx.stopFollow) ctx.stopFollow(true);
    if (tab) ctx.pendingHomeTab = tab;
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      if (ctx.homeWindow.isMinimized()) ctx.homeWindow.restore();
      ctx.homeWindow.show();
      ctx.homeWindow.focus();
      if (ctx.pendingHomeTab) {
        gotoHomeTab(ctx.pendingHomeTab);
        ctx.pendingHomeTab = null;
      }
      return;
    }
    createHomeWindow();
  }

  Object.assign(ctx, { createHomeWindow, openHomeWindow, gotoHomeTab });
}

module.exports = { attach };
