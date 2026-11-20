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

  /**
   * 只在第一皮肤上成立的断言，以前用 `if (r.skin === 'default')` 包住整段，
   * 当前皮肤是导入皮肤时会显示 ✓ 却零验证。改为临时切过去跑完再无条件恢复，
   * 断言始终真实执行，也不改动用户的存档设置。
   */
  async function withSkin(id, fn) {
    const before = await pet.ev('currentSkin');
    try {
      await pet.ev(`(async function(){ await loadSkin(${JSON.stringify(id)}); })()`);
      return await fn();
    } finally {
      await pet.ev(`(async function(){ await loadSkin(${JSON.stringify(before)}); })()`);
    }
  }

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
        border: getComputedStyle(document.getElementById('petHint')).borderTopWidth,
        lines: (persona.follow || []).concat(['跟随中 · 移动鼠标我会慢慢跟上'])
      })`));
      await pet.ev(`api.followStop()`);
      await new Promise((r) => setTimeout(r, 350));
      const off = JSON.parse(await pet.ev(`JSON.stringify({
        following, hint: document.getElementById('petHint').textContent,
        lines: (persona.followStop || []).concat(['已停止跟随'])
      })`));
      // 轻提示文案现在来自皮肤 [follow] / [followStop] 分组（没配才用内置默认），
      // 断言写死旧文案会在换皮肤后误报。
      assert(on.following && on.shown && on.hint && on.lines.indexOf(on.hint) >= 0 && on.border === '0px',
        JSON.stringify(on));
      assert(!off.following && off.hint && off.lines.indexOf(off.hint) >= 0, JSON.stringify(off));
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
  await check('双击宠物触发舔手动作，不误触发跟随', async () => {
    // 用真实 pointer 事件模拟两次快速点击：第一下挂起、第二下应判为双击 → lick。
    const r = JSON.parse(await pet.ev(`(async function(){
      const oldOv = overrideExpr, oldFol = following, oldBub = bubbleEl.textContent;
      const h = (function(){ let f=null; for(let y=0;y<CH;y+=4) for(let x=0;x<CW;x+=4) if(overPet(x,y)){f=[x,y];break} return f; })();
      if (!h) return JSON.stringify({ error: 'no hit point' });
      try {
        overrideExpr = null;
        api.followStop();
        following = false;
        for (let i=0;i<2;i++) {
          canvas.dispatchEvent(new PointerEvent('pointerdown', {button:0, clientX:h[0], clientY:h[1], pointerId:1, bubbles:true}));
          document.dispatchEvent(new PointerEvent('pointerup', {button:0, clientX:h[0], clientY:h[1], pointerId:1, bubbles:true}));
        }
        await new Promise(function(res){ setTimeout(res, 120); });
        return JSON.stringify({
          expr: resolveExpr(),
          override: overrideExpr && overrideExpr.name,
          following: following,
          bubble: bubbleEl.textContent,
          hasLick: !!(skinPack && skinPack.actions && skinPack.actions.lick),
          skin: currentSkin,
          lickFrames: (skinPack && skinPack.actions && skinPack.actions.lick && skinPack.actions.lick.frames) || [],
          lickCapable: hasLickAction(),
          resolvedLickAction: resolveAction('lick'),
          lickDisplayFrames: availableFrames('lick')
        });
      } finally {
        try { canvas.releasePointerCapture(1); } catch(e){}
        overrideExpr = oldOv; following = oldFol; bubbleEl.textContent = oldBub;
        api.followStop();
      }
    })()`));
    assert(!r.error, JSON.stringify(r));
    assert(r.following === false, '双击不应触发跟随: ' + JSON.stringify(r));
    assert(r.bubble && r.bubble.length > 0, '双击应有气泡反馈: ' + JSON.stringify(r));
    if (r.lickCapable) {
      assert(r.expr === 'lick' && r.override === 'lick', JSON.stringify(r));
    } else {
      // 没做舔爪动作的皮肤（如导入的奶龙）：双击仍要有反馈，但既不能假装播 lick，
      // 也不能冒出「抬起爪子舔了舔」这种写死的兜底台词。
      assert(r.expr !== 'lick' && r.override !== 'lick',
        '没有舔爪动作的皮肤双击不应假装播舔爪: ' + JSON.stringify(r));
      assert(!/舔|爪/.test(r.bubble),
        '没有舔爪动作的皮肤双击不应说舔爪台词: ' + JSON.stringify(r));
    }
    // 默认皮肤的舔爪帧必须是 sleep-2.png（前爪贴嘴），不能退回站立图 wave-1.png
    if (r.skin === 'default') {
      assert(r.lickFrames.indexOf('sleep-2.png') >= 0,
        '默认皮肤 lick 帧应为 sleep-2.png: ' + JSON.stringify(r));
      assert(r.resolvedLickAction === 'lick' && r.lickDisplayFrames.indexOf('sleep-2.png') >= 0,
        '双击应真正播放 sleep-2.png 舔爪帧: ' + JSON.stringify(r));
    }
  });
  await check('双击反馈与皮肤的舔爪能力一致（动作、台词都不串味）', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const oldOv = overrideExpr, oldBub = bubbleEl.textContent;
      const oldMood = mood, oldAff = affection;
      try {
        const lines = [];
        for (let i = 0; i < 8; i++) {
          overrideExpr = null;
          doLick();
          lines.push({ line: bubbleEl.textContent, override: overrideExpr && overrideExpr.name, expr: resolveExpr() });
        }
        return JSON.stringify({ skin: currentSkin, capable: hasLickAction(), lines: lines });
      } finally {
        overrideExpr = oldOv; bubbleEl.textContent = oldBub; mood = oldMood; affection = oldAff;
      }
    })()`));
    assert(r.skin && r.lines && r.lines.length === 8, JSON.stringify(r));
    if (r.capable) {
      assert(r.lines.every((x) => x.override === 'lick' && x.line),
        '有舔爪动作的皮肤双击应播 lick 并有台词: ' + JSON.stringify(r));
    } else {
      assert(r.lines.every((x) => x.override !== 'lick' && x.expr !== 'lick'),
        '没有舔爪动作的皮肤双击不应切到 lick 动作: ' + JSON.stringify(r));
      assert(r.lines.every((x) => x.line && !/舔|爪/.test(x.line)),
        '没有舔爪动作的皮肤双击台词不应提到舔爪: ' + JSON.stringify(r));
    }
  });
  await check('triggers 事件映射生效：cpu / longpress / sit 可重映射到皮肤动作', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const t = skinPack.triggers || (skinPack.triggers = {});
      const saved = { cpu: t.cpu, longpress: t.longpress, sit: t.sit };
      const oldOv = overrideExpr, oldPom = pomodoro, oldFol = following, oldDrag = dragging;
      const oldCd = Object.assign({}, reactionCooldown);
      try {
        const target = Object.keys(actionConfig)[0];
        t.cpu = target; t.longpress = target; t.sit = target;
        pomodoro = null; overrideExpr = null; following = false; dragging = false;
        ['cpu','longpress','sit'].forEach(function(k){ delete reactionCooldown[k]; });
        react('cpu', 'hot', '', 0);
        const cpu = overrideExpr && overrideExpr.name;
        overrideExpr = null;
        react('longpress', 'happy', '', 0);
        const longpress = overrideExpr && overrideExpr.name;
        overrideExpr = null;
        react('sit', 'wave', '', 0);
        const sit = overrideExpr && overrideExpr.name;
        return JSON.stringify({ target: target, cpu: cpu, longpress: longpress, sit: sit,
          mapped: resolveEvent('cpu','hot'), fallback: resolveEvent('unknown-event','idle') });
      } finally {
        Object.keys(saved).forEach(function(k){ if (saved[k] === undefined) delete t[k]; else t[k] = saved[k]; });
        overrideExpr = oldOv; pomodoro = oldPom; following = oldFol; dragging = oldDrag;
        Object.keys(reactionCooldown).forEach(function(k){ delete reactionCooldown[k]; });
        Object.assign(reactionCooldown, oldCd);
      }
    })()`));
    assert(r.target && r.cpu === r.target && r.longpress === r.target && r.sit === r.target,
      '事件应映射到 triggers 指定的动作: ' + JSON.stringify(r));
    assert(r.mapped === r.target && !!r.fallback,
      'resolveEvent 应同时支持映射与兜底: ' + JSON.stringify(r));
  });
  await check('换肤无空窗：连续切换后帧与动作表仍属同一代', async () => {
    const r = JSON.parse(await pet.ev(`(async function(){
      const before = currentSkin;
      try {
        await loadSkin('smoky');
        await loadSkin('default');
        const pack = await api.readSkin(currentSkin);
        const names = Object.keys(frames);
        const declared = Object.keys(pack.frames || {});
        return JSON.stringify({
          skin: currentSkin, frameCount: names.length, declared: declared.length,
          allDeclared: names.every(function(n){ return declared.indexOf(n) >= 0; }),
          hasIdle: !!frames['idle-1.png'], actions: Object.keys(actionConfig).length,
          drawable: availableFrames('idle').length
        });
      } finally { await loadSkin(before); }
    })()`));
    assert(r.skin === 'default' && r.allDeclared && r.frameCount === r.declared,
      '连续换肤后帧表不应混入上一代: ' + JSON.stringify(r));
    assert(r.hasIdle && r.drawable > 0 && r.actions > 0,
      '换肤后应能立刻画出新皮肤: ' + JSON.stringify(r));
  });
  await check('番茄钟专注动作不被跟随 / 长按 / 双击顶掉', () => withSkin('default', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const oldPom = pomodoro, oldFol = following, oldMov = followMoving, oldOv = overrideExpr;
      try {
        pomodoro = { phase:'focus', endAt: Date.now()+60000, minutes:1,
          action: resolveEvent('focus','read') };
        following = true; followMoving = true;
        overrideExpr = { name:'happy', until: Date.now()+5000 };
        const duringFollow = resolveExpr();
        overrideExpr = { name:'lick', until: Date.now()+2000 };
        const duringLick = resolveExpr();
        pomodoro = null; overrideExpr = null;
        const afterStop = resolveExpr();
        return JSON.stringify({ action: resolveEvent('focus','read'), duringFollow: duringFollow,
          duringLick: duringLick, afterStop: afterStop });
      } finally {
        pomodoro = oldPom; following = oldFol; followMoving = oldMov; overrideExpr = oldOv;
      }
    })()`));
    assert(r.duringFollow === r.action && r.duringFollow !== 'run',
      '专注中跟随与长按不应盖过陪伴动作: ' + JSON.stringify(r));
    assert(r.duringLick === 'lick', '主动双击仍应短暂可见: ' + JSON.stringify(r));
    assert(r.afterStop === 'run', '结束后应交还跟随表现: ' + JSON.stringify(r));
  }));
  await check('第二次按下期间，挂起的单击不会误开跟随', async () => {
    const r = JSON.parse(await pet.ev(`(async function(){
      const oldDown = down, oldFol = following, oldOv = overrideExpr;
      try {
        cancelPendingClick();
        api.followStop();
        await new Promise(function(res){ setTimeout(res, 120); });
        const before = await api.debugHoverState();
        following = false; overrideExpr = null; down = null;
        handleClick();
        const pending = !!pendingClickTimer;
        down = { x: 10, y: 10, sx: 100, sy: 100, long: false };
        await new Promise(function(res){ setTimeout(res, DOUBLE_CLICK_MS + 150); });
        const after = await api.debugHoverState();
        return JSON.stringify({ pending: pending, consumed: !pendingClickTimer,
          before: before.followActive, after: after.followActive, following: following });
      } finally {
        cancelPendingClick(); down = oldDown; following = oldFol; overrideExpr = oldOv;
        api.followStop();
      }
    })()`));
    assert(r.pending === true && r.consumed === true, '挂起计时器应正常消费: ' + JSON.stringify(r));
    assert(r.before === false && r.after === false && r.following === false,
      '第二次按住期间不应触发跟随: ' + JSON.stringify(r));
  });
  await check('锁定期间点击触发 angry 动作与皮肤台词', () => withSkin('default', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const oldLocked = locked, oldOv = overrideExpr;
      const hint = document.getElementById('petHint');
      const oldHint = hint.textContent;
      try {
        locked = true; overrideExpr = null;
        handleClick();
        return JSON.stringify({ expr: overrideExpr && overrideExpr.name,
          hasAction: !!actionConfig.angry, hint: hint.textContent,
          angryLines: (persona.angry||[]).length });
      } finally {
        locked = oldLocked; overrideExpr = oldOv; hint.textContent = oldHint;
      }
    })()`));
    assert(r.hasAction && r.expr === 'angry', '锁定点击应播放 angry 动作: ' + JSON.stringify(r));
    assert(r.angryLines > 0 && r.hint && r.hint.length > 0,
      '应使用皮肤 [angry] 分组台词: ' + JSON.stringify(r));
  }));
  await check('专注进行中，主进程拒绝启动跟随', async () => {
    const r = JSON.parse(await pet.ev(`(async function(){
      api.followStop();
      await new Promise(function(res){ setTimeout(res, 120); });
      api.reportPomodoro({ running: true, phase: 'focus', remain: 60000 });
      await new Promise(function(res){ setTimeout(res, 80); });
      api.followToggle();
      await new Promise(function(res){ setTimeout(res, 250); });
      const during = await api.debugHoverState();
      api.reportPomodoro({ running: false, phase: 'idle', remain: 0 });
      api.followStop();
      hideBubble();
      await new Promise(function(res){ setTimeout(res, 100); });
      return JSON.stringify({ followActive: during.followActive });
    })()`));
    assert(r.followActive === false, '专注中不应进入跟随态: ' + JSON.stringify(r));
  });
  await check('单击（超时未双击）仍然切换跟随', async () => {
    const r = JSON.parse(await pet.ev(`(async function(){
      const oldOv = overrideExpr, oldFol = following;
      const h = (function(){ let f=null; for(let y=0;y<CH;y+=4) for(let x=0;x<CW;x+=4) if(overPet(x,y)){f=[x,y];break} return f; })();
      if (!h) return JSON.stringify({ error: 'no hit point' });
      let toggled = 0;
      const origToggle = api.followToggle;
      try {
        overrideExpr = null;
        api.followStop();
        following = false;
        // 用真实 pointer 事件走 handleClick 的延迟判定：等待 > 双击窗口再断言调用次数。
        // api.followToggle 不可写，改从主进程回推的 following 观察不可靠；这里直接读挂起计时器。
        canvas.dispatchEvent(new PointerEvent('pointerdown', {button:0, clientX:h[0], clientY:h[1], pointerId:2, bubbles:true}));
        document.dispatchEvent(new PointerEvent('pointerup', {button:0, clientX:h[0], clientY:h[1], pointerId:2, bubbles:true}));
        const pending =!!pendingClickTimer;
        await new Promise(function(res){ setTimeout(res, DOUBLE_CLICK_MS + 120); });
        return JSON.stringify({ pending, expr: resolveExpr(), timerCleared: !pendingClickTimer });
      } finally {
        try { canvas.releasePointerCapture(2); } catch(e){}
        overrideExpr = oldOv; following = oldFol; api.followStop(); api.followStop();
      }
    })()`));
    assert(!r.error, JSON.stringify(r));
    assert(r.pending === true, '单击应先挂起等待双击窗口: ' + JSON.stringify(r));
    assert(r.timerCleared === true, '超时后挂起单击应被消费: ' + JSON.stringify(r));
    assert(r.expr !== 'lick', '单击不应触发舔手: ' + JSON.stringify(r));
  });
  await check('拖动朝向跟随鼠标水平方向（左拖朝左，右拖朝右）', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const oldFacing=facing, oldDrag=dragging, oldLast=lastDragScreenX;
      const oldOv=overrideExpr, oldMoved=moved;
      const dragAct = actionConfig[resolveAction('drag')] || {};
      // 导入皮肤可能压根没做 drag 动作（回退到 idle 帧），此时只验证朝向逻辑，
      // 镜像配置由单测对内置皮肤检查。
      const hasDrag = !!actionConfig.drag;
      try {
        dragging = true;
        moved = true;
        lastDragScreenX = 100;
        // 鼠标向左移动 → 朝左
        document.dispatchEvent(new PointerEvent('pointermove', {screenX:60, clientX:40, clientY:40, bubbles:true}));
        const left = facing;
        // 鼠标向右移动 → 朝右（跨过上次位置）
        lastDragScreenX = 60;
        document.dispatchEvent(new PointerEvent('pointermove', {screenX:120, clientX:40, clientY:40, bubbles:true}));
        const right = facing;
        return JSON.stringify({ left, right, mirror: !!dragAct.mirror, hasDrag: hasDrag, frames: dragAct.frames || [] });
      } finally {
        facing=oldFacing; dragging=oldDrag; lastDragScreenX=oldLast;
        overrideExpr=oldOv; moved=oldMoved;
      }
    })()`));
    assert(r.left === -1, '左移应朝左(-1): ' + JSON.stringify(r));
    assert(r.right === 1, '右移应朝右(1): ' + JSON.stringify(r));
    if (r.hasDrag) {
      assert(r.mirror === true, '定义了 drag 动作的皮肤需开启镜像才能左右朝向: ' + JSON.stringify(r));
    }
  });
  await check('默认皮肤待机散步为坐立+舔爪交替，不再是 happy 侧身', () => withSkin('default', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const skin = currentSkin;
      const walk = (skinPack && skinPack.actions && skinPack.actions.walk) || {};
      const resolved = actionConfig[resolveAction('walk')] || {};
      return JSON.stringify({
        skin: skin,
        frames: walk.frames || [],
        mirror: !!walk.mirror,
        drift: walk.drift,
        displayFrames: availableFrames('walk'),
        resolvedMirror: !!resolved.mirror
      });
    })()`));
    if (r.skin === 'default') {
      assert(r.frames.indexOf('idle-2.png') >= 0 && r.frames.indexOf('sleep-2.png') >= 0,
        '待机散步帧应为 idle-2(坐立)+sleep-2(舔爪): ' + JSON.stringify(r));
      assert(r.frames.every(function(f){ return f.indexOf('happy') < 0; }),
        '待机散步不应再用 happy 侧身帧: ' + JSON.stringify(r));
      assert(r.mirror === false && r.resolvedMirror === false,
        '正面待机帧不应再镜像翻转: ' + JSON.stringify(r));
      assert(r.displayFrames.indexOf('sleep-2.png') >= 0,
        '待机散步应能真正显示舔爪帧: ' + JSON.stringify(r));
      assert(r.drift === false,
        '坐立+舔爪是原地动作，不应带着窗口横移: ' + JSON.stringify(r));
    }
  }));
  await check('默认皮肤待机散步原地播放，窗口不再被横向拖走', () => withSkin('default', async () => {
    // 真实调一次 startWalk() 并采样窗口位置：CDP 注入事件无法验证主进程位移，
    // 只有读 window.screenX 的实际变化才能确认没有 wander 定时器在拖窗口。
    const r = JSON.parse(await pet.ev(`(async function(){
      const skin = currentSkin;
      const walk = (skinPack && skinPack.actions && skinPack.actions.walk) || {};
      const oldLi = lastInteraction, oldOv = overrideExpr, oldRt = roamTimer, oldFacing = facing;
      const x0 = window.screenX;
      try {
        lastInteraction = Date.now() - 20000;
        overrideExpr = null;
        if (roamTimer) { clearTimeout(roamTimer); roamTimer = null; }
        startWalk();
        await new Promise(function(res){ setTimeout(res, 900); });
        // 后台窗口的 rAF 会被节流，lastDraw 可能还是上一个动作的残留帧；
        // 手动重画一帧再读实际画面，才能验证 walk 真的画的是坐立/舔爪。
        draw(resolveExpr(), performance.now());
        return JSON.stringify({
          skin: skin, drift: walk.drift, dx: window.screenX - x0,
          expr: resolveExpr(), frame: lastDraw && lastDraw.name,
          frames: availableFrames('walk')
        });
      } finally {
        stopWalk(false);
        lastInteraction = oldLi; overrideExpr = oldOv; roamTimer = oldRt; facing = oldFacing;
      }
    })()`));
    if (r.skin === 'default') {
      assert(r.drift === false, '第一个皮肤应关闭散步横移: ' + JSON.stringify(r));
      assert(Math.abs(r.dx) <= 2, '原地散步期间窗口不应横向移动: ' + JSON.stringify(r));
      assert(r.expr === 'walk', '原地散步仍应播放 walk 动作: ' + JSON.stringify(r));
      assert(r.frames.indexOf('idle-2.png') >= 0 && r.frames.indexOf('sleep-2.png') >= 0 &&
             r.frames.every(function(f){ return f.indexOf('happy') < 0; }),
        '原地散步帧应为坐立+舔爪，不含 happy 侧身: ' + JSON.stringify(r));
      assert(r.frame === 'idle-2.png' || r.frame === 'sleep-2.png',
        '原地散步应真正画出坐立或舔爪帧: ' + JSON.stringify(r));
    }
  }));
  await check('第一个皮肤待机/打盹不再冒出侧身帧', () => withSkin('default', async () => {
    const r = JSON.parse(await pet.ev(`(function(){
      const isSide = function(f){ return /^happy-/.test(f) || f === 'sleep-1.png'; };
      const keys = ['idle','walk','sleep','hover','wave','hot','read','lick'];
      const bad = {};
      keys.forEach(function(k){
        const fs = availableFrames(k);
        if (fs.some(isSide)) bad[k] = fs;
      });
      const sleepFrames = (skinPack.actions.sleep || {}).frames || [];
      // 真实重画一帧打盹，确认渲染链路拿到的也是正面帧
      const oldExpr = lastExpr, oldSince = exprSince, oldDraw = lastDraw;
      let drawn = null;
      try {
        lastExpr = '';
        draw('sleep', performance.now());
        drawn = lastDraw && lastDraw.name;
      } finally {
        lastExpr = oldExpr; exprSince = oldSince; lastDraw = oldDraw;
      }
      return JSON.stringify({ skin: currentSkin, bad: bad, sleepFrames: sleepFrames, drawn: drawn });
    })()`));
    if (r.skin === 'default') {
      assert(Object.keys(r.bad).length === 0,
        '待机类动作不应含 happy 侧身帧或 sleep-1: ' + JSON.stringify(r));
      assert(r.sleepFrames.indexOf('idle-2.png') >= 0 && r.sleepFrames.indexOf('sleep-2.png') >= 0,
        '打盹应为坐立+舔爪两帧: ' + JSON.stringify(r));
      assert(r.drawn === 'idle-2.png' || r.drawn === 'sleep-2.png',
        '打盹实际应画出正面帧: ' + JSON.stringify(r));
    }
  }));
  await check('散步期间窗口锁定可点，穿透不再随窗口位移抖动', async () => {
    // 回归「第二/三皮肤鼠标失灵」：散步时窗口持续横移，若轮询仍按 hoverBox 判穿透，
    // 状态会来回翻转，pointerdown 落在穿透瞬间被吞（pointerup 却到了）。
    const r = JSON.parse(await pet.ev(`(async function(){
      api.followStop();
      await new Promise(function(res){ setTimeout(res,150); });
      const before = await api.debugHoverState();
      api.wanderStart(1, 50);
      await new Promise(function(res){ setTimeout(res,150); });
      const during = await api.debugHoverState();
      api.wanderStop();
      await new Promise(function(res){ setTimeout(res,100); });
      return JSON.stringify({
        beforeFollow: before.followActive,
        beforeIgnore: before.ignoreState,
        duringFollow: during.followActive,
        duringIgnore: during.ignoreState,
        hoverTimer: during.hoverTimer
      });
    })()`));
    assert(r.beforeFollow === false && r.duringFollow === false,
      '测试前后都不应处于跟随状态: ' + JSON.stringify(r));
    assert(r.hoverTimer === true, '光标轮询应仍在运行: ' + JSON.stringify(r));
    assert(r.duringIgnore === false,
      '散步期间必须锁定可点，否则 pointerdown 会被穿透吞掉: ' + JSON.stringify(r));
  });
  await check('穿透状态心跳持续重发，镜像脱节可自愈', async () => {
    // 回归「第一/第三皮肤点击又失灵」：旧版 applyIgnore 只在镜像值变化时调用
    // setIgnoreMouseEvents，一旦真实窗口状态与镜像脱节就永远早退，mousedown
    // 被系统吞掉、只有 mouseup 转发，重启应用才能恢复。
    const r = JSON.parse(await pet.ev(`(async function(){
      const wait = ms => new Promise(res => setTimeout(res, ms));
      const a = await api.debugHoverState();
      await wait(1200);
      const b = await api.debugHoverState();
      const desync = await api.debugDesyncIgnore();   // 不改镜像，只把真实窗口设成穿透
      await wait(1300);
      const c = await api.debugHoverState();
      return JSON.stringify({
        hasHeartbeat: typeof a.lastIgnoreApplyAt === 'number' && a.lastIgnoreApplyAt > 0,
        wander: typeof a.wanderTimer === 'boolean',
        advancedBy: b.lastIgnoreApplyAt - a.lastIgnoreApplyAt,
        ageB: b.ignoreAgeMs,
        desynced: desync && desync.desynced,
        healedAt: c.lastIgnoreApplyAt - b.lastIgnoreApplyAt,
        healedAge: c.ignoreAgeMs,
        healedState: c.ignoreState
      });
    })()`));
    assert(r.hasHeartbeat && r.wander && r.desynced === true,
      '诊断字段与脱节注入应可用: ' + JSON.stringify(r));
    assert(r.advancedBy > 0 && r.ageB < 1200,
      '心跳应每秒无条件真正下发一次穿透状态: ' + JSON.stringify(r));
    assert(r.healedAt > 0 && r.healedAge !== null && r.healedAge < 1200,
      '脱节后应在 1 秒内强制重发纠正: ' + JSON.stringify(r));
    assert(r.healedState !== null,
      '自愈后镜像不应停留在失效状态: ' + JSON.stringify(r));
  });
  await check('换肤/无帧瞬间的空命中框不会让窗口永久穿透', async () => {
    // 回归「第二/三皮肤鼠标失灵」：draw() 在动作无可用帧时会把 hoverBox 置空并
    // 发 0 宽高矩形；旧实现直接覆盖主进程命中框，配合渲染层 2px 节流可能不再重发。
    const r = JSON.parse(await pet.ev(`(async function(){
      const before = await api.debugHoverState();
      api.setHoverBox({ x: 0, y: 0, w: 0, h: 0 });
      const after = await api.debugHoverState();
      return JSON.stringify({ before: before.hoverBox, after: after.hoverBox });
    })()`));
    assert(r.before && r.before.w > 0 && r.before.h > 0,
      '测试前应有有效命中框: ' + JSON.stringify(r));
    assert(r.after && r.after.w === r.before.w && r.after.h === r.before.h,
      '空框不得覆盖有效命中框: ' + JSON.stringify(r));
  });
  await check('主进程命中框丢失后自动补发，心跳做完整状态复位', async () => {
    // 页面重载、窗口 show/hide、渲染进程恢复都会清空主进程命中框；resync 的一次性
    // IPC 可能在渲染层监听器就绪前发出而丢失。现在主进程持续索取 + 渲染层每秒心跳，
    // 无论时序如何都必须收敛；心跳还要完成穿透→可点的完整内部状态转换。
    const r = JSON.parse(await pet.ev(`(async function(){
      const wait = ms => new Promise(res => setTimeout(res, ms));
      const a = await api.debugHoverState();
      await api.debugClearHoverBox();
      await wait(1400);
      const b = await api.debugHoverState();
      return JSON.stringify({
        cleared: a.hoverBox,
        healed: b.hoverBox,
        missingMs: b.hoverBoxMissingMs,
        resetCount: b.fullResetCount
      });
    })()`));
    assert(r.healed && r.healed.w > 0 && r.healed.h > 0,
      '命中框清空后应在 1.4 秒内自动恢复: ' + JSON.stringify(r));
    assert(r.missingMs === null,
      '恢复后不应仍在持续索取命中框: ' + JSON.stringify(r));
    assert(typeof r.resetCount === 'number',
      '应暴露心跳完整复位计数供诊断: ' + JSON.stringify(r));
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
