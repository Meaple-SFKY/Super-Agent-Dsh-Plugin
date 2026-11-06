# 009 · 打包 / 面板 / 配置审查

> 范围：`src/index.ts`、`src/client/main.js`、`cordis.patch.yml`、`src/app/setup.ts`、`scripts/`、`SETUP.md`、`package.json`、`docs/002-setup-api.md`。
> 方式：只读审查 + 命令测量；**本文件是唯一改动**（未改任何代码）。
> 结论时点：2026-11-06，工作树 `./scripts/pnpmw check` 全绿（25 files / 461 tests），`lib/client.js` 174,799 B。

## 0. 结论摘要

整体形态已经可用：guardian 失败隔离、setup API 的 loopback/fence/无 token 回显、向导保存后轮询重启、SSH key 生成、watchdog 一键开关、DSH 原生风格与能力矩阵都已落地。当前主要问题不是功能缺失，而是**打包体积/依赖形态**、**面板轮询与重渲染成本**、以及**Config 与 source/setup/runtime 的字段漂移**。

| 主题 | 现状 | 风险 | 优先级 |
| --- | --- | --- | --- |
| 打包体积与依赖 | tarball 打包 512 KB / 解包 1.97 MB；其中 sourcemap 1.05 MB、内部 docs 122 KB；`@deepseek-ai/dsh-*` 被放进 `dependencies` | 中（安装体积、重复 DSH 副本、tarball 不可用） | P0 |
| 客户端轮询/重渲染 | 5 个轮询同时常驻（空闲约 29 req/min）；每次响应都 setState，整页重渲染；client bundle 175 KB 未压缩 | 中（首屏、空闲流量、输入时重渲染） | P0/P1 |
| Config ↔ runtime/source 漂移 | Telegram 7 个 source 字段、GitHub `botLogins` 未进 Config；`quiet.quietHours` 进 Config 但 runtime 不消费；`pollSeconds` 默认语义两边不同 | 中（用户在 Settings 配不了的字段、配了不生效的字段） | P1 |
| 向导保存/重启可观测性 | 200 在 commit 之前返回；commit 失败只写日志；面板 60 s 后只能显示通用超时 | 中（用户不知道为什么没生效） | P1 |
| Preset/prompt 维护 | Worker 25 个插件行 / Router 17 个；YAML 220 行、9.2 KB；worker/router 的 shell/compaction 块复制粘贴；prompt 合计约 33 KB（md 16.4 KB + builtin 17.2 KB） | 低-中（漂移、上下文成本） | P2 |
| 安装/卸载/升级 | link 安装是当前唯一可靠方式；SETUP 已说明 tarball 暂不支持；uninstall 已覆盖 plist/profile/link/state/sessions/legacy token | 低-中（残留、watchdog node 路径） | P1/P2 |
| 可观测性 | guardian status/degraded、heartbeat、health、watchdog.log、redactDetail 都有；缺 commit 失败状态、日志轮转、client 错误上报 | 中（排障靠翻日志） | P1 |

---

## 1. 客户端：体积、首屏、重渲染、轮询

### 1.1 体积与首屏

| 产物 | 原始 | gzip | 说明 |
| --- | ---: | ---: | --- |
| `lib/client.js` | **174,799 B / 3,832 行** | **40,365 B** | 手写单文件 Client 模块，无 sourcemap、未 minify；含大量注释（36 行 `//`）和空行（162 行） |
| `lib/index.js`（guardian） | 62,973 B | 18,164 B | schemastery + cosmokit 已打进 bundle，避免宿主解析依赖 |
| `lib/runtime-*.js` | 323,312 B | — | 宿主侧运行时 chunk（不进浏览器） |
| `cordis.patch.yml` | 9,259 B / 220 行 | — | 两个 preset 的完整工具列表 |

- Client 入口声明 `immediately: true`（`package.json`），Web 壳会在**首帧前**加载并解析整个 client bundle；“应用首帧等待每个 client entry”（ui-renderer 文档）——175 KB 未压缩脚本会推迟首次可交互时间，虽然 gzip 仅 40 KB。
- 面板渲染发生在打开 Superagent 时，但模块解析/注册在启动时；client bundle 没有按 tab 拆分。
- 结论：体积不至于不可用，但 **minify + 去掉注释**预计可把原始体积压到 ~60–75 KB（gzip ~20–25 KB），是最直接的收益。

