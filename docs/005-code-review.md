# 005 · 独立代码审查（正确性 / 隔离 / 安全 / 测试盲区）

审查者：qa（独立于实现者，只读）
时间：2026-11-06 23:05（Asia/Shanghai）
基线：`git HEAD = ff8a17c`（工作区仅 `pnpm-lock.yaml` 修改，无我产生的代码改动）
范围：`src/**`（约 21.9k 行，含 client 3.8k 行）、`tests/**`、`cordis.patch.yml`、`package.json`、`scripts/**`、`docs/002-003`。
方法：逐文件读码 + 针对既往缺陷的回归验证 + `./scripts/pnpmw check` + 对高危路径做交叉检索（调用链、测试覆盖）。**未做**：真实 DSH 安装、真实 Telegram/GitHub 账号、真实 LLM、运行时漏洞利用尝试；因此标“推测”的条目是静态推理，需运行环境确认。

复跑命令与结果：

```text
$ ./scripts/pnpmw check
tsc --noEmit && tsdown && node scripts/build-client.mjs && vitest run
Test Files  25 passed (25)   Tests  471 passed (471)   Duration ~4.7s
```

严重度定义：**P0** 无需额外前提即可造成数据丢失/权限提升/宿主不可用；**P1** 在常见使用路径或合理攻击场景下破坏硬要求（安全、幂等、自愈、可安装）；**P2** 稳健性/维护性/文档一致性/测试盲区。
状态：**确认** = 读码可证（含调用链）；**推测** = 逻辑成立但依赖运行时/环境条件，未被实际触发。

---

## 1. 结论摘要

- 在本次静态审查范围内**未发现无条件 P0**。整体工程质量高：guardian 隔离、effect 队列持久性、token 处理、outbox 幂等、watchdog 静默重试都经过了刻意设计和测试覆盖。
- 发现 **8 个 P1**、**14 个 P2**。P1 集中在四类：
  1. **状态机幂等**：`Engine.decide` 对同一 Trigger 的重复 accept 没有去重（见 CR-1）。
  2. **GitHub 写权限的模型可控面**：`superagent_github` 允许模型自选仓库、自选 admin collaborator，且 source 默认自动接受任意仓库邀请（CR-2、CR-3、CR-14）。
  3. **本地管理 API 的信任边界**：只用 loopback+header 自实现 fence，未使用宿主 `connection.requestRejection`；`models` 路由未 dispose 导致重启后路由泄漏（CR-4、CR-6、CR-18）。
  4. **默认仓库凭据路径与文档不符**：文档/配置声称默认 HTTPS+PAT credential helper，实际只有 SSH（CR-5）；另外崩溃后 stale lock 会让插件降级且 watchdog 拒绝重启（CR-7），`uninstall --purge-state` 缺少路径护栏（CR-8）。
- 上一轮验证发现的 B1（重复打扰消息）已修复（`src/core/engine.ts:871-890`）；guardian 重启安全、来源 `receive` 失败不推进游标、无报告回合的静默重试（`src/app/watchdog.ts:164-220`）也已落实。本轮不再重复。

---

## 2. Findings 总表

