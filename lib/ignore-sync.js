'use strict';

/**
 * 穿透状态的「心跳重发」间隔。
 *
 * setIgnoreMouseEvents 是 Windows/Electron 侧的窗口状态，主进程只能靠一个镜像变量
 * 记住自己上次设了什么。渲染进程重载、窗口 show/hide、系统挂起恢复、显示器热插拔
 * 都可能让真实窗口状态与镜像脱节；而 applyIgnore 若只在镜像值变化时调用，脱节后
 * 轮询会永远早退，窗口一直停留在「忽略鼠标 + forward」状态：mousedown 被系统吞掉、
 * 只有 mouseup 转发到页面，表现就是点击和拖拽全部失灵、重启应用才恢复。
 *
 * 因此每隔一段时间无条件重发一次当前目标状态，让任何脱节都能自动纠正。
 */
const RESYNC_MS = 1000;

function needsResync(lastApplyAt, now = Date.now(), intervalMs = RESYNC_MS) {
  if (!Number.isFinite(lastApplyAt) || lastApplyAt <= 0) return true;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : RESYNC_MS;
  return now - lastApplyAt >= interval;
}

/**
 * 心跳下发时是否需要走一次「穿透 → 可点」的完整内部状态转换。
 * 目标为穿透时普通重发即可；只有目标为可点、且处于心跳强制下发时才需要复位，
 * 用来纠正「OS 窗口可点、Electron 内部仍忽略鼠标」的脱节。
 */
function needsFullReset(force, targetIgnore) {
  return !!force && !targetIgnore;
}

module.exports = { RESYNC_MS, needsResync, needsFullReset };