### 1.2 轮询与重渲染

`usePolling`（`src/client/main.js:1983`）在 `SuperagentPage`（:3305）里被同时实例化 5 次：

| 轮询 | 间隔 | 空闲请求/分钟 | 视图相关性 |
| --- | ---: | ---: | --- |
| `GET /state`（dashboard） | 5 s | 12 | 仅 Overview 需要 |
| `GET /setup/state` | 5 s | 12 | 向导 + Overview 状态都需要，但 Permissions 不需要 |
| `GET /setup/permissions` | 30 s | 2 | 仅 Permissions |
| `GET /setup/models` | 60 s | 1 | 仅 Setup 行为步骤 |
| `GET /setup/watchdog` | 30 s | 2 | 仅 Permissions |
| **合计** | | **约 29 req/min（~1,740/h）** | |

- `usePolling` 每次请求成功都会 `setSnapshot({ data: result.data, ... })`（新对象、新 `at`），**不做内容相等性判断**；任一轮询更新都会让整个 `SuperagentPage` 重渲染，3 个视图函数和所有控件（含 only-on-one-tab 的 SetupView）都会重新执行。空闲时每 5 s 至少 2 次整页渲染。
- 在向导里输入 token/仓库搜索时，setup/state 的 5 s 轮询仍会持续重渲染表单（受控输入不丢值，但存在无谓 diff）。
- 保存后 `saveAndWait` 用 `RESTART_POLL_MS = 2 s`、最多 60 s（:3567）；这是合理的低频短时轮询，但会叠加到上述常驻轮询上。
- 长列表：ticket/source/health 列表走原生渲染，没有虚拟化；当前量级（几十条内）不是问题。长 detail 已用 `ExpandableDetail` 折叠（task-26），不会撑爆卡片。
- 可访问性：按钮/输入有 `aria-label`/label、`:focus-visible`、状态点配文字、toast `role=status`；但 **tab 只有 `role=tablist`/`role=tab`，没有 `aria-controls`、`tabpanel` 和方向键切换**；也没有全局 React Error Boundary——视图渲染异常会空白该 slot，只剩 host 控制台报错。

---

## 2. Config schema 与 runtime/source 校验漂移

### 2.1 已对齐部分

- `src/index.ts` 的 schemastery Config 现在覆盖：`enabled/stateDir/language/router/sources(.telegram/.github)/policy/executor/quiet/watchdog/acknowledgeOnAccept/passIntervalMs/heartbeatIntervalMs`。
- runtime `src/app/setup.ts` 的 `prepareConfig` 接受 `sources/policy/router/executor/quiet/language`；`applyConfig` 通过 `configEditor` 深合并；模型路由会先经 `llm.resolveModelInfo` 校验。
- Telegram `richText/files/keyboards` 与 GitHub `allowSelf/collaborators/login/allowedLogins/observe*` 都已在 Config 和 source 两侧存在。

### 2.2 漂移清单（需要补 Config 或明确“不支持”）

| 字段 | source/runtime 是否支持 | Config 情况 | 影响 |
| --- | --- | --- | --- |
| `sources.telegram.pollTimeoutSeconds` | 是（长轮询超时） | **缺** | Settings 无法调；默认 25 s |
| `sources.telegram.observeCallbacks` | 是（按钮点击成为候选） | **缺** | 按钮点击策略不可配 |
| `sources.telegram.observeAllChatMessages` | 是（群聊未 @ 也收） | **缺** | 群聊观察策略不可配 |
| `sources.telegram.replyToMessages` | 是（回复原消息） | **缺** | 回复形态不可配 |
| `sources.telegram.mentionPattern` | 是（额外 @ 名称） | **缺** | 多 bot 名称不可配 |
| `sources.telegram.processBacklog` | 是（首次启动回灌 24h） | **缺** | 无法开启/关闭回灌 |
| `sources.telegram.maxDownloadBytes` | 是（附件上限） | **缺** | 上传/下载上限不可配 |
| `sources.telegram.apiBaseUrl` | 是（仅测试用） | 缺（合理） | 不需暴露 |
| `sources.github.botLogins` | 是（允许的 bot 触发者） | **缺** | bot 触发白名单不可配 |
| `sources.github.apiBaseUrl` | 仅测试 | 缺（合理） | 不需暴露 |
| `quiet.quietHours` | Engine/runtime **不消费** | Config 有、示例/SETUP 有 | 用户配了静默时段但不生效 |
| `sources.telegram.pollSeconds` | source 语义=**空轮询后的 idle gap**（默认 1 s） | Config 语义写成“轮询间隔”、默认 **60 s** | 加载后 idle gap 变 60 s，长轮询 25 s，实际最多 ~85 s 才有下一次 poll；与“每分钟轮询”接近但语义/默认值不同 |

