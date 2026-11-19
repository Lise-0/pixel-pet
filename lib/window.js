'use strict';

const path = require('path');
const ctx = require('./context');
const { debugLog, clamp } = require('./utils');
const { DEFAULT_SETTINGS } = require('./store');

const WIN_W = 320;
const WIN_H = 360;

function attach() {
  function clampToWorkArea(x, y, w, h) {
    const point = { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    const area = ctx.screen.getDisplayNearestPoint(point).workArea;
    return {
      x: Math.round(clamp(x, area.x, area.x + area.width - w)),
      y: Math.round(clamp(y, area.y, area.y + area.height - h))
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
    ctx.petWindow.setIgnoreMouseEvents(true, { forward: true });
    ctx.petWindow.loadFile(path.join(ctx.APP_DIR, 'src', 'pet.html'));

    ctx.petWindow.once('ready-to-show', () => {
      debugLog('ready-to-show');
      applySettings();
      if (ctx.store.data.window.visible !== false) ctx.petWindow.showInactive();
    });

    ctx.petWindow.webContents.on('did-finish-load', () => {
      debugLog('renderer loaded');
      ctx.startMetrics();
      ctx.broadcastSettings();
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
    ctx.petWindow.on('closed', () => { debugLog('pet window closed'); ctx.petWindow = null; });
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
    }
  }

  function startDrag() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed() || ctx.store.data.window.locked) return;
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
    debugLog(`wander start dir=${dir} speed=${speed}`);
    stopWander(false);
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

  /** 宽松命中：只要鼠标落在窗口矩形内就认为可点击（跟随状态下用于恢复点击能力） */
  function cursorInsidePet(cursor) {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed() || !cursor) return false;
    const b = ctx.petWindow.getBounds();
    return cursor.x >= b.x && cursor.x <= b.x + b.width &&
           cursor.y >= b.y && cursor.y <= b.y + b.height;
  }

  let followIgnore = null;
  function setFollowMouseState(inside) {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    const wantIgnore = !(inside && !ctx.store.data.window.passthrough);
    if (wantIgnore !== followIgnore) {
      followIgnore = wantIgnore;
      ctx.petWindow.setIgnoreMouseEvents(wantIgnore, { forward: true });
    }
  }

  /**
   * 追随鼠标：由主进程轮询全局鼠标位置驱动。
   * 渲染进程在窗口穿透后收不到鼠标移动，所以这里必须自己取 screen 光标。
   * 用 lerp 缓动接近目标，形成"小猫跑过来"的温和跟随感。
   */
  function startFollow() {
    if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
    // 位置已锁定时禁止启动跟随：否则主进程会移动窗口，而渲染层按 locked 拒绝进入跟随表现，
    // 变成“位置在动、动作不变”的撕裂状态。主进程是唯一状态源，守卫必须放在这里。
    if (ctx.store.data.window.locked) return;
    // 幂等：已经是跟随态就直接返回，避免重复 start 走 stopFollow 发出 ended，
    // 把渲染层刚置起的 following 打回 false（双状态撕裂、点击失灵的根因）。
    if (ctx.followActive) return;
    stopWander(false);
    if (ctx.dragTimer) endDrag();
    // 只清残留定时器，不调用 stopFollow（它会广播 follow:ended）
    if (ctx.followTimer) {
      clearInterval(ctx.followTimer);
      ctx.followTimer = null;
    }
    ctx.followActive = true;
    followIgnore = null;
    debugLog('follow start');
    if (ctx.refreshTray) ctx.refreshTray();
    // 主进程是唯一状态源：进入跟随主动通知渲染层，渲染层据此进入跑动表现
    if (ctx.sendToPet) ctx.sendToPet('follow:started');

    // 跟随期间窗口全程保持“可点击”，不再逐帧按鼠标是否落进窗口矩形来切换穿透。
    // 猫在移动时鼠标常在窗口边缘反复进出，逐帧切换会让穿透状态横跳，点击常常落空。
    // 停止跟随时（stopFollow）再统一恢复穿透。
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      ctx.petWindow.setIgnoreMouseEvents(false, { forward: true });
    }

    const START_DIST = 26;   // 鼠标离猫超过它，才起身去追
    const STOP_DIST = 10;    // 靠近到它之内，就坐下；配合 START_DIST 形成滞回，避免反复站起坐下
    let running = false;     // 当前是否在奔跑（滞回状态，不直接等于 dist>阈值）
    let lastFaceDir = null;
    let lastMoving = null;
    let lastSpeedT = -1;     // 上次推送给渲染层的速度档位

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
      if (!ctx.followActive || !ctx.petWindow || ctx.petWindow.isDestroyed()) {
        stopFollow(false);
        return;
      }
      const cursor = ctx.screen.getCursorScreenPoint();
      const size = currentSize();
      const b = ctx.petWindow.getBounds();

      // 追逐锚点对准猫本体中心（画布 160x180、猫帧高 116、脚底在 y=176，
      // 猫身中心约在窗口高度的 65%）。停下时鼠标落在猫肚子上，点击稳定命中。
      const anchorX = b.x + Math.round(size.w / 2);
      const anchorY = b.y + Math.round(size.h * 0.65);
      const dx = cursor.x - anchorX;
      const dy = cursor.y - anchorY;
      const dist = Math.hypot(dx, dy);

      // 滞回：dist 落在 STOP_DIST~START_DIST 之间时维持原状态，
      // 不再因在单一阈值附近来回穿越而导致猫反复“站起—坐下”。
      if (!running && dist > START_DIST) running = true;
      else if (running && dist < STOP_DIST) running = false;
      const moving = running;

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
        ctx.sendToPet('follow:motion', { moving });
      }

      if (moving) {
        // 距离自适应：离得远追得快些，靠近后放慢，呈现"小跑追上来再慢慢停下"。
        // 速度档位一并推给渲染层，让跑动帧率与位移同步，避免"迈步很急但几乎没动"。
        const t = Math.min(1, Math.max(0, (dist - STOP_DIST) / (START_DIST * 3)));
        const ease = 0.035 + t * 0.075;          // 0.035~0.11，越远越快
        if (t !== lastSpeedT && Math.abs(t - lastSpeedT) > 0.12) {
          lastSpeedT = t;
          ctx.sendToPet('follow:motion', { speed: t });
        }
        const targetX = b.x + dx * ease;
        const targetY = b.y + dy * ease;
        const pos = clampToWorkArea(targetX, targetY, size.w, size.h);
        ctx.petWindow.setPosition(pos.x, pos.y);
      }
      // 不在这里切换穿透：跟随全程可点击，保证“点一下就停”稳定生效
    }, 16);
  }

  function stopFollow(save = true) {
    if (ctx.followTimer) {
      clearInterval(ctx.followTimer);
      ctx.followTimer = null;
    }
    if (!ctx.followActive) return;
    ctx.followActive = false;
    followIgnore = null;
    if (save) saveWindowPosition();
    // 交还穿透控制权：取消跟随态可能残留的“矩形内可点”设置，
    // 恢复默认穿透，随后渲染层按像素命中重新判定。
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
      ctx.petWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    // 恢复渲染层自己管理的穿透判定
    ctx.sendToPet('follow:ended');
    if (ctx.refreshTray) ctx.refreshTray();
    debugLog('follow stop save=' + save);
  }

  function toggleFollow() {
    if (ctx.followActive) stopFollow(true);
    else startFollow();
  }

  Object.assign(ctx, {
    clampToWorkArea, targetPosition, currentSize, lockWindowSize, applyScale,
    applySettings, createPetWindow, schedulePositionSave, toggleVisible,
    startDrag, endDrag, saveWindowPosition, stopWander, startWander,
    handleDisplaysChanged, resetWindowGeometry,
    startFollow, stopFollow, toggleFollow, cursorInsidePet
  });
}

module.exports = { attach, WIN_W, WIN_H, DEFAULT_SETTINGS };
