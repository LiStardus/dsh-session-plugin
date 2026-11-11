# @LiStardus/dsh-session-delete

> **本地分支 v0.1.12**（维护者：@LiStardus）：基于 `@heeweelee/dsh-session-plugin` 0.1.11（MIT）修改维护，保留原作者署名与 LICENSE。
> 本地改动：① 删除白名单支持 DSH 0.2.x 的 `session.v4.jsonl[.zstd]`；② 删除后清理改为 `unarchiveSession`/`unpinSession` 清墓碑（修复新版 UI「未命名工作区」归档幽灵）；③ 删除时清理 `session_projcache` 投影缓存（修复「未分组」幽灵行）；④ 删除时从会话 store detach live 会话条目（修复幽灵行与投影缓存反复复活）。
> 以下为原 README（保留原文以存档原作者说明）。

一个可安装的 DeepSeek Harness（DSH）插件，把「输入框历史回填」和「会话右键彻底删除」作为发布包提供。

> ⚠️ **删除是彻底删除本地会话记录，不可恢复，不是归档/隐藏。** 执行后该会话的本地日志目录（`session.jsonl[.zstd]`）即被移除。0.1.7 及更早版本的「归档该会话」只是隐藏，升级到 0.1.8 后右键菜单的同一位置改为真删除；此前已归档（隐藏）但未删除的会话仍只是隐藏，需要再手动删除一次才会真正消失。

- **输入框历史**：在输入框聚焦时按 `↑` 回填上一条你发过的消息，继续 `↑/↓` 切换；有草稿时按 `↑` 会先暂存草稿，`↓` 走到底恢复它（无草稿则落到空输入框）。会话标题栏的 `↑ 历史 N` 按钮显示条数与当前位置（`i/N`），旁边的 `▾` 打开可搜索的历史列表（点击回填，`×` 隐藏单条）。
- **右键删除**：在工作区左侧会话列表里右键某个会话 →「删除该会话…」→ 二次确认后**永久删除该会话的本地日志文件**。只有真正在干活的会话会被拒绝（409：正在生成中 / 有后台任务在跑，等完成后再删）；空闲会话——包括当前正在查看的那个——都可以直接删。

## 快速上手

1. 安装本包（见「安装」），重启 DSH 使其生效。
2. 把光标点到输入框，按 `↑` 回填上一条你发过的话；再按 `↑`/`↓` 在历史里上下切换；按 `↓` 到最后会恢复进入回填前暂存的草稿（没有则清空输入框）。
3. 点标题栏 `▾` 可搜索历史、点选回填、用 `×` 隐藏不想再提示的条目（仅隐藏回填，不改会话记录）。
4. 想彻底删除一个会话，到左侧会话列表右键它 →「删除该会话…」→ 二次确认。**文件级删除，不可恢复**；删除后该行即时隐藏，当前输入框草稿不受影响；若提示“正在生成/有后台任务”，等本轮或任务完成后即可删除，无需切换会话。删的是当前正在查看的会话时，确认框会额外提醒，删后请切换到其他会话（否则在此继续发送会重建该会话的记录）。

## 安装

```bash
dsh plugin add github:LiStardus/dsh-session-delete
```

或在 DSH Desktop 的 **设置 > 插件** 市场中安装。安装后重启 DSH 使新包生效。

## 卸载

```bash
dsh plugin remove @LiStardus/dsh-session-delete
```

或从 **设置 > 插件** 里禁用/移除；随后重启 DSH。卸载只移除本插件，不会影响已删除（已消失）或已归档（隐藏）的会话数据。

## 配置

可选：在 `DSH_HOME`（默认 `~/.dsh`）下放一个 `dsh-session-plugin.json`：

```json
{ "historyLimit": 200, "maxCharsPerEntry": 4000, "disableDiskCache": false }
```

- `historyLimit`（默认 **100**，上限 10000）：每会话保留最近 N 条用户消息；改完需重启 DSH 生效。调大后旧缓存视为过期，会自动重读一次全量日志补满窗口。
- `maxCharsPerEntry`（默认 **4000**，上限 20000）：单条回填文本截断长度，防止一次超大粘贴撑爆内存/磁盘；超长会缀 `…（已截断）`。
- `disableDiskCache`（默认 false）：设 true 则不写磁盘缓存（仅内存 1s TTL），适合不希望明文落盘的机器；开启后启动时会自动删掉此前留下的旧缓存文件。
- 插件还会在同目录写一个缓存文件 `dsh-session-plugin-history-cache.json`（0600 权限，仅所有者可读写），
  用于重启后加速首次召回，可随时删除，会自动重建。缓存为明文用户文本，请注意多用户机器的文件权限。

## 删除与恢复