> 补充：Config 没有声明 `sources.*` 的未知字段时，schemastery `resolve` 会保留未声明键，但 `simplify()` 会丢掉它们；`configEditor` 写盘若走简化路径，上述字段可能在 UI 保存时丢失。建议以 contract test 锁定。

---

## 3. 向导保存与重启

流程（`src/app/setup.ts`）：

1. `prepareConfig` 校验 patch、`deepMerge` 到当前 config、调用 `validateConfig` 与模型校验（:1040–1080）。
2. **返回 `{ok:true,restarting:true}` 在 commit 之前**（:1076）；HTTP 层随后 `commitConfigSoon`。
3. `commitConfigSoon` 先写 `KV_RESTART=true`，再用 25 ms 定时器触发 `applyConfig` → `configEditor.edit(...)`（:1174–1224）。
4. 插件重启后 runtime 启动时删除 `KV_RESTART`（:368）；`setup/state.restartRequired` 即该标志。
5. 面板 `saveAndWait` 先等 2 s（避开“旧 ready”），再轮询 `setup/state`，要求 `plugin.status=ready`、账号匹配、`restartRequired !== true`（:3567–3610）。

评价与风险：

- “先响应再重启”的顺序正确；grace + `restartRequired` 避免了把旧的 ready 误判为完成。
- **失败不可诊断**：`applyConfig`/configEditor 失败只写 DSH 日志（:1177），不会写进 `setup/state`；面板 60 s 后只能显示通用超时，用户无法知道是 configEditor 不可用、权限问题还是重启失败。`prepareConfig` 能提前发现 `configEditor` 缺失（501），但 commit 期失败仍不可见。
- `KV_RESTART` 在 commit 失败时会保持 `true`；下次成功启动才清除，期间 `setup/state.restartRequired` 一直为真——面板会超时，但状态可解释性不足。
- 25 ms 的 `setTimeout` 是经验值；若 `configEditor.edit` 内部触发插件卸载，HTTP 响应能否可靠写出取决于 200 是否已 flush（现有测试覆盖“response before edit”，但缺少真实 profile 的端到端验证）。
- 模型路由校验依赖 `llm.resolveModelInfo`；缺失 `llm` 时只做结构校验，错误会在首次会话才暴露（已在代码注释中说明）。
- token 不回显：POST 只返回 tokenFile/账号信息；`sanitize` 截断 500 字符并接 `redactDetail`（runtime 的 token 正则），相关测试存在。

---

## 4. Preset 与 prompt 大小

| 项 | 数值 | 说明 |
| --- | --- | --- |
| `cordis.patch.yml` | 220 行 / 9,259 B | Worker 119 行、Router 72 行；含 25 / 17 个 `name:` 行（含 group 内工具） |
| Worker preset | `goal`、`read_image`、subagent、todo、web search、compaction、skills、5s shell/job | 不含 agent-team/workflow |
| Router preset | 只读 fs（含 read_image）、jobs、skills、compaction、5s shell | 无写盘、无 goal/web/subagent |
| `src/prompts/worker.md` | 9,212 B | 每个 Worker session 的指令主体 |
| `src/prompts/router.md` | 4,350 B | 主 Session 指令 |
| `src/prompts/admission.md` | 2,865 B | 准入/研判规则 |
| `src/prompts/builtin.ts`（内置文本） | 17,184 B / 12 行 | 与 md 同步的常量，存在双份维护 |
| `agent-instructions` | 64 KB 上限 | 读取仓库 AGENTS 等 |

