# PixelPet 像素桌宠

一只住在桌面上的像素小伙伴：透明悬浮窗口、逐帧动画、心情/疲劳/好感养成、番茄钟，还能换皮肤、导入自己的素材。纯本地运行，不联网、不上传任何数据。

## 功能

- **透明桌宠窗口**：无边框、置顶、鼠标穿透，可拖动，支持点击/长按/拖拽互动
- **鼠标跟随**：点击开启跟随，宠物会跑到光标附近；进主控台自动停止，可随时取消/锁定
- **状态养成**：心情、疲劳、好感随时间和互动变化；打盹能恢复疲劳，离开太久自动休息
- **系统联动**：CPU/内存/电池指标驱动表情（发热冒汗、高负载疲惫等）
- **番茄钟**：专注/休息计时，完成记录与 7 天统计，可选完成通知
- **主控台**：状态总览、近期状态趋势图、专注记录、外观与行为设置
- **皮肤系统**：manifest 驱动的独立皮肤包，内置皮肤 + 用户皮肤分离存放
- **皮肤向导**：从图片/精灵图/文件夹/ZIP 导入，拆帧、去背、配置动作与台词；支持编辑已有皮肤
- **托盘菜单**：快速打开主控台、设置、切换皮肤、退出

## 运行

需要 Node.js 18+（含 npm）。

```bash
npm install
npm start        # 启动桌宠
npm run dev      # 开发调试模式：启动并开放 9223 调试端口
```

打包 Windows 安装包：

```bash
npm run build        # NSIS 安装包
npm run build:dir    # 仅生成目录版
```

## 测试

```bash
npm test             # 单元测试 + 端到端测试（E2E 需调试端口，未启动则跳过）
npm run test:unit    # 仅单元测试（纯 Node，无需 Electron）
npm run test:e2e     # 仅端到端测试
```

端到端测试通过 Chrome DevTools Protocol 连接正在运行的应用（调试端口 `9223`）。运行前请先启动应用并开启该端口：

```bash
electron . --remote-debugging-port=9223
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
- `actions`：动作名 → `{ frames: [...], fps, loop, mirror, bob }`
- `triggers`：事件 → 动作名（如 `longpress`、`cpu`、`mem`、`battery`、`pomodoro`、`sit`、`idlePool`）
- `behavior`：疲劳/心情变化速率等参数
- `effects`：`sleepZ` / `hotDrop` / `angryMark` 符号颜色

`sleep` / `hot` / `angry` 这类状态符号只在皮肤提供了对应专属动作帧时才绘制；没有专属动作的皮肤会回退到 `idle`，不会凭空冒出符号。`assets/skins/_TEMPLATE` 是模板目录（下划线开头不会被扫描为皮肤）。

新增或修改皮肤后，在主控台点「刷新皮肤」即可生效，无需重启。

## 数据存储

设置、状态、番茄钟统计保存在 Electron 的 `userData` 目录；导入的皮肤在 `<userData>/skins/`。可从主控台查看 `userData` 路径。状态定期自动保存，关闭窗口时同步落盘。

## 技术栈

Electron 主进程作为唯一状态源，preload 通过 `contextBridge` 暴露 IPC API；渲染层用 Canvas 逐帧绘制动画；皮肤用 manifest + ZIP 导入，写入采用原子替换与备份回滚。

## 许可证

MIT，见 [LICENSE](LICENSE)。