- 「删除该会话」**永久删除该会话的本地日志目录**（`session.jsonl` 或 `session.jsonl.zstd` 及其空父目录），**不可恢复**，并且**从工作区列表中彻底消失**（0.1.9 起不再留下可点的幽灵行）。DSH 官方只提供归档（隐藏）接口，没有删除接口，因此本插件经 `sessionPersistence.locate(header)` 定位后端文件后直接移除——删前会校验文件名为且仅为会话产物形态，形态不符则拒绝。
- 「忙」按是否真在干活判定（0.1.11 起）：`agent.status === 'running'`（正在生成）或 `jobs` 服务列出该会话未完结的后台任务时拒绝删除（409，body 带 `reason: running/jobs`，客户端据此分别提示），等本轮/任务完成后即可删除——**无需先切换会话**。只是挂载着、空闲的会话（含当前正在查看的）会在删前先经 store flush 把写缓冲刷盘、复查一次忙闲后再移除文件。删的是当前会话时确认框会额外提醒，删后请切换到其他会话：内存中的 agent/会话对象没有官方卸载接口，会比文件多活一会儿，在此继续发送会重建该会话的记录。删前校验：绝对路径、文件名且仅为会话产物形态、父目录与会话 id 同名、不在 home/配置根、不经过 symlink——任一不符直接拒绝。文件移除后会经官方 `workspaceRegistry.detachSession` 清掉工作区挂载关系，并经 `archiveSession` 下发隐藏 feed——被删行即时消失，点进去报“会话删除了”的幽灵行即为此 bug（0.1.8 只删文件不等工作区，已在 0.1.9 修复）。附件不在删除范围内；`archivedSessionIds` 里会留下一条该 id 的隐藏标记（官方隐藏机制本身，无 unarchive 接口可清，不可见、无害，重启后会话本身已不存在）。
- 删除后本插件自带的该会话回填缓存（内存 + 磁盘）与浏览器 `localStorage` 隐藏记录一并清理；客户端同时从会话 store 移除该行并拉取新基线，React 重渲染也不会复活幽灵行。
- 执行后不再整页 reload：当前输入框草稿、滚动位置保留；被删行即时消失（工作区 feed + 会话列表刷新双通道）。
- 从 0.1.7 升级：旧「归档」只是隐藏，升级后菜单同位置变为真删除；之前已归档的会话如需真删除，请再手动删除一次。

## 权限与数据

- 本包没有运行期 npm 依赖，运行时代码是你的本地用户权限。
- Host 三个路由是同源、无鉴权的进程内接口：
  - `GET  /api/dsh-session-plugin/history?sessionId=` — 只读该会话 `user/message` 文本历史；
  - `GET  /api/dsh-session-plugin/sessions` — 只读会话 `{id, title}` 列表；
  - `POST /api/dsh-session-plugin/delete` — `{sessionId}` **彻底删除本地会话记录（不可恢复）**；`POST /api/dsh-session-plugin/archive` 为旧客户端兼容别名，自 0.1.8 起行为与 `/delete` 完全一致（同样真删除）。
- 历史读取是只读操作；删除路由返回 `409（busy：running/jobs/busy，body 带 reason）/404（不存在）/501（后端不支持）` 区分失败原因。
- 防 CSRF：删除路由要求请求同时携带自定义头 `x-dsh-csrf: 1` 且
  `Origin` 为空或与本机同源——跨站页面发出的简单 POST 无法满足，会被 403 拒绝。
  两个 GET 只读路由同样校验 `Origin` 为空或同源，并拒绝非 GET 方法。
- `sessionId` 统一白名单校验（仅字母数字/`_`/`-`/`:`，≤240 字符），非法直接 400。
- 「删除该会话」默认二次确认后才执行；右键菜单限定工作区会话列表容器，文件树等其它 treeitem 不会误触发。
- `GET /history?refresh=1`（发送后对账用）每会话 2 秒至多一次全量重放，节流命中返回缓存并标记 `throttled:true`。

## 兼容性

- 依赖 DSH `>=0.1.0-rc.7` 运行时（`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-workspace` 均为 `>=0.1.0-rc.7` 范围声明）；删除路径另经 `ctx.get('sessionPersistence')` / `ctx.get('sessions')` 可选解析文件位置与 live 状态（缺失时返回 501 而非挂载失败）。旧的非 scoped `cordis` 会被商店受管安装器拒绝。该值是**最低验证版本**，不是上限：`0.1.2-alpha.1`（DSH Desktop 2.0.4）上本包依赖的 Host 契约 `sessionQuery.readSession/listSessions`、`webServer.register({kind:'exact'})` 与 slot `conversation.session.header.actions` / `shell.overlay` 及标准 props `useInput` / `inputActions` / `sessionId` 均保持不变；删除后的工作区清理依赖 `workspaceRegistry.detachSession` + `workspaceRegistry.archiveSession`（0.1.9 起；若宿主缺失这两个接口，文件仍会被删除，只是列表行需重启后消失）。
- **输入框形态跨版本兼容**：DSH 2.0.4 起 composer 是 shell 所有的 Lexical 编辑器（`div[contenteditable][role=textbox][data-composer-input][data-phase]`），此前是受控 `<textarea data-phase>`。本包 0.1.6 起两种形态都识别（见 `isComposerSurface`），所以 ↑/↓ 在新旧 DSH 上都工作。若你维护的是 0.1.5 及更早版本，升级到 2.0.4 后 ↑/↓ 会静默失效。
- Node `^22.19.0 || >=24`（与 DSH Desktop 内置 Node 运行时一致）。

