'use strict';

const path = require('path');
const ctx = require('./context');
const { debugLog, clamp } = require('./utils');
const { followParams, followStep, followHysteresis, FOLLOW_TICK_MS } = require('./follow-params');
const { hoverHit } = require('./hover-hit');
const { RESYNC_MS, needsResync, needsFullReset } = require('./ignore-sync');

const WIN_W = 320;
const WIN_H = 360;

function attach() {
  // 鼠标穿透由主进程按全局光标位置主动判定。
  // 旧做法是渲染层收到 pointermove（forward 转发）后再发 IPC 解除穿透，
  // 往返的几毫秒里用户按下的 pointerdown 会被窗口吞掉，
  // 表现就是"点宠物没反应、也拖不动"，而 pointerup 却又到了页面。
  let hoverBox = null;      // 猫身在窗口内的矩形，CSS 像素，由渲染层同步
  let ignoreState = null;   // 当前 setIgnoreMouseEvents(false=可点) 的镜像
  let lastIgnoreApplyAt = 0; // 上一次真正下发穿透状态的时间（心跳自愈用）
  let hoverBoxMissingAt = 0; // 命中框丢失的起始时间，用于持续向渲染层索取
  let fullResetCount = 0;   // 诊断：心跳完整复位执行次数
  let hoverTimer = null;

  /**
   * 下发穿透状态。force=true 时无视镜像强制重发（心跳 / 状态重置后使用）。
   * 注意：窗口无效时直接返回且不更新镜像——否则「镜像说可点、真实窗口仍穿透」，
   * 之后轮询每次早退，失灵就再也无法自愈（历史上反复出现的鼠标失灵根因）。
   * ignore=false 时不要传 forward：forward 只在穿透态有意义，带着它恢复可点
   * 可能让 Chromium 继续保留命中过滤行为。
   */
  function applyIgnore(ignore, force = false, fullReset = false) {
    const win = ctx.petWindow;
    if (!win || win.isDestroyed()) return;
    if (!force && !fullReset && ignoreState === ignore) return;
    const want = !!ignore;
    ignoreState = want;
    lastIgnoreApplyAt = Date.now();
    try {
      // 心跳自愈：Electron/Windows 侧的窗口输入状态可能与镜像脱节（渲染进程重载、
      // show/hide、系统挂起恢复）。此时单纯重发 false 可能被内部早退吃掉——窗口在
      // OS 层面明明可点，却仍不派发 pointerdown。先显式回到穿透再恢复可点，强制走
      // 一次完整的内部状态转换；两步同步执行，不会留下可见的穿透窗口。
      if (fullReset && !want) {
        fullResetCount++;
        win.setIgnoreMouseEvents(true, { forward: true });
      }
      win.setIgnoreMouseEvents(want, want ? { forward: true } : undefined);
    } catch (err) {
      // 调用失败时清掉镜像，下一 tick 会强制重试而不是永远早退
      ignoreState = null;
      lastIgnoreApplyAt = 0;
      debugLog('setIgnoreMouseEvents failed ' + (err && err.message));
    }
  }

  function setHoverBox(box) {
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) ||
        !Number.isFinite(box.w) || !Number.isFinite(box.h)) return;
    // 渲染层在「当前动作没有可用帧」时会发 0 宽高的空框。忽略它：否则一次换肤或
    // 无帧瞬间就足以抹掉命中框，而渲染层的 2px 节流可能不再重发，窗口永久全穿透。
    if (box.w <= 0 || box.h <= 0) return;
    hoverBox = { x: box.x, y: box.y, w: box.w, h: box.h };
    hoverBoxMissingAt = 0;
  }

  /**
   * 渲染页面（重新）加载、窗口重新显示、渲染进程恢复之后：镜像与 hoverBox 都可能
   * 已经过期。把镜像置空让下一 tick 必定真正下发，并请渲染层重发命中矩形
   * （渲染层 syncHoverBox 有 2px 节流，不通知它就不会再发，主进程会永远判穿透）。
   */
  function resyncHoverState() {
    ignoreState = null;
    lastIgnoreApplyAt = 0;
    hoverBox = null;
    hoverBoxMissingAt = 0;
    if (ctx.sendToPet) ctx.sendToPet('pet:resync-hover');
  }

  function startHoverWatch() {
    if (hoverTimer) return;
    hoverTimer = setInterval(() => {
      const win = ctx.petWindow;
      if (!win || win.isDestroyed()) return;
      // 心跳：每隔 RESYNC_MS 无条件真正下发一次，纠正「镜像与真实窗口状态脱节」。
      // 这是鼠标失灵能自愈的关键，不能只在镜像值变化时才调用 setIgnoreMouseEvents。
      const force = needsResync(lastIgnoreApplyAt);
      if (!win.isVisible()) { applyIgnore(true, force); return; }
      // 命中框丢失时持续向渲染层索取。resync 的一次性 IPC 可能在渲染层监听器就绪前
      // 发出而丢失；只发一次就等于把恢复希望押在时序上，窗口会一直全穿透。
      if (!hoverBox || hoverBox.w <= 0 || hoverBox.h <= 0) {
        if (!hoverBoxMissingAt) hoverBoxMissingAt = Date.now();
        else if (Date.now() - hoverBoxMissingAt >= 200 && ctx.sendToPet) {
          ctx.sendToPet('pet:resync-hover');
          hoverBoxMissingAt = Date.now();
        }
      }
      const store = ctx.store && ctx.store.data;
      if (store && store.window && store.window.passthrough) { applyIgnore(true, force); return; }
      // 跟随/拖拽/散步期间窗口会持续移动，hoverBox 相对全局光标的位置每帧都在变，
      // 这里再按矩形判定会让穿透状态来回翻转，pointerdown 正好落在穿透的那一瞬被吞掉
      // （表现为"点了没反应、也拖不动"，而 pointerup 却到了）。三者统一锁定可点。
      // 心跳时做完整复位：这些状态通常长期不切换，最容易累积内部状态脱节。
      if (ctx.followActive || ctx.dragTimer || ctx.wanderTimer) {
        if (force) applyIgnore(false, true, needsFullReset(force, false));
        return;
      }

      let ignore = true;
      if (hoverBox) {
        try {
          const c = ctx.screen.getCursorScreenPoint();
          const b = win.getBounds();
          ignore = !hoverHit(c, b, hoverBox);
        } catch (err) { /* 取不到光标/窗口位置时保持穿透，宁可漏点也不吞桌面 */ }
      }
      // 心跳且目标为「可点」时做完整复位，纠正镜像与 Electron 内部状态脱节。
      applyIgnore(ignore, force, needsFullReset(force, ignore));
    }, 25);
  }

  /** 退出或窗口销毁时停掉轮询并清空镜像，避免定时器空转 / 陈旧命中框 */
  function stopHoverWatch() {
    if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
    ignoreState = null;
    lastIgnoreApplyAt = 0;
    hoverBox = null;
  }

  function clampToWorkArea(x, y, w, h) {
    const point = { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    const area = ctx.screen.getDisplayNearestPoint(point).workArea;
    // 极小工作区/超大窗口时上界会小于下界，clamp 会夹出屏幕；先保证上界不小于下界。
    const maxX = Math.max(area.x, area.x + area.width - w);
    const maxY = Math.max(area.y, area.y + area.height - h);
    return {
      x: Math.round(clamp(x, area.x, maxX)),
      y: Math.round(clamp(y, area.y, maxY))
    };
  }

  function targetPosition() {
    const win = ctx.store.data.window;
    const size = currentSize();
    if (typeof win.x === 'number' && typeof win.y === 'number') {
      return clampToWorkArea(win.x, win.y, size.w, size.h);
    }
    const area = ctx.screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - size.w - 24, y: area.y + area.height - size.h - 8 };
  }

  function currentSize() {
    const scale = clamp(Number(ctx.store.data.pet.scale) || 1, 0.5, 2);
    return { w: Math.round(WIN_W * scale), h: Math.round(WIN_H * scale) };
  }

  /** 锁定窗口尺寸：透明窗口的边缘很容易被误拖，缩放后画面会横向拉伸 */
  function lockWindowSize(w, h) {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    try {
      ctx.petWindow.setMinimumSize(w, h);
      ctx.petWindow.setMaximumSize(w, h);
    } catch (err) {
      debugLog('lockWindowSize failed ' + err.message);
    }
  }

  /** 缩放改动时保持底部中心锚点，避免宠物“跳走” */
  function applyScale() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const scale = clamp(Number(ctx.store.data.pet.scale) || 1, 0.5, 2);
    if (scale === ctx.lastScale) return;
    ctx.lastScale = scale;
    const size = currentSize();
    const b = ctx.petWindow.getBounds();
    const x = Math.round(b.x + b.width / 2 - size.w / 2);
    const y = Math.round(b.y + b.height - size.h);
    const pos = clampToWorkArea(x, y, size.w, size.h);
    // 先放开尺寸上限，否则 setBounds 会被旧的最大尺寸截断
    try {
      ctx.petWindow.setMaximumSize(10000, 10000);
      ctx.petWindow.setMinimumSize(1, 1);
    } catch (err) { /* 忽略 */ }
    ctx.petWindow.setBounds({ x: pos.x, y: pos.y, width: size.w, height: size.h });
    lockWindowSize(size.w, size.h);
  }

  function applySettings() {
    if (ctx.store.data.window.locked || ctx.store.data.system.roam === false) stopWander(true);
    if (ctx.store.data.window.locked && ctx.followActive) stopFollow(true);
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      const opacity = clamp(Number(ctx.store.data.pet.opacity) || 1, 0.3, 1);
      if (opacity !== ctx.lastOpacity) {
        ctx.lastOpacity = opacity;
        ctx.petWindow.setOpacity(opacity);
      }
      applyScale();
    }
    const autoStart = !!ctx.store.data.system.autoStart;
    if (autoStart !== ctx.lastAutoStart) {
      ctx.lastAutoStart = autoStart;
      ctx.applyAutoStart(autoStart);
    }
  }

  function createPetWindow() {
    const pos = targetPosition();
    const size = currentSize();
    ctx.lastScale = clamp(Number(ctx.store.data.pet.scale) || 1, 0.5, 2);

    ctx.petWindow = new ctx.BrowserWindow({
      width: size.w,
      height: size.h,
      minWidth: size.w,
      maxWidth: size.w,
      minHeight: size.h,
      maxHeight: size.h,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false,
      show: false,
      title: 'PixelPet',
      webPreferences: {
        preload: path.join(ctx.APP_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });

    ctx.petWindow.setAlwaysOnTop(true, 'screen-saver');
    applyIgnore(true);
    startHoverWatch();
    ctx.petWindow.loadFile(path.join(ctx.APP_DIR, 'src', 'pet.html'))
      .catch((err) => debugLog('pet loadFile failed ' + (err && err.message)));

    ctx.petWindow.once('ready-to-show', () => {
      debugLog('ready-to-show');
      applySettings();
      if (ctx.store.data.window.visible !== false) {
        ctx.petWindow.showInactive();
        // show/hide 会重建窗口的输入状态，镜像必须失效并让渲染层重发命中框
        resyncHoverState();
      }
    });

    ctx.petWindow.webContents.on('did-finish-load', () => {
      debugLog('renderer loaded');
      ctx.startMetrics();
      ctx.broadcastSettings();
      // 页面（重新）加载后旧的穿透镜像与命中矩形都不可信，强制重新同步
      resyncHoverState();
      if (ctx.DEBUG) {
        setTimeout(() => {
          ctx.petWindow.webContents.capturePage().then((image) => {
            const fs = require('fs');
            fs.writeFileSync(path.join(ctx.DATA_DIR, 'debug-snapshot.png'), image.toPNG());
            debugLog('snapshot saved');
          }).catch((err) => debugLog('snapshot failed ' + err.message));
        }, 2000);
      }
    });

    ctx.petWindow.webContents.on('render-process-gone', (event, details) => {
      debugLog('render-process-gone ' + JSON.stringify(details));
      // 渲染进程崩溃后窗口白屏，主进程轮询还拿着陈旧的 hoverBox / 穿透镜像判穿透：
      // 全部置空（不发 IPC，渲染进程已不在），重载完成后 did-finish-load 会完整重同步。
      ignoreState = null;
      lastIgnoreApplyAt = 0;
      hoverBox = null;
      const now = Date.now();
      if (ctx.lastRendererReloadAt && now - ctx.lastRendererReloadAt < 5000) return;
      ctx.lastRendererReloadAt = now;
      setTimeout(() => {
        try {
          if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.webContents.reload();
        } catch (err) { debugLog('renderer reload failed ' + err.message); }
      }, 400);
    });

    ctx.petWindow.webContents.on('console-message', (event, level, message) => {
      if (ctx.DEBUG) debugLog('console: ' + message);
    });

    ctx.petWindow.on('moved', schedulePositionSave);
    // 兜底：即使系统允许拖拽边缘，也立即恢复成目标尺寸，避免画面拉伸
    ctx.petWindow.on('will-resize', (event) => { event.preventDefault(); });
    ctx.petWindow.on('resize', () => {
      if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
      const size = currentSize();
      const [w, h] = ctx.petWindow.getSize();
      if (w !== size.w || h !== size.h) {
        debugLog(`resize intercepted ${w}x${h} -> ${size.w}x${size.h}`);
        ctx.petWindow.setSize(size.w, size.h, false);
        lockWindowSize(size.w, size.h);
      }
    });
    ctx.petWindow.on('closed', () => {
      debugLog('pet window closed');
      stopHoverWatch();
      // 托盘常驻：窗口销毁后 app 仍在跑，跟随/散步/拖拽的定时器必须一起停，
      // 状态也要复位，否则重建窗口后残留的 followActive 会让新窗口一直穿透、点不到。
      [ctx.followTimer, ctx.wanderTimer, ctx.dragTimer].forEach((t) => { if (t) clearInterval(t); });
      if (ctx.dragSafetyTimer) clearTimeout(ctx.dragSafetyTimer);
      ctx.followTimer = ctx.wanderTimer = ctx.dragTimer = ctx.dragSafetyTimer = null;
      ctx.followActive = false;
      ctx.dragInfo = null;
      broadcastFollowState(false);
      ctx.petWindow = null;
    });
  }

  function schedulePositionSave() {
    if (ctx.savePosTimer) clearTimeout(ctx.savePosTimer);
    ctx.savePosTimer = setTimeout(() => {
      if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
      const [x, y] = ctx.petWindow.getPosition();
      ctx.store.data.window.x = x;
      ctx.store.data.window.y = y;
      ctx.store.save(800);
    }, 600);
  }

  function toggleVisible() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const visible = ctx.store.data.window.visible !== false;
    if (visible) {
      stopWander(true);
      if (ctx.followActive) stopFollow(true);
      ctx.petWindow.hide();
      ctx.store.patch({ window: { visible: false } });
    } else {
      ctx.petWindow.showInactive();
      ctx.store.patch({ window: { visible: true } });
      resyncHoverState();
    }
  }

  function startDrag() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed() || ctx.store.data.window.locked) return;
    // 拖拽期间保持可点：轮询遇到 dragTimer 会跳过，这里主动锁定一次
    applyIgnore(false, true);
    stopWander(false);
    const cursor = ctx.screen.getCursorScreenPoint();
    const [wx, wy] = ctx.petWindow.getPosition();
    ctx.dragInfo = { cursor, origin: { x: wx, y: wy }, last: cursor, moved: false };
    if (ctx.dragSafetyTimer) clearTimeout(ctx.dragSafetyTimer);
    ctx.dragSafetyTimer = setTimeout(() => endDrag(), 30000);
    if (ctx.dragTimer) clearInterval(ctx.dragTimer);
    ctx.dragTimer = setInterval(() => {
      if (!ctx.dragInfo || !ctx.petWindow || ctx.petWindow.isDestroyed()) return;
      const p = ctx.screen.getCursorScreenPoint();
      if (p.x === ctx.dragInfo.last.x && p.y === ctx.dragInfo.last.y) return;
      ctx.dragInfo.last = p;
      ctx.dragInfo.moved = true;
      ctx.petWindow.setPosition(
        Math.round(ctx.dragInfo.origin.x + (p.x - ctx.dragInfo.cursor.x)),
        Math.round(ctx.dragInfo.origin.y + (p.y - ctx.dragInfo.cursor.y))
      );
    }, 16);
  }

  function endDrag() {
    if (ctx.dragTimer) {
      clearInterval(ctx.dragTimer);
      ctx.dragTimer = null;
    }
    if (ctx.dragSafetyTimer) {
      clearTimeout(ctx.dragSafetyTimer);
      ctx.dragSafetyTimer = null;
    }
    if (!ctx.dragInfo) return;
    const moved = ctx.dragInfo.moved;
    ctx.dragInfo = null;
    if (!moved || !ctx.petWindow || ctx.petWindow.isDestroyed()) return;

    const size = currentSize();
    const [x, y] = ctx.petWindow.getPosition();
    const pos = clampToWorkArea(x, y, size.w, size.h);
    ctx.petWindow.setPosition(pos.x, pos.y);
    ctx.store.data.window.x = pos.x;
    ctx.store.data.window.y = pos.y;
    ctx.store.save(600);
    ctx.sendToPet('pet:drag-ended');
  }

  function saveWindowPosition() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const [x, y] = ctx.petWindow.getPosition();
    ctx.store.data.window.x = x;
    ctx.store.data.window.y = y;
    ctx.store.save(600);
  }

  function stopWander(save = true) {
    if (ctx.wanderTimer) {
      clearInterval(ctx.wanderTimer);
      ctx.wanderTimer = null;
    }
    if (save) saveWindowPosition();
  }

  function startWander(dir, speed) {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    if (ctx.store.data.window.locked || ctx.store.data.system.roam === false) return;
    // 跟随期间窗口由 followTimer 独占：两个定时器同时 setPosition 会让猫原地抖动。
    // 渲染层也不知道主进程拒绝了散步，所以回推一次 ended 让它清掉 walk 表现。
    if (ctx.followActive) {
      if (ctx.sendToPet) ctx.sendToPet('pet:wander-ended', { blocked: true });
      return;
    }
    debugLog(`wander start dir=${dir} speed=${speed}`);
    stopWander(false);
    // 散步时窗口在动，全程保持可点；否则轮询会随窗口位移反复切穿透，吞掉按下事件。
    applyIgnore(false, true);
    ctx.wanderDir = Number(dir) >= 0 ? 1 : -1;
    ctx.wanderSpeed = clamp(Number(speed) || 55, 10, 200);
    ctx.wanderLast = Date.now();

    ctx.wanderTimer = setInterval(() => {
      if (!ctx.petWindow || ctx.petWindow.isDestroyed()) {
        stopWander(false);
        return;
      }
      const now = Date.now();
      const dt = Math.min(0.12, (now - ctx.wanderLast) / 1000);
      ctx.wanderLast = now;

      const size = currentSize();
      const [x, y] = ctx.petWindow.getPosition();
      const area = ctx.screen.getDisplayNearestPoint({
        x: x + Math.round(size.w / 2),
        y: y + Math.round(size.h / 2)
      }).workArea;
      const clampedY = Math.round(clamp(y, area.y, area.y + area.height - size.h));

      let nextX = x + ctx.wanderDir * ctx.wanderSpeed * dt;
      let hitEdge = false;
      if (nextX <= area.x) {
        nextX = area.x;
        hitEdge = true;
      }
      if (nextX + size.w >= area.x + area.width) {
        nextX = area.x + area.width - size.w;
        hitEdge = true;
      }

      ctx.petWindow.setPosition(Math.round(nextX), clampedY);

      if (hitEdge) {
        stopWander(true);
        ctx.sendToPet('pet:wander-ended', { edge: true });
      }
    }, 16);
  }

  function handleDisplaysChanged() {
    if (ctx.dragInfo) endDrag();
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const size = currentSize();
    const [x, y] = ctx.petWindow.getPosition();
    const pos = clampToWorkArea(x, y, size.w, size.h);
    ctx.petWindow.setPosition(pos.x, pos.y);
  }

  function resetWindowGeometry() {
    ctx.lastScale = null;
    ctx.lastOpacity = null;
    ctx.lastAutoStart = null;
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      const pos = targetPosition();
      ctx.petWindow.setBounds({ x: pos.x, y: pos.y, width: WIN_W, height: WIN_H });
    }
  }

  /**
   * 追随鼠标：由主进程轮询全局鼠标位置驱动。
   * 渲染进程在窗口穿透后收不到鼠标移动，所以这里必须自己取 screen 光标。
   *
   * 目标是「松散地伴行」而不是贴住光标：猫收敛到距鼠标 keepDist 的圆环上，
   * 鼠标小范围移动不理会，追的过程用很小的缓动系数慢慢飘过去。
   * 具体档位由设置里的「跟随松紧」映射，见 lib/follow-params.js。
   */
  function startFollow() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    // 位置已锁定时禁止启动跟随：否则主进程会移动窗口，而渲染层按 locked 拒绝进入跟随表现，
    // 变成“位置在动、动作不变”的撕裂状态。主进程是唯一状态源，守卫必须放在这里。
    if (ctx.store.data.window.locked) return;
    // 幂等：已经是跟随态就直接返回，避免重复 start 走 stopFollow 发出 ended，
    // 把渲染层刚置起的 following 打回 false（双状态撕裂、点击失灵的根因）。
    if (ctx.followActive) return;
    // 番茄钟进行中：专注陪伴动作优先，此时移动窗口只会让画面与位置撕裂。
    // 渲染层通过 pomodoro:status 上报的状态存在 ctx.lastPomodoro。
    if (ctx.lastPomodoro && ctx.lastPomodoro.running) {
      debugLog('follow blocked by pomodoro');
      if (ctx.sendToPet) ctx.sendToPet('pet:command', { type: 'say', text: '专注中，结束后再跟随～' });
      broadcastFollowState(false);
      return;
    }
    stopWander(false);
    if (ctx.dragTimer) endDrag();
    // 只清残留定时器，不调用 stopFollow（它会广播 follow:ended）
    if (ctx.followTimer) {
      clearInterval(ctx.followTimer);
      ctx.followTimer = null;
    }
    ctx.followActive = true;
    broadcastFollowState(true);
    debugLog('follow start');
    if (ctx.refreshTray) ctx.refreshTray();
    // 主进程是唯一状态源：进入跟随主动通知渲染层，渲染层据此进入跑动表现
    if (ctx.sendToPet) ctx.sendToPet('follow:started');

    // 跟随期间全程可点击：点一下猫就能停，轮询在 followActive 时不会翻转这个状态。
    applyIgnore(false, true);

    let running = false;     // 当前是否在奔跑（滞回状态，不直接等于 dist>阈值）
    let lastFaceDir = null;
    let lastMoving = null;
    let lastSpeedT = -1;     // 上次推送给渲染层的速度档位

    // 运动参数每个 tick 读一次：设置页拖动「跟随松紧」滑杆时无需重启跟随即可生效。

    // 开始跟随时立刻同步一次朝向：按鼠标相对猫的方位决定初始朝向，不再一律朝右。
    // 否则鼠标在左侧时，猫会以错误朝向起步，直到水平位移超过阈值才纠正。
    try {
      const c0 = ctx.screen.getCursorScreenPoint();
      const b0 = ctx.petWindow.getBounds();
      const dx0 = c0.x - (b0.x + Math.round(currentSize().w / 2));
      lastFaceDir = dx0 < -4 ? -1 : 1;
      ctx.sendToPet('follow:motion', { dir: lastFaceDir, moving: false });
    } catch (err) { /* 首帧取不到光标就保持默认朝右 */ }

    ctx.followTimer = setInterval(() => {
      // 主循环里任何一步抛错（光标 API、窗口已销毁、屏幕热拔插）都直接收尾，
      // 否则 30ms 定时器会每帧重复抛异常，把主进程日志刷爆。
      try {
        if (!ctx.followActive || !ctx.petWindow || ctx.petWindow.isDestroyed()) {
          stopFollow(false);
          return;
        }
        const cursor = ctx.screen.getCursorScreenPoint();
        const size = currentSize();
        const b = ctx.petWindow.getBounds();

        // 追逐锚点对准猫本体中心（画布 160x180、猫帧高 116、脚底在 y=176，
        // 猫身中心约在窗口高度的 65%）。
        const anchorX = b.x + Math.round(size.w / 2);
        const anchorY = b.y + Math.round(size.h * 0.65);
        const dx = cursor.x - anchorX;
        const dy = cursor.y - anchorY;

        const p = followParams(ctx.store.data.pet && ctx.store.data.pet.followLoose);
        const s = followStep(p, dx, dy);   // 只追超出 keepDist 的那截，收敛到圆环上

        // 用「假设本 tick 就按 step 移动」求目标位置，据此判断真的能挪动多少。
        // 不能拿 running 之后的 step 来算：running=false 时 step 恒为 0，会永远判成
        // canMove=false，滞回再也起不了身（死锁）。
        let pos = null;
        let canMove = false;
        // 已收敛到不足 1px 时不必查询显示器/工作区，静止状态省掉每 tick 的系统调用
        if (s.step >= 1) {
          const desiredX = b.x + (dx / s.dist) * s.step;
          const desiredY = b.y + (dy / s.dist) * s.step;
          pos = clampToWorkArea(desiredX, desiredY, size.w, size.h);
          // 被工作区边缘夹住时同样不再空跑，切回待机即可。
          canMove = Math.abs(pos.x - b.x) + Math.abs(pos.y - b.y) >= 1;
        }
        // 滞回把「能不能动」也纳入判定：否则 gap 卡在 stopGap 之上时 running 永不复位，
        // moving 随边界反复翻转，猫会在跑动/待机之间抽搐。
        const h = followHysteresis(p, s, running, canMove);
        running = h.running;
        const moving = h.moving;
        const t = s.t;   // 速度档位推给渲染层，让跑动帧率与位移同步

        // 朝向只在奔跑且水平位移明显时更新，避免左右抖动
        if (moving && Math.abs(dx) > 4) {
          const faceDir = dx > 0 ? 1 : -1;
          if (faceDir !== lastFaceDir) {
            lastFaceDir = faceDir;
            ctx.sendToPet('follow:motion', { dir: faceDir });
          }
        }
      if (moving !== lastMoving) {
        lastMoving = moving;
        // 停下时渲染层会把速度归位 0.5；重新起步必须立刻同步一次当前档位，
        // 否则 t 变化不足 0.12 时会一直沿用旧的默认速度。
        if (moving) lastSpeedT = -1;
        ctx.sendToPet('follow:motion', { moving });
      }

        if (moving) {
          if (t !== lastSpeedT && Math.abs(t - lastSpeedT) > 0.12) {
            lastSpeedT = t;
            ctx.sendToPet('follow:motion', { speed: t });
          }
          ctx.petWindow.setPosition(pos.x, pos.y);
        }
        // 不在这里切换穿透：跟随全程可点击，保证“点一下就停”稳定生效
      } catch (err) {
        debugLog('follow tick failed ' + (err && err.message));
        stopFollow(false);
      }
    }, FOLLOW_TICK_MS);
  }

  /** 把跟随状态推给主控台：按钮应显示"跟随中/停止跟随"，否则点下去像没反应 */
  function broadcastFollowState(active) {
    if (ctx.homeWindow && !ctx.homeWindow.isDestroyed()) {
      ctx.homeWindow.webContents.send('follow:state', { active: !!active });
    }
  }

  function stopFollow(save = true) {
    if (ctx.followTimer) {
      clearInterval(ctx.followTimer);
      ctx.followTimer = null;
    }
    if (!ctx.followActive) return;
    ctx.followActive = false;
    broadcastFollowState(false);
    if (save) saveWindowPosition();
    // 先切回穿透；轮询会在下一个 tick 按当前光标位置重新决定是否可点
    applyIgnore(true);
    // 恢复渲染层自己管理的穿透判定
    ctx.sendToPet('follow:ended');
    if (ctx.refreshTray) ctx.refreshTray();
    debugLog('follow stop save=' + save);
  }

  function toggleFollow() {
    if (ctx.followActive) stopFollow(true);
    else startFollow();
  }

  /** 只读诊断：把穿透判定的内部状态暴露出来，便于定位 pointerdown 被吞的原因。 */
  function debugHoverState() {
    let cursor = null;
    let bounds = null;
    let hit = null;
    let error = null;
    try {
      cursor = ctx.screen.getCursorScreenPoint();
      if (ctx.petWindow && !ctx.petWindow.isDestroyed()) bounds = ctx.petWindow.getBounds();
      hit = bounds ? hoverHit(cursor, bounds, hoverBox) : null;
    } catch (err) { error = err.message; }
    return {
      hoverBox,
      hoverBoxMissingMs: hoverBoxMissingAt ? Date.now() - hoverBoxMissingAt : null,
      fullResetCount,
      ignoreState,
      hoverTimer: !!hoverTimer,
      wanderTimer: !!ctx.wanderTimer,
      lastIgnoreApplyAt,
      ignoreAgeMs: lastIgnoreApplyAt ? Date.now() - lastIgnoreApplyAt : null,
      followActive: !!ctx.followActive,
      dragTimer: !!ctx.dragTimer,
      passthrough: !!(ctx.store && ctx.store.data && ctx.store.data.window &&
                      ctx.store.data.window.passthrough),
      visible: !!(ctx.petWindow && !ctx.petWindow.isDestroyed() && ctx.petWindow.isVisible()),
      cursor,
      bounds,
      hit,
      error
    };
  }

  // 只挂载真正会被其它模块经 ctx 调用的方法；其余函数在本文件内按名字直接用，
  // 不必挂到全局上下文（避免 ctx 里堆一堆无人读取的键）。
  Object.assign(ctx, {
    applySettings, createPetWindow, toggleVisible,
    startDrag, endDrag, stopWander, startWander,
    handleDisplaysChanged, resetWindowGeometry,
    stopFollow, toggleFollow, broadcastFollowState, setHoverBox,
    stopHoverWatch, resyncHoverState, debugHoverState,
    setIgnoreMouse: applyIgnore,
    desyncIgnoreForDebug: () => {
      // 仅供诊断/回归测试：让真实窗口状态与镜像脱节，验证心跳能否自愈。
      const win = ctx.petWindow;
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
      return !!win;
    }
  });
}

module.exports = { attach };
