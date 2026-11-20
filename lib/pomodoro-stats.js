'use strict';

/**
 * 番茄钟统计：纯函数，不依赖 Electron，便于单元测试。
 * 记录结构 { at: 毫秒时间戳, minutes: 分钟数, phase: 'focus' | 'break' }
 * 只统计专注（focus）；休息记录保留但不计入专注时长。
 */

const MAX_RECORDS = 500;

function isValidEntry(entry) {
  return entry && Number.isFinite(entry.at) && entry.at > 0 &&
         Number.isFinite(entry.minutes) && entry.minutes > 0 && entry.minutes <= 1440 &&
         (entry.phase === 'focus' || entry.phase === 'break');
}

/** 追加一条专注完成记录，返回新数组（不改原数组），超出上限时丢弃最旧的。
 *  休息完成只弹通知、不入明细：它不参与任何统计，不该占掉 500 条专注配额。 */
function record(list, entry) {
  const src = Array.isArray(list) ? list : [];
  if (!isValidEntry(entry) || entry.phase !== 'focus') return src.slice();
  const next = src.filter((e) => isValidEntry(e) && e.phase === 'focus').slice(-(MAX_RECORDS - 1));
  next.push({ at: entry.at, minutes: entry.minutes, phase: 'focus' });
  return next;
}

/** 本地日期键 YYYY-MM-DD */
function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 汇总统计。days 天窗口按本地自然日，含今天。
 * lifetime 是独立维护的累计计数 { focusMinutes, focusCount }：明细最多留 500 条，
 * 累计不能因此停止增长甚至倒退。旧存档没有该字段时回退按明细累加。
 * 返回 { todayMinutes, todayCount, totalMinutes, totalCount, streak, days: [...] }
 */
function summarize(list, now = Date.now(), days = 7, lifetime = null) {
  const src = Array.isArray(list) ? list.filter(isValidEntry) : [];
  const win = Math.max(1, Math.min(30, Number(days) || 7));
  const buckets = new Map();
  for (let i = win - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.set(localDateKey(d.getTime()), { key: localDateKey(d.getTime()), minutes: 0, count: 0 });
  }

  let listedMinutes = 0;
  let listedCount = 0;
  const focusDays = new Set();
  src.forEach((e) => {
    if (e.phase !== 'focus') return;
    listedMinutes += e.minutes;
    listedCount += 1;
    const key = localDateKey(e.at);
    focusDays.add(key);
    const b = buckets.get(key);
    if (b) { b.minutes += e.minutes; b.count += 1; }
  });

  const life = lifetime && typeof lifetime === 'object' ? lifetime : {};
  const lifeMinutes = Number.isFinite(life.focusMinutes) && life.focusMinutes > 0 ? life.focusMinutes : 0;
  const lifeCount = Number.isFinite(life.focusCount) && life.focusCount > 0 ? life.focusCount : 0;
  const totalMinutes = Math.max(listedMinutes, lifeMinutes);
  const totalCount = Math.max(listedCount, lifeCount);

  const dayList = Array.from(buckets.values());
  const today = dayList[dayList.length - 1] || { minutes: 0, count: 0 };
  // 连续天数按全部历史记录算，不受图表窗口天数限制；今天还没开始专注就从昨天起算，
  // 否则中午之前打开主页会看到"坚持 0 天"。
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if (!focusDays.has(localDateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (focusDays.has(localDateKey(cursor.getTime()))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    todayMinutes: today.minutes,
    todayCount: today.count,
    totalMinutes,
    totalCount,
    streak,
    days: dayList
  };
}

module.exports = { MAX_RECORDS, record, summarize };
