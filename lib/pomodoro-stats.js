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

/** 追加一条完成记录，返回新数组（不改原数组），超出上限时丢弃最旧的 */
function record(list, entry) {
  const src = Array.isArray(list) ? list : [];
  if (!isValidEntry(entry)) return src.slice();
  const next = src.filter(isValidEntry).slice(-(MAX_RECORDS - 1));
  next.push({ at: entry.at, minutes: entry.minutes, phase: entry.phase });
  return next;
}

/** 本地日期键 YYYY-MM-DD */
function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 汇总统计。days 天窗口按本地自然日，含今天。
 * 返回 { todayMinutes, todayCount, totalMinutes, totalCount, streak, days: [{key, minutes, count}] }
 */
function summarize(list, now = Date.now(), days = 7) {
  const src = Array.isArray(list) ? list.filter(isValidEntry) : [];
  const win = Math.max(1, Math.min(30, Number(days) || 7));
  const buckets = new Map();
  for (let i = win - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.set(localDateKey(d.getTime()), { key: localDateKey(d.getTime()), minutes: 0, count: 0 });
  }

  let totalMinutes = 0;
  let totalCount = 0;
  src.forEach((e) => {
    if (e.phase !== 'focus') return;
    totalMinutes += e.minutes;
    totalCount += 1;
    const b = buckets.get(localDateKey(e.at));
    if (b) { b.minutes += e.minutes; b.count += 1; }
  });

  const dayList = Array.from(buckets.values());
  const today = dayList[dayList.length - 1] || { minutes: 0, count: 0 };
  // 连续天数：从今天往前数，遇到第一个无专注记录的日子为止
  let streak = 0;
  for (let i = dayList.length - 1; i >= 0; i--) {
    if (dayList[i].count > 0) streak += 1; else break;
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

/** 限制存档体积：只保留最近 MAX_RECORDS 条有效记录 */
function trim(list) {
  return (Array.isArray(list) ? list : []).filter(isValidEntry).slice(-MAX_RECORDS);
}

module.exports = { MAX_RECORDS, record, summarize, trim, isValidEntry, localDateKey };