| ID | 严重度 | 状态 | 标题 | 关键位置 |
| --- | --- | --- | --- | --- |
| CR-1 | P1 | 确认 | 同一 Trigger 的重复 accept 会创建第二个 Ticket/Worker | `src/core/engine.ts:501,1230`；`src/tools/router.ts:141` |
| CR-2 | P1 | 确认 | `create_repository` 可对既有仓库邀请模型指定的 admin（权限提升） | `src/tools/worker.ts:586-604`；`src/sources/github-api.ts:1409-1452,1478` |
| CR-3 | P1 | 确认（利用链推测） | GitHub Source 默认自动接受任意仓库邀请 | `src/sources/github.ts:596-601,787-850` |
| CR-4 | P1 | 确认（可利用性推测） | 管理 API 未使用宿主 connection/origin 校验 | `src/app/api.ts:104-120,236-262`；`src/app/runtime.ts:1487-1495,1550-1558,1660-1668` |
| CR-5 | P1 | 确认 | 默认 clone/push 走 SSH，文档/Config 声称的 HTTPS+PAT credential helper 不存在 | `src/app/executor.ts:61,357`；`src/index.ts:232-233`；`src/client/main.js:221` |
| CR-6 | P1 | 确认 | `GET setup/models` 路由未保存 disposer；重启后重复注册抛错、旧 handler 泄漏 | `src/app/runtime.ts:1530`；`src/app/runtime.ts:1933-1935` |
| CR-7 | P1 | 确认（时序推断） | 崩溃后 stale lock（120s）会使新进程启动失败并降级；watchdog 对 degraded 不再重启 | `src/app/runtime.ts:1883-1901`；`scripts/watchdog.mjs` degraded 分支 |
| CR-8 | P1 | 确认 | `uninstall.sh --purge-state` 仅校验绝对路径即 `rm -rf` | `scripts/uninstall.sh:63-65,110-112` |
| CR-9 | P2 | 推测 | guardian stop 上限 15s < runtime shutdown 最坏耗时，重启可能与旧实例抢锁 | `src/index.ts:304,588`；`src/app/runtime.ts:1928-1941` |
| CR-10 | P2 | 确认 | `quiet.quietHours` 是死配置；`quiet.minChars` 语义与 Schema 描述相反 | `src/index.ts:244-258`；`src/app/runtime.ts:224-227` |
| CR-11 | P2 | 确认 | 面板“个人 PAT”被采集并随请求发送，但服务端完全不处理 | `src/client/main.js:216-218,3442-3445`；`src/app/setup.ts:923-976` |
| CR-12 | P2 | 确认 | `update_issue`（可关闭 Issue）与 docs/003“保留给人”矛盾；`merge_pull` 的 `confirm` 可由模型自填 | `src/tools/worker.ts:669-682,751-780`；`docs/003-capabilities.md:53` |
| CR-13 | P2 | 确认 | 报告附件接受任意绝对路径，无目录约束 | `src/tools/worker.ts:66-105`；`src/core/engine.ts:1565-1580` |
| CR-14 | P2 | 确认 | `superagent_github` 的 `repo` 参数不受 allowlist 限制（token 可见即操作） | `src/tools/shared.ts:150-168`；`src/tools/worker.ts:612` |
| CR-15 | P2 | 确认 | setup API 的 `tokenFile` 可为任意绝对路径（写入受校验 token）；config patch 可写 `executor.prepare` | `src/app/setup.ts:1006-1028,1040-1066` |
| CR-16 | P2 | 确认 | 打开更新 schema 的库时先 DDL 后读版本（拒绝本身无损） | `src/app/store.ts:846-955` |
| CR-17 | P2 | 确认 | Router 不在线时 relay/notice 效果静默丢失（handler 不检查 deliverRouter 返回值） | `src/app/runtime.ts:1117-1146` |
| CR-18 | P2 | 确认 | 三段 setup 路由复制 fence 与 readBody；header 数组处理不一致、超限时 timer 未清 | `src/app/runtime.ts:1453-1700` vs `src/app/api.ts:114-118` |
| CR-19 | P2 | 推测 | `ensureWorker` 并发/重试与 launch 竞争时可能重复创建会话或留下无主 session | `src/app/sessions.ts:415-455`；`src/app/executor.ts:174-200` |
| CR-20 | P2 | 确认 | 死/不可配置字段与文档漂移：Telegram 高级开关不在 Config schema；docs/003 多处过期 | `src/index.ts:96-190`；`src/sources/telegram.ts:80-115`；`docs/003-capabilities.md:44,51,53` |
| CR-21 | P2 | 确认 | 测试盲区（见 §6） | `tests/**` |
| CR-22 | P2 | 确认 | `stateDir` Schema 默认空串 + setup 路由依赖已启动 runtime 的安装顺序陷阱 | `src/index.ts:63`；`src/app/api.ts:293` |

计数：P0 = 0；P1 = 8；P2 = 14（含 CR-21 汇总项）。

---

## 3. P1 详情

### CR-1 同一 Trigger 的重复 accept 创建第二个 Ticket/Worker

- 位置：`src/core/engine.ts:501`（`decide`）、`:1230`（`createTicket`）、`:1195`（`finishEval`）；调用入口 `src/tools/router.ts:141-157`。
- 证据（确认）：
  - 第一次 accept：`decide` 取 `thread.eval` → `createTicket()` → 新 `Ticket` + 新 `Assignment` + `enqueueLaunch` → `finishEval()` 清空 `thread.eval`、写 disposition。
  - 第二次用同一 `triggerId` 调 accept：`thread.eval === undefined` → `evalRun` 为空 → `triggers=[trigger]` → 仍走 `createTicket()`；`decide` 全程**不检查**该 trigger 的 disposition/decision，`createTicket` 也不复用已有 ticket。
  - 触发面：模型对同一候选重复调用工具（模型抖动/重试）；或 assessment 超时（120s）后 `expireEval` 把同一批 trigger 重新入队、再次投递候选（`src/core/engine.ts:1148-1193`），Router 两次 accept 都合法。
- 影响：同一 Trigger 两个 Ticket → 两个 Worker Session、两次 clone/prepare、可能两个 PR/两条评论；用户收到两条 ready/blocked 消息；kernel/outbox 按 ticket 分渠道不会互相抑制。
- 建议：在 `decide` 内做幂等（二选一）：
  1. 若 `disposition.decisionId` 已有 `outcome==='accept'` 且 ticket 仍存在 → 直接返回既有 decision/ticket；
  2. 或 `trigger → ticket` 唯一索引/字段，`createTicket` 前命中则返回已有。
  同时 `superagent_route` 工具层可用 `engine.mainSession.decide` 返回值带 `{deduped:true}` 提示模型。
