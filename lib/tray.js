'use strict';

const path = require('path');
const fs = require('fs');
const ctx = require('./context');
const { debugLog } = require('./utils');

function attach({ Menu, Tray, nativeImage, shell, app }) {
  function trayIcon(locked) {
    const name = locked ? 'icon-locked' : 'icon';
    // Windows 托盘用 ico 更清晰，缺失时回退 png
    const ico = path.join(ctx.APP_DIR, 'assets', name + '.ico');
    if (fs.existsSync(ico)) return ico;
    return path.join(ctx.APP_DIR, 'assets', name + '.png');
  }

  function buildTrayMenu() {
    const s = ctx.store.data;
    return Menu.buildFromTemplate([
      {
        label: s.window.visible === false ? '显示宠物' : '隐藏宠物',
        click: ctx.toggleVisible
      },
      { type: 'separator' },
      {
        label: '锁定位置',
        type: 'checkbox',
        checked: !!s.window.locked,
        click: (item) => ctx.store.patch({ window: { locked: item.checked } })
      },
      {
        label: '鼠标穿透',
        type: 'checkbox',
        checked: !!s.window.passthrough,
        click: (item) => ctx.store.patch({ window: { passthrough: item.checked } })
      },
      {
        label: '系统联动',
        type: 'checkbox',
        checked: s.system.monitor !== false,
        click: (item) => ctx.store.patch({ system: { monitor: item.checked } })
      },
      {
        label: '自由走动',
        type: 'checkbox',
        checked: s.system.roam !== false,
        click: (item) => ctx.store.patch({ system: { roam: item.checked } })
      },
      { type: 'separator' },
      {
        label: ctx.followActive ? '停止跟随鼠标' : '跟随鼠标',
        enabled: !s.window.locked,
        click: () => ctx.handleCommand({ type: 'follow:toggle' })
      },
      {
        label: '番茄钟',
        submenu: [
          { label: '开始专注', click: () => ctx.sendToPet('pet:command', { type: 'pomodoro:start' }) },
          { label: '停止', click: () => ctx.sendToPet('pet:command', { type: 'pomodoro:stop' }) }
        ]
      },
      { label: '打开主界面', click: () => ctx.openHomeWindow() },
      { label: '设置…', click: () => ctx.openHomeWindow('settings') },
      { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')).catch((e) => debugLog('打开数据目录失败 ' + e.message)) },
      { type: 'separator' },
      { label: '退出', click: ctx.quitApp }
    ]);
  }

  function refreshTray() {
    if (!ctx.tray) return;
    ctx.tray.setContextMenu(buildTrayMenu());
    const image = nativeImage.createFromPath(trayIcon(!!ctx.store.data.window.locked));
    if (!image.isEmpty()) ctx.tray.setImage(image);
    ctx.tray.setToolTip(ctx.store.data.window.locked ? 'PixelPet（位置已锁定）' : 'PixelPet');
  }

  function createTray() {
    const image = nativeImage.createFromPath(trayIcon(false));
    debugLog(`tray icon empty=${image.isEmpty()} size=${JSON.stringify(image.getSize())}`);
    ctx.tray = new Tray(image);
    ctx.tray.setToolTip('PixelPet');
    ctx.tray.setContextMenu(buildTrayMenu());
    ctx.tray.on('double-click', ctx.toggleVisible);
  }

  function showPetMenu() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const s = ctx.store.data;
    const menu = Menu.buildFromTemplate([
      {
        label: '锁定位置',
        type: 'checkbox',
        checked: !!s.window.locked,
        click: (item) => ctx.store.patch({ window: { locked: item.checked } })
      },
      {
        label: '鼠标穿透',
        type: 'checkbox',
        checked: !!s.window.passthrough,
        click: (item) => ctx.store.patch({ window: { passthrough: item.checked } })
      },
      { type: 'separator' },
      { label: '开始番茄钟', click: () => ctx.sendToPet('pet:command', { type: 'pomodoro:start' }) },
      { label: '主界面…', click: () => ctx.openHomeWindow() },
      { label: '设置…', click: () => ctx.openHomeWindow('settings') },
      { label: '隐藏宠物', click: ctx.toggleVisible },
      { type: 'separator' },
      { label: '退出', click: ctx.quitApp }
    ]);
    menu.popup({ window: ctx.petWindow });
  }

  Object.assign(ctx, { refreshTray, createTray, showPetMenu });
}

module.exports = { attach };
