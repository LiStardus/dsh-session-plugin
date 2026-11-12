# 更新日志 / Changelog

所有对外可见的变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循语义化版本。

## [0.1.14] - 2026-11-12

### 变更

- 文档：安装段同时提供 npm（推荐）与 GitHub 两种安装命令。

## [0.1.13] - 2026-11-11

### 变更

- **包名全小写化**：`@listardus/dsh-session-plugin`（npm 拒绝含大写字母的包名，影响商店/市场安装与 DSH CLI 解析）。
- `/archive` 遗留别名加版本门：仅当请求头 `x-dsh-plugin-version >= 0.1.8` 放行；0.1.6/0.1.7 客户端（不发该头）被 426 拒绝，杜绝「以为归档、实为永久删除」。客户端所有请求现携带该头。
- 删除**当前**会话后客户端自动切换到其他会话（依次尝试会话服务导航钩子 → 点「新会话」按钮 → 退回提醒文案）。

### 修复 / 加固

- `cleanupWorkspaceAfterDelete` 的静默 `catch {}` 全部改为 `ctx.logger.debug` 降级日志：保留 try/catch 不再 500，但宿主签名变化会留下线索。
- 磁盘缓存新增 32MB 字节上限（原先只限 128 会话、不限字节，最坏可近 50MB 明文），超限按 ts 淘汰。
- `/sessions` 标题读取改为 `size:mtime` 签名缓存：未变更文件不再重复读盘；无法定位时退化为 60s TTL。右键菜单打开不再 O(n) 读盘。
- 删除路径安全校验抽为 `safety.js` 并新增单测 `test/delete-safety.test.js`（8 例：形状白名单、路径穿越、文件系统根、归属检查、home/config 根、符号链接目录/文件、合法路径放行），`npm test` 运行。

## [0.1.12] - 2026-11-11

### 变更