- 测试建议：`tests/core-ticket.spec.ts` 新增 “accept twice for one trigger creates one ticket” 与 “accept after eval expiry re-delivery creates one ticket”；`tests/tools-router.spec.ts` 连续两次 `superagent_route accept` 断言 ticketId 相同、`launch` effect 只有一条。

### CR-2 `create_repository` 可对既有仓库邀请模型指定的 admin（权限提升）

- 位置：`src/tools/worker.ts:588-591`（`requested = args.collaborators ?? options.collaborators`，随后无条件 `inviteCollaborators`）、`:554-620`（`create_repository` 分支）；`src/sources/github-api.ts:1409-1452`（422 “already exists” → 读取 `user.login/name` 返回既有仓库，`created:false`）、`:1478-1520`（`addGithubCollaborator`，默认 `admin`）。
- 证据（确认）：
  - 创建失败且 GitHub 返回 422 “name already exists” 时，helper 把**已存在的、token 所属账号的仓库**当成功返回；工具随后仍用 `args.collaborators` 邀请 `admin`，不校验 `created === true`，也不与 `sources.github.collaborators` 比对。
  - Worker 可读入站/仓库内容（prompt 注入面），工具 `create_repository` 无人工确认（对比 `merge_pull` 至少要求 `confirm` 参数，但该参数同样由模型自填）。
  - 现有测试只覆盖 “新建 + 邀请” 与 “既有仓库（不传 collaborators）”，**没有**覆盖组合路径（`tests/tools-worker.spec.ts:721-745,763-800`）。
- 影响：一次成功注入即可让模型把攻击者账号以 **admin** 邀请进 token 主人的仓库（含私有仓库），随后可读代码/改分支；若 token 是个人主账号 PAT，影响面最大。
- 建议：三处收紧，缺一不可：① 忽略工具参数里的 `collaborators`，只允许 `sources.github.collaborators` 配置；② 仅在 `created === true` 时邀请；③ 邀请前校验 repo 属于 ticket 作用域/配置仓库（见 CR-14）。
- 测试建议：既有仓库 + `collaborators:[attacker]` → 断言 0 次 PUT；新建 + args 覆盖配置 → 断言只邀请配置名单；helper 422 分支返回既有仓库时 `created:false` 且不邀请。

### CR-3 GitHub Source 默认自动接受任意仓库邀请

- 位置：`src/sources/github.ts:596-601`（每轮 poll 开头 `acceptPendingInvitations`）、`:787-850`（遍历 pending invitations 自动 PATCH accepted，404/422 也视为成功）；`:732-770`（`repositories:['*']` 自动发现，刷新后再次强制接受邀请）。
- 证据（确认）：无需任何配置开关，bot token 的 pending invitations 会被自动接受；`invitationsChecked` 只保证每个进程一次，`refreshAutoRepositories()` 之后还会 `force` 再跑一次。
- 影响（利用链为推测，但组件均为实际代码）：
  1. 攻击者（知道 bot GitHub 用户名即可）邀请 bot 进自己的仓库 → bot 自动成为 collaborator（write/read）；
  2. 若配置了 `repositories:['*']`（文档支持的“自动发现”），该仓库进入轮询集合，攻击者 Issue/评论变为候选（`observeIssues/observeComments` 时连 @ 都不需要）；
  3. 若配合 prompt 注入让 Worker 把代码 push 到该仓库，bot 的写权限即可作为外泄通道（Worker 拥有 shell 与 Git 凭据）。
  另：docs/003:51 与 SETUP:86 声称“提供**个人 PAT** 时自动接受邀请”，实际代码用的是 bot token、与 personal PAT 无关（且 personal PAT 服务端未实现，见 CR-11）。
- 建议：默认不自动接受；新增显式配置（如 `sources.github.acceptInvitations: false` 默认关闭，或允许 `[owner]` 白名单）；只接受白名单 owner/仓库的邀请，并对每次接受写 info 日志（不含 token）。
- 测试建议：fake GitHub 返回一条 invitation → 默认配置断言 0 次 PATCH；开启白名单后只接受匹配项；`repositories:['*']` 下邀请不被自动发现（需人工确认）。

### CR-4 管理 API 未使用宿主 connection/origin 校验

