# dsh-notifier

DeepSeek Harness 的提示音插件：任务完成、任务中断、需要你介入时，各响一段不同的声音，并在设置页里开关和挑选。

> **English** — Notification tones for DeepSeek Harness. A distinct sound plays on the machine running the Harness when a turn finishes, when a turn stops short, and when the agent is waiting for your approval or answer, with a settings page to switch the tones on and pick each one.

声音从**运行 Harness 的那台机器**的扬声器发出，而不是浏览器标签页：只有 Host 半侧能碰到那块声卡，所以预览与试听都由 Host 播放。

---

## 功能

- **三种事件，三段可分辨的提示音**——完成用上行琶音，中断用下行小三度，需要你介入用双声叮；默认三段音高走向不同，不看屏幕也听得出来。
- **每种事件独立选音**——内置 8 段音色，任选一段分配给任一事件；另有总开关与统一音量（0.05–1，默认 0.6）。
- **改完即生效**——所有配置项都是 `volatile()` 字段，设置页写入即被运行中的插件读取，不需要重启、不会重挂载插件（重挂载会丢会话监听）。
- **子智能体的回合不吵你**——`origin: 'subagent'` 或 `delegationDepth > 0` 的会话不发声，被委派的子任务跑几十个短回合也不会淹没真正该听的通知。
- **不会把「停」听成「完」**——`turn/end` 的 `reason` 是唯一依据：只有 `completed` 算完成，`aborted` / `error` / `max-tokens` / `blocked` / `interrupted` 以及插件扩展的未知原因一律按中断处理（未知原因宁可响一声，也不静默）；`forked` 是分叉边界，不响。
- **只是观察者，不抢答**——`approval/request` 与 `user-questions/request` 是瀑布流，插件响一声后 `next()` 交还，真正的应答仍归 Web UI。
- **没有自己的运行时依赖**——`dependencies` 为空，`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是 peer（由宿主提供、且都标为 optional）；`src/` 里的 IO 与子进程只用 Node 内置模块，音色表模块刻意不依赖任何包，Host 和浏览器半侧共用它。
- **提示音不会堆积**——同一时刻只播一段；已有声音在播时，新请求替换掉还在排队的那一个，而不是排成队列延后爆音。

## 安装

本包是 DSH 的 **bundle**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后它会自动往组合里插入一行加载器条目（`id: notifier`）。

```sh
# 普通 profile（web / headless / tui 等，用你自己的 dsh）
dsh plugin --profile <profile> add /path/to/ds-notifier

