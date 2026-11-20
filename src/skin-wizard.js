'use strict';

/**
 * 皮肤导入向导（主控台页内视图，不弹出新窗口）
 *
 * 1 选素材  → 2 拆帧/去背/统一画布 → 3 动作与台词 → 4 确认导入
 * 最终写出一个完全独立的皮肤文件夹：skin.json + persona.txt + 自己的 PNG 帧。
 */
(() => {
  const api = window.pet;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const ACTION_DEFS = [
    { key: 'idle',  label: '待机',   fps: 2, loop: true },
    { key: 'hover', label: '悬停',   fps: 2, loop: true },
    { key: 'click', label: '点击',   fps: 6, loop: false },
    { key: 'drag',  label: '拖动',   fps: 3, loop: true },
    { key: 'happy', label: '开心',   fps: 5, loop: true },
    { key: 'angry', label: '生气',   fps: 2, loop: true },
    { key: 'sleep', label: '睡觉',   fps: 1, loop: true },
    { key: 'walk',  label: '走路',   fps: 5, loop: true, mirror: true },
    { key: 'run',   label: '小跑',   fps: 7, loop: true, mirror: true, bob: 2 },
    { key: 'hot',   label: '发热',   fps: 2, loop: true },
    { key: 'wave',  label: '招手',   fps: 4, loop: true },
    { key: 'read',  label: '陪伴',   fps: 2, loop: true }
  ];

  const PERSONA_DEFAULT = `# 专属台词：[分组名] 对应动作/事件名，每行一条，# 开头为注释
# 这个文件只属于这款皮肤，其它皮肤不会读取它

[idle]
你好呀，我在这儿。
今天也一起加油吧。

[click]
嗯？被你发现啦。

[drag]
放我下来～

[follow]
等等我，小跑跟上！

[followStop]
到啦，先歇会儿。

[happy]
好开心！

[sleep]
晚安……

[longpress]
别闹，好痒。

[pomodoro]
时间到啦！
`;

  const DEFAULT_BEHAVIOR = {
    fatiguePerTickDay: 0.035, fatiguePerTickNight: 0.07, fatigueDragAdd: 3,
    moodDecayPerTick: 0.017, moodSleepyThreshold: 85, idleSleepAfter: 90
  };
  const DEFAULT_EFFECTS = { sleepZ: '#a9c2d6', hotDrop: '#93d9f5', angryMark: '#e2685f' };

  const S = {
    mounted: false,
    step: 1,
    source: null,
    kind: 'sheet',
    skipStep2: false,
    rawImages: [],
    frames: [],
    rows: [],
    autoFrameCount: -1,
    manifest: null,
    userDir: '',
    idEdited: false,
    busy: false,
    raf: 0,
    previewImgs: [],
    result: null,
    edit: null,         // 编辑态：{ originalId, builtin }；普通导入为 null
    debounce: 0         // 拆帧参数防抖定时器，关闭向导时清理
  };

  const TEMPLATE = `
<div class="wz-head">
  <button class="wz-close" id="wzClose" type="button">← 返回换肤页</button>
  <div class="wz-heading"><b id="wzTitle">皮肤导入向导</b><span id="wzSub">把图片变成一只有自己动作和台词的小伙伴</span></div>
  <ol class="wz-steps" id="wzSteps">
    <li data-step="1"><i>1</i><span>选择素材</span></li>
    <li data-step="2"><i>2</i><span>拆帧处理</span></li>
    <li data-step="3"><i>3</i><span>动作台词</span></li>
    <li data-step="4"><i>4</i><span>确认导入</span></li>
  </ol>
</div>

<div class="wz-body">
  <div class="wz-error" id="wzError" hidden></div>

  <!-- Step 1 -->
  <section class="wz-step" data-step="1">
    <div class="wz-drop" id="wzDrop">
      <div class="wz-drop-ico">📥</div>
      <div><b>把图片、文件夹或 .zip 拖到这里</b><span>支持精灵图、多张序列帧、已有皮肤包</span></div>
    </div>
    <div class="wz-section-title">或者直接选择一种素材</div>
    <div class="wz-sources">
      <button class="wz-source" type="button" data-pick="sheet"><b>🖼️</b><strong>一张精灵图</strong><small>大图里排着很多格，自动切成帧</small></button>
      <button class="wz-source" type="button" data-pick="frames"><b>🎞️</b><strong>多张序列帧</strong><small>每张图就是一帧，按顺序编号</small></button>
      <button class="wz-source" type="button" data-pick="folder"><b>📁</b><strong>整个文件夹</strong><small>装帧图的文件夹，或含 skin.json 的皮肤包</small></button>
      <button class="wz-source" type="button" data-pick="zip"><b>🗜️</b><strong>zip 压缩包</strong><small>别人分享的皮肤包，直接导入</small></button>
    </div>
    <div class="wz-source-info" id="wzSourceInfo" hidden></div>
    <div class="wz-guide">
      <div class="wz-guide-head"><b>素材要求与建议</b><span>照着准备，一次就能做出背景干净、动作自然的皮肤</span></div>
      <div class="wz-guide-grid">
        <div class="wz-guide-item">
          <i>1</i>
          <div><b>格式与排布</b><p>精灵图：一张大图按行列排满格子（内置两款是 4 列 × 8 行 = 32 格），从左到右、从上到下编号。序列帧：每张一帧，文件名带序号会按顺序读取。文件夹和 zip 也可以直接导入。</p></div>
        </div>
        <div class="wz-guide-item">
          <i>2</i>
          <div><b>背景要真透明（最易踩坑）</b><p>最好本身就是透明 PNG。白底／纯色底的图（像奶龙，看着透明其实是白底）在第 2 步务必勾上「去掉纯色背景」，用取色器点一下背景色、容差 28 左右，否则桌宠周围会留一圈白框。</p></div>
        </div>
        <div class="wz-guide-item">
          <i>3</i>
          <div><b>尺寸与对齐</b><p>每格／每张尺寸一致，角色居中、贴底，头顶留点空白别顶到边。向导会统一到 160×180 画布并贴底对齐；原图排太满会裁到头顶。</p></div>
        </div>
        <div class="wz-guide-item">
          <i>4</i>
          <div><b>姿势覆盖要全（跑动的关键）</b><p>跑得自然靠「侧面朝向 + 迈步连续帧（4~6 张）」。只有正面静态姿势（奶龙那样）只能原地蹦。建议至少备齐：待机、开心、挥手、迈步／跑、睡觉、生气，每个动作 2~4 帧。</p></div>
        </div>
      </div>
      <div class="wz-guide-ref"><b>参考已做的三款：</b><span>紫团子 / 灰炭炭 = 精灵图 4×8、透明底、12 个动作；奶龙 = 12 张序列帧、白底需去背、正面姿势跑动受限。</span></div>
    </div>
    <div class="wz-note">导入的皮肤会放在「我的皮肤」目录，和内置皮肤分开保存；每款皮肤都是独立文件夹，动作、台词、参数互不干扰。</div>
  </section>

  <!-- Step 2 -->
  <section class="wz-step" data-step="2" hidden>
    <div class="wz-cols">
      <div class="wz-col">
        <div class="wz-card">
          <h3>① 拆分网格</h3>
          <div class="wz-fields" id="wzGridFields">
            <label>列 <input id="wzCols" type="number" min="1" max="16" value="4" /></label>
            <label>行 <input id="wzRows" type="number" min="1" max="16" value="4" /></label>
          </div>
          <p class="wz-muted">从左到右、从上到下编号；只有一张大图时才需要网格。</p>
          <div class="wz-sheet-box"><canvas id="wzSheetCanvas"></canvas></div>
        </div>
        <div class="wz-card">
          <h3>② 画面处理</h3>
          <label class="wz-check"><input id="wzRemoveBg" type="checkbox" checked /> 去掉纯色背景</label>
          <div class="wz-fields">
            <label>背景色 <input id="wzBgColor" type="color" value="#ffffff" /></label>
            <button class="btn ghost small" id="wzPickColor" type="button">取左上角颜色</button>
            <label>容差 <input id="wzTolerance" type="range" min="0" max="120" value="28" /><b id="wzTolVal">28</b></label>
          </div>
          <label class="wz-check"><input id="wzTrim" type="checkbox" checked /> 自动裁掉透明边</label>
          <div class="wz-fields">
            <label>帧宽 <input id="wzFrameW" type="number" min="32" max="512" value="160" /></label>
            <label>帧高 <input id="wzFrameH" type="number" min="32" max="512" value="180" /></label>
            <label>缩放 <select id="wzFit"><option value="contain">等比贴底</option><option value="stretch">拉满画布</option><option value="none">保持原尺寸</option></select></label>
          </div>
          <p class="wz-muted">帧会水平居中、贴住地面线，和桌宠绘制方式一致。</p>
        </div>
      </div>
      <div class="wz-col">
        <div class="wz-card wz-frames-card">
          <h3>拆分结果 <small id="wzFrameCount">0 帧</small></h3>
          <div class="wz-frame-grid" id="wzFrameGrid"></div>
          <p class="wz-muted">编号用于下一步分配动作，鼠标悬停可看大图。</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 3 -->
  <section class="wz-step" data-step="3" hidden>
    <div class="wz-cols">
      <div class="wz-col">
        <div class="wz-card">
          <h3>基本信息</h3>
          <div class="wz-form">
            <label>皮肤 ID <input id="wzId" type="text" maxlength="32" placeholder="my-pet" /><small>文件夹名，小写字母 / 数字 / - / _</small></label>
            <label>名字 <input id="wzName" type="text" maxlength="40" placeholder="我的小伙伴" /></label>
            <label>一句话介绍 <input id="wzDesc" type="text" maxlength="120" placeholder="写一句属于它的介绍" /></label>
            <label>作者 <input id="wzAuthor" type="text" maxlength="40" value="我" /></label>
          </div>
          <div class="wz-fields wz-colors">
            <label>主色 <input id="wzAccent" type="color" value="#e2a87c" /></label>
            <label>深色 <input id="wzAccentDeep" type="color" value="#c07b45" /></label>
            <label>浅色 <input id="wzAccentSoft" type="color" value="#fbe6d1" /></label>
          </div>
        </div>
        <div class="wz-card">
          <h3>专属台词 <small>只属于这一款皮肤</small></h3>
          <textarea id="wzPersona" spellcheck="false"></textarea>
          <p class="wz-muted">用 <code>[分组名]</code> 对应动作或事件名，一行一句；可以随意增删分组，也可以加自己动作的分组。</p>
        </div>
      </div>
      <div class="wz-col">
        <div class="wz-card">
          <h3>动作分配 <button class="btn ghost small" id="wzAutoActions" type="button">一键自动分配</button></h3>
          <div class="wz-frame-strip" id="wzFrameStrip"></div>
          <p class="wz-auto-hint" id="wzAutoHint" hidden></p>
          <div class="wz-actions" id="wzActionRows"></div>
          <div class="wz-add-action">
            <input id="wzNewAction" type="text" maxlength="32" placeholder="自定义动作名，例如 dance" />
            <button class="btn ghost small" id="wzAddAction" type="button">+ 添加</button>
          </div>
          <p class="wz-muted">点亮数字把帧放进这个动作；至少给「待机 idle」留 1 帧。</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 4 -->
  <section class="wz-step" data-step="4" hidden>
    <div class="wz-summary">
      <div class="wz-summary-stage"><canvas id="wzPreviewCanvas" width="160" height="180"></canvas><span>待机动画预览</span></div>
      <div class="wz-summary-meta" id="wzSummaryMeta"></div>
    </div>
    <div class="wz-card">
      <h3>将生成这些文件 <small>完全独立的一个文件夹</small></h3>
      <label class="wz-check"><input id="wzActivate" type="checkbox" checked /> 导入后立刻换上这款皮肤</label>
      <pre class="wz-json" id="wzJsonPreview"></pre>
    </div>
  </section>

  <!-- 完成 -->
  <section class="wz-done" id="wzDone" hidden>
    <div class="wz-done-ico">✓</div>
    <h2 id="wzDoneTitle">导入完成！</h2>
    <p id="wzDoneText"></p>
    <button class="btn" id="wzFinish" type="button">查看我的皮肤</button>
  </section>
</div>

<div class="wz-foot" id="wzFoot">
  <span id="wzFootHint">第 1 步 / 共 4 步</span>
  <div class="wz-foot-btns">
    <button class="btn ghost" id="wzPrev" type="button">上一步</button>
    <button class="btn" id="wzNext" type="button">下一步</button>
  </div>
</div>`;

  /* ---------------- 基础工具 ---------------- */
  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function showError(text) {
    const el = $('wzError');
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
  }

  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [255, 255, 255];
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  function readOptions() {
    return {
      cols: clamp(parseInt($('wzCols').value, 10) || 4, 1, 16),
      rows: clamp(parseInt($('wzRows').value, 10) || 1, 1, 16),
      removeBg: $('wzRemoveBg').checked,
      bg: $('wzBgColor').value,
      tol: Number($('wzTolerance').value) || 0,
      trim: $('wzTrim').checked,
      outW: clamp(parseInt($('wzFrameW').value, 10) || 160, 32, 512),
      outH: clamp(parseInt($('wzFrameH').value, 10) || 180, 32, 512),
      fit: $('wzFit').value
    };
  }

  function suggestId(name) {
    const ascii = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const head = ascii && /^[a-z0-9]/.test(ascii) ? ascii.slice(0, 20) : 'my-pet';
    return head + '-' + String(Date.now()).slice(-4);
  }

  /* ---------------- 步骤 1：素材 ---------------- */
  async function pick(mode) {
    if (S.busy) return;
    showError('');
    try {
      const r = await api.skinPick(mode);
      if (r.canceled) return;
      if (r.error) { showError(r.error); return; }
      await handlePaths(r.paths || []);
    } catch (err) { showError('打开文件失败：' + err.message); }
  }

  async function handlePaths(paths) {
    if (!paths.length) { showError('没有读到文件，请重新选择'); return; }
    S.busy = true;
    $('wzSourceInfo').hidden = false;
    $('wzSourceInfo').innerHTML = '<div class="wz-loading">正在读取素材…</div>';
    try {
      const info = await api.skinInspect(paths);
      if (!info || !info.ok) throw new Error((info && info.error) || '素材读取失败');
      await applySource(info);
    } catch (err) {
      showError(err.message);
      $('wzSourceInfo').hidden = true;
    } finally { S.busy = false; }
  }

  async function applySource(info) {
    S.source = info;
    S.kind = info.kind;
    S.skipStep2 = info.kind === 'pack';
    S.manifest = null;
    S.result = null;
    S.autoFrameCount = -1;
    showError('');

    const imgs = [];
    for (const item of info.images) {
      const img = await loadImage(item.dataUrl);
      if (img) imgs.push({ name: item.name, img, width: img.naturalWidth, height: img.naturalHeight, dataUrl: item.dataUrl });
    }
    if (!imgs.length) throw new Error('这些图片都读不出来，换一份素材试试');
    S.rawImages = imgs.slice(0, 64);

    let manifest = null;
    if (info.manifestText) {
      try { manifest = JSON.parse(info.manifestText); }
      catch (err) { throw new Error('皮肤包里的 skin.json 格式不对：' + err.message); }
    }
    S.manifest = manifest;

    // 猜一个网格：按每格近似正方形推算行数（例如 865×1820 的图会猜成 4×8）
    if (S.rawImages.length === 1 && info.kind !== 'pack') {
      const first = S.rawImages[0];
      const cols = clamp(Math.round(first.width / 200) || 4, 1, 8);
      $('wzCols').value = cols;
      $('wzRows').value = clamp(Math.round(first.height / (first.width / cols)), 1, 16);
    }

    const thumb = S.rawImages.slice(0, 6).map((i) => `<img src="${i.dataUrl}" alt="" />`).join('');
    const warn = (info.warnings || []).length
      ? `<div class="wz-warn">${(info.warnings || []).map(esc).join('；')}</div>` : '';
    $('wzSourceInfo').innerHTML = `
      <div class="wz-source-thumbs">${thumb}${info.images.length > 6 ? `<span>+${info.images.length - 6}</span>` : ''}</div>
      <div class="wz-source-text">
        <b>${esc(info.label)}</b>
        <span>${info.kind === 'pack' ? '完整皮肤包（自带 skin.json）' : info.kind === 'sheet' ? '一张精灵图，下一步拆帧' : '序列帧'}
          · ${info.images.length} 张图片 · ${S.rawImages[0].width}×${S.rawImages[0].height}px</span>
        ${warn}
      </div>`;

    if (S.kind === 'pack') {
      await preparePackFrames(manifest);
      fillMetaFromManifest(manifest, info);
      fillRowsFromManifest(manifest);
    } else {
      $('wzName').value = '';
      $('wzDesc').value = '';
      $('wzAuthor').value = '我';
      S.idEdited = false;
      $('wzId').value = '';
      $('wzPersona').value = info.personaText || PERSONA_DEFAULT;
    }
    renderSheetPreview();
    rebuildFrames();
  }

  /** 皮肤包：保留原有帧，只把非 PNG 统一转成 PNG 并同步改名 */
  async function preparePackFrames(manifest) {
    const frames = [];
    const rename = new Map();
    for (let i = 0; i < S.rawImages.length; i++) {
      const it = S.rawImages[i];
      let name = it.name;
      let dataUrl = it.dataUrl;
      if (!/\.png$/i.test(name) || !/^data:image\/png/.test(dataUrl)) {
        const cv = document.createElement('canvas');
        cv.width = it.width; cv.height = it.height;
        cv.getContext('2d').drawImage(it.img, 0, 0);
        dataUrl = cv.toDataURL('image/png');
        name = name.replace(/\.[^.]+$/, '.png');
      }
      rename.set(it.name, name);
      frames.push({ name, dataUrl });
    }
    S.frames = frames;
    S.rename = rename;
    const cv = manifest && manifest.canvas ? manifest.canvas : {};
    $('wzFrameW').value = clamp(Number(cv.width) || 160, 32, 512);
    $('wzFrameH').value = clamp(Number(cv.height) || 180, 32, 512);
  }

  function fillMetaFromManifest(manifest, info) {
    const m = manifest || {};
    $('wzName').value = String(m.name || info.label || '我的小伙伴').slice(0, 40);
    $('wzDesc').value = String(m.desc || '导入的皮肤包。').slice(0, 120);
    $('wzAuthor').value = String(m.author || '皮肤包作者').slice(0, 40);
    S.idEdited = true;
    $('wzId').value = suggestId(m.name || info.label);
    const t = m.theme || {};
    $('wzAccent').value = /^#[0-9a-f]{6}$/i.test(t.accent || '') ? t.accent : '#e2a87c';
    $('wzAccentDeep').value = /^#[0-9a-f]{6}$/i.test(t.accentDeep || '') ? t.accentDeep : '#c07b45';
    $('wzAccentSoft').value = /^#[0-9a-f]{6}$/i.test(t.accentSoft || '') ? t.accentSoft : '#fbe6d1';
    let text = info.personaText || '';
    if (!text && m.persona && typeof m.persona === 'object') {
      text = Object.keys(m.persona).map((k) => `[${k}]\n` + (Array.isArray(m.persona[k]) ? m.persona[k] : [m.persona[k]]).join('\n')).join('\n\n') + '\n';
    }
    $('wzPersona').value = text || PERSONA_DEFAULT;
  }

  function fillRowsFromManifest(manifest) {
    const index = new Map();
    S.frames.forEach((f, i) => index.set(f.name, i));
    const lookup = (n) => {
      // 皮肤包里有时写成 frames/idle-1.png，统一按文件名匹配
      const base = String(n).replace(/\\/g, '/').split('/').pop();
      return index.get(S.rename.get(base) || base);
    };
    const defs = new Map(ACTION_DEFS.map((d) => [d.key, d]));
    const raw = (manifest && manifest.actions) || {};
    const rows = [];
    Object.keys(raw).slice(0, 32).forEach((key) => {
      const item = raw[key];
      if (!item || !Array.isArray(item.frames)) return;
      const frames = item.frames.map(lookup).filter((i) => i != null);
      if (!frames.length) return;
      const def = defs.get(key) || {};
      rows.push({
        key, label: def.label || key, fps: Number(item.fps) || def.fps || 2,
        loop: item.loop !== false, mirror: !!item.mirror, bob: Number(item.bob) || 0,
        frames
      });
    });
    if (!rows.some((r) => r.key === 'idle')) {
      rows.unshift({ key: 'idle', label: '待机', fps: 2, loop: true, frames: [0] });
    }
    S.rows = rows.length ? rows : autoRows();
    S.autoFrameCount = S.frames.length;   // 皮肤包自带动作表，别被自动分配覆盖
  }

  /* ---------------- 步骤 2：拆帧 ---------------- */
  function renderSheetPreview() {
    const cv = $('wzSheetCanvas');
    if (!cv || !S.rawImages.length) return;
    const first = S.rawImages[0];
    const o = readOptions();
    const scale = Math.min(300 / first.width, 155 / first.height, 1);
    cv.width = Math.max(1, Math.round(first.width * scale));
    cv.height = Math.max(1, Math.round(first.height * scale));
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(first.img, 0, 0, cv.width, cv.height);
    if (S.kind === 'sheet' && !S.skipStep2) {
      c.strokeStyle = 'rgba(226,120,55,.9)';
      c.lineWidth = 1;
      for (let i = 1; i < o.cols; i++) {
        const x = Math.round(cv.width * i / o.cols) + .5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, cv.height); c.stroke();
      }
      for (let i = 1; i < o.rows; i++) {
        const y = Math.round(cv.height * i / o.rows) + .5;
        c.beginPath(); c.moveTo(0, y); c.lineTo(cv.width, y); c.stroke();
      }
    }
  }

  /** 低分辨率灰度指纹：用于判断相邻帧是不是同一动作的连续帧 */
  function fpOf(canvas) {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff';
    x.fillRect(0, 0, N, N);
    x.drawImage(canvas, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data;
    const out = new Array(N * N);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      out[j] = Math.round((d[i] + d[i + 1] + d[i + 2]) / 3);
    }
    return out;
  }

  function makeFrame(img, cell, o) {
    const w = Math.max(1, Math.round(cell.w));
    const h = Math.max(1, Math.round(cell.h));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const t = tmp.getContext('2d', { willReadFrequently: true });
    t.drawImage(img, cell.x, cell.y, cell.w, cell.h, 0, 0, w, h);

    let pixels = null;
    if (o.removeBg) {
      pixels = t.getImageData(0, 0, w, h);
      const [br, bg, bb] = hexToRgb(o.bg);
      const d = pixels.data;
      for (let i = 0; i < d.length; i += 4) {
        const diff = Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bg), Math.abs(d[i + 2] - bb));
        if (diff <= o.tol * 0.65) d[i + 3] = 0;
        else if (diff <= o.tol && o.tol > 0) {
          d[i + 3] = Math.round(d[i + 3] * (diff - o.tol * 0.65) / (o.tol * 0.35));
        }
      }
      t.putImageData(pixels, 0, 0);
    }

    let sx = 0, sy = 0, sw = w, sh = h;
    if (o.trim) {
      if (!pixels) pixels = t.getImageData(0, 0, w, h);
      const d = pixels.data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 >= x0) { sx = x0; sy = y0; sw = x1 - x0 + 1; sh = y1 - y0 + 1; }
    }

    const out = document.createElement('canvas');
    out.width = o.outW; out.height = o.outH;
    const c = out.getContext('2d');
    let dw = sw, dh = sh;
    if (o.fit === 'stretch') { dw = o.outW; dh = o.outH; }
    else if (o.fit === 'contain') {
      const k = Math.min(o.outW / sw, o.outH / sh);
      dw = sw * k; dh = sh * k;
    }
    c.imageSmoothingEnabled = dw < sw || dh < sh;
    const dx = Math.round((o.outW - dw) / 2);
    const dy = Math.round((o.outH - 4) - dh);
    c.drawImage(tmp, sx, sy, sw, sh, dx, dy, Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)));
    return { dataUrl: out.toDataURL('image/png'), fp: fpOf(out) };
  }

  function rebuildFrames() {
    if (!S.rawImages.length) return;
    if (S.skipStep2) {          // 皮肤包沿用自带帧，不重新处理
      renderFrameGrid();
      return;
    }
    const o = readOptions();
    const isSheet = S.kind === 'sheet' && S.rawImages.length === 1;
    const frames = [];
    S.rawImages.forEach((item) => {
      const cells = [];
      if (isSheet) {
        const cw = item.width / o.cols;
        const ch = item.height / o.rows;
        for (let r = 0; r < o.rows; r++) {
          for (let c = 0; c < o.cols; c++) cells.push({ x: c * cw, y: r * ch, w: cw, h: ch, row: r, col: c });
        }
      } else {
        cells.push({ x: 0, y: 0, w: item.width, h: item.height, row: -1, col: -1 });
      }
      cells.forEach((cell) => {
        if (frames.length >= 64) return;
        const made = makeFrame(item.img, cell, o);
        frames.push({
          name: 'frame-' + String(frames.length + 1).padStart(2, '0') + '.png',
          dataUrl: made.dataUrl,
          // 识别信号：原始文件名（序列帧可含动作关键词）、精灵图行列、画面指纹
          srcName: item.name || '',
          row: cell.row,
          col: cell.col,
          fp: made.fp
        });
      });
    });
    S.frames = frames;
    renderFrameGrid();
    renderSheetPreview();
  }

  function renderFrameGrid() {
    $('wzFrameCount').textContent = S.frames.length + ' 帧';
    const grid = $('wzFrameGrid');
    grid.innerHTML = S.frames.map((f, i) => `
      <div class="wz-frame"><img src="${f.dataUrl}" alt="第 ${i + 1} 帧" /><b>${i + 1}</b></div>`).join('')
      || '<div class="wz-empty">还没有帧</div>';
    const strip = $('wzFrameStrip');
    if (strip) {
      strip.innerHTML = S.frames.map((f, i) => `<span title="第 ${i + 1} 帧"><img src="${f.dataUrl}" alt="" /><i>${i + 1}</i></span>`).join('');
    }
  }

  /* ---------------- 步骤 3：动作与台词 ---------------- */
  // 动作关键词：命中原始文件名时置信度最高（如 run_01.png、happy-3.png、待机.png）
  const NAME_HINTS = [
    { key: 'run',    re: /(run|dash|sprint|running|跑|奔|冲)/i },
    { key: 'walk',   re: /(walk|stroll|walking|走|迈步|散步)/i },
    { key: 'sleep',  re: /(sleep|sleeping|zzz|睡|眠|躺)/i },
    { key: 'happy',  re: /(happy|joy|smile|laugh|cheer|开心|笑|高兴|欢喜)/i },
    { key: 'angry',  re: /(angry|mad|anger|生气|怒|愤怒)/i },
    { key: 'wave',   re: /(wave|waving|hello|hi|挥手|招手|打招呼)/i },
    { key: 'click',  re: /(click|touch|tap|pat|点击|摸|戳)/i },
    { key: 'drag',   re: /(drag|pull|拖拽|拖动|拽|拉)/i },
    { key: 'hot',    re: /(hot|heat|sweat|发热|热|烫|汗)/i },
    { key: 'read',   re: /(read|book|study|阅读|看书|读书|陪伴)/i },
    { key: 'hover',  re: /(hover|悬停|漂浮)/i },
    { key: 'idle',   re: /(idle|stand|default|normal|待机|站立|默认|普通|站着)/i }
  ];

  function fpDist(a, b) {
    if (!a || !b || a.length !== b.length) return 999;
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s / a.length);
  }

  /** 把给定索引里连续相近的帧切成若干段（返回原始帧索引的子数组）：一段≈一个动作的连续帧 */
  function segmentIndices(indices, frames) {
    const n = indices.length;
    if (!n) return [];
    const dists = [];
    for (let i = 1; i < n; i++) dists.push(fpDist(frames[indices[i - 1]].fp, frames[indices[i]].fp));
    const usable = dists.filter((d) => d < 900);
    const avg = usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : 0;
    const thr = Math.max(14, avg * 0.9);
    const segs = [];
    let start = 0;
    for (let i = 1; i < n; i++) {
      const a = frames[indices[i - 1]], b = frames[indices[i]];
      let cut;
      if (a.fp && b.fp) cut = fpDist(a.fp, b.fp) > thr;
      else if (a.row >= 0 && b.row >= 0) cut = a.row !== b.row;   // 无指纹时按精灵图行切
      else cut = false;
      if (cut) { segs.push(indices.slice(start, i)); start = i; }
    }
    segs.push(indices.slice(start));
    return segs;
  }

  /** 智能分配：文件名关键词 > 画面相似度分段 > 顺序启发式；拿不准的留给手动 */
  function autoRows() {
    const n = S.frames.length;
    if (!n) return [];
    const buckets = {};
    const used = new Set();
    const unnamed = [];
    let byName = 0;

    // 1) 逐帧按文件名关键词归类（置信度最高，不依赖画面指纹）
    //    像 run_01.png / happy-3.png / 待机.png 这类规范命名能精确归位
    S.frames.forEach((f, i) => {
      const nm = f.srcName || '';
      let hit = null;
      for (const h of NAME_HINTS) { if (h.re.test(nm)) { hit = h.key; break; } }
      if (hit) {
        (buckets[hit] = buckets[hit] || []).push(i);
        used.add(hit);
        byName += 1;
      } else {
        unnamed.push(i);
      }
    });

    // 2) 无关键词的帧按画面相似度切成段，长段给循环动作、短段给单帧动作，不同段优先不同动作
    const segs = segmentIndices(unnamed, S.frames);
    const multiPref = ['idle', 'happy', 'walk', 'run', 'wave', 'sleep'];
    const singlePref = ['idle', 'click', 'angry', 'drag', 'hot', 'read', 'sleep', 'wave', 'happy'];
    segs.slice().sort((a, b) => b.length - a.length).forEach((seg) => {
      const pref = seg.length >= 2 ? multiPref : singlePref;
      let key = pref.find((k) => !used.has(k));
      if (!key) key = ACTION_DEFS.find((d) => !used.has(d.key) && d.key !== 'idle');
      if (!key) key = 'idle';
      if (key === 'idle' && used.has('idle') && buckets.idle) {
        buckets.idle = buckets.idle.concat(seg);
      } else {
        buckets[key] = seg.slice();
        used.add(key);
      }
    });

    // 3) 保证常用动作都有帧，且彼此错开（避免所有动作都指向第 1 帧）
    ['idle', 'happy', 'walk', 'run'].forEach((k, ci) => {
      if (buckets[k] && buckets[k].length) return;
      const picks = [];
      for (let i = ci; i < n && picks.length < 4; i += 4) picks.push(i);
      buckets[k] = picks.length ? picks : [0];
    });
    if (!buckets.idle || !buckets.idle.length) buckets.idle = [0];

    // 记录置信度来源，供 UI 提示用户是否需要手动核对
    S.autoAssign = {
      byName,
      segs: segs.length,
      mode: byName > 0 ? 'name' : (segs.length > 1 ? 'visual' : 'guess')
    };

    return ACTION_DEFS
      .filter((d) => buckets[d.key] && buckets[d.key].length)
      .map((d) => Object.assign({}, d, {
        frames: Array.from(new Set(buckets[d.key])).slice(0, 16)
      }));
  }

  function renderActionRows() {
    const box = $('wzActionRows');
    if (!box) return;
    const hint = $('wzAutoHint');
    if (hint && S.autoAssign) {
      const a = S.autoAssign;
      if (a.mode === 'name') {
        hint.textContent = `已按文件名识别出 ${a.byName} 组动作；画面相近的帧归为一组（共 ${a.segs} 组）。跑动/朝向仍建议核对。`;
      } else if (a.mode === 'visual') {
        hint.textContent = `没有带动作关键词的文件名，已按画面相似度分成 ${a.segs} 组并错开分配——纯属推测，请手动核对「小跑 run / 走路 walk」的帧。`;
      } else {
        hint.textContent = '帧之间太相似，无法自动判断动作，已按序号错开分配——建议手动点亮数字调整。';
      }
      hint.hidden = false;
    } else if (hint) {
      hint.hidden = true;
    }
    box.innerHTML = S.rows.map((row, ri) => `
      <div class="wz-action" data-ri="${ri}">
        <div class="wz-action-head">
          <b>${esc(row.label)}</b><code>${esc(row.key)}</code>
          <label>fps <input class="wz-fps" type="number" min="0.5" max="30" step="0.5" value="${row.fps}" /></label>
          <label class="wz-mini"><input class="wz-loop" type="checkbox" ${row.loop ? 'checked' : ''} /> 循环</label>
          <label class="wz-mini"><input class="wz-mirror" type="checkbox" ${row.mirror ? 'checked' : ''} /> 镜像</label>
          <button class="wz-row-del" type="button" title="移除这个动作">×</button>
        </div>
        <div class="wz-chips">${S.frames.map((f, i) =>
          `<button type="button" class="wz-chip ${row.frames.includes(i) ? 'on' : ''}" data-frame="${i}" title="第 ${i + 1} 帧">${i + 1}</button>`
        ).join('')}</div>
      </div>`).join('') || '<div class="wz-empty">还没有动作，点「一键自动分配」</div>';
  }

  function addAction(key) {
    const clean = String(key || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!clean || !/^[A-Za-z]/.test(clean)) { showError('动作名要用英文字母开头，例如 dance'); return false; }
    if (S.rows.some((r) => r.key === clean)) { showError('这个动作已经存在了'); return false; }
    S.rows.push({ key: clean, label: clean, fps: 3, loop: false, mirror: false, bob: 0, frames: [0] });
    renderActionRows();
    showError('');
    return true;
  }

  /* ---------------- 步骤 4：确认 ---------------- */
  function buildPayload(overwrite) {
    const id = String($('wzId').value || '').trim().toLowerCase();
    const actions = {};
    S.rows.forEach((r) => {
      if (!r.frames || !r.frames.length) return;
      const item = {
        frames: r.frames.map((i) => S.frames[i].name).filter(Boolean),
        fps: r.fps,
        loop: !!r.loop
      };
      if (!item.frames.length) return;
      if (r.mirror) item.mirror = true;
      if (r.bob) item.bob = r.bob;
      actions[r.key] = item;
    });
    const keys = Object.keys(actions);
    const pickAction = (name, alts) => keys.includes(name) ? name : (alts.find((k) => keys.includes(k)) || keys[0] || 'idle');
    const customs = keys.filter((k) => !ACTION_DEFS.some((d) => d.key === k));
    const triggers = {
      idlePool: ['idle'].concat(customs),
      longpress: pickAction('happy', ['click']),
      pomodoro: pickAction('happy', ['click']),
      cpu: pickAction('hot', []),
      mem: pickAction('wave', []),
      sit: pickAction('wave', []),
      battery: pickAction('sleep', [])
    };
    const o = readOptions();
    const outW = o.outW;
    const outH = o.outH;
    return {
      id,
      name: $('wzName').value.trim(),
      desc: $('wzDesc').value.trim(),
      author: $('wzAuthor').value.trim(),
      overwrite: !!overwrite,
      theme: {
        accent: $('wzAccent').value,
        accentDeep: $('wzAccentDeep').value,
        accentSoft: $('wzAccentSoft').value
      },
      canvas: { width: outW, height: outH, groundY: outH - 4 },
      behavior: Object.assign({}, (S.manifest && S.manifest.behavior) || DEFAULT_BEHAVIOR),
      effects: Object.assign({}, (S.manifest && S.manifest.effects) || DEFAULT_EFFECTS),
      actions,
      triggers,
      personaText: $('wzPersona').value,
      thumb: (actions.idle && actions.idle.frames[0]) || (S.frames[0] && S.frames[0].name),
      frames: S.frames.map((f) => ({ name: f.name, dataUrl: f.dataUrl }))
    };
  }

  function renderSummary() {
    const p = buildPayload(false);
    const bytes = S.frames.reduce((sum, f) => sum + Math.round(f.dataUrl.length * 0.75), 0);
    const groups = (p.personaText.match(/^\[[^\]]+\]/gm) || []).length;
    $('wzSummaryMeta').innerHTML = `
      <div><span>名字</span><b>${esc(p.name || '未填写')}</b></div>
      <div><span>皮肤 ID</span><code>${esc(p.id || '未填写')}</code></div>
      <div><span>作者</span><b>${esc(p.author || '我')}</b></div>
      <div><span>帧 / 动作 / 台词</span><b>${S.frames.length} 帧 · ${Object.keys(p.actions).length} 个动作 · ${groups} 组台词</b></div>
      <div><span>帧尺寸</span><b>${p.canvas.width} × ${p.canvas.height}px</b></div>
      <div><span>素材体积</span><b>${(bytes / 1024 / 1024).toFixed(2)} MB</b></div>
      <div><span>存放位置</span><code>${esc(S.userDir || '我的皮肤目录')}\\${esc(p.id)}</code></div>`;
    const preview = {
      id: p.id, name: p.name, builtin: false, source: 'imported',
      theme: p.theme, canvas: p.canvas, behavior: p.behavior,
      actions: p.actions, triggers: p.triggers, persona: 'persona.txt',
      thumb: p.thumb
    };
    $('wzJsonPreview').textContent = JSON.stringify(preview, null, 2).slice(0, 2200);
    const cv = $('wzPreviewCanvas');
    cv.width = p.canvas.width;
    cv.height = p.canvas.height;
    startPreview();
  }

  function startPreview() {
    stopPreview();
    const idle = S.rows.find((r) => r.key === 'idle') || S.rows[0];
    const urls = idle && idle.frames && idle.frames.length
      ? idle.frames.map((i) => S.frames[i] && S.frames[i].dataUrl).filter(Boolean)
      : S.frames.slice(0, 2).map((f) => f.dataUrl);
    Promise.all(urls.map(loadImage)).then((list) => {
      S.previewImgs = list.filter(Boolean);
      const fps = (idle && Number(idle.fps)) || 2;
      const cv = $('wzPreviewCanvas');
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      const tick = (now) => {
        if (S.step !== 4 || $('wzDone').hidden === false || !S.previewImgs.length) return;
        c.clearRect(0, 0, cv.width, cv.height);
        const img = S.previewImgs[Math.floor(now / 1000 * fps) % S.previewImgs.length];
        c.drawImage(img, Math.round((cv.width - img.width) / 2), Math.round((cv.height - 4) - img.height));
        S.raf = requestAnimationFrame(tick);
      };
      S.raf = requestAnimationFrame(tick);
    });
  }

  function stopPreview() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
  }

  /* ---------------- 步骤切换 ---------------- */
  function setStep(n) {
    if (S.edit && n < 3) n = 3;    // 编辑已有皮肤时不需要重新选素材/拆帧
    stopPreview();
    S.step = n;
    document.querySelectorAll('.wz-step').forEach((el) => {
      el.hidden = Number(el.dataset.step) !== n;
    });
    $('wzDone').hidden = true;
    $('wzFoot').hidden = false;
    document.querySelectorAll('#wzSteps li').forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
      if (S.skipStep2 && s === 2) li.classList.add('skip');
    });
    const editing = !!S.edit;
    if ($('wzTitle')) $('wzTitle').textContent = editing ? '编辑皮肤' : '皮肤导入向导';
    $('wzPrev').disabled = n === 1 || (editing && n === 3);
    $('wzPrev').hidden = n === 1 || (editing && n === 3);
    $('wzNext').textContent = n === 4 ? (editing ? '保存修改' : '完成导入') : '下一步';
    $('wzFootHint').textContent = editing
      ? `编辑皮肤 · ${['', '', '动作与台词', '确认保存'][n - 1] || ''}`
      : `第 ${n} 步 / 共 4 步 · ${['选择素材', '拆帧处理', '动作与台词', '确认导入'][n - 1]}`;
    $('wzSub').textContent = editing
      ? ['', '', '修改它的名字、动作和台词，保存后会更新这款皮肤', '检查一遍，保存修改'][n - 1] || ''
      : [
        '把图片变成一只有自己动作和台词的小伙伴',
        '切成帧、去掉背景，让每一格都干干净净',
        '决定它会做什么动作、说什么话',
        '检查一遍，然后写进独立的皮肤文件夹'
      ][n - 1];
    if (n === 2) { rebuildFrames(); }
    if (n === 3) {
      if (!S.rows.length || !S.rows.some((r) => r.key === 'idle') || S.autoFrameCount !== S.frames.length) {
        S.rows = autoRows();
        S.autoFrameCount = S.frames.length;
      }
      renderFrameGrid();
      renderActionRows();
      if (!S.idEdited && !$('wzId').value) $('wzId').value = suggestId($('wzName').value || 'my-pet');
    }
    if (n === 4) renderSummary();
  }

  function next() {
    showError('');
    if (S.step === 1) {
      if (!S.source) { showError('先选一份素材吧，可以点上面的卡片或直接拖进来'); return; }
      setStep(S.skipStep2 ? 3 : 2);
      return;
    }
    if (S.step === 2) {
      rebuildFrames();
      if (!S.frames.length) { showError('没有拆出任何帧，检查一下行列数'); return; }
      setStep(3);                       // 帧数变了会自动重排动作，没变则保留用户的编辑
      return;
    }
    if (S.step === 3) {
      const id = $('wzId').value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { showError('皮肤 ID 只能用小写字母、数字、- 和 _，且以字母或数字开头'); return; }
      if (!$('wzName').value.trim()) { showError('给它取个名字吧'); return; }
      const idle = S.rows.find((r) => r.key === 'idle');
      if (!idle || !idle.frames.length) { showError('「待机 idle」至少要选 1 帧'); return; }
      setStep(4);
      return;
    }
    if (S.step === 4) doImport();
  }

  function prev() {
    showError('');
    if (S.step === 3 && S.skipStep2) { setStep(1); return; }
    if (S.step > 1) setStep(S.step - 1);
  }

  /* ---------------- 导入 ---------------- */
  async function doImport() {
    if (S.busy) return;
    S.busy = true;
    const editing = !!S.edit;
    const btn = $('wzNext');
    btn.disabled = true;
    btn.textContent = editing ? '正在保存…' : '正在导入…';
    showError('');
    try {
      // 编辑态允许覆盖的是"原皮肤"本身：仅当当前 ID 与原 ID 相同时才用 overwrite。
      // 若用户在编辑态把 ID 改成了另一个已有皮肤，必须走 EXISTS 确认流程，
      // 否则会静默覆盖掉那款不相干的皮肤（内置皮肤另存副本时 ID 已变成新值，天然走确认流程）。
      const sameId = editing && $('wzId').value.trim().toLowerCase() === String(S.edit.originalId).toLowerCase();
      let res = await api.skinImport(buildPayload(sameId));
      if (!res.ok && res.code === 'EXISTS') {
        const ok = window.confirm(`已经有一个叫「${$('wzId').value.trim()}」的皮肤了，覆盖它吗？`);
        if (!ok) return;
        res = await api.skinImport(buildPayload(true));
      }
      if (!res.ok) throw new Error(res.error || '导入失败');
      S.result = res;
      stopPreview();
      document.querySelectorAll('.wz-step').forEach((el) => { el.hidden = true; });
      $('wzDone').hidden = false;
      $('wzFoot').hidden = true;
      const isCopy = editing && S.edit.builtin;
      $('wzDoneTitle').textContent = editing ? '修改已保存！' : '导入完成！';
      $('wzDoneText').textContent = editing
        ? `「${$('wzName').value.trim()}」的修改已经保存：${res.frameCount} 帧 · ${res.actionCount} 个动作。${isCopy ? '内置皮肤已另存为一款新皮肤。' : ''}`
        : `「${$('wzName').value.trim()}」已经装好啦：${res.frameCount} 帧 · ${res.actionCount} 个动作，拥有自己独立的 skin.json 和台词文件。`;
      document.querySelectorAll('#wzSteps li').forEach((li) => { li.classList.add('done'); li.classList.remove('active'); });
      document.dispatchEvent(new CustomEvent('skins:changed', {
        detail: { id: res.id, activate: $('wzActivate').checked, edited: editing }
      }));
    } catch (err) {
      showError(err.message);
    } finally {
      S.busy = false;
      btn.disabled = false;
      btn.textContent = editing ? '保存修改' : '完成导入';
    }
  }

  /* ---------------- 挂载 ---------------- */
  function mount() {
    if (S.mounted) return;
    const layer = $('wizardLayer');
    if (!layer) return;
    layer.innerHTML = TEMPLATE;
    S.mounted = true;

    $('wzClose').addEventListener('click', close);
    $('wzFinish').addEventListener('click', close);
    $('wzPrev').addEventListener('click', prev);
    $('wzNext').addEventListener('click', next);
    document.querySelectorAll('.wz-source').forEach((btn) => {
      btn.addEventListener('click', () => pick(btn.dataset.pick));
    });

    const drop = $('wzDrop');
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) { showError('没能读到拖进来的文件路径，请用上面的按钮选择'); return; }
      handlePaths(paths);
    });
    // 阻止整页把文件当成导航目标
    ['dragover', 'drop'].forEach((type) => layer.addEventListener(type, (e) => e.preventDefault()));

    $('wzPickColor').addEventListener('click', () => {
      if (!S.rawImages.length) return;
      const it = S.rawImages[0];
      const cv = document.createElement('canvas');
      cv.width = it.width; cv.height = it.height;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(it.img, 0, 0);
      const d = c.getImageData(0, 0, 1, 1).data;
      $('wzBgColor').value = rgbToHex(d[0], d[1], d[2]);
      rebuildFrames();
    });

    // 拆帧参数变化：防抖重算，避免每敲一个数字就全量处理
    const onOptionChange = () => {
      $('wzTolVal').textContent = $('wzTolerance').value;
      clearTimeout(S.debounce);
      S.debounce = setTimeout(rebuildFrames, 120);
    };
    ['wzCols', 'wzRows', 'wzRemoveBg', 'wzBgColor', 'wzTolerance', 'wzTrim', 'wzFrameW', 'wzFrameH', 'wzFit']
      .forEach((id) => {
        $(id).addEventListener('input', onOptionChange);
        $(id).addEventListener('change', onOptionChange);
      });

    $('wzId').addEventListener('input', () => { S.idEdited = true; });
    $('wzName').addEventListener('input', () => {
      if (!S.idEdited) $('wzId').value = suggestId($('wzName').value);
    });
    $('wzAutoActions').addEventListener('click', () => {
      S.rows = autoRows();
      S.autoFrameCount = S.frames.length;
      renderActionRows();
    });
    $('wzAddAction').addEventListener('click', () => {
      if (addAction($('wzNewAction').value)) $('wzNewAction').value = '';
    });
    $('wzNewAction').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('wzAddAction').click(); }
    });

    const rows = $('wzActionRows');
    rows.addEventListener('click', (e) => {
      const chip = e.target.closest('.wz-chip');
      const wrap = e.target.closest('.wz-action');
      if (!wrap) return;
      const row = S.rows[Number(wrap.dataset.ri)];
      if (!row) return;
      if (chip) {
        const i = Number(chip.dataset.frame);
        const at = row.frames.indexOf(i);
        if (at >= 0) row.frames.splice(at, 1); else row.frames.push(i);
        row.frames.sort((a, b) => a - b);
        chip.classList.toggle('on');
        return;
      }
      if (e.target.closest('.wz-row-del')) {
        if (row.key === 'idle') { showError('待机动作不能删'); return; }
        S.rows.splice(Number(wrap.dataset.ri), 1);
        renderActionRows();
      }
    });
    rows.addEventListener('change', (e) => {
      const wrap = e.target.closest('.wz-action');
      if (!wrap) return;
      const row = S.rows[Number(wrap.dataset.ri)];
      if (!row) return;
      if (e.target.classList.contains('wz-fps')) row.fps = clamp(Number(e.target.value) || 2, 0.5, 30);
      if (e.target.classList.contains('wz-loop')) row.loop = e.target.checked;
      if (e.target.classList.contains('wz-mirror')) row.mirror = e.target.checked;
    });

    api.skinUserDir().then((dir) => { S.userDir = dir || ''; }).catch(() => {});
    setStep(1);
  }

  /** 把 config.readSkin 返回的 persona 对象还原成可编辑的台词文本 */
  function personaToText(persona) {
    const groups = persona && typeof persona === 'object' && !Array.isArray(persona) ? persona : {};
    const keys = Object.keys(groups);
    if (!keys.length) return PERSONA_DEFAULT;
    return keys.map((k) => {
      const lines = Array.isArray(groups[k]) ? groups[k] : [groups[k]];
      return `[${k}]\n` + lines.filter((v) => typeof v === 'string').join('\n');
    }).join('\n\n') + '\n';
  }

  /** 从已有皮肤打开编辑：读取完整资源包，预填后直接进入动作台词页 */
  async function openForEdit(id) {
    if (S.busy || !id) return;
    if (!S.mounted) mount();
    const layer = $('wizardLayer');
    if (!layer) return;
    resetState();
    let pack;
    try {
      pack = await api.readSkin(id);
    } catch (err) {
      window.alert('读取皮肤失败：' + err.message);
      return;
    }
    if (!pack || !Object.keys(pack.frames || {}).length) {
      window.alert('这个皮肤没有可编辑的帧');
      return;
    }

    const builtin = !!(pack.builtin || pack.source === 'builtin');
    S.edit = { originalId: id, builtin };
    S.source = null;
    S.kind = 'pack';
    S.skipStep2 = true;
    S.result = null;
    S.autoFrameCount = -1;

    // 组装成 skinInspect 的 pack 结构，复用现成的预填逻辑
    const images = Object.keys(pack.frames).map((name) => ({ name, dataUrl: pack.frames[name] }));
    const info = {
      ok: true,
      kind: 'pack',
      label: pack.name || id,
      images,
      manifestText: JSON.stringify({
        name: pack.name, desc: pack.desc, author: pack.author, theme: pack.theme,
        canvas: pack.canvas, behavior: pack.behavior, effects: pack.effects,
        actions: pack.actions, triggers: pack.triggers
      }),
      personaText: personaToText(pack.persona),
      warnings: []
    };

    S.busy = true;
    try {
      // 载入帧（沿用原图，不重新拆帧）
      const imgs = [];
      for (const item of info.images) {
        const img = await loadImage(item.dataUrl);
        if (img) imgs.push({ name: item.name, img, width: img.naturalWidth, height: img.naturalHeight, dataUrl: item.dataUrl });
      }
      if (!imgs.length) throw new Error('这个皮肤的帧图都读不出来');
      S.rawImages = imgs;

      const manifest = JSON.parse(info.manifestText);
      S.manifest = manifest;
      await preparePackFrames(manifest);
      fillMetaFromManifest(manifest, info);
      fillRowsFromManifest(manifest);

      // 内置皮肤在 asar 里只读，另存为副本；用户皮肤保留原 ID 直接覆盖
      if (builtin) {
        let copyId = String(id).slice(0, 22) + '-copy';
        let n = 2;
        const existing = await api.listSkins().catch(() => []);
        const ids = new Set((existing || []).map((s) => s.id));
        while (ids.has(copyId)) copyId = String(id).slice(0, 20) + '-copy' + (n++);
        S.idEdited = true;
        $('wzId').value = copyId;
        $('wzName').value = String(pack.name || id).slice(0, 34) + '（副本）';
      } else {
        S.idEdited = true;
        $('wzId').value = id;
      }

      layer.hidden = false;
      document.body.classList.add('wizard-open');
      setStep(3);
      if (builtin) {
        showError('这是内置皮肤，无法覆盖；已为你另存为副本，修改会保存为新皮肤。');
      }
    } catch (err) {
      showError('载入皮肤失败：' + err.message);
    } finally {
      S.busy = false;
    }
  }

  /** 清空上一次会话的素材/表单/预览状态，保证每次打开都是全新向导 */
  function resetState() {
    stopPreview();
    clearTimeout(S.debounce);
    S.debounce = 0;
    S.step = 1;
    S.source = null;
    S.kind = 'sheet';
    S.skipStep2 = false;
    S.rawImages = [];
    S.frames = [];
    S.rows = [];
    S.autoFrameCount = -1;
    S.manifest = null;
    S.userDir = '';
    S.idEdited = false;
    S.busy = false;
    S.result = null;
    S.edit = null;
    S.previewImgs = [];
    ['wzName', 'wzDesc', 'wzId', 'wzPersona', 'wzNewAction'].forEach((id) => {
      const el = $(id);
      if (el) el.value = '';
    });
    const activate = $('wzActivate');
    if (activate) activate.checked = true;
    const grid = $('wzFrameGrid');
    if (grid) grid.innerHTML = '';
    const strip = $('wzFrameStrip');
    if (strip) strip.innerHTML = '';
    const sheet = $('wzSheetPreview');
    if (sheet) sheet.innerHTML = '';
    showError('');
  }

  function open() {
    if (!S.mounted) mount();
    const layer = $('wizardLayer');
    if (!layer) return;
    resetState();
    layer.hidden = false;
    document.body.classList.add('wizard-open');
    setStep(1);
  }

  function close() {
    resetState();
    const layer = $('wizardLayer');
    if (layer) layer.hidden = true;
    document.body.classList.remove('wizard-open');
  }

  window.SkinWizard = { open, openForEdit, close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
