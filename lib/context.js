'use strict';

/**
 * 全局共享上下文。
 * 把原来散落在 main.js 顶层的可变状态集中到这里，各模块通过 ctx 访问，
 * 从而避免模块之间循环 require（函数都在运行时通过 ctx 互相调用）。
 */
const ctx = {
  // 环境与路径
  DEBUG: false,
  APP_DIR: '',
  DATA_DIR: '',

  // 核心对象
  app: null,
  BrowserWindow: null,
  ipcMain: null,
  screen: null,
  Tray: null,
  Menu: null,
  nativeImage: null,
  globalShortcut: null,
  powerMonitor: null,
  shell: null,

  store: null,
  petWindow: null,
  homeWindow: null,
  homeReady: false,
  pendingHomeTab: null,
  tray: null,

  // 定时器与状态
  metricsTimer: null,
  cpuPrev: null,
  cpuHistory: [],

  dragTimer: null,
  dragInfo: null,
  dragSafetyTimer: null,

  wanderTimer: null,
  wanderDir: 1,
  wanderSpeed: 55,
  wanderLast: 0,

  followTimer: null,
  followActive: false,

  savePosTimer: null,

  lastScale: null,
  lastOpacity: null,
  lastAutoStart: null,

  batteryLevel: null,
  batterySampleAt: 0
};

module.exports = ctx;
