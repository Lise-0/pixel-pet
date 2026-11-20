'use strict';

/** 纯逻辑单元测试：不需要 Electron，node tests/unit.js 即可运行 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Store, DEFAULT_SETTINGS, sanitizePatch } = require('../lib/store');
const { deepMerge, clamp } = require('../lib/utils');
const stats = require('../lib/pomodoro-stats');
const { readZip } = require('../lib/skin-import');
const skinImport = require('../lib/skin-import');
const config = require('../lib/config');
const fsMod = require('node:fs');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

console.log('\n[单测] 配置存档 store');

test('默认值深拷贝不被运行时修改污染', () => {
  const before = JSON.stringify(DEFAULT_SETTINGS.window);
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const merged = deepMerge(base, sanitizePatch({ pet: { skin: 'x' } }));
  merged.window.x = 999;
  assert.equal(DEFAULT_SETTINGS.window.x, null);
  assert.equal(before, JSON.stringify(DEFAULT_SETTINGS.window));
});

test('未知字段被白名单丢弃', () => {
  const clean = sanitizePatch({ pet: { skin: 'default', evil: 1 }, hacked: true });
  assert.equal(clean.pet.skin, 'default');
  assert.equal('evil' in clean.pet, false);
  assert.equal('hacked' in clean, false);
});

test('数值超出范围被夹回', () => {
  const clean = sanitizePatch({ pet: { scale: 99, volume: -5 }, state: { mood: 200 } });
  assert.equal(clean.pet.scale, 2);
  assert.equal(clean.pet.volume, 0);
  assert.equal(clean.state.mood, 100);
});

test('空数组模板字段保留存档值', () => {
  const clean = sanitizePatch({ unlock: { stories: ['a', 'b'] } });
  assert.deepEqual(clean.unlock.stories, ['a', 'b']);
});

test('番茄钟统计数组上限放宽到 500', () => {
  const arr = Array.from({ length: 600 }, (_, i) => ({ at: i + 1, minutes: 25, phase: 'focus' }));
  const clean = sanitizePatch({ pomodoro: { stats: arr } });
  assert.equal(clean.pomodoro.stats.length, 500);
});

test('通知开关布尔值正确读写', () => {
  assert.equal(sanitizePatch({ pomodoro: { notify: false } }).pomodoro.notify, false);
  assert.equal(sanitizePatch({ pomodoro: { notify: 'false' } }).pomodoro.notify, undefined);
});

test('Store 原子写入与备份回退', () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-test-'));
  const file = path.join(dir, 'nested', 'settings.json');
  const s = new Store(file);
  s.data.pet.skin = 'test-skin';
  s.flush();
  s.flush();   // 第二次 flush 才会生成 .bak（备份的是第一次的内容）
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pet.skin, 'test-skin');
  assert.ok(fs.existsSync(file + '.bak'), '备份文件应存在');
  // 破坏主文件后应回退到备份
  fs.writeFileSync(file, '{ broken json');
  const s2 = new Store(file);
  s2.load();
  assert.equal(s2.data.pet.skin, 'test-skin');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n[单测] 番茄钟统计 pomodoro-stats');

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const at = (dayOffset, hour = 10) => new Date(2026, 10, 20 - dayOffset, hour, 0, 0).getTime();

test('record 追加记录且不改原数组', () => {
  const src = [];
  const next = stats.record(src, { at: NOW, minutes: 25, phase: 'focus' });
  assert.equal(src.length, 0);
  assert.equal(next.length, 1);
  assert.equal(next[0].minutes, 25);
});

test('record 拒绝非法记录', () => {
  assert.equal(stats.record([], { at: 0, minutes: 25, phase: 'focus' }).length, 0);
  assert.equal(stats.record([], { at: NOW, minutes: -1, phase: 'focus' }).length, 0);
  assert.equal(stats.record([], { at: NOW, minutes: 25, phase: 'unknown' }).length, 0);
  assert.equal(stats.record([], null).length, 0);
});

test('record 超出上限丢弃最旧', () => {
  let list = [];
  for (let i = 0; i < stats.MAX_RECORDS + 10; i++) {
    list = stats.record(list, { at: NOW + i, minutes: 25, phase: 'focus' });
  }
  assert.equal(list.length, stats.MAX_RECORDS);
  assert.equal(list[0].at, NOW + 10);
});

test('summarize 正确统计今日与累计', () => {
  const list = [
    { at: at(0, 9), minutes: 25, phase: 'focus' },
    { at: at(0, 11), minutes: 25, phase: 'focus' },
    { at: at(1, 10), minutes: 30, phase: 'focus' },
    { at: at(0, 12), minutes: 5, phase: 'break' }
  ];
  const s = stats.summarize(list, NOW, 7);
  assert.equal(s.todayMinutes, 50);
  assert.equal(s.todayCount, 2);
  assert.equal(s.totalMinutes, 80);
  assert.equal(s.totalCount, 3);
  assert.equal(s.days.length, 7);
});

test('summarize 连续天数 streak 正确', () => {
  const list = [
    { at: at(0, 9), minutes: 25, phase: 'focus' },
    { at: at(1, 9), minutes: 25, phase: 'focus' },
    { at: at(3, 9), minutes: 25, phase: 'focus' }
  ];
  const s = stats.summarize(list, NOW, 7);
  assert.equal(s.streak, 2);   // 今天+昨天，前天断了
});

test('summarize 空数据不崩溃', () => {
  const s = stats.summarize(null, NOW, 7);
  assert.equal(s.todayMinutes, 0);
  assert.equal(s.streak, 0);
  assert.equal(s.days.length, 7);
});

test('summarize 只统计窗口内的天数', () => {
  const list = [{ at: at(10, 9), minutes: 25, phase: 'focus' }];
  const s = stats.summarize(list, NOW, 7);
  assert.equal(s.totalMinutes, 25);   // 累计仍算
  assert.equal(s.todayMinutes, 0);    // 但不在7天窗口内
});

console.log('\n[单测] 工具函数 utils');

test('clamp 边界正确', () => {
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(200, 0, 100), 100);
  assert.equal(clamp(50, 0, 100), 50);
});

test('deepMerge 保留未覆盖字段', () => {
  const base = { a: 1, b: { c: 2, d: 3 } };
  const out = deepMerge(base, { b: { c: 9 } });
  assert.equal(out.a, 1);
  assert.equal(out.b.c, 9);
  assert.equal(out.b.d, 3);
  assert.equal(base.b.c, 2);   // 不改原对象
});

console.log('\n[单测] 皮肤 ZIP 读取安全 skin-import');

/** 构造一个最小可用的单条目 zip（store / deflate），用于安全回归测试 */
function buildZip({ name, compressed, method = 8, claimedUncomp = compressed.length, flags = 0x800 }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);      // 本地文件头签名
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18); // 压缩大小
  local.writeUInt32LE(claimedUncomp, 22);     // 声明的解压大小（可被伪造）
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);    // 中央目录签名
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(claimedUncomp, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // EOCD 签名
  eocd.writeUInt16LE(1, 8);                // 本盘条目数
  eocd.writeUInt16LE(1, 10);               // 总条目数
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(local.length + nameBuf.length + compressed.length, 16);
  return Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
}

