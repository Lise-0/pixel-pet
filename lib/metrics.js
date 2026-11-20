'use strict';

const os = require('os');
const ctx = require('./context');
const { execFile } = require('child_process');

function attach({ powerMonitor }) {
  function sampleCpu() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    cpus.forEach((cpu) => {
      Object.keys(cpu.times).forEach((key) => { total += cpu.times[key]; });
      idle += cpu.times.idle;
    });
    return { idle, total };
  }

  /** 采样电池百分比：powerMonitor 只能判断是否在电池，取不到电量 */
  function sampleBatteryLevel() {
    if (ctx.batterySampleAt && Date.now() - ctx.batterySampleAt < 60000) return;
    ctx.batterySampleAt = Date.now();
    if (process.platform !== 'win32') return;
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining'],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err) { ctx.batteryLevel = null; return; }
          const value = parseFloat(String(stdout).trim());
          ctx.batteryLevel = Number.isFinite(value) ? value : null;
        }
      );
    } catch (err) {
      ctx.batteryLevel = null;
    }
  }

  function tickMetrics() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    if (!ctx.petWindow.isVisible()) {
      ctx.cpuPrev = null;
      return;
    }
    if (!ctx.store.data.system.monitor) {
      // 关闭监控时清掉上一次采样，避免重新开启后第一次算出跨度为整段停机时间的
      // 失真 CPU 值（可能误触发"电脑好烫"反应）。
      ctx.cpuPrev = null;
      return;
    }

    const now = sampleCpu();
    if (ctx.cpuPrev) {
      const idleDiff = now.idle - ctx.cpuPrev.idle;
      const totalDiff = now.total - ctx.cpuPrev.total;
      if (totalDiff > 0) {
        ctx.cpuHistory.push((1 - idleDiff / totalDiff) * 100);
        if (ctx.cpuHistory.length > 6) ctx.cpuHistory.shift();
      }
    }
    ctx.cpuPrev = now;

    let idleSeconds = 0;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch (err) { /* 部分平台不支持 */ }
    sampleBatteryLevel();

    ctx.sendToPet('system:metrics', {
      cpu: ctx.cpuHistory.length ? ctx.cpuHistory.reduce((a, b) => a + b, 0) / ctx.cpuHistory.length : 0,
      mem: 1 - os.freemem() / os.totalmem(),
      idleSeconds,
      onBattery: typeof powerMonitor.isOnBattery === 'function' ? powerMonitor.isOnBattery() : false,
      batteryLevel: ctx.batteryLevel
    });
  }

  function startMetrics() {
    if (ctx.metricsTimer) return;
    ctx.cpuPrev = sampleCpu();
    tickMetrics();
    ctx.metricsTimer = setInterval(tickMetrics, 5000);
  }

  Object.assign(ctx, { startMetrics });
}

module.exports = { attach };
