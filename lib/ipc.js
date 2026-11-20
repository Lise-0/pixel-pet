'use strict';

const ctx = require('./context');
const { DEFAULT_SETTINGS, sanitizePatch } = require('./store');
const config = require('./config');
const skinImport = require('./skin-import');
const pomodoroStats = require('./pomodoro-stats');

function attach({ ipcMain, shell, app }) {
  const importer = skinImport.create({ dialog: ctx.dialog, shell });
  // 系统通知需要强引用：对象一旦被 GC，点击回调在某些平台上就再也不会触发。
  // 用集合保留所有未关闭的通知，连发多条时先前的那条也不会失去引用。
  const activeNotifications = new Set();

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

  function sendPomodoroStats() {
    if (!ctx.homeWindow || ctx.homeWindow.isDestroyed()) return;
    const pom = ctx.store.data.pomodoro || {};
    ctx.homeWindow.webContents.send('pomodoro:stats', pomodoroStats.summarize(pom.stats, Date.now(), 7, pom.lifetime));
  }

  function showPomodoroNotification(phase, minutes) {
    const pom = ctx.store.data.pomodoro || {};
    if (pom.notify === false || !ctx.Notification || !ctx.Notification.isSupported()) return;
    try {
      const isFocus = phase === 'focus';
      const n = new ctx.Notification({
        title: isFocus ? '专注完成 🎉' : '休息结束',
        body: isFocus
          ? `完成了 ${minutes} 分钟专注，起来活动一下吧～`
          : '休息好了，继续加油！'
      });
      activeNotifications.add(n);
      n.on('click', () => ctx.openHomeWindow());
      n.on('close', () => activeNotifications.delete(n));
      n.show();
    } catch (err) {
      console.warn('[ipc] 番茄钟通知失败:', err.message);
    }
  }

  function handleCommand(cmd) {
    if (!cmd || !cmd.type) return;
    switch (cmd.type) {
      case 'toggle-visible': ctx.toggleVisible(); break;
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
    // 主控台渲染层初始化完成（监听器已注册）后回执，此时才补发待跳转的 Tab
    ipcMain.on('home:ready', () => { if (ctx.onHomeReady) ctx.onHomeReady(); });

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
    ipcMain.handle('skins:user-dir', () => importer.userDir());

    ipcMain.handle('pomodoro:get', () => ctx.lastPomodoro || { running: false, phase: 'idle', remain: 0 });
    ipcMain.handle('pomodoro:stats', () => {
      const pom = ctx.store.data.pomodoro || {};
      return pomodoroStats.summarize(pom.stats, Date.now(), 7, pom.lifetime);
    });
    // 番茄钟阶段完成：由桌宠渲染层上报，主进程负责落盘与系统通知
    ipcMain.on('pomodoro:complete', (event, payload) => {
      if (!payload || !ctx.store) return;
      const pom = ctx.store.data.pomodoro;
      if (!pom) return;
      const phase = payload.phase === 'break' ? 'break' : 'focus';
      const minutes = Number(payload.minutes) || 0;
      pom.stats = pomodoroStats.record(pom.stats, {
        at: Number(payload.at) || Date.now(),
        minutes,
        phase
      });
      // 累计值独立累加，不受 stats 的 500 条上限影响
      if (phase === 'focus' && minutes > 0) {
        const life = pom.lifetime || (pom.lifetime = { focusMinutes: 0, focusCount: 0 });
        life.focusMinutes += minutes;
        life.focusCount += 1;
      }
      ctx.store.flush();
      sendPomodoroStats();
      showPomodoroNotification(phase, minutes);
    });
    ipcMain.handle('app:command', (event, cmd) => {
      handleCommand(cmd);
      return true;
    });

    ipcMain.on('pet:ignore-mouse', (event, ignore) => {
      // 兼容旧的渲染层调用；穿透判定已移到主进程，统一走镜像避免状态不一致
      if (typeof ctx.setIgnoreMouse === 'function') ctx.setIgnoreMouse(!!ignore);
    });
    // 渲染层只同步"猫身在哪"，不直接切穿透：穿透由主进程按全局光标判定，
    // 避免 IPC 往返期间 pointerdown 被窗口吞掉（点击/拖不动的根因）。
    ipcMain.on('pet:hover-box', (event, box) => {
      if (typeof ctx.setHoverBox === 'function') ctx.setHoverBox(box);
    });
    ipcMain.handle('debug:hover-state', () =>
      (typeof ctx.debugHoverState === 'function' ? ctx.debugHoverState() : null));
    // 诊断用：制造「真实窗口穿透、主进程镜像仍以为可点」的脱节，验证心跳自愈。
    ipcMain.handle('debug:desync-ignore', () => ({
      desynced: typeof ctx.desyncIgnoreForDebug === 'function' && !!ctx.desyncIgnoreForDebug()
    }));
    // 诊断用：模拟页面重载/窗口重建后主进程命中框丢失，验证渲染层心跳能补发。
    ipcMain.handle('debug:clear-hover-box', () => {
      if (typeof ctx.resyncHoverState === 'function') ctx.resyncHoverState();
      return true;
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

  Object.assign(ctx, { sendToPet, broadcastSettings, handleCommand, registerIpc });
}

module.exports = { attach };
