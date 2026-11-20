'use strict';

const ctx = require('./context');
const { DEFAULT_SETTINGS, sanitizePatch } = require('./store');
const config = require('./config');
const skinImport = require('./skin-import');

function attach({ ipcMain, shell, app }) {
  const importer = skinImport.create({ dialog: ctx.dialog, shell });

  function sendToPet(channel, payload) {
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      ctx.petWindow.webContents.send(channel, payload);
    }
  }

  function broadcastSettings() {
    sendToPet('settings:changed', ctx.store.data);
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.webContents.send('settings:changed', ctx.store.data);
    }
  }

  function handleCommand(cmd) {
    if (!cmd || !cmd.type) return;
    switch (cmd.type) {
      case 'toggle-visible': ctx.toggleVisible(); break;
      // 设置并入主控页，统一跳到主控页的“设置”Tab，不再弹独立窗口
      case 'open-settings': ctx.openHomeWindow('settings'); break;
      case 'open-home': ctx.openHomeWindow(); break;
      case 'skin:reload': sendToPet('pet:command', { type: 'skin:reload' }); break;
      case 'open-data-dir': shell.openPath(app.getPath('userData')).catch((e) => console.warn('[ipc] 打开数据目录失败', e.message)); break;
      case 'open-assets-dir': importer.openDir(); break;              // 我的皮肤目录（可写）
      case 'open-builtin-skins-dir': importer.openBuiltinDir(); break; // 内置皮肤与 _TEMPLATE
      case 'reset': resetData(); break;
      // 跟随由主进程统一管理状态，所有入口（托盘/主控台按钮）都走这里，
      // 不再转发给渲染层，避免双状态源不同步导致点击失灵。
      case 'follow:toggle': ctx.toggleFollow(); break;
      case 'follow:stop': ctx.stopFollow(true); break;
      default: sendToPet('pet:command', cmd);
    }
  }

  function resetData() {
    if (ctx.followActive) ctx.stopFollow(false);
    ctx.store.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    ctx.store.flush();
    ctx.resetWindowGeometry();
    ctx.applySettings();
    sendToPet('pet:command', { type: 'state:reload' });
    broadcastSettings();
    ctx.refreshTray();
  }

  function registerIpc() {
    ipcMain.handle('settings:get', () => ctx.store.data);
    ipcMain.handle('settings:patch', (event, patch) => {
      ctx.store.patch(patch);
      return ctx.store.data;
    });
    const applyStateSave = (state) => {
      const clean = sanitizePatch({ state: state || {} });
      ctx.store.data.state = Object.assign({}, ctx.store.data.state, clean.state || {});
    };
    ipcMain.handle('state:save', (event, state) => {
      applyStateSave(state);
      ctx.store.save(600);
      return true;
    });
    // 页面卸载时的同步存盘：send 不等待返回，主进程收到后立即落盘，
    // 避免渲染层关闭瞬间 invoke 来不及完成导致最后状态丢失。
    ipcMain.on('state:save-sync', (event, state) => {
      applyStateSave(state);
      ctx.store.flush();
    });
    ipcMain.handle('config:skin', (event, skin) => config.readSkin(skin));
    ipcMain.handle('config:skins', () => config.listSkins());
    ipcMain.handle('app:data-path', () => app.getPath('userData'));

    // 皮肤导入向导
    ipcMain.handle('skins:pick', (event, mode) => importer.pick(mode));
    ipcMain.handle('skins:inspect', (event, paths) => importer.inspect(paths));
    ipcMain.handle('skins:import', (event, payload) => importer.save(payload));
    ipcMain.handle('skins:remove', async (event, id) => {
      const result = await importer.remove(id);
      if (result.ok && ctx.store.data.pet && ctx.store.data.pet.skin === id) {
        ctx.store.patch({ pet: { skin: 'default' } });   // 正在用的皮肤被删，自动换回默认
      }
      return result;
    });
    ipcMain.handle('skins:open-dir', () => importer.openDir());
    ipcMain.handle('skins:user-dir', () => importer.userDir());

    ipcMain.handle('pomodoro:get', () => ctx.lastPomodoro || { running: false, phase: 'idle', remain: 0 });
    ipcMain.handle('app:command', (event, cmd) => {
      handleCommand(cmd);
      return true;
    });

    ipcMain.on('pet:ignore-mouse', (event, ignore) => {
      if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
      ctx.petWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    });
    ipcMain.on('pet:drag-start', () => ctx.startDrag());
    ipcMain.on('pet:drag-end', () => ctx.endDrag());
    ipcMain.on('pet:wander-start', (event, payload) => {
      ctx.startWander(payload && payload.dir, payload && payload.speed);
    });
    ipcMain.on('pet:wander-stop', () => ctx.stopWander(true));
    ipcMain.on('pet:context-menu', () => ctx.showPetMenu());
    // 桌宠点击/拖拽只发“切换”或“停止”请求，状态由主进程裁决并回推
    ipcMain.on('pet:follow-toggle', () => ctx.toggleFollow());
    ipcMain.on('pet:follow-stop', () => ctx.stopFollow(true));
    ipcMain.on('pomodoro:status', (event, status) => {
      ctx.lastPomodoro = status;
      if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
        ctx.homeWindow.webContents.send('pomodoro:status', status);
      }
    });
  }

  Object.assign(ctx, { sendToPet, broadcastSettings, handleCommand, resetData, registerIpc });
}

module.exports = { attach };
