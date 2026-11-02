# AGENTS.md

给在本仓库里工作的智能体的常驻规则。产品说明见 [README.md](README.md)，这里只写「改了会坏什么」和必须守住的契约。

先读 [README.md](README.md) 的工作方式一节，再动 `src/` 或 `lib/`。

## 命令

```sh
pnpm install                     # 只有 devDependencies：schemastery / react / react-dom
pnpm test                        # 唯一的门禁：45 个用例，必须全绿
pnpm run test:unit               # 分类 / 音色表 / 播放器命令行 / WAV 资产
pnpm run test:host               # 桩 Cordis 上下文下的监听、开关、回落、三条路由
pnpm run test:client             # 真实 ModuleLoader 协议 + 真实 React 渲染的设置页
pnpm run sounds                  # 重新生成 assets/sounds/*.wav（确定性输出，可逐字节比对）
```

没有构建、没有 lint、没有类型检查步骤。改完跑 `pnpm test`，这是唯一可依赖的信号。

## 不可打破的契约

### 1. 音色 id 是持久化的用户数据

`TONES[].id` 会写进用户的 profile patch。**只能新增，不能重命名、不能删除**——改名等于静默改掉所有人已保存的选择。删掉的 id 会让 `toneFor()` 回落到该事件的默认音色（这是有意的降级），但那属于用户可感知的行为变化，不是内部重构。

新增一段音色要同步改**六处**，少一处测试就会红：

| 位置 | 改什么 |
|---|---|
| `scripts/generate-sounds.mjs` | `TONES` 表里加一条（时长、音高走向、包络） |
| `assets/sounds/<id>.wav` | 跑 `pnpm run sounds` 生成并提交 |
| `src/tones.js` | `TONES` 里加条目（`id` / `file` / `durationMs`） |
| `lib/client.js` | `FALLBACK_CATALOG` 加上新 id |
| `lib/client.js` | `DICT.en` 与 `DICT.zh` 各加 `'tone.<id>'` 标签 |
| 本文件与 [README.md](README.md) | 音色表各补一行 |

`tests/client.test.js` 强制 `FALLBACK_CATALOG` 与 Host 的 `TONE_IDS` 一致，并强制 `en` / `zh` 两份字典键集相同、每个 `tone.<id>` 都有标签。

### 2. 每个 Config 字段都必须是 `volatile()`

设置页写配置走 `ctx.configForms` → profile patch → volatile 通道就地更新运行中的实例。漏掉 `.volatile()` 会让写入变成重挂载插件，**直接丢掉已注册的会话监听**，提示音从此不响且不报错。新增字段时保持 `z.<type>().default(...).volatile()` 的形状，别把 `volatile()` 挪到被复用的子 schema 上。

### 3. 两个瀑布流只能观察，不能应答

`approval/request` 与 `user-questions/request` 的应答权归 Web UI。监听器必须响一声后 `return next()`；不要 `void next()`、不要在 `next()` 之后再做任何可能抛错的事、不要自己构造答案。测试会断言监听器的返回值就是下游的真实决定。

### 4. 监听器里绝不抛错

`session/event` 监听器跑在会话的持久化追加路径上。提示音失败只能降级成 `logger.warn` / `logger.debug`：找不到播放器、文件缺失、spawn 失败都必须吞掉（`src/player.js` 已实现，改它别破坏这条）。同理，`play()` 报的是「**开始播了没有**」，不要改成 await 整段音频——那会把 HTTP 请求挂满整段时长。

### 5. 子智能体的回合必须静音

`isSubagentSession()` 过滤 `origin: 'subagent'` 或 `delegationDepth > 0`。去掉它，委派子任务会把用户扬声器淹没。改判定逻辑就同步更新 `tests/unit.test.js` 的子智能体判定用例与 `tests/host.test.js` 的 `a fork boundary and a delegated child turn stay silent`。

### 6. 只有 `completed` 算「完成」

分类规则在 `src/classify.js`：`completed` → `complete`；`aborted` / `error` / `max-tokens` / `blocked` / `interrupted` 以及插件扩展的未知 reason → `interrupted`；`forked` → 静默。未知 reason **响一声**而不是静默（宁可吵一下，也别让人以为任务还在跑），这条别「顺手改成更安静」。