- 位置：`src/app/api.ts:104-120`（`isLoopback` + `x-superagent-request`）、`:236-262`（统一 `guarded`）；`src/app/runtime.ts:1487-1495,1550-1558,1660-1668`（三段自写 fence）；对照 `docs/dsh-api-notes.md` §5.1 “One-call gate for your route — always use it”（`ctx.connection.requestRejection(req)`）与“profile 无 Web carrier 时 fail closed”。
- 证据（确认）：全仓库无 `connection` / `requestRejection` 调用（`grep -rn connection src/` 仅注释）。fence 只信任 `req.socket.remoteAddress` 与本机 header。
- 影响（可利用性取决于部署，推测）：
  - 若 DSH 通过反向代理/远程访问/隧道转发请求，`remoteAddress` 可能呈现为 127.0.0.1，fence 即失效；此时远程调用者可 `PUT setup/config`。
  - 同源页面（任何已加载的 DSH 客户端插件/XSS）天然带 header，可调用全部 setup API：写 token 文件、改 `sources.*`、`executor.prepare`（下一 Ticket 执行任意 shell，见 CR-15）。这比“只读面板”权限大得多。
  - 未校验 Host/Origin/sec-fetch-site（DSH 的 connection 门正是做这个），DNS rebinding 类攻击面无法从代码层排除。
- 建议：统一走宿主 gate：`const rejection = ctx.get('connection')?.requestRejection(req); if (rejection !== undefined) 403;`，无 connection 服务时 fail closed（或至少保留 loopback 但要求 Host=127.0.0.1/localhost）；所有写路由共用同一 helper（顺便解决 CR-18 的重复与 CR-6 的 dispose）。
- 测试建议：`tests/runtime-api.spec.ts` 增加：注入 fake `connection.requestRejection` 返回 403/undefined 的两条路径；无 connection 服务时的 fail-closed；`Host: evil.example` 被拒；所有 setup 路由（state/permissions/telegram/github/config/ssh-key/models/watchdog）逐一断言同一 fence。

### CR-5 默认 clone/push 走 SSH；文档/Config 声称的 HTTPS+PAT credential helper 不存在

- 位置：`src/app/executor.ts:61`（`DEFAULT_CLONE_URL = 'git@github.com:{repo}.git'`）、`:348-390`（clone/prepare 只注入 `GIT_SSH_COMMAND`）；`src/index.ts:230-233`（Config `gitSshKeyFile` 文案：“By default the host uses HTTPS with a credential helper generated from sources.github.tokenFile”）；`src/client/main.js:221,509`（“HTTPS/PAT or generated SSH key”）；`SETUP.md:86`。
- 证据（确认）：全仓库无 `credential.helper`/`askpass`/`x-access-token` 实现（grep 仅命中注释/文档）。只有 `executor.gitSshKeyFile`（向导生成的 SSH key）路径。
- 影响：按 SETUP 的“单账号 PAT 也能完整工作”路径安装（不点“生成 SSH 密钥”）时，新 Ticket 的 `git clone` 使用 `git@github.com:`，无 SSH key → 首次 launch 失败 → effect 重试 → 5 次后进入 safe mode；Worker 无法 push。用户看到的是插件“降级/暂停”，与文档承诺不符。
- 建议（二选一）：
  1. 实现 repo-local credential helper：clone 后写 `.git/config` `credential.helper` 或 `.git-credentials`（0600，位于 stateDir），并在 `GIT_CONFIG_*` 中传递；确保 token 不进入命令行/日志；
  2. 或在 `validateConfig`/Executor 明确要求“必须配置 gitSshKeyFile，否则 clone 使用 HTTPS 但 push 会失败”，并修正 Config/面板/SETUP 文案，`clone` 时优先 `https://github.com/{repo}.git` + 上述 helper。
- 测试建议：`tests/executor*.spec.ts`（若不存在可加）：默认配置 + PAT tokenFile → 断言 clone URL 与注入的 git 配置不提 token；无 SSH key 时不静默失败或给出明确 blocked 原因；日志中 grep 不到 token。

### CR-6 `GET setup/models` 路由未保存 disposer；重启后重复注册抛错、旧 handler 泄漏

- 位置：`src/app/runtime.ts:1516-1571`（`registerModelsRoute` 内 `webServer.register(...)` 未赋值给 `this.*Dispose`）、`:1933-1935`（shutdown 只 dispose api/ssh/watchdog）。
- 证据（确认）：对照 `src/app/runtime.ts:1467`（ssh 保存 disposer）、`:1640`（watchdog 保存）；DSH 的 `WebServer.register` 对同 `(kind,path)` **抛错**（宿主行为见 `docs/dsh-api-notes.md` §5.1 “Duplicate (kind, path) throws”；本仓库提取物 `research/vendor/.../dsh-host-webserver/lib/index.js:370-377` 同样可见）。
- 影响：任意一次插件重启（面板保存配置/`fiber.restart()`）后：
  1. 新 runtime `registerModelsRoute` 抛 “duplicate exact route”，被 catch 成 warn → 新路由不存在；
  2. 旧 handler 仍挂在宿主上，闭包持有旧 `SetupService` 与旧 runtime（store/sessions/ctx 已停止），可能返回 501/陈旧数据，并阻止旧 runtime 被 GC → 每次重启泄漏一份；
  3. 面板模型选择器在首次保存配置后即失效（直到 DSH 重启）。
