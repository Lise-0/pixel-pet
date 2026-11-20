'use strict';

const { clamp } = require('./utils');

/** 跟随松紧度默认值：0 = 贴身紧跟，100 = 松散慢随 */
const DEFAULT_LOOSENESS = 70;

/** 跟随轮询周期（毫秒）。原为 16ms / 60Hz，放慢到 30ms / 33Hz，动作更从容也少占 CPU */
const FOLLOW_TICK_MS = 30;

/**
 * 把「跟随松紧度」映射成主循环的运动参数。纯函数，便于单测与在运行中热调整。
 *
 * 松紧度越大：
 *   - keepDist 越大 → 与鼠标保持更远距离，不会糊在光标上
 *   - startGap 越大 → 鼠标小范围移动不理会，起身更迟钝
 *   - easeMin/Max 越小 → 每次只挪一点点，慢慢飘过来
 *
 * @param {number} value 0~100，非法值回落到默认档
 */
function followParams(value) {
  const n = value == null ? NaN : Number(value);
  const looseness = Number.isFinite(n) ? clamp(n, 0, 100) : DEFAULT_LOOSENESS;
  const t = looseness / 100;
  return {
    looseness,
    keepDist: 12 + t * 150,        // 与鼠标保持的距离：12 ~ 162 px
    startGap: 26 + t * 34,         // 超出保持距离多少才起身：26 ~ 60 px
    stopGap: 8 + t * 10,           // 差值小于多少就坐下：8 ~ 18 px
    easeMin: 0.055 - t * 0.040,    // 近距离缓动系数：0.055 ~ 0.015
    easeMax: 0.110 - t * 0.075,    // 远距离缓动系数：0.110 ~ 0.035
    // 单个 tick 的位移上限：鼠标瞬移或把滑杆从 100 猛拉到 0 时也不会“飞过去”
    maxStep: 20 - t * 14,          // 20 ~ 6 px / tick
    tickMs: FOLLOW_TICK_MS
  };
}

/**
 * 单步追逐量。dx/dy 是「猫锚点 → 光标」的向量。
 * 只追超出 keepDist 的那截，所以猫会收敛到距光标 keepDist 的圆环上，而不是贴住光标。
 * 抽成纯函数便于单测验证收敛行为，主循环只负责滞回状态与窗口定位。
 *
 * @returns {{dist:number, gap:number, t:number, step:number}}
 *   gap 为超出保持距离的量（滞回判定用），t 为速度档位 0~1，step 为本轮应移动的像素数
 */
function followStep(p, dx, dy) {
  const dist = Math.hypot(dx, dy);
  const gap = dist - p.keepDist;
  // 分母放宽到 startGap 的 4 倍：日常移动档位落在中低段，跑动步频也跟着放缓。
  const t = clamp(gap / (p.startGap * 4), 0, 1);
  const ease = p.easeMin + t * (p.easeMax - p.easeMin);
  const cap = Number.isFinite(p.maxStep) ? p.maxStep : Infinity;
  const step = Math.min(gap > 0 ? gap * ease : 0, cap);
  return { dist, gap, t, step };
}

/**
 * 滞回状态机：抽成纯函数，方便单测覆盖主循环里最容易出错的一段。
 *
 * canMove 由主循环用「假设本 tick 按 step 移动」后的实际位移给出（贴工作区边缘、
 * 或已收敛到不足 1px 时为 false）。把 canMove 纳入判定很关键：否则收敛到
 * gap 仍略大于 stopGap 时，running 永远不复位，猫会在待机/跑动间抽搐。
 *
 * @returns {{running:boolean, moving:boolean}}
 */
function followHysteresis(p, s, running, canMove) {
  const next = running
    ? (s.gap >= p.stopGap && canMove)
    : (s.gap > p.startGap && canMove);
  return { running: next, moving: next && canMove };
}

module.exports = { followParams, followStep, followHysteresis, DEFAULT_LOOSENESS, FOLLOW_TICK_MS };