### 7. headless 组合没有 `settings` 与 `connection`

`ctx.inject(['settings'])` 和 `ctx.inject(['connection'])` 的回调只在服务存在时运行。任何新的服务依赖都要包在 `inject` 里，并且回调外不能假定它存在——headless 组合仍须正常加载、正常发声，只是没有设置页和 HTTP 路由。`tests/host.test.js` 的桩按依赖名分发，正是为了复现这一点（见下）。

### 8. 浏览器半侧是手写的，没有构建步骤

`lib/client.js` 是**提交进仓库的产物**，不是从 `src/` 生成的。它必须保持：

- `window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS factory 形状；
- `id` 等于 `package.json.name`（`dsh-notifier`）；
- 只 `require('react')`，其它平台模块要靠 `dsh.client.external` 显式声明（测试断言 `requested` 恰好是 `['react']`）；
- CSS 类名一律带 `dsn_` 前缀（测试逐条校验）；
- 样式全部用 `--dsw-*` 主题 token（绝大多数是 `--dsw-alias-*`，中性色用 `--dsw-static-*`），别写死颜色——否则深浅色模式只有一套配色。

改宿主侧 `src/` 不会动到这里；改页面就是直接改这个文件。

### 9. bundle 条目只有一行，id 与裸包名都不能改

`cordis.patch.yml` 的条目必须 `id: notifier`、`name: 'dsh-notifier'`：

- 客户端模块系统只把 `dsh.client` 声明的半侧挂在**说明符恰为裸包名**的那一行上，换成子路径就永远不带半侧；
- `notifier` 是设置页 `ctx.configForms.get('notifier')` 与 `ENTRY_ID` 的命名空间，改了页面就找不到自己。

### 10. `src/tones.js` 保持零依赖

浏览器半侧镜像了同一份音色表；这个模块一旦引入任何包（哪怕是 Node 内置），就不能再被两侧共用。这是它存在的理由，不要往里面塞 IO 或 environment 判断。

### 11. 提示音只播最新一条

`player.js` 的队列语义：正在播时，新请求**替换**排队项，而不是排队。播放器子进程 `unref()`，不拖住宿主退出；卸载插件时 `stop()` 释放当前音并丢弃队列。

## 测试写法

三组用例都是 `node:test`，无框架、无 mock 库。

- **`tests/host.test.js` 的桩按依赖名分发**：`inject(deps, cb)` 只在该组合确实提供全部命名服务时才同步调用 `cb`，否则推迟——这正是 Cordis 的语义，也是 headless 组合没有 `settings` / `connection` 时插件仍能加载的原因。忽略这一点，桩会在 `ctx.settings` 为空时调用回调，一次性打掉全部 host 用例。给插件加服务依赖时，先在 `servicesOf()` 里补桩，再写断言。
- **配置传入两种形状都要覆盖**：Cordis 传 volatile 引用树，脱离 Loader 的宿主传纯值。`valueOf()` 同时吃两种，测试各有一条。
- **断言可观测行为，不要断言实现细节**：提示音是否响，看 `record.debug` 里 `-> <tone-id>` 那一行；播放器是否启动，看注入的 `spawn` 收到的命令行。
- **浏览器半侧的渲染用例在没有 `node_modules` 时会跳过**（`t.diagnostic` 说明），别把它当成必须本地装 React 的理由。
- 加新音色 / 新路由 / 新配置字段时，**同时**加一条会因遗漏而失败的用例。

## 提交前

1. `pnpm test` 全绿（45 passed, 0 failed）。
2. 若新增或改动了音色：`pnpm run sounds` 后 `git status` 里 WAV 的改动与 `tones.js`、两份字典、`FALLBACK_CATALOG` 一致。
3. 若改了 `package.json` 的 `files`：确认 `assets`、`lib`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md` 全在，否则安装版会缺文件。`AGENTS.md` 是开发文档，刻意不进 `files`。
4. 若改了对外行为（新配置字段、新路由、默认音色变化）：更新 [README.md](README.md) 与 `locale/*.json` 的描述。