- 建议：统一 `registerRoute()` helper 返回并保存 disposer（见 CR-18 合并方案）；shutdown 步骤枚举所有路由 disposer；`stop()` 后再断言 `webServer.route(path)` 为 undefined。
- 测试建议：`tests/runtime-setup.spec.ts`：启动→stop→再次启动同一 FakeWebServer，断言第二次注册成功且没有 “duplicate route”；stop 后所有 `SETUP_*` 路由被移除。

### CR-7 崩溃后 stale lock（120s）导致启动失败并降级；watchdog 不会恢复

- 位置：`src/app/runtime.ts:1883-1901`（`stale:120_000`、`update:30_000`、`retries:0`、最多 5 次尝试、退避 300/600/900/1200ms ≈ 总计 3s）；`src/app/runtime.ts:683` 处 lock 失败 → `initialize` reject → `engine.ts` 抛错 → guardian `degraded`；`scripts/watchdog.mjs:322-328` 对 `superagent-status.json: degraded` 的策略是“重启修不了，exit 3”。
- 证据（确认代码，时序为推断）：进程被 SIGKILL/崩溃后锁文件 mtime 停留在崩溃时刻；DSH 由 launchd/用户立即重启（常见 <120s）时，`proper-lockfile` 认为锁未 stale，5 次 ~3s 内放弃；插件 degraded；watchdog 判定 degraded 不重启 → 直到用户手动再次重启（≥120s 后）才恢复。
- 影响：违反“崩溃后自愈”硬要求：一次崩溃 + 自动重启后，SuperAgent 可能静默离线约 2 分钟且不会自行恢复；若用户不再重启，长期离线。
- 建议：① 锁文件由 runtime 写入自身 `pid`/启动时间，启动时若锁持有者进程不存在则主动 `rm`/接管（或把 `stale` 降到 ~15s 并 3s 更新，代价是短暂重叠风险）；② 或在 lock 失败时让 runtime 进入“starting/重试”状态而非直接 degraded，并在后台每 10s 重试获取锁、成功后继续初始化（guardian 的 30s start 上限需要相应放宽或把重试放在 start 之后）；③ watchdog 对 “degraded 且 detail 含 lock” 允许有限重启。
- 测试建议：用真实 SQLite 目录 + 子进程持锁后 SIGKILL，父进程立即启动 Runtime，断言在限定时间内恢复为 ready（或至少无需再次 DSH 重启）；`tests/verify-recovery.spec.ts` 已有子进程 kill 基础设施可复用。

### CR-8 `uninstall.sh --purge-state` 仅校验绝对路径即 `rm -rf`

- 位置：`scripts/uninstall.sh:63-65`（只 `case "$STATE_DIR" in /*)`）、`:110-112`（`rm -rf -- "$STATE_DIR"`）、`:104-107`（`rm -rf "$HOME/.config/superagent"`）。
- 证据（确认）：没有拒绝 `/`、`$HOME`、`$HOME/.dsh`、`/Users`、`/Volumes/*` 等危险值，也没有校验该目录确为 SuperAgent stateDir（缺 `superagent.sqlite`/`secrets/` 等可识别文件）。`SUPERAGENT_STATE_DIR` 环境变量可被任何调用方注入。
- 影响：一次误输入（`--state-dir "$HOME"` 或环境变量误设）即递归删除用户主目录；这是不可恢复操作，属于“低成本、灾难性”问题。
- 建议：purge 前做三重护栏：① 黑名单拒绝 `/`、`$HOME`、`$HOME/.dsh`、`$HOME/Library`、`/Users`、`/Volumes`、`/tmp` 等及浅路径（目录层级 <3）；② 必须存在 `<stateDir>/superagent.sqlite` 或 `<stateDir>/secrets`（或显式 `--force`）；③ 打印将要删除的绝对路径并要求交互确认（`--yes` 可跳过）；`--dry-run` 已存在，默认行为可改为先打印再删除。
- 测试建议：把脚本的路径校验函数抽出为 `scripts/lib/path-guard.mjs` 并用 node 测试（`tests/scripts-uninstall.spec.ts`）：拒绝 `/`、`$HOME`、`~/.dsh`、相对路径、不存在 stateDir 的目录；`--dry-run` 不删除任何文件。

---

## 4. P2 详情（按主题）

### 4.1 恢复 / 生命周期