function withZipFile(buf, fn) {
  const file = path.join(os.tmpdir(), `pixelpet-zip-test-${process.pid}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, buf);
  try { return fn(file); } finally { fs.unlinkSync(file); }
}

test('正常 deflate 皮肤包可正确读取', () => {
  const raw = Buffer.from('hello pixelpet');
  const zip = buildZip({ name: 'a.txt', compressed: zlib.deflateRawSync(raw) });
  withZipFile(zip, (file) => {
    const entries = readZip(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'a.txt');
    assert.equal(entries[0].buffer.toString(), 'hello pixelpet');
  });
});

test('伪造极小 uncompSize 的解压炸弹被拦截', () => {
  // 极小压缩体可膨胀到 65MB（超过 60MB 预算），中央目录却只声明 100 字节。
  // 修复前会在真实长度校验前就 inflateRawSync 分配巨量内存；修复后由
  // maxOutputLength 在解压阶段封顶并抛出友好错误。
  const bomb = zlib.deflateRawSync(Buffer.alloc(65 * 1024 * 1024, 0));
  const zip = buildZip({ name: 'bomb.bin', compressed: bomb, claimedUncomp: 100 });
  withZipFile(zip, (file) => {
    assert.throws(() => readZip(file), /60MB/);
  });
});

test('zip slip 路径穿越条目被跳过', () => {
  const raw = Buffer.from('evil');
  const zip = buildZip({ name: '../evil.txt', compressed: zlib.deflateRawSync(raw) });
  withZipFile(zip, (file) => {
    assert.throws(() => readZip(file), /没有可用的文件/);
  });
});

console.log('\n[单测] 皮肤清单加载性能 config');

test('inspect 不读取未声明的任意文本配置文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-inspect-'));
  try {
    // 放一个伪装成配置的文件，内容含敏感标记
    fs.writeFileSync(path.join(dir, 'secrets.txt'), 'TOP_SECRET_SHOULD_NOT_LEAK');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"leak":"TOP_SECRET_SHOULD_NOT_LEAK"}');
    // 一张最小 PNG（1x1）让 inspect 有可用素材，避免整体抛错
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(dir, 'idle-1.png'), png);
    const info = skinImport.inspect([dir]);
    assert.equal(info.ok, true);
    const dump = JSON.stringify(info);
    assert.ok(!dump.includes('TOP_SECRET_SHOULD_NOT_LEAK'),
      'secrets.txt/config.json 的内容不应出现在 inspect 结果中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspect 支持 manifest.persona 指定的自定义台词文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-persona-'));
  try {
    fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({ name: '自定义台词', persona: 'dialog.txt' }));
    fs.writeFileSync(path.join(dir, 'dialog.txt'), '[idle]\n你好呀\n');
    fs.writeFileSync(path.join(dir, 'secrets.txt'), 'TOP_SECRET_SHOULD_NOT_LEAK');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(dir, 'idle-1.png'), png);
    const info = skinImport.inspect([dir]);
    assert.equal(info.personaText, '[idle]\n你好呀\n', '应读取 manifest 指定的 dialog.txt');
    assert.ok(!JSON.stringify(info).includes('TOP_SECRET_SHOULD_NOT_LEAK'),
      '未声明的 secrets.txt 仍不得外泄');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSkins 每款皮肤只读单张缩略图而非全部帧', () => {
  const skins = config.listSkins();
  assert.ok(skins.length >= 2, '应至少能列出内置皮肤');
  for (const s of skins) {
    assert.equal(typeof s.thumb, 'string');
    assert.ok(s.thumb.startsWith('data:image/png;base64,'), `${s.id} 应有缩略图`);
    assert.equal(s.frames, undefined, '清单不应携带全部帧数据');
  }
  // 统计 readFileSync 读取 .png 的次数：旧实现会解码每款皮肤的全部帧（17+ 张），
  // 新实现每款只读一张缩略图，因此总次数不应超过皮肤数量。
  const realRead = fsMod.readFileSync;
  let pngReads = 0;
  fsMod.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && /\.png$/i.test(file)) pngReads += 1;
    return realRead.call(this, file, ...args);
  };
  try {
    config.listSkins();
  } finally {
    fsMod.readFileSync = realRead;
  }
  // 允许每款皮肤一次命中 + 极少量兜底重读
  assert.ok(pngReads <= skins.length + 2,
    `PNG 读取次数 ${pngReads} 明显超过皮肤数 ${skins.length}，疑似回归为全帧解码`);
});

test('listSkins 与 readSkin 缩略图一致', () => {
  const meta = config.listSkins().find((s) => s.id === 'default');
  const pack = config.readSkin('default');
  assert.ok(meta && pack);
  assert.equal(meta.thumb, pack.thumb, '同一皮肤的清单缩略图应与完整包一致');
});

test('无 thumb/idle-1.png 时清单与完整包仍选中同一张兜底帧', () => {
  // 构造一个既无 manifest.thumb 也无 idle-1.png 的皮肤：
  // 两个入口的兜底都必须取“按文件名排序的第一张 PNG”，否则缩略图会不一致。
  const ctx = require('../lib/context');
  const oldDataDir = ctx.DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-thumb-'));
  const userRoot = path.join(tmp, 'skins');
  const skinDir = path.join(userRoot, 'fallback-test');
  try {
    fs.mkdirSync(skinDir, { recursive: true });
    fs.writeFileSync(path.join(skinDir, 'skin.json'), JSON.stringify({ name: '兜底测试', frames: {} }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    // 故意按 b → a 的倒序创建两张不同内容的 PNG，验证兜底取的是“排序第一张 a”
    fs.writeFileSync(path.join(skinDir, 'b-1.png'), png);
    fs.writeFileSync(path.join(skinDir, 'a-1.png'), Buffer.concat([png, Buffer.from('AAAA')]));
    ctx.DATA_DIR = tmp;
    const meta = config.listSkins().find((s) => s.id === 'fallback-test');
    const pack = config.readSkin('fallback-test');
    assert.ok(meta && pack, '临时皮肤应被扫描到');
    assert.equal(meta.thumb, pack.thumb, '兜底缩略图两入口应一致（均取排序第一张）');
    assert.ok(meta.thumb.startsWith('data:image/png;base64,'), '兜底缩略图应是有效 PNG');
    assert.equal(meta.frameCount, pack.frameCount, '两入口 frameCount 口径应一致');
  } finally {
    ctx.DATA_DIR = oldDataDir;
    config.invalidate();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n[单测结果] 通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.error('失败项:\n  ' + failures.join('\n  '));
  process.exit(1);
}
