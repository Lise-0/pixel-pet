# PixelPet 像素桌宠

一只住在桌面上的像素小伙伴：透明悬浮窗口、逐帧动画、心情/疲劳/好感养成、番茄钟，还能换皮肤、导入自己的素材。纯本地运行，不联网、不上传任何数据。

## 功能

- **透明桌宠窗口**：无边框、置顶、鼠标穿透，可拖动，支持点击/长按/拖拽互动
- **鼠标跟随**：点击开启后慢悠悠跟过来，并与光标保持一段距离、不再贴住指针；设置页「跟随松紧」滑杆可调（0% 贴身紧跟 / 100% 松散慢随，默认 70%）。进主控台自动停止，可随时取消/锁定
- **状态养成**：心情、疲劳、好感随时间和互动变化；打盹能恢复疲劳，离开太久自动休息
- **系统联动**：CPU/内存/电池指标驱动动作与提醒（发热冒汗、内存吃紧、久坐提醒等）
- **番茄钟**：专注/休息计时，完成记录与 7 天统计，可选完成通知
- **主控台**：状态总览、近期状态趋势图、专注记录、外观与行为设置
- **皮肤系统**：manifest 驱动的独立皮肤包，内置皮肤 + 用户皮肤分离存放
- **皮肤向导**：从图片/精灵图/文件夹/ZIP 导入，拆帧、去背、配置动作与台词；支持编辑已有皮肤
- **托盘菜单**：快速打开主控台、设置、切换皮肤、退出

## 运行

**系统要求**：Windows 10/11（安装包与托盘图标按 Windows 打包；源码在 macOS / Linux 也能启动，电池电量采样会自动跳过）。跑源码需要 Node.js 18+（含 npm）；跑完整测试需要 Node.js 22+（E2E 用到全局 `WebSocket`）。

```bash
npm install          # 首次需联网下载 Electron 二进制（约 100 MB）
npm start            # 启动桌宠（托盘常驻，关窗口不会退出）
npm run dev          # 开发调试模式：启动并开放 9223 调试端口
```

> 仓库里**不含 `.exe`**：安装包属于构建产物，未提交到 Git。想免安装直接双击运行，请在本机执行 `npm run build`，产物在 `dist/PixelPet Setup 1.0.0.exe` 和 `dist/win-unpacked/PixelPet.exe`；或下载项目 Release 里已构建好的安装包。

打包 Windows 安装包：

```bash
npm run build        # NSIS 安装包 + 免安装目录版
npm run build:dir    # 仅生成目录版
```

### 常见问题

- **提示找不到 `electron` 命令**：不要直接敲 `electron .`（那是全局安装的用法）。用 `npm run dev`，或 `npx electron . --remote-debugging-port=9223`。
- **启动时只闪一下 / 桌宠没多开一份**：应用带单实例锁且托盘常驻，重复启动会把已有实例显示出来，这是预期行为。退出请点托盘菜单「退出」。
- **`npm start` 报 Electron 二进制缺失**：国内网络下载失败时设置镜像后重装，例如 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`，必要时先删掉 `node_modules`。
- **`npm start` 报 `Cannot read properties of undefined (reading 'getPath')`**：少数 IDE / 自动化终端会注入 `ELECTRON_RUN_AS_NODE=1`，让 Electron 退化成纯 Node。程序会自动清掉该变量并以桌面模式重启；若仍失败，换系统终端，或执行 `env -u ELECTRON_RUN_AS_NODE npm start`。
- **首次运行看不到宠物**：宠物默认在屏幕右下角，托盘图标可「显示宠物」；`Alt+P` 也能切换显示。

## 测试

```bash
npm test             # 单元测试 + 端到端测试
npm run test:unit    # 仅单元测试（纯 Node，无需 Electron）
npm run test:e2e     # 仅端到端测试
```

`npm test` 先跑单测，再检测 9223 调试端口：端口上没有实例时会**自动拉起**一个临时调试实例，跑完自动关闭。若本机已有一个不带调试端口的实例占用了单实例锁，E2E 会明确标记「未运行」，不会假装通过（CI 可设 `PIXELPET_STRICT_E2E=1` 把「未运行」视为失败）；此时先退出托盘里的桌宠再跑测试。

端到端测试通过 Chrome DevTools Protocol 连接正在运行的应用。手动启动调试实例：

```bash
npm run dev
```

换端口时把端口传给测试入口即可（应用与测试必须用同一个端口）：

```bash
PIXELPET_CDP_PORT=9333 npm test      # 或 node tests/run.js 9333
npm run test:e2e -- 9333
```

## 皮肤格式

皮肤就是一个文件夹，放在 `assets/skins/<id>/`（内置）或 `<userData>/skins/<id>/`（自己导入的）。文件夹名即皮肤 id。最低限度需要一个 `skin.json` 和若干 PNG 帧；更省事的做法是用程序里的「皮肤导入向导」从图片生成。

一个皮肤文件夹包含：

| 文件 | 作用 |
|---|---|
| `skin.json` | manifest：名称、主题、画布、动作帧、触发器、行为参数 |
| `persona.txt` | 台词分组（可选，也可在 manifest 里用 `persona` 对象内嵌） |
| `*.png` | 序列帧，文件名由 `actions` 引用 |

`skin.json` 关键字段：

- `name` / `desc` / `author` / `version` / `order`：展示信息
- `thumb`：缩略图帧文件名，默认 `idle-1.png`
- `persona`：台词文件名（字符串，默认 `persona.txt`）或内嵌对象
- `theme`：`accent` / `accentDeep` / `accentSoft`
- `canvas`：`width` / `height` / `groundY`
- `actions`：动作名 → `{ frames: [...], fps, loop, mirror, bob, drift }`（`drift:false` 表示原地动作不横移窗口）
- `triggers`：事件 → 动作名（如 `longpress`、`cpu`、`mem`、`battery`、`pomodoro`、`sit`、`focus`、`idlePool`、`lick`）；运行时按事件名解析，可把系统事件重映射到皮肤独有动作。`focus` 只映射专注期间的陪伴动作（默认 `read`），`pomodoro` 映射阶段完成/休息动作（默认 `happy`）
- `behavior`：疲劳/心情变化速率等参数
- `effects`：`sleepZ` / `hotDrop` / `angryMark` 符号颜色

`persona.txt` 的 `[分组]` 对应事件/动作名；皮肤没写某个分组时，代码只用一句内置默认短句兜底（不是共享的全局台词表），想完全自定义就补齐对应分组。

`sleep` / `hot` / `angry` 这类状态符号只在皮肤提供了对应专属动作帧时才绘制；没有专属动作的皮肤会回退到 `idle`，不会凭空冒出符号。`assets/skins/_TEMPLATE` 是模板目录（下划线开头不会被扫描为皮肤）。

新增或修改皮肤后，在主控台点「刷新皮肤」即可生效，无需重启。

## 数据存储

设置、状态、番茄钟统计保存在 Electron 的 `userData` 目录；导入的皮肤在 `<userData>/skins/`。可从主控台查看 `userData` 路径。状态定期自动保存，关闭窗口时同步落盘。

## 技术栈

Electron 主进程作为唯一状态源，preload 通过 `contextBridge` 暴露 IPC API；渲染层用 Canvas 逐帧绘制动画；皮肤用 manifest + ZIP 导入，写入采用原子替换与备份回滚。

## 许可证

MIT，见 [LICENSE](LICENSE)。