# 桌面端（desktop profile 由 Electron 独占，必须用桌面端安装的 dsh，
# 并且先完全退出应用）
dsh plugin --profile desktop add /path/to/ds-notifier
```

`dsh plugin add` 会同时更新 profile 的依赖与 `dsh.profile.bundles` 列表，不需要手写 profile manifest。装完可以确认 bundle 已进组合：desktop 之外的 profile 用 `dsh --profile <profile> --dump-config | grep -A4 notifier`（应出现一条 `id: notifier` 条目）；desktop profile 不能被 CLI 启动，直接看清单即可：`grep -A2 dsh-notifier ~/.dsh/profiles/desktop/package.json`。

> **桌面端注意**：`$DSH_HOME/profiles/desktop` 由 Electron 应用独占，**npm 安装的 dsh 无法改写它**（会报 `profile "desktop" is managed exclusively by the Electron application`）。正确顺序是：启动一次 Desktop 初始化 profile → 完全退出 → 用应用菜单 **Manage dsh Command…** 安装的 `dsh` 执行上面的命令 → 重新打开 Desktop。装/卸期间应用必须处于退出状态。

Node 版本按 `engines` 字段：`^22.19.0 || >=24.0.0`。

## 使用

打开 **设置 → 提示音**：

| 控件 | 作用 |
|---|---|
| 开启提示音 | 总开关；关掉后下面所有控件失效，任何事件都不发声 |
| 音量 | 所有事件共用，滑块拖动期间只在本地预览，松手才写入一次 |
| 每个事件的音色下拉框 | 该事件要播放的音色 |
| 试听 | 让 Host 立刻在本地扬声器上播一遍当前选中的音色 |

设置写入后由 Host 校验并落到 profile patch，`volatile` 通道把它应用回运行中的插件实例。

## 提示音

| 音色 id | 名称 | 波形 | 时长 | 默认用于 |
|---|---|---|---|---|
| `task-complete` | 上行琶音 | 马林巴音色的大三和弦上行 | 1.50 s | 任务完成 |
| `chime` | 钟声 | 泛音长尾的钟状音 | 1.80 s | — |
| `ping` | 单声叮 | 高音短促单响 | 0.55 s | — |
| `soft-tick` | 轻声嘀嗒 | 极短、低存在感 | 0.40 s | — |
| `task-interrupted` | 下行小三度 | 缓慢下行两音 | 1.20 s | 任务中断 |
| `pulse` | 双脉冲 | 同音高双击 | 0.70 s | — |
| `alarm` | 警报 | 反复交替的急切四音 | 1.30 s | — |
| `needs-input` | 双声叮 | 两个上行亮音 | 1.40 s | 需要你介入 |

全部为 16 bit 单声道 PCM WAV（44.1 kHz），在 `assets/sounds/` 里随包发布。**音色 id 是持久化的用户数据**（写进 profile patch），改名会让你已保存的选择失效，因此只能新增、不能重命名或删除。

## 配置项

由 `src/index.js` 导出的 Schemastery `Config` 定义，默认值写在 schema 上：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 所有提示音的总开关 |
| `completeTone` | 音色 id | `task-complete` | 回合正常结束时播放 |
| `interruptedTone` | 音色 id | `task-interrupted` | 回合未正常结束（取消、失败、被阻止、超 token）时播放 |
| `needsInputTone` | 音色 id | `needs-input` | 等待授权或等待回答时播放 |
| `volume` | number 0.05–1 | `0.6` | 所有提示音共用 |

非法值在源头就被拒绝：未知的音色 id 或越界的音量无法写进配置。手改过 patch、指向了已被移除的音色时，回落该事件的默认音色而不是静音。

`cordis.patch.yml` 里 `id: notifier` 那一行是本插件的组合条目，它的 `config` 是上述字段的初始值。

## 平台

`src/player.js` 按平台挑播放器，找不到就安静放弃、只在日志里 warn，绝不抛进会话事件监听器：

| 平台 | 播放命令 |
|---|---|
| macOS | `afplay -v <增益> <file>`（需要 PATH 上有 `afplay`） |
| Windows | `powershell (New-Object Media.SoundPlayer '<file>').PlaySync()` |
| Linux / BSD | 依次尝试 `paplay` → `aplay` → `ffplay` → `play(sox)` |

配置的 0.05–1 音量按各播放器自己的量纲下发：`afplay -v` 直接取 0–1（它在 0–4 之间，因此不会超出安全范围）、`paplay --volume` 映射到 0–65536、`ffplay -volume` 映射到 0–100、sox `play -v` 取 0–1。**`aplay` 与 Windows 的 `SoundPlayer` 没有音量参数**，在它们上面音量滑块不生效。

## 工作方式

```
Host 半侧 (src/)
  session/event ──→ classify.js ──→ 子智能体会话? 是则静默
  approval/request ──────────────┐
  user-questions/request ────────┤
                                 └──→ notify() ──→ tones.js（按事件取音色）
                                            └────→ player.js → OS 播放器 → 扬声器

  connection.fetch 上注册三条路由：GET /state、GET /preview、POST /test
  （同源、经鉴权的 Fetch 通道；只有 Web / 桌面端组合才有）

浏览器半侧 (lib/client.js)
  settings.section（id: notifier）：读 ctx.configForms.get('notifier') 并写回
  试听按钮 → POST /api/notifier/test，让 Host 在自己的扬声器上播
