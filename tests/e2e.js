'use strict';

/**
 * 端到端测试：通过 CDP 连接已运行的 PixelPet 应用，验证关键功能无回归。
 * 前置：应用需以 --remote-debugging-port=9223 启动。
 * 用法：node tests/e2e.js [port]
 */

const PORT = Number(process.argv[2]) || 9223;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.errs = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') this.errs.push(m.params.exceptionDetails.text);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const i = ++this.id;
      this.pending.set(i, res);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
  }
  close() { if (this.ws) this.ws.close(); }
}

(async () => {
  console.log(`\n[E2E] 连接 CDP ${BASE}`);
  let targets;
  try {
    targets = await (await fetch(`${BASE}/json/list`)).json();
  } catch (err) {
    console.error(`  ✗ 无法连接 ${BASE}，请先以 --remote-debugging-port=${PORT} 启动应用`);
    process.exit(1);
  }
  const petTarget = targets.find((t) => t.url.includes('pet.html'));
  const homeTarget = targets.find((t) => t.url.includes('home.html'));
  if (!petTarget || !homeTarget) {
    console.error('  ✗ 未找到 pet.html / home.html 调试目标');
    process.exit(1);
  }
  const pet = new CDP(petTarget.webSocketDebuggerUrl);
  const home = new CDP(homeTarget.webSocketDebuggerUrl);
  await pet.connect();
  await home.connect();

  console.log('\n[E2E] 启动冒烟');
  await check('双页面画布与 DOM 就绪', async () => {
    const r = JSON.parse(await pet.ev(`JSON.stringify({
      canvas: !!document.getElementById('pet-canvas'),
      actions: Object.keys(actionConfig).length,
      skin: currentSkin
    })`));
    assert(r.canvas && r.actions > 0 && r.skin, JSON.stringify(r));
    const h = JSON.parse(await home.ev(`JSON.stringify({
      mood: !!document.getElementById('valMood'),
      trend: !!document.getElementById('stateTrend'),
      focusChart: !!document.getElementById('focusChart')
    })`));
    assert(h.mood && h.trend && h.focusChart, JSON.stringify(h));
  });
  await check('启动后控制台无异常', async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert(pet.errs.length === 0, 'pet: ' + pet.errs.join('; '));
    assert(home.errs.length === 0, 'home: ' + home.errs.join('; '));
  });

  console.log('\n[E2E] 桌宠层');
  await check('奶龙睡觉符号修复无回归', async () => {
    const r = await pet.ev(`(async function(){
      const old=currentSkin;
      await loadSkin('my-pet-2971');
      const fallback = resolveAction('sleep') === resolveAction('idle');
      await loadSkin(old);
      return fallback ? 'ok' : 'fail';
    })()`);
    assert(r === 'ok', r);
  });
  await check('打盹恢复疲劳机制生效', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const oldF=fatigue,oldOv=overrideExpr,oldFol=following,oldDrg=dragging;
      const oldMon=settings.system.monitor, oldLi=lastInteraction;
      // 隔离"离开3分钟恢复"逻辑：重置交互时间并关闭系统 idle 采样
      settings.system.monitor=false; lastInteraction=Date.now();
      following=false;dragging=false;
      overrideExpr=null;fatigue=50;tickState();const awake=fatigue;
      fatigue=95;overrideExpr={name:'sleep',until:Date.now()+15000};tickState();const nap=fatigue;
      fatigue=oldF;overrideExpr=oldOv;following=oldFol;dragging=oldDrg;
      settings.system.monitor=oldMon;lastInteraction=oldLi;
      return JSON.stringify({awake,nap});
    })()`));
    assert(r.awake > 50 && r.nap < 95, JSON.stringify(r));
  });
  await check('番茄钟完成上报 API 存在', async () => {
    const r = await pet.ev(`typeof api.reportPomodoroComplete === 'function' ? 'ok' : 'fail'`);
    assert(r === 'ok', r);
  });

  console.log('\n[E2E] 主控台层');
  await check('皮肤列表与编辑入口', async () => {
    const r = JSON.parse(await home.ev(`JSON.stringify({
      cards: document.querySelectorAll('.skin-card').length,
      edit: document.querySelectorAll('.skin-edit').length,
      selected: document.querySelectorAll('.skin-card.selected').length
    })`));
    assert(r.cards >= 2 && r.edit >= 2 && r.selected === 1, JSON.stringify(r));
  });
  await check('向导状态可重置', async () => {
    const r = await home.ev(`(function(){
      SkinWizard.open();
      const n=document.getElementById('wzName'),i=document.getElementById('wzId');
      n.value='残留';i.value='old';
      SkinWizard.close();SkinWizard.open();
      const ok=n.value===''&&i.value==='';
      SkinWizard.close();return ok?'ok':'fail';
    })()`);
    assert(r === 'ok', r);
  });
  await check('好感整数显示', async () => {
    const r = await home.ev(`/^\\d+$/.test(document.getElementById('valAffection').textContent) ? 'ok' : 'fail'`);
    assert(r === 'ok', r);
  });

  console.log('\n[E2E] 番茄钟统计');
  await check('统计 API 与 UI 元素就绪', async () => {
    const r = JSON.parse(await home.ev(`JSON.stringify({
      get: typeof api.getPomodoroStats === 'function',
      on: typeof api.onPomodoroStats === 'function',
      chart: !!document.getElementById('focusChart'),
      notify: !!document.getElementById('qNotify')
    })`));
    assert(r.get && r.on && r.chart && r.notify, JSON.stringify(r));
  });
  await check('统计查询返回合法结构', async () => {
    const r = JSON.parse(await home.ev(`(async function(){
      const s=await api.getPomodoroStats();
      return JSON.stringify({days:s.days&&s.days.length,today:typeof s.todayMinutes,total:typeof s.totalCount});
    })()`));
    assert(r.days === 7 && r.today === 'number' && r.total === 'number', JSON.stringify(r));
  });
  await check('通知开关可切换并持久化', async () => {
    const r = JSON.parse(await home.ev(`(async function(){
      const before=(await api.getSettings()).pomodoro.notify !== false;
      await api.patchSettings({pomodoro:{notify:!before}});
      const after=(await api.getSettings()).pomodoro.notify !== false;
      await api.patchSettings({pomodoro:{notify:before}});   // 恢复
      return JSON.stringify({before,after,ok:before!==after});
    })()`));
    assert(r.ok, JSON.stringify(r));
  });

  await new Promise((r) => setTimeout(r, 300));
  console.log('\n[E2E] 控制台异常检查');
  await check('验证期间无新异常', async () => {
    assert(pet.errs.length === 0, 'pet: ' + pet.errs.join('; '));
    assert(home.errs.length === 0, 'home: ' + home.errs.join('; '));
  });

  pet.close();
  home.close();
  console.log(`\n[E2E结果] 通过 ${passed}，失败 ${failed}`);
  if (failed) {
    console.error('失败项:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
})().catch((err) => { console.error('[E2E] 运行失败:', err); process.exit(1); });
