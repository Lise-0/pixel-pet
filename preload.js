'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 配置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  readSkin: (skin) => ipcRenderer.invoke('config:skin', skin),
  listSkins: () => ipcRenderer.invoke('config:skins'),
  dataPath: () => ipcRenderer.invoke('app:data-path'),
  command: (cmd) => ipcRenderer.invoke('app:command', cmd),

  // 皮肤导入向导
  skinPick: (mode) => ipcRenderer.invoke('skins:pick', mode),
  skinInspect: (paths) => ipcRenderer.invoke('skins:inspect', paths),
  skinImport: (payload) => ipcRenderer.invoke('skins:import', payload),
  skinRemove: (id) => ipcRenderer.invoke('skins:remove', id),
  skinOpenDir: () => ipcRenderer.invoke('skins:open-dir'),
  skinUserDir: () => ipcRenderer.invoke('skins:user-dir'),
  // 拖拽进窗口的 File 必须先在 preload 里换成真实路径，渲染层拿不到绝对路径
  pathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file) : '';
    } catch (err) { return ''; }
  },

  // 窗口行为
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  wanderStart: (dir, speed) => ipcRenderer.send('pet:wander-start', { dir, speed }),
  wanderStop: () => ipcRenderer.send('pet:wander-stop'),
  showContextMenu: () => ipcRenderer.send('pet:context-menu'),
  followToggle: () => ipcRenderer.send('pet:follow-toggle'),
  followStop: () => ipcRenderer.send('pet:follow-stop'),
  reportPomodoro: (status) => ipcRenderer.send('pomodoro:status', status),

  // 主进程推送
  onSettings: (cb) => ipcRenderer.on('settings:changed', (event, data) => cb(data)),
  onCommand: (cb) => ipcRenderer.on('pet:command', (event, cmd) => cb(cmd)),
  onMetrics: (cb) => ipcRenderer.on('system:metrics', (event, data) => cb(data)),
  onDragEnded: (cb) => ipcRenderer.on('pet:drag-ended', () => cb()),
  onFollowEnded: (cb) => ipcRenderer.on('follow:ended', () => cb()),
  onFollowStarted: (cb) => ipcRenderer.on('follow:started', () => cb()),
  onFollowMotion: (cb) => ipcRenderer.on('follow:motion', (event, info) => cb(info)),
  onWanderEnded: (cb) => ipcRenderer.on('pet:wander-ended', (event, data) => cb(data)),
  onPomodoroStatus: (cb) => ipcRenderer.on('pomodoro:status', (event, data) => cb(data)),
  onGotoTab: (cb) => ipcRenderer.on('home:goto-tab', (event, tab) => cb(tab)),
  getPomodoro: () => ipcRenderer.invoke('pomodoro:get')
});