- **CR-9 重启时 stop 超时与旧实例竞争**（推测）：guardian `STOP_TIMEOUT_MS=15s`（`src/index.ts:304,588`），runtime shutdown 有 8 个步骤、每步 15s 上限（`src/app/runtime.ts:1928-1941`）；effects 步骤会 `await` 在途 launch handler（prepare 默认 120s，`src/app/executor.ts:376-383`）。因此 teardown 可能在上限内“放弃等待”，而旧 runtime 仍在释放锁/关闭 DB；Cordis 随后 re-apply 的新实例可能锁竞争失败 → degraded。建议：runtime 暴露 `forceStop()`/整体 shutdown deadline，guardian 的 stop 上限 ≥ runtime 最坏耗时；或在 stop 中先 abort 在途 handler（AbortSignal 已部分存在）。
- **CR-19 `ensureWorker` 竞争**（推测）：`ensureWorker` 先查 map、`await openSession` 后才 `set`（`src/app/sessions.ts:415-455`）；launch effect 与 delivery effect 并发时可能各自尝试 create/resume 同一 sessionId（create 会抛 “already live”，靠 effect 重试收敛）。后果是噪声重试或短暂双 session；worker cap/`forgetWorker` 的 LRU dispose 也可能与进行中的 launch 竞争。建议：per-ticket promise 复用（router 已有 `routerStarting` 模式），失败时清理。
- **CR-17 relay/notice 静默丢失**（确认）：`src/app/runtime.ts:1117-1146` 中 `sessions.deliverRouter()` 返回 boolean，但 relay/notice handler 忽略返回值；Router 不在线时 effect 视为成功并移除。建议：`deliverRouter` false → `throw new Defer(..., delay)`，或至少记 health。

### 4.2 配置 / 文档一致性（死字段）

- **CR-10 quiet 配置**（确认）：`Config` 声明 `quiet.quietHours`（`src/index.ts:253-260`），但 `RuntimeConfig`/engine 完全没有实现；`quiet.minChars` 的 Schema 文案是“小于该长度不发送（minimum length）”，而 runtime 用 `resolveQuietMaxChars()` 把它当**最大长度截断**（`src/app/runtime.ts:224-227,708`）——用户把 `minChars` 调大反而每句话更长（与描述相反）。建议：实现 quietHours（或从 Schema/示例删除），并统一文案/字段名（`minChars` 重命名为 `maxChars` 或删掉旧别名）。
- **CR-11 personal PAT 死功能**（确认）：面板收集 `personalToken` 并随 `POST /setup/github` 发送（`src/client/main.js:3442-3445`），服务端 `saveToken` 只读取 `token`/`tokenFile`（`src/app/setup.ts:923-976`），personal PAT 被静默丢弃；同时 docs/003:51、SETUP:86 宣称提供 personal PAT 可自动接受邀请。建议：实现（用于接受邀请/邀请 bot 等操作后不留存）或删除 UI/文档，避免让用户在无预期的情况下粘贴第二个高权限 token。
- **CR-12 `update_issue`/`merge_pull` 与文档、提示词矛盾**（确认）：`superagent_github` 提供 `update_issue`（title/body/state/labels/assignees，`src/tools/worker.ts:669-682`），可把 Issue 置为 `closed`；docs/003:53 明文“修改 Issue/PR 标题或关闭 Issue 暂不提供工具（保留给人）”。`merge_pull` 的 `confirm:true` 由模型自行填写（`src/tools/worker.ts:751-780`）；worker prompt 同时存在“Use merge_pull only when the ticket explicitly asks”与“Never merge”（`src/prompts/worker.md:125-127,173`）。建议：产品层面明确权限边界——要么删除 `update_issue.state`/`merge_pull` 的写能力，要么要求“人工确认”（由 engine 记录 person approve 事件而非模型参数），并同步 docs/003 与 prompt。
- **CR-20 其它死字段/漂移**（确认）：Config schema 未包含 Telegram 高级开关（`observeCallbacks/processBacklog/observeAllChatMessages/replyToMessages/mentionPattern/maxDownloadBytes`，`src/sources/telegram.ts:80-115`），`simplify()` 后无法经 Settings/向导配置（仅配置文件直接写可行）；docs/003:44 说“没有 create_issue”而工具已提供；docs/003:51 的 personal PAT 自动化不存在；`src/prompts/worker.md` 对 push 默认分支自相矛盾（第 76 行要求新仓库 `push main`，第 173 行“Never push to the default branch”）。
- **CR-22 安装顺序陷阱**（确认但已被文档缓解）：`Config.stateDir` 默认空串（`src/index.ts:63`），而 setup 路由依赖 runtime 已启动（`src/app/api.ts:293` 之后才注册）；先装 bundle 后配 stateDir 会得到 degraded 且面板无法自救。SETUP:185 与 `scripts/setup.mjs` 已提示先写配置，可接受；建议 Schema 给 stateDir 一个默认值（如 `~/.dsh/state/superagent`，需展开 home）或安装文档置顶该顺序。

### 4.3 安全 / 权限面（其余）