```

三个信号来自三个独立来源，因为 Harness 分别记录它们：

- **回合结束**：`session/event` 的持久化追加流，其中 `turn/end` 记录带 `reason`。
- **授权请求**：`approval/request` 瀑布流。
- **提问请求**：`user-questions/request` 瀑布流。

播放语义：`play()` 报的是「**开始播了没有**」（`started` / `skipped` / `failed`），不是「播完了」，因此不会把一次 HTTP 请求挂满整段音频；子进程 `unref()`，提示音不会拖住宿主进程退出。

### 目录

```
src/index.js     插件入口：Config、监听、三条 HTTP 路由
src/classify.js  回合结束 → 通知分类，以及子智能体会话判定
src/tones.js     音色表、默认值、音量夹取（零依赖，Host 与浏览器共用）
src/player.js    播放器选择与调度（不抛错、只保留最新一条、不阻塞调用方）
lib/client.js    浏览器半侧：手写的 ModuleLoader bundle，无构建步骤
assets/sounds/   8 段 WAV，由 scripts/generate-sounds.mjs 生成
locale/          en.json / zh.json：插件在插件市场/插件列表里的标题与描述
cordis.patch.yml bundle 补丁层：插入一条 id 为 notifier 的加载器条目
tests/           unit / host / client 三组 node:test 用例
```

### HTTP 路由

挂在 `connection.fetch` 上（Web 与桌面端组合都有；headless 组合没有 `connection`，插件仍会正常发通知，只是没有页面可读）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/notifier/state` | 实时配置、音色目录与事件表，供外部工具与测试读取 |
| GET | `/api/notifier/preview?tone=<id>` 或 `?event=<类别>` | 直接返回该音色的 WAV 字节；未知音色 400，文件缺失 404 |
| POST | `/api/notifier/test` | 让 Host 在本地扬声器播一遍（`{ tone, volume? }`），返回 `{ tone, volume, outcome }` |

设置页本身不调 `/state`：它通过共享的 `configForms` 读写配置，只有在试听时才打 `/test`。

## 开发

```sh
pnpm install          # 只装 devDependencies（schemastery / react / react-dom）
pnpm test             # 45 个用例：unit + host + client
pnpm run test:unit    # 分类、音色表、播放器命令行、WAV 资产
pnpm run test:host    # 桩 Cordis 上下文下的监听、开关、回落与三条路由
pnpm run test:client  # 真实 ModuleLoader 协议 + 真实 React 渲染的设置页
pnpm run sounds       # 重新生成 assets/sounds/*.wav（输出是确定性的）
```

没有构建步骤：`lib/client.js` 是手写并提交的产物，`src/` 就是 Node 直接跑的 ESM。改浏览器半侧就是改这个文件本身。

### 排查：某次任务到底响了没有

插件每次发声只写一行 `debug` 日志（`dsh-notifier: complete (completed) -> task-complete`）。**这一行不会出现在轨迹里，也不会落盘**——Host 侧没有日志文件，`ctx.logger` 的环形缓冲默认只收 `warn`/`error` 及以上，`debug` 连缓冲都进不去。所以「刚才那声是什么、该不该响」只能靠会话日志离线复盘：

```sh
# 本工作区最新会话 / 指定工作区 / 指定会话目录或文件都可以
node scripts/explain-tones.mjs
node scripts/explain-tones.mjs /path/to/workspace
node scripts/explain-tones.mjs ~/.dsh/sessions/<label>/<session-id>
```

它用插件自己那份 `src/classify.js` 重放 `turn/end`、`approval/asked` 和 `ask_user_question` / `exit_plan_mode` 调用，逐行列出该响什么音、以及为什么静默（`forked` 边界、子智能体会话）。两处容易误判的边界：

- **子智能体会话整场静默**：委派出去的回合、以及子智能体内部的授权与提问都不会响，只有顶层会话的事件才发声。
- **瀑布流事件本身不落盘**：`approval/asked` 与 `user-questions/request` 的调用记录是「该响过 `needs-input`」最接近的耐久证据；权限策略为 `never` 时授权不走瀑布流，也就不会响。

会话日志是**多帧 zstd 拼接**：`zstd -dc` 能完整解，但 `zlib.zstdDecompressSync()` 只解第一帧、只会读到 header 那一行——脚本已按 magic 逐帧处理。要在运行期看到真实日志行，只能给该 Loader 条目加 `intercept: { logger: { level: 3 } }` 把 `debug` 放进环形缓冲，这属于临时调试手段，不是本插件的能力。

## 已知限制

- 设置页只在 Web / 桌面端组合存在；headless 组合里插件照常发声，但没有页面与 HTTP 路由。
- 没有任何系统播放器可用时（例如精简容器里的 Linux），提示音静默跳过并写一条 warn——这是刻意的降级，不是错误。
- 浏览器半侧只从 Host 拿「试听」，不参与发声；浏览器静音、标签页在后台都不影响提示音。
- 本包目前 `private: true`，不发布到 npm；请以本地 checkout 或 tarball 方式安装。

## 许可证

`package.json` 声明 `license: MIT`（仓库当前未随附独立的 LICENSE 文本）；本包另标 `private: true`，不面向 npm 发布。