- 上下文成本：Worker 每步系统提示约 9 KB md + 工具 schema（goal/read_image/todo/subagent/web 等）；goal/read_image 各自只增加 1 个工具 schema 与简短 guidance，属于合理增量。`read_image` 依赖宿主 `attachments` 服务，缺失时 tool-fs 的 `ctx.inject(['attachments'])` 不注册该工具（不会报错，但 Router 会“看不见图”）。
- 维护成本：Worker/Router 的 shell group、compaction group 是复制粘贴；未来改超时/插件名要同步两处，容易漂移。prompt 同时存在 `.md` 与 `builtin.ts` 两份，也让“改一处漏一处”的概率上升。
- 启动影响：preset 插件行在 Session 创建时组合，插件行越多，首个 Session 的 mount 时间越长（当前 25/17 行属正常量级）；goal 默认 `blockedAfterConsecutiveRounds=3`，需观察是否产生额外续跑。

---

## 5. 安装 / 卸载 / 升级

### 5.1 依赖与打包形态

- `package.json` 当前把 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-tools` 放在 **`dependencies`**（不是 peers），同时还有 15 个 peer 依赖。这会让 `plugin_manager` 尝试把 DSH 包安装进 profile，或在 tarball 安装时解析不到/重复安装，导致**同一服务有多份类身份**（SessionId/DocumentId 等 branded 类型、事件常量）与版本漂移风险。
- `SETUP.md` 已明确“当前只支持从仓库构建后用 Plugin Manager 安装（link:）；tarball 在线安装暂不支持”，原因是这些静态依赖。作为长期方案，应二选一：
  - 自包含打包（把 helper 打进产物/或改用 `ctx.get()` 间接调用，删掉静态 import）；
  - 全部改为 `peerDependencies`，依赖宿主 DSH 解析。
- `npm pack --dry-run`：44 files / 512 KB packed / 1.97 MB unpacked；
  - sourcemap **10 个 / 1,053,630 B（占解包体积 53.6%）**：`lib/*.map`；
  - 内部 docs **7 个 / 122,164 B**：`docs/dsh-api-notes.md` 45 KB、`verification.md` 25 KB、`dsh-types-verified.md` 25 KB 等；
  - client 174,799 B；runtime chunk 323 KB（+650 KB map）；`scripts/` 含 `pnpmw`、`build-client.mjs`、`cleanup-profile.mjs` 等开发脚本。
  - 这些对运行不必要；`files` 里排除 `*.map` 与内部 docs，可把 unpacked 降到 ~750 KB、packed ~200 KB。
- `files` 已经包含 `locale/*.json`、`icon.svg`、`prompts`、`scripts`、`docs`；link 安装不经过 `files` 过滤（安装的是整个 checkout），所以开发产物/测试目录也会被 profile 的模块解析看到（不影响运行，但对“安装包”预期不干净）。

### 5.2 link vs tarball / 升级

- link：改代码后需要 `pnpmw build` 生成 `lib/`；Host 侧改动需重启插件/DSH，client 侧可刷新页面（HMR 或 Cmd+R）。SETUP 已说明。
- tarball：当前不支持（见上）；若未来支持，需要保证 `lib/` 的 chunk 和 `prompts/*.md` 都在包内、依赖可解析。
- 版本/engines：`0.1.1`、`private:true`、`node ^22.19.0 || >=24`、`dsh >=0.2.2-rc.1 <0.3.0`。guardian 运行时再检查一次；不兼容时 degraded 而不是崩溃，符合设计。注意 `dependencies` 中的 DSH 版本是精确 `0.2.2-rc.1`，与 peer 范围混用会让 npm/pnpm 警告且没有额外收益。
- 升级：替换已安装 bundle 的 JS 需要 DSH 重启（模块代际），link 切换 tarball 也需要完整重启（SETUP 已写）；数据库迁移只能向前，升级前要备份 stateDir（SETUP 已写）。

### 5.3 卸载残留

`scripts/uninstall.sh` 目前覆盖：LaunchAgent bootout + plist 删除、`cleanup-profile.mjs` 删除 profile patch 行、link 包符号链接、legacy `~/.config/superagent`，`--purge-state` 再删 stateDir（含 downloads/secrets/SSH key）与 `~/.dsh/sessions` 下 `*state-superagent*`。风险点：

- session 目录匹配依赖命名模式 `*state-superagent*`；若 DSH 的 session 目录命名/层级变化（例如按 workspace/profile 再分层），可能漏删，需要安装后实际验证。
- `--purge-state` 之外的默认行为保留 secrets（token/SSH key），这是有意设计，但卸载文档需要明确提示用户手动 revoke（SETUP 已写）。
- `watchdog.log` 会随 stateDir 保留；默认卸载不轮转也不删除，属于预期。

### 5.4 Watchdog

- `scripts/install-launchd.sh`：`NODE_BIN` 优先 `command -v node`（可能是 nvm/volta 的临时路径），失败才回退到 DSH bundled node；launchd 的 ProgramArguments 固化这个绝对路径。**Node 升级/卸载后 plist 会在下次登录时静默失败**（stdout/stderr 指向 `/dev/null`）。
- `scripts/watchdog.mjs` 的日志是纯 `appendFile`，没有大小上限/轮转（:168–175）；每分钟一次检查，长期运行会无限增长。
- 看门狗重启策略（指数退避、最多 5 次、intentional stop 不重启）设计合理；但没有“安装后自检”（dry-run）步骤，也没有把 launchctl 状态写进插件 health。

---

## 6. 可观测性与排障

已有：

- guardian：`<stateDir>/superagent-status.json`、`superagent-degraded.json`（原子写、0600/0700，best effort），`bootState()` 导出；版本不兼容/缺 stateDir/engine 启动失败都写 degraded 并只 warn（`src/index.ts:306–387`）。
- runtime heartbeat：`superagent-heartbeat.json`（30 s，status/paused/safeMode/sources），watchdog 用它和 SQLite mtime 判断。
- health：`runtime`、`effects:<kind>`、`sources:<id>`、`sessions:router` 等；setup/state 把 `plugin.detail`、`models`、`git`、`watchdog` 一起返回，面板可见。
- 错误可读性：setup 的 `failure()` 返回 `{error, description}` 并 `sanitize` 500 字符；`redactDetail` 覆盖 Telegram/GitHub/sk 等 token 形态（runtime:2001–2007）。
- SETUP 的排障表覆盖 token/版本/向导/重启/看门狗等主要路径。

缺口：

1. **commit/restart 失败没有结构化状态**：面板 60 s 超时后只能提示“看 DSH 日志”，无法区分 `configEditor` 失败、插件重启失败、还是 commit 尚未执行。
2. **watchdog.log 无轮转**；看门狗自身失败（node 路径失效）只写日志/无 health 上报。
3. **client 渲染异常没有 Error Boundary/上报**：slot 级崩溃会空白，只在浏览器控制台可见；面板也没有把 API 403/JSON 解析失败以外的异常统一上报到某个 health。
4. **health 条目缺时间戳**（除 sources 外），排障时无法判断“这条 error 是 5 分钟前还是启动时”；`/state` 里 `plugin.detail` 是唯一 detail，多个来源错误只保留最后一个字符串。
5. **docs/002 已落后于实现**：没有 ssh-key/models/watchdog 路由，`PUT config` 未写 `router/language`，`setup/state` 未写 `git/models/watchdog/language`；SETUP 的部分说明（如 Telegram capabilities、router 模型）也可能滞后。文档漂移会直接造成排障错误。

---

## 7. 五个高 ROI 改进（按风险排序）

### 1) 打包体积与依赖形态（P0，风险中，工作量 M）
- `@deepseek-ai/dsh-llm|dsh-session|dsh-tools` 从 `dependencies` 移回 `peerDependencies`（或改为 `ctx.get()` 间接获取，避免静态 import），消除重复 DSH 副本与“tarball 不可装”的根因。
- `files` 排除 `lib/**/*.map` 与内部 docs（`docs/dsh-api-notes.md`、`docs/dsh-types-verified.md`、`docs/verification.md`）；保留 `docs/000-003`、`SETUP.md`、`README.md`。
- 预期：unpacked 1.97 MB → ~0.75 MB，packed 512 KB → ~200 KB；安装/升级更快、profile 更干净。
- 验收：`npm pack --dry-run` 体积、`plugin_manager install_bundle` 后无 DSH 重复安装、tarball 可启动（如目标支持）。

### 2) 客户端性能：minify + 轮询按视图门控 + 内容相等性（P0/P1，风险低-中，工作量 M）
- `scripts/build-client.mjs` 用现有 rolldown/esbuild 对 `src/client/main.js` 做 minify（保留可读源码；不新增依赖），预计 175 KB → ~65 KB（gzip ~22 KB），加快首帧模块加载。
- `SuperagentPage` 按 `view` 只保留必要的轮询：Overview 用 `/state`+`/setup/state`，Setup 用 `/setup/state`+`/models`，Permissions 用 `/setup/state`+`/permissions`+`/watchdog`；向导关闭时把 setup 轮询降到 15–30 s。
- `usePolling` 对 JSON 序列化结果做浅比较，内容未变不 `setState`；避免每 5 s 全页重渲染。
- 预期：空闲请求 29 → ~10–13/min，无变化时 0 次重渲染；向导输入更稳。
- 验收：Network 面板请求数、React DevTools render count、首屏耗时。

### 3) Config/source 契约收敛（P1，风险低，工作量 S-M）
- 把 §2.2 的 Telegram 字段（`pollTimeoutSeconds/observeCallbacks/observeAllChatMessages/replyToMessages/mentionPattern/processBacklog/maxDownloadBytes`）与 GitHub `botLogins` 补进 Config；`quiet.quietHours` 要么实现，要么从 Config/示例/SETUP 删除并注明未实现；修正 `telegram.pollSeconds` 的默认/文案（idle gap 1 s vs Config 60 s）。
- 加一个 contract test：从 `src/sources/telegram.ts`/`github.ts` 的 Config interface 提取字段名，与 `src/index.ts` 的 Config schema 字段比对（允许 test-only 白名单 `apiBaseUrl/callbacks/commands`），防止再次漂移。
- 验收：Settings 能改这些字段并生效；contract test 红即提示补字段。

### 4) 向导保存/重启可诊断（P1，风险低，工作量 S-M）
- `setup/state` 增加 `commit: {status:'idle'|'pending'|'failed'|'done', error?: string, at?: ISO}`（不泄露 token/path），`applyConfig`/`commitConfigSoon` 失败时写入；面板超时时直接显示具体原因并提供“重试保存”。
- 将 `KV_RESTART` 的 pending 状态与 commit 状态关联；commit 失败时清除或标记 failed，避免 `restartRequired` 永远为真。
- 验收：故意让 configEditor 抛错时，面板 60 s 内显示“配置写入失败：…”，而不是通用超时。

### 5) Watchdog/安装运维硬化（P1/P2，风险低，工作量 S）
- `install-launchd.sh` 默认优先 **DSH bundled node**（`$HOME/.dsh/dsh-runtimes/.../node`）或要求 `--node` 显式指定，并在写入 plist 前跑一次 `node watchdog.mjs --state-dir ... --dry-run`；plist 的 stdout/stderr 写 `<stateDir>/watchdog-launchd.log` 而不是 `/dev/null`。
- `watchdog.mjs` 日志按大小轮转（例如 >2 MB 时保留 `.1` 一份），或限制为最近 N 天；`--dry-run`/安装后把 launchctl 状态写进 `<stateDir>/watchdog-status.json` 供面板/health 读取。
- 卸载脚本对 session 目录的匹配规则加一条说明/验证（安装后实际 `find ~/.dsh/sessions` 确认命名），避免升级后漏删。

> 备选第 6 项（不在前 5）：给面板加 React Error Boundary（错误显示在卡片内 + `console.error` 前缀），并补 tab 的 `aria-controls/tabpanel`、方向键切换；工作量 S，主要收益是可用性而非核心性能。

---

## 附录 A：测量命令（可复现）

```sh
wc -c lib/client.js lib/index.js cordis.patch.yml
gzip -c lib/client.js | wc -c
npm pack --dry-run --json | node -e '...'   # 44 files / 512 KB / 1.97 MB；.map 1.05 MB；docs 122 KB
grep -n 'POLL_MS\|usePolling(() => api.get' src/client/main.js
grep -n 'restarting: true\|commitConfigSoon\|KV_RESTART' src/app/setup.ts
wc -lc src/prompts/*.md cordis.patch.yml
grep -n 'appendFile\|LOG_FILE' scripts/watchdog.mjs
grep -n 'NODE_BIN' scripts/install-launchd.sh
```

## 附录 B：本次审查边界

- 未改任何代码；未安装/卸载/重启任何 profile。
- 未做真实浏览器 React Profiler、axe 扫描或 10k 条 Ticket 压测；客户端重渲染/请求数为代码推导，首屏体积为 gzip 实测。
- `quiet.quietHours`、Config 缺字段、`pollSeconds` 语义等属于“代码事实”判断，依据为 `src/index.ts`、`src/sources/*`、`src/app/runtime.ts` 的当前实现；若这些 owner 已在并行修改，以最新代码为准。
