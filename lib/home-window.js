'use strict';

const path = require('path');
const ctx = require('./context');
const { debugLog } = require('./utils');

function attach({ BrowserWindow }) {
  // 渲染层要等数次异步 IPC 才注册 home:goto-tab 监听，而 did-finish-load 早于它。
  // 因此用 ready 握手：渲染层初始化完成后发 home:ready，主进程此时才补发待跳转 Tab，
  // 避免首次从托盘进“设置”等场景因监听器尚未注册而丢消息。
  function flushPendingHomeTab() {
    if (!ctx.homeReady || !ctx.pendingHomeTab) return;
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.webContents.send('home:goto-tab', ctx.pendingHomeTab);
    }
    ctx.pendingHomeTab = null;
  }

  // Tab 跳转统一走 openHomeWindow(tab)：未 ready 时写入 pendingHomeTab，
  // 由 onHomeReady → flushPendingHomeTab 补发，避免监听器尚未注册就丢消息。

  function onHomeReady() {
    ctx.homeReady = true;
    flushPendingHomeTab();
    // 主页刚注册完监听，补一次当前跟随状态，按钮文案才不会停留在默认值
    if (ctx.broadcastFollowState) ctx.broadcastFollowState(ctx.followActive);
  }

  function createHomeWindow() {
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.show();
      ctx.homeWindow.focus();
      flushPendingHomeTab();
      return;
    }
    ctx.homeReady = false;
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
    // 不再在 did-finish-load 发送 Tab：那时渲染层监听尚未注册，消息会丢失。
    // 改由渲染层初始化完成后发 home:ready，在 onHomeReady 里补发。
    ctx.homeWindow.on('closed', () => {
      debugLog('home window closed');
      ctx.homeWindow = null;
      ctx.homeReady = false;
      ctx.pendingHomeTab = null;   // 否则残留的 tab 会在下次打开无参窗口时被误补发
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
      // 复用已加载的窗口：此时 homeReady 通常已为 true，可直接补发；
      // 若尚未 ready（首个窗口仍在初始化），flush 会保留待发，等 ready 后再发。
      flushPendingHomeTab();
      return;
    }
    createHomeWindow();
  }

  Object.assign(ctx, { openHomeWindow, onHomeReady });
}

module.exports = { attach };