- **项目更名为 `@listardus/dsh-session-plugin`**（本地分支，维护者 @LiStardus；基于 `@heeweelee/dsh-session-plugin` 0.1.11，MIT，保留原作者署名与 LICENSE）。安装/卸载命令、仓库链接更新为 [github.com/listardus/dsh-session-plugin](https://github.com/listardus/dsh-session-plugin)。

### 修复（适配 DSH 0.2.x）

- **删除报 500**：删除白名单支持 DSH 0.2.x 的 `session.v4.jsonl[.zstd]` 会话产物命名。
- **「未命名工作区」归档幽灵**：删除后改用 `unarchiveSession`/`unpinSession` 清墓碑，不再留归档标记（新版 UI 会渲染归档 id，旧版是过滤）。
- **「未分组」幽灵行**：删除时清理 `session_projcache` 投影缓存条目。
- **幽灵行反复复活**：删除时从会话 store detach live 条目（`liveEntryFor().detach()`，官方移除路径），已删但仍挂载的会话不再进列表索引、不再重写投影缓存。

## [0.1.11] - 2026-09-05

### 变更

- **删除规则改为“忙才拒”**：此前只要挂载了 agent 就 409——而看一眼会话就会挂载其 agent，等于空闲的当前会话永远删不掉。现仅当 `agent.status === 'running'`（正在生成）或 `jobs` 服务列出该会话未完结的后台任务时拒绝（409，body 新增 `reason: running/jobs/busy`）；挂载但空闲的会话（含当前正在查看的）删前经 store flush + 复查忙闲后可直接删除。
- **409 提示精确化**：客户端按 `reason` 区分“正在生成中”与“有后台任务在跑”，不再一律说“切换到其他会话”；未知形态 fail-closed（按忙处理），无 `agents` 服务的未知宿主保持严格模式。
- **删当前会话的提醒**：确认框在目标为当前会话时追加提醒行；删后 toast 提示切换到其他会话（内存中的 agent/会话对象无官方卸载接口，滞留在此继续发送会重建该会话的记录）。

## [0.1.10] - 2026-09-05

### 修复

- **v1 磁盘缓存不再永不过期**：无 `limit` 字段的旧条目只在 `historyLimit` 仍为默认值时视为有效，调大窗口后会自动重读一次全量日志补满（此前旧截断列表被永久沿用）。
- **live 误判**：agent/会话挂载判空同时接受 `null` 与 `undefined`（此前宿主返回 `null` 会被误判为 live，冷会话全部 409 删不掉）。
- **异步 `registry.list()` 不再跳过 detach**：`cleanupWorkspaceAfterDelete` 兼容同步/异步两种返回，异步注册表此前因 Promise 不可迭代被吞掉、幽灵行复发。
- **删前二次 live 复查**：`flush` 之后、`rm` 之前再查一次 agent 挂载，把并发 send 的竞态窗口压到 `rm` 本身。
- **删除路径收紧**：绝对路径 + 产物文件名 + 父目录与会话 id 同名 + 排除 home/配置根 + 产物与父目录均非 symlink，任一不符直接拒绝（此前只验文件名与非根目录）。
- **`disableDiskCache:true` 清理旧明文**：启动时删掉此前留下的磁盘缓存文件；崩溃残留的 `*.pid.ts.tmp` 启动时一并清理。
- **`lastForceAt` 节流表加 256 上限**：最老条目优先淘汰，此前无界增长。
- **文档对齐**：安装命令升到 0.1.10；修正兼容性段“不再依赖 `archiveSession`”的过时描述（0.1.9 起工作区清理依赖它）；CHANGELOG 版本链接改为完整 URL 并补 0.1.9/0.1.10。

## [0.1.9] - 2026-09-05

### 修复

- **删除后工作区不再留下可点的幽灵行**：0.1.8 只删了磁盘文件，工作区注册（`sessionIds`）与客户端会话列表仍保留该 id，于是行还在、点进去才报“会话删除了”。现文件 `rm` 成功后（以及文件已不在、header 已不可解析的 404 路径同样）经官方接口 `workspaceRegistry.detachSession` 清掉各工作区的挂载关系，再经 `workspaceRegistry.archiveSession` 下发隐藏 feed——被删行即时从工作区消失，无需 reload；重启后持久层本来就没有它，不会回魂。`archivedSessionIds` 会留一条该 id 的不可见隐藏标记（官方机制无 unarchive 接口可清，无害）。
- **客户端不再靠 DOM `display:none` 假隐藏**：React 重渲染会复活假隐藏的行。现成功后清掉自有 `/sessions` 回退缓存，经 `ctx.get('sessions').handleSessionRemoved(sid)` 即时从会话 manager 移除，再调 `refresh()` 拉新基线确认；工作区 feed 与列表刷新双通道保证幽灵行不复活，当前草稿与滚动不受影响。
- **`/sessions` 过滤已归档（含刚删除）id**：标题回退查找不再用已隐藏的旧标题匹配到已删除的会话。

## [0.1.8] - 2026-09-05

### 破坏性变更

- **右键删除改为彻底删除本地会话记录（不可恢复），不再是归档/隐藏**：`POST /delete`（及兼容别名 `POST /archive`，行为一致）经 `sessionPersistence.locate(header)` 定位后端文件后移除 `<sessionDir>/session.jsonl[.zstd]` 及其空父目录。DSH 官方没有删除会话接口（`workspaceRegistry.archiveSession` 仅隐藏），因此本插件直接操作本地文件；附件、工作区注册信息与 `archivedSessionIds` 旧隐藏标记不在删除范围内。
- **Live 会话拒绝删除**：按 agent 运行时判定（`agents.get(id)` 命中即 409，可能正在生成；切走会话即卸载其 agent）。常驻 store（切视图不 detach）不再作为拒绝依据，否则切走也删不掉；常驻未挂载 agent 的会话先经 store `flush` 刷盘再删；无 `agents` 服务的未知 Host 回退到严格模式。路径形态校验不符（非 `session.jsonl[.zstd]` 绝对路径）直接拒绝删除。
- 客户端文案同步「归档」→「删除」，确认态增加不可恢复警告行；成功态清掉该会话的 `localStorage` 隐藏集并派发 `dsh-session-plugin:deleted`（兼容保留 `archived` 事件）；409/404/501 分别提示“使用中/已不存在/后端不支持”。
- 从 0.1.7 升级注意：旧「归档」只是隐藏，升级后同位置变为真删除；之前已归档的会话需再手动删除一次才会真正消失。

### 修复

- **右键菜单被容器门禁误杀**：0.1.7 收紧的 `[data-dsh-role="session-list"]` 容器检查在真实 DSH DOM 里一个都匹配不上（工作区 UI 源码里零 `data-dsh-role` 属性），导致右键无菜单。现去掉容器白名单，改以 React fiber 记录（`{node}`/`{result}`）为权威判定（非会话行恒为 null），标题回退保持唯一匹配；搜索结果标题选择器兼容大写 `Title`。
- 删除后同步清理本插件该会话的内存/TTL/磁盘回填缓存与 `lastForceAt` 节流表，已删文本不再出现在 `↑` 历史里。

## [0.1.7] - 2026-09-05

### 修复

- **Toast 自动消失恢复**：`toast()` 自增 `id` 从未写入 store，超时回调 `store.toast.id === id` 恒为 false，第一条提示常驻。现写入 `{msg, id}`，连续提示互不截断。
- **发送对账竞态**：前一次 `refresh=1` 仍在飞行时，新发送直接丢弃对账，pending 滞留至过期。现改为飞行中延迟 800ms 重试，且成功后若仍有 pending 再补约一次（最多 2 轮）。
- **切会话竞态**：新旧会话请求无代际隔离，慢请求会覆盖新会话列表。现加 `loadSeq` 代际 token + `sessionId` 双重校验。
- **右键误触发文件树**：容器选择器 `[class*="session"], nav, aside` 会命中文件管理器等其它 treeitem。现收紧为 `[data-dsh-role="session-list/workspacesession-search"]`，非会话列表直接忽略；`sid` 为空且非重名时不再展示归档项，转为“无法确定归属”提示。
- **菜单越界裁剪**：右/下边缘右键菜单被视口裁掉。现钳制 `min(x, innerWidth-190)` / `min(y, innerHeight-150)`。
- **`sessionId` 非法输入**：GET/POST 均只做长度校验，`../` 等可透传。现统一白名单 `^[A-Za-z0-9_:\-]{1,240}$`，非法 400。
- **读路由无防护**：`/history`、`/sessions` 接受任意 method、无 Origin 校验。现非 GET 405，跨站 Origin 403（与 `archive` 复用 `isOriginSafe`）。
- **`/sessions` N+1 串行**：`readTitle` 逐个 await。现 8 并发 worker 池。
- **`refresh=1` 可打爆全量重放**：现每会话 2 秒至多一次强制重放，节流命中走缓存并回 `throttled:true`。
- **缓存权限与爆炸半径**：磁盘缓存 0644 明文 → 0600（写时 `mode` + 双 `chmod`）；单条新增 `maxCharsPerEntry`（默认 4000、上限 20000）截断；磁盘项记录 `limit`，`historyLimit` 调大后旧截断缓存自动失效重读；`disableDiskCache:true` 可完全关闭落盘。
- **卸载泄漏**：`ctx.effect` 清理新增 `clearTimeout(saveTimer)` + `historyCache.clear()` + `lastForceAt.clear()`，定时器 `unref()` 不拖住 Host 退出。
- **归档整页 reload 丢草稿**：`archive` 成功后 `window.location.reload()` 改为乐观隐藏该行 + 派发 `dsh-session-plugin:archived` 事件 + toast，不再销毁当前草稿与滚动状态。

### 新增

- **历史列表面板**：标题栏 `↑ 历史 N` 显示条数/位置（`i/N`），`▾` 打开可搜索列表（最近 30 条匹配），点击回填，`×` 隐藏单条（`localStorage dsh-session-plugin:forgotten:<sessionId>`，仅隐藏回填、不改会话日志）。
- **草稿暂存/恢复**：有草稿时按 `↑` 直接进回填（旧行为拒绝），`↓` 到底恢复暂存草稿；真实发送清空暂存。
- **连续去重**：回填视图折叠连续重复文本。
- **请求超时与缓存**：`fetch` 8s `AbortController` 超时；`/sessions` 右键 fallback 5s 记忆缓存。
- **配置项**：`dsh-session-plugin.json` 新增 `maxCharsPerEntry`、`disableDiskCache`（见 README）。
- **主题变量**：toast/菜单/面板改用 `var(--dsh-*)` + 深色兜底，浅色主题不再瞎眼；hover 高亮统一半透明。

### 变更

- 文案「删除该会话」→「归档该会话」（确认态同），toast 同步；`peerDependencies` 精确钉 `0.1.0-rc.7` → 范围 `>=0.1.0-rc.7`（最低验证版本语义）。
- `package.json` 版本 0.1.6 → 0.1.7；磁盘缓存 `version` 1 → 2（含 `limit` 字段，旧缓存惰性迁移）。

## [0.1.6] - 2026-09-01

### 修复

- **↑/↓ 在 DSH 2.0.4 之后恢复可用**：DSH 2.0.4 把 composer 从受控 `<textarea data-phase>` 换成了 shell 所有的 Lexical 编辑器（`<div contenteditable role="textbox" data-composer-input data-phase>`），而按键守卫硬编码要求 `activeElement.tagName === 'TEXTAREA'`，于是每次 ↑/↓ 都在守卫处 return——不回填、不弹提示，表现为完全无响应。现在所有 composer 表面判定统一走 `isComposerSurface` / `findComposerSurface`，同时接受 textarea 与 Lexical contenteditable 两种形态，跨这次升级都可用。
- **不再对 contenteditable 强写 DOM**：`programmaticSet` / `programmaticClear` 的值核查与「原生 value setter + 冒泡 `input` 事件」兜底只在真正的 `<textarea>` 上执行。Lexical 形态下 `inputActions.setDraft()` 本身就是权威写入（它重写编辑器并已 `selectEnd()` 落好光标），强写 `.value` 只会和编辑器抢 DOM。
- **不劫持输入法候选**：合成进行中（`isComposing` 或 `keyCode === 229`）的 ↑/↓ 一律放行给 IME 候选栏，避免在 contenteditable 上草稿仍读作空时把候选选择误当成回填。

### 变更

- **点「↑ 历史」按钮回填后焦点跟随**：此前按钮触发时焦点仍停在按钮上，下一次 ↑/↓ 就不再生效；现在回填后把焦点移到 composer（键盘触发路径本就聚焦，等于无操作）。

## [0.1.5] - 2026-08-27

### 修复

- **↑/↓ 回填恢复可用**：修复 0.1.4 引入的作用域错误——程序化写入辅助函数引用了调用方局部变量，导致每次按键抛出 `ReferenceError`、按键完全无响应。（0.1.4 内部版本，未发布）
- **↓ 导航走到底正确落到空输入框**：受控 textarea 上程序化 `setDraft('')` 偶发不生效（DOM 值追踪器竞态），现在微任务核查 DOM 实际值，必要时通过原生 value setter + 冒泡 `input` 事件强制回写——与用户手动清空走同一条被证明可靠的通道；落空后再次按 ↑ 会重新回到最新一条。
- **↓ 落空不再产生幽灵消息**：导航终点清空前设置一次性抑制锁存，发送监听不再把撤下的消息误判为"刚发送"，回填历史不会瞬时出现重复尾巴。

## [0.1.4] - 2026-08-27

内部版本（因 ↑/↓ 无响应回归未进入使用），其有效变更并入 0.1.5。

### 修复

- **↓ 导航终点清空**的首次尝试（含验证与兜底机制）及发送监听抑制锁存。
- 存在上述作用域回归缺陷，由 0.1.5 取代。

## [0.1.3] - 2026-08-27

### 修复

- **右键删除改用 React fiber 权威定位 sessionId**：读取 DSH 工作区 UI 渲染行时使用的记录对象（`SessionNodeItem({ node })` 的 `node.id`），不再依赖"标题字符串反查"；搜索结果行（`result.id`）同样支持。
- **重名会话保护**：当 fiber 定位不可用而必须退回标题匹配时，只有唯一匹配才允许归档；存在多个同名会话时明确提示「无法确定目标」而不是猜测删除列表第一个。
- **右键目标收紧**：选择器限定为 `[role="treeitem"][aria-selected]`，排除工作区分组行（`aria-expanded`），右键项目分组不会再误触发会话归档菜单。
- `_owner` 快路径：优先从元素 owner 直接命中渲染组件，减少祖先爬取。

## [0.1.2] - 2026-08-27

### 新增

- **archive 路由 CSRF 双重防护**：要求自定义头 `x-dsh-csrf: 1` 且 `Origin` 为空或与本机同源；跨站简单 POST 无法满足，返回 403。（纵深防御——DSH webServer 上游本身已有同源鉴权层）

### 变更

- 「删除该会话」增加二次确认：第一次点击将菜单项翻转为红色加粗「确认删除该会话」，第二次点击才真正执行归档。
- 会话历史改为双层模型（confirmed/pending）：草稿清空先入暂挂区，250ms 后与 Host 日志对账，只有日志中确实存在的文本才转正；暂挂条目 10 秒兜底过期——**未发送即手动清空的输入不再永久污染回填历史**。
- 右键监听范围收敛到工作区会话列表容器。
- 首次拉取历史失败时增加两次退避重试；toast 计数防互踩。
- 文档修正：README 补充真实配置项（`dsh-session-plugin.json` 的 `historyLimit`）与缓存文件说明，纠正"无可配置项"的错误描述。

## [0.1.1] - 2026-08-21

### 变更

- 包元数据规范：npm 强制小写，scope 规范为 `@heeweelee/dsh-session-plugin`。
- 完善 README（快速上手/安装/卸载/配置/权限/架构/故障排查章节）。
- 补充 1024Store 条目格式说明与仓库链接一致性要求。

## [0.1.0] - 2026-08-21

### 新增

- 输入框历史回填：输入框聚焦时按 `↑` 回填上一条发出的消息，`↑/↓` 在历史里切换，走到底落到空输入框；会话标题栏新增「↑ 历史」按钮。
- 会话右键归档：工作区左侧会话列表条目右键 →「删除该会话」，经确认后走 DSH 原生 `archiveSession`（仅隐藏，不删除磁盘文件）。
- Host 三路由：`GET /history`（只读会话 user/message 文本）、`GET /sessions`（会话 id+标题列表）、`POST /archive`（归档会话）；内存 TTL + 磁盘两级缓存让重启后的首次召回免于全量重放会话日志。
- 可选配置 `~/.dsh/dsh-session-plugin.json` 的 `historyLimit`（默认 100，上限 10000）。

[0.1.11]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.11
[0.1.10]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.10
[0.1.9]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.9
[0.1.8]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.8
[0.1.7]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.7
[0.1.6]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.6
[0.1.5]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.5
[0.1.3]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.3
[0.1.2]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.2
[0.1.1]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.1
[0.1.0]: https://github.com/Heeweelee/dsh-session-plugin/releases/tag/v0.1.0
