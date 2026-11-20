'use strict';

/**
 * 判断全局光标（屏幕坐标）是否落在猫身矩形内。
 * 矩形是渲染层同步的窗口内 CSS 坐标；pad 给边缘留余量，
 * 宁可贴着猫边多几像素可点，也不要把鼠标漏成穿透到桌面。
 */
function hoverHit(cursor, bounds, box, pad = 4) {
  if (!cursor || !bounds || !box) return false;
  if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return false;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) ||
      !Number.isFinite(box.w) || !Number.isFinite(box.h)) return false;
  const margin = Number.isFinite(pad) ? pad : 4;
  const lx = cursor.x - bounds.x;
  const ly = cursor.y - bounds.y;
  return lx >= box.x - margin && lx <= box.x + box.w + margin &&
         ly >= box.y - margin && ly <= box.y + box.h + margin;
}

module.exports = { hoverHit };
