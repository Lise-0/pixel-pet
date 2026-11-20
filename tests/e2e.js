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
  await check('睡觉符号守卫无回归（缺动作不画 z z）', async () => {
    // 不依赖任何本机导入的皮肤 ID：临时移除 sleep 动作映射，验证
    // (1) resolveAction('sleep') 回退到 idle；
    // (2) drawExtras 用 hasOwnAction 守卫，缺动作时不调用 fillText('z')。
    // 测试结束原样恢复，绝不改动真实皮肤包。
    const r = await pet.ev(`(function(){
      const t = skinPack && skinPack.triggers;
      const hadTrig = !!(t && Object.prototype.hasOwnProperty.call(t, 'sleep'));
      const savedTrig = hadTrig ? t.sleep : undefined;
      const hadAct = Object.prototype.hasOwnProperty.call(actionConfig, 'sleep');
      const savedAct = actionConfig.sleep;
      if (t) delete t.sleep;
      delete actionConfig.sleep;
      const fallback = resolveAction('sleep') === 'idle';

      // 真正验证绘制守卫：hook fillText，捕获 sleep 分支是否画了 'z'
      const fake = { bbox: { x: 0, y: 0, w: 40, h: 40 }, img: { width: 40, height: 40 } };
      const texts = [];
      const orig = ctx.fillText;
      let guardOk = false;
      try {
        ctx.fillText = function(s){ texts.push(String(s)); };
        drawExtras('sleep', fake, 0, 0, 0, false);
        guardOk = texts.indexOf('z') === -1;
      } catch (err) {
        guardOk = false;
      } finally {
        ctx.fillText = orig;
      }
      if (hadTrig) t.sleep = savedTrig;
      if (hadAct) actionConfig.sleep = savedAct;
      return (fallback && guardOk) ? 'ok' : 'fail';
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
  await check('跟随开关有可见反馈（轻提示，无边框黑框）', async () => {
    try {
      await pet.ev(`api.followToggle()`);
      await new Promise((r) => setTimeout(r, 350));
      const on = JSON.parse(await pet.ev(`JSON.stringify({
        following, hint: document.getElementById('petHint').textContent,
        shown: document.getElementById('petHint').classList.contains('show'),
        border: getComputedStyle(document.getElementById('petHint')).borderTopWidth
      })`));
      await pet.ev(`api.followStop()`);
      await new Promise((r) => setTimeout(r, 350));
      const off = JSON.parse(await pet.ev(`JSON.stringify({
        following, hint: document.getElementById('petHint').textContent
      })`));
      assert(on.following && on.shown && on.hint.includes('跟随中') && on.border === '0px', JSON.stringify(on));
      assert(!off.following && off.hint.includes('已停止跟随'), JSON.stringify(off));
    } finally {
      await pet.ev(`api.followStop()`);
    }
  });
  await check('跟随状态光环只在跟随中绘制', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const old = following, orig = ctx.ellipse;
      let n = 0;
      ctx.ellipse = function(){ n += 1; return orig.apply(this, arguments); };
      try {
        following = false; drawFollowMark(); const idle = n;
        following = true; drawFollowMark(); const active = n - idle;
        return JSON.stringify({ idle, active });
      } finally { ctx.ellipse = orig; following = old; }
    })()`));
    assert(r.idle === 0 && r.active === 1, JSON.stringify(r));
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
  await check('主控台跟随按钮实时显示状态', async () => {
    try {
      await home.ev(`api.command({type:"follow:toggle"})`);
      await new Promise((r) => setTimeout(r, 400));
      const on = JSON.parse(await home.ev(`JSON.stringify({
        label: document.querySelector("#quickFollow .quick-label b").textContent,
        active: document.getElementById("quickFollow").classList.contains("is-following"),
        api: typeof api.onFollowState
      })`));
      await home.ev(`api.command({type:"follow:toggle"})`);
      await new Promise((r) => setTimeout(r, 400));
      const off = JSON.parse(await home.ev(`JSON.stringify({
        label: document.querySelector("#quickFollow .quick-label b").textContent,
        active: document.getElementById("quickFollow").classList.contains("is-following")
      })`));
      assert(on.api === 'function' && on.active && on.label === '停止跟随', JSON.stringify(on));
      assert(!off.active && off.label === '跟随鼠标', JSON.stringify(off));
    } finally {
      await pet.ev(`api.followStop()`);
    }
  });
  await check('状态趋势：无时间戳/过期数据丢弃，两条曲线成对还原', async () => {
    const r = JSON.parse(await home.ev(`(function(){
      const key = TREND_KEY;
      const saved = localStorage.getItem(key);
      const before = { mood: stateTrend.mood.slice(), fatigue: stateTrend.fatigue.slice() };
      try {
        localStorage.setItem(key, JSON.stringify({ mood:[10,20,30], fatigue:[40,50,60] }));
        stateTrend = { mood:[99], fatigue:[99] };
        loadStateTrend();
        const noAt = stateTrend.mood.length === 0 && stateTrend.fatigue.length === 0;
        localStorage.setItem(key, JSON.stringify({ mood:[10,20,'bad'], fatigue:[40,50,60,70], at: Date.now() }));
        loadStateTrend();
        const paired = stateTrend.mood.length === 2 && stateTrend.fatigue.length === 2 &&
          stateTrend.mood[0] === 10 && stateTrend.fatigue[0] === 40 &&
          stateTrend.mood[1] === 20 && stateTrend.fatigue[1] === 50;
        localStorage.setItem(key, JSON.stringify({ mood:[1,2], fatigue:[3,4], at: Date.now()-31*60*1000 }));
        stateTrend = { mood:[99], fatigue:[99] };
        loadStateTrend();
        const stale = stateTrend.mood.length === 0 && stateTrend.fatigue.length === 0;
        return JSON.stringify({ noAt, paired, stale });
      } finally {
        if (saved === null) localStorage.removeItem(key); else localStorage.setItem(key, saved);
        stateTrend = before;
        drawStateTrend();
      }
    })()`));
    assert(r.noAt && r.paired && r.stale, JSON.stringify(r));
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
