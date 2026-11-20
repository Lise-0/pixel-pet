'use strict';

/**
 * electron-builder afterPack 钩子：把用不到的 Electron 语言包移出 app 目录。
 *
 * 这里刻意用「移动」而不是「删除」：electron-builder 在 NSIS 收尾时还要删除若干
 * 中间文件，而部分受限环境（沙箱 / 删除保护）对单个构建回合内的删除次数有上限。
 * 逐个 unlink 50+ 个 .pak 会耗尽配额，导致收尾清理被拦截、构建命令报错退出，
 * 即使安装包本体已经生成完毕。移动不产生删除，裁剪体积的同时不影响收尾。
 *
 * 移出的文件放在 dist/_unused-locales（同盘、属构建产物、不会进入安装包），
 * 可随 dist 一起清理；文件名冲突时加时间戳后缀，避免连续构建失败。
 */
module.exports = async function afterPack(context) {
  const fs = require('fs');
  const path = require('path');

  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;

  const keep = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  const spareDir = path.join(context.appOutDir, '..', '_unused-locales');
  let moved = 0;
  let spareReady = false;

  for (const name of fs.readdirSync(localesDir)) {
    if (!name.endsWith('.pak') || keep.has(name)) continue;
    try {
      if (!spareReady) {
        fs.mkdirSync(spareDir, { recursive: true });
        spareReady = true;
      }
      let target = path.join(spareDir, name);
      if (fs.existsSync(target)) {
        target = path.join(spareDir, `${Date.now()}-${moved}-${name}`);
      }
      fs.renameSync(path.join(localesDir, name), target);
      moved += 1;
    } catch (err) {
      console.warn('[afterPack] 移出语言包失败:', name, err.message);
    }
  }
  console.log(`[afterPack] 已移出 ${moved} 个语言包，保留 ${[...keep].join(', ')}`);
};