- **CR-13 附件无目录约束**（确认）：worker 报告 `files[].path` 可为任意绝对路径（仅 `existsSync` 校验，`src/tools/worker.ts:66-105`），engine 原样转成 `OutboundAttachment`（`src/core/engine.ts:1565-1580`），Telegram `sendDocument` 直接读该路径（`src/sources/telegram.ts:973-996`）。影响：模型可把 `~/.ssh/id_ed25519`、`~/.dsh` 下 token 文件等作为附件发到用户自己的 Telegram（用户自己的聊天，风险较低但属越权读文件；若配合账号被盗/转发则放大）。建议：附件的绝对路径必须位于 assignment 目录或 `<stateDir>/downloads` 内（`isUnder` 校验），越界一律拒绝并在工具结果中返回明确原因。
- **CR-14 仓库参数不受 allowlist 限制**（确认）：`resolveRepository` 直接采用工具参数 `repo`（`src/tools/shared.ts:150-168`），`superagent_github` 可对 token 可见的任意仓库评论/建 PR/合并/关 Issue；`secretFileFor` 还会从 stateDir 读取 token（`src/tools/worker.ts:262-275`）。建议：repo 必须在 `sources.github.repositories`（或 ticket mandate scope）内；`search/list` 可放宽但写操作必须限制；对 `create_repository` 限制在“新仓库”语义并只允许配置的 collaborator。
- **CR-15 setup 写入面**（确认）：`tokenFile` 允许任意绝对路径写（内容为已通过 Telegram/GitHub 校验的 token，0600，`src/app/setup.ts:1006-1028`）；`PUT setup/config` 接受 `executor.prepare`（用户级任意 shell，`src/app/setup.ts:1040-1066`，executor 在下个 Ticket 执行 `src/app/executor.ts:376-383`）。单独看是“本地用户可控配置”，与 CR-4 的 fence 弱点叠加后变成远程/同源可利用的写入+执行面。建议：setup 写路径仅允许 `<stateDir>/secrets/**`（除非配置显式允许）；`executor.prepare` 不经 setup API 写入（或要求面板二次确认 + 记录 person 操作）。
- **CR-18 路由 fence 重复实现**（确认）：`runtime.ts` 三段路由各自复制了 `loopback + header`/`readJsonBody`/`reply` 逻辑（`src/app/runtime.ts:1453-1700`，约 250 行），与 `api.ts` 的 `guarded` 语义已有漂移：header 在 `api.ts` 用 `hasApiHeader`（兼容数组，`src/app/api.ts:114-118`），runtime 用 `req.headers[API_HEADER] !== '1'`；watchdog 路由的 `readBody` 超限时 timer 不清（`src/app/runtime.ts:1605-1635`）。建议：抽出唯一的 `registerGuardedRoute()`，三段路由复用之（同时解决 CR-6）。
- **CR-16 迁移顺序**（确认）：`src/app/store.ts:846-955` 在读取 `schema_version` 之前执行全部 `CREATE TABLE IF NOT EXISTS`；打开“更新 schema”的库时会先补表、再抛 “newer than supported schema”。上一轮已验证不损坏数据（integrity ok、原值保留），但更稳妥的是先读 meta 再 DDL（或把整个 migrate 包在事务中）。

---

## 5. 已核实为“好”的设计（避免误伤，供后续维护参考）

1. **guardian 隔离**：`apply()` 全路径 try/catch、同步注册 teardown、per-instance 状态（重启安全）、engine start 超时与迟到 handle stop；`tests/verify-guardian.spec.ts` 20 例覆盖。`src/index.ts:627-795`。
2. **effect 队列持久性**：事务内 enqueue、提交后执行、失败退避、`drain()` 等在途 handler（`src/app/effects.ts`）；`tests/verify-recovery.spec.ts` 用 SIGKILL 验证“恰好一次/不丢行/at-least-once 窗口”。
3. **outbox**：receipt 状态机 + effect 排序（按 effect seq），发送失败/等待/丢弃语义清晰；GitHub 评论带内容 marker 幂等（`src/app/outbox.ts`、`src/sources/github-api.ts:806-831`）。
4. **token 处理**：token 仅出现在 Telegram URL path / GitHub `authorization` header；setup 校验错误、API 响应、状态/心跳文件、日志均不含 token；`redactDetail()`/`sanitizeGithub()` 兜底（`src/app/runtime.ts:2001-2007`、`src/tools/worker.ts:186-193`）。
5. **watchdog 无报告回合自愈**：`scanSilent()` 用 KV 持久重试预算，`silentMs/silentMaxAttempts` 可配，耗尽后只报 health 不再循环（`src/app/watchdog.ts:164-220`）。
6. **安全默认**：policy 默认 `observe`、`keyboards` 按钮默认不转候选、Router 无写盘工具、Worker 工具按 session scope 注册并校验调用者角色（`src/tools/shared.ts:122-170`）。
7. **Guardian 配置 Schema 化**：`Config` 由 schemastery 导出，非法配置在 Loader 层被拒而不影响宿主；`getDshRuntimeVersion` 等可选依赖均在 apply 内动态导入。

---

## 6. 测试盲区（CR-21）

现有 25 文件/471 测试以 happy path 为主，以下路径**没有**自动化测试（按风险排序）：

