'use strict';

/** 测试总入口：先跑纯逻辑单测，再跑端到端（若应用未启动则跳过并提示） */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(file, args = []) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  return r.status === 0;
}

const PORT = Number(process.env.PIXELPET_CDP_PORT || process.argv[2]) || 9223;

async function main() {
  const unitOk = run('unit.js');
  let e2eOk = true;
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`);
    e2eOk = run('e2e.js', [String(PORT)]);
  } catch (err) {
    console.log(`\n[E2E] 跳过：应用未以 --remote-debugging-port=${PORT} 启动`);
    console.log(`  启动命令：npm start -- --remote-debugging-port=${PORT}`);
    console.log('  自定义端口：PIXELPET_CDP_PORT=9333 npm test');
  }
  console.log(`\n[总计] 单测 ${unitOk ? '通过' : '失败'}，端到端 ${e2eOk ? '通过/跳过' : '失败'}`);
  process.exit(unitOk && e2eOk ? 0 : 1);
}

main();