## 架构

这是从动态 Cordis 插件 `sess-7/pkg-9`（"Session Input History + Archive"）1:1 移植而来的发布包，二者共用同一套 Cordis 模型（`apply(ctx)`），只有 RPC 传输方式改变：

| 动态插件 | 本发布包 |
| --- | --- |
| `harness.handle(...)` / `host.call(...)` | Host `webServer` JSON 路由 + Client `fetch('/api/dsh-session-plugin/...')` |
| `ctx.get('slots')` | `ctx.slots`（`inject: ['slots', 'timer']`） |

### Host（`index.js`）

- `inject: ['sessionQuery', 'workspaceRegistry', 'webServer']`（删除路径另经 `ctx.get('sessionPersistence')` / `ctx.get('sessions')` 可选服务定位文件与判定 live）
- 注册三个路由（见「权限与数据」；删除为 `POST /delete`，`/archive` 为兼容别名）。

### Client（`dist/client.js`）

- `inject: ['slots', 'timer']`
- 注册 `conversation.session.header.actions`（`↑ 历史 N` 按钮 + `▾` 历史列表 + `↑/↓` 键盘监听）和 `shell.overlay`（toast + 右键菜单）。
- 输入框表面统一由 `isComposerSurface` / `findComposerSurface` 判定（`data-phase` + `<textarea>` 或 `div[data-composer-input]`），`domForceWrite` 只服务于 textarea 形态；Lexical 形态下写入只走 `inputActions.setDraft()`。
- 回填模型：confirmed（Host 日志对账）+ pending（10s 兜底）+ forgotten（localStorage 隐藏集）+ 连续去重；切会话用代际 token 防旧请求覆盖新会话。

## 目录结构与发布

```
index.js             Host 入口（ESM，直接可运行）
dist/client.js       Client 入口（window.__ModuleLoader__ 预打包格式）
cordis.patch.yml     bundle patch（插入到 profile 组合）
package.json         声明 dsh.bundle.patch / dsh.client / exports
```

`dist/client.js` 是手写的模块加载器 bundle（与内置插件 `lib/client.js` 相同的
`window.__ModuleLoader__.load({ id, factory })` 线格式）。发布前建议用 DSH 插件
构建链重新生成该文件，并核对 `id` 等于包名 `@LiStardus/dsh-session-delete`。

## 故障排查

- **重启后按钮/回填不出现**：确认 `@LiStardus/dsh-session-delete` 在 profile 的 `dsh.profile.bundles` 里，且已重启 DSH。
- **按 `↑`/`↓` 没反应**：先点一下输入框让光标聚焦；`↑` 会接管并暂存草稿，`↓` 仅在回填状态下导航（编辑器多行光标优先），输入法候选中的方向键一律放行。用 0.1.5 及更早版本 + DSH 2.0.4+ 时按键必然无响应（只认 `<textarea>`），请升级到 0.1.6+。
- **区分「插件没挂载」和「按键守卫不匹配」**：点会话标题栏的「↑ 历史」按钮——它不走按键守卫。能回填或弹出提示说明插件已挂载、Host 路由正常，问题只在按键那侧；按钮本身不出现，则去 **设置 > 插件 > 插件清单** 看该条目的状态圆点是否处于已挂载 phase。
- **回填的历史不完整**：历史来源是 `user/message` 事件文本；图片、引用等非文本内容不进入回填文本。含 `@文件` 的引用在发送时即拍平成 `@path` 字面文本，回填时会以 `@path` 文本形式还原。超长单条按 `maxCharsPerEntry` 截断。
- **打完字没发送、手动清空后还出现在历史里**：0.1.3 及以前版本存在该问题；0.1.4 起改为「发送后与 Host 日志对账 + 10 秒兜底过期」，未真正发送的内容不会留存。
- **「删除该会话」点了没反应**：需在工作区**左侧会话列表**的条目上右键触发（文件树右键不会触发，这是刻意收紧）；二次确认后才执行彻底删除，被删行即时隐藏，无需整页刷新。若提示“正在生成/有后台任务”，等本轮或任务完成后即可删除，无需切换会话；删的是当前会话时删后请切换到其他会话。若提示“无法确定归属”，说明 DSH 界面结构变化导致 fiber 定位失效且标题不唯一，请重命名后重试并反馈。
- **某条不想再被提示**：点 `▾` 历史列表中该条右侧 `×`，仅隐藏回填（不改会话记录）；清掉对应 `localStorage`（`dsh-session-plugin:forgotten:<sessionId>`）可恢复。
- **删错了能恢复吗**：不能。删除是文件级永久移除，请确认后再点第二次确认。

## 安全边界

本包没有运行期 npm 依赖，Host 三个路由为同源、无鉴权的进程内接口；删除路由
**永久移除本地会话日志文件，不可恢复**（0.1.8 起；0.1.7 及更早为归档隐藏）。
商店收录/安装不构成安全背书——安装后代码以
本地用户权限运行。

## 许可证

MIT