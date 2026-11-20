'use strict';

/**
 * 测试总入口：先跑纯逻辑单测，再跑端到端。
 * 没有调试端口时自动拉起一个带 --remote-debugging-port 的实例，跑完关掉；
 * 自动启动也失败时明确报「未运行」，不再把跳过写成「通过/跳过」含糊带过。
 * PIXELPET_NO_AUTOSTART=1 可关闭自动启动，PIXELPET_CDP_PORT 可换端口。
 */

const { spawnSync, spawn } = require('node:child_process');
const path = require('path');

function run(file, args = []) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  return r.status === 0;
}

const PORT = Number(process.env.PIXELPET_CDP_PORT || process.argv[2]) || 9223;

async function cdpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) return true;
    } catch (err) { /* 实例还没起来 */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

/** 返回自动拉起的进程（供测试结束后关掉），已有实例或不允许自动拉起时返回 null */
async function ensureApp(port) {
  if (await cdpReady(port, 300)) return null;
  if (process.env.PIXELPET_NO_AUTOSTART === '1') return null;
  // require('electron') 在纯 Node 下返回可执行文件路径；宿主可能注入
  // ELECTRON_RUN_AS_NODE=1，会让 electron.exe 变成纯 Node 而启动失败，必须清掉。
  let exe;
  try { exe = require('electron'); } catch (err) { return null; }
  if (typeof exe !== 'string' || !exe) return null;
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], {
    cwd: path.join(__dirname, '..'), env, stdio: 'ignore', windowsHide: true
  });
  if (!await cdpReady(port, 20000)) {
    child.kill();
    return null;
  }
  return child;
}

async function main() {
  const unitOk = run('unit.js');
  let e2eOk = false;
  let e2eRan = false;
  let child = null;
  try {
    child = await ensureApp(PORT);
  } catch (err) {
    console.log(`\n[E2E] 自动启动异常：${err.message}`);
  }
  if (child || await cdpReady(PORT, 200)) {
    e2eRan = true;
    e2eOk = run('e2e.js', [String(PORT)]);
  } else {
    console.log(`\n[E2E] 未运行：端口 ${PORT} 不可用，自动启动也失败（可能已有非调试实例占用单实例锁）`);
    console.log(`  手动启动：npm run dev（等同 electron . --remote-debugging-port=${PORT}）`);
    console.log('  只跑单测：npm run test:unit；PIXELPET_NO_AUTOSTART=1 可关闭自动启动');
  }
  if (child) child.kill();
  // 端到端没跑起来时：CI 设 PIXELPET_STRICT_E2E=1 视为失败；本地只明确标注「未运行」，
  // 不再像以前那样把跳过含糊地写成「通过/跳过」。
  const strict = process.env.PIXELPET_STRICT_E2E === '1';
  const e2eSatisfied = e2eRan ? e2eOk : !strict;
  const e2eLabel = e2eRan ? (e2eOk ? '通过' : '失败') : '未运行';
  console.log(`\n[总计] 单测 ${unitOk ? '通过' : '失败'}，端到端 ${e2eLabel}`);
  if (strict && !e2eRan) console.log('[总计] PIXELPET_STRICT_E2E=1：端到端未运行视为失败');
  process.exit(unitOk && e2eSatisfied ? 0 : 1);
}

main();
