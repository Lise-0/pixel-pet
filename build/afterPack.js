'use strict';

/**
 * electron-builder afterPack 钩子：裁剪 Electron 自带的语言包。
 * 默认会打包 50+ 个 locales/*.pak，这里只保留中英文，显著减小安装包体积。
 */
module.exports = async function afterPack(context) {
  const fs = require('fs');
  const path = require('path');

  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;

  const keep = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  let removed = 0;
  for (const name of fs.readdirSync(localesDir)) {
    if (name.endsWith('.pak') && !keep.has(name)) {
      try {
        fs.unlinkSync(path.join(localesDir, name));
        removed += 1;
      } catch (err) {
        console.warn('[afterPack] 删除语言包失败:', name, err.message);
      }
    }
  }
  console.log(`[afterPack] 已裁剪 ${removed} 个语言包，保留 ${[...keep].join(', ')}`);
};