1. 重复 `superagent_route accept`（CR-1）——`tests/tools-router.spec.ts`、`tests/core-ticket.spec.ts` 均无。
2. 既有仓库 + `collaborators` 组合、邀请自动接受（CR-2/CR-3）——`tests/tools-worker.spec.ts` 只测“新建+邀请”，`sources-github` 测了邀请列表/接受但没测“默认是否应接受”的安全策略。
3. `connection.requestRejection`/Host/Origin/origin 校验、无 connection 时 fail-closed（CR-4）——`tests/runtime-api.spec.ts` 只测 loopback+header。
4. 路由 dispose/重启重复注册（CR-6）——无“stop 后再启动”测试。
5. 崩溃 + 立即重启的 stale lock 恢复（CR-7）——`verify-recovery` 只测 SQLite 数据，不测锁。
6. `uninstall.sh` 路径护栏（CR-8）——脚本无测试（`tests/` 里没有任何 shell 脚本测试）。
7. 附件路径逃逸（CR-13）、repo allowlist（CR-14）、setup 任意路径写入（CR-15）——无负向安全测试。
8. `quiet.quietHours`/`quiet.minChars` 语义（CR-10）——`tests/*language*` 只测文案，无 quiet 阈值行为测试。
9. personal PAT 是否被使用（CR-11）——`client-panel.spec.ts` 测了 UI 字段存在，没断言请求体被服务端处理/拒绝。
10. `update_issue`/`merge_pull` 的人工确认边界（CR-12）——只测“confirm 缺失时失败”，没测“模型自填 confirm 也应被拒（如果产品要求人工确认）”。

---

## 7. 五个最高 ROI 修复（按“风险 × 成本”排序）

1. **让 accept 幂等（CR-1，~30 行 + 2 个测试）**：`Engine.decide` 在触发 disposition 已有 accept decision/ticket 时直接返回既有结果；`superagent_route` 返回 `deduped:true`。可立即消除“双 Worker/双 PR/双消息”这类用户可见故障，且不改变现有语义。
2. **收紧 GitHub 写权限（CR-2 + CR-3 + CR-14，~60 行 + 测试）**：工具忽略 `args.collaborators`（只认配置）、仅 `created===true` 邀请、repo 必须在配置/工单作用域内；邀请接受默认关闭或仅接受白名单。一次改动关闭“权限提升 + 外泄链”两类风险，成本低。
3. **统一管理路由并接入宿主 connection gate（CR-4 + CR-6 + CR-18，~120 行重构 + 测试）**：一个 `registerGuardedRoute()`（loopback/header + `connection.requestRejection`，无 connection 时 fail closed）替换 `api.ts` 与 `runtime.ts` 中 4 处重复实现，保存并 dispose 每条路由；顺带修复 models 路由泄漏与 header 数组不一致。这是“安全类问题一次清”的杠杆点。
4. **给 `uninstall --purge-state` 加护栏（CR-8，~20 行 + 小测试）**：黑名单 + 必须识别为 SuperAgent stateDir + 交互确认。成本极低，避免不可恢复的灾难性误删。
5. **修复崩溃后锁恢复（CR-7，~40 行 + 子进程测试）**：锁文件记录持有者 pid 并做进程存在性检查（或把 stale 降到 15s/update 3s + 失败后台重试），让“DSH 崩溃自动重启”真正回到 ready；与 guardian 30s start 上限对齐（顺带处理 CR-9）。

> 次优（若时间允许）：CR-5（HTTPS+PAT 凭据路径，或至少改文档并 fail loudly）、CR-10（清理 quiet 死字段/语义）、CR-11（实现或删除 personal PAT UI）。

---

## 8. 附：审查证据清单

```text
# 全量检查（审查时）
./scripts/pnpmw check  → 25 files / 471 tests passed，构建通过（lib/index.js、engine.js、client.js）

# 关键代码证据
grep -rn "connection\|requestRejection" src/            → 仅注释，无宿主 gate
grep -rn "credential.helper\|askpass\|x-access-token" src/ scripts/ → 无实现（仅 Config 文案）
grep -n "DEFAULT_CLONE_URL" src/app/executor.ts         → git@github.com:{repo}.git
grep -n "webServer.register" src/app/runtime.ts         → models 路由 1530 未保存 disposer
grep -n "acceptPendingInvitations" src/sources/github.ts → 600（每轮 poll 首）、752（发现刷新 force）
grep -n "private decide(" -A 60 src/core/engine.ts      → accept 分支无已决策检查
grep -n "requested: string\[\]" -A 6 src/tools/worker.ts → args.collaborators 覆盖配置
grep -rn "personalToken" src/                           → 仅 client 发送；服务端 0 处读取
grep -rn "stale:" src/app/runtime.ts                    → 120_000，重试 ~3s
ls tests | wc -l; grep -rn "it.skip\|it.todo" tests/    → 0 跳过（但存在 §6 盲区）
```

（本文件是唯一写入产物；未修改任何代码。）
