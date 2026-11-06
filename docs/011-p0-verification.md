# 011 · P0 修复独立验证报告

验证者：qa（独立于 P0 修复实现者）
时间：2026-11-07 00:40（Asia/Shanghai）
基线：`git HEAD = 97b4234` + **未提交的 P0 修复工作区改动**（27 个文件，`git diff --stat` 约 +4.1k/−0.6k）；业务代码只读，本报告不含产品代码改动。
产物：
- 本文件；
- 4 个独立对抗性验证套件（40 个测试）：`tests/verify-p0-engine.spec.ts`(9)、`tests/verify-p0-api-lock.spec.ts`(11)、`tests/verify-p0-github.spec.ts`(10)、`tests/verify-p0-telegram-scripts.spec.ts`(10)；
- 维护性修正：我此前（task-5）的 `tests/e2e/verify-packaging.spec.ts` 两条断言因打包改动（`files` 改为 `lib/**/*.js`、client 产物改为打包压缩）而过期，已按新契约更新，仅测试维护、不是产品回归。

## 0. 结论（发布建议）

**P0 范围内：PASS，建议有条件 GO。**
- 7 个 P0 主题全部通过对抗性验证；**未发现 P0 回归**，也未发现可绕过核心修复的路径。
- 全量质量门：`./scripts/pnpmw check` → **32 files / 600 tests 全绿**（含 build；当前工作区）。
- 发布条件：① 把当前工作区 P0 修复提交（现在未提交）；② Lead 按 `docs/verification.md §7` 在真实 DSH profile 完成一次安装冒烟（本报告不含真实安装/真实账号/真实 LLM）；③ 下列 3 个 **P2 观察项**不阻塞发布，建议排进后续版本。

P2 观察项（详见 §4）：附件护栏无法阻止“worker 先复制/硬链接到 work 目录再上报”（worker 本就有 shell 读权限，属深度防御边界）；附件全部被拒且无文本时 `send()` 返回 `failed` 触发 outbox 重试；显式 `meta.ticketId` 与 open owner 共存时会双投递（当前没有 Source 产生该 meta，属潜伏路径）。

---

## 1. 方法与证据

```text
$ ./scripts/pnpmw check
tsc --noEmit && tsdown && node scripts/build-client.mjs && vitest run
Test Files  32 passed (32)   Tests  600 passed (600)

# 独立对抗套件（本次新增）
$ ./scripts/pnpmw exec vitest run tests/verify-p0-engine.spec.ts         # 9
$ ./scripts/pnpmw exec vitest run tests/verify-p0-api-lock.spec.ts       # 11
$ ./scripts/pnpmw exec vitest run tests/verify-p0-github.spec.ts         # 10
$ ./scripts/pnpmw exec vitest run tests/verify-p0-telegram-scripts.spec.ts # 10
```

方法：全部使用临时目录（`os.tmpdir()`，`afterEach` 清理）、本地假 HTTP 服务（127.0.0.1）、假 DSH host（`tests/runtime-host.ts`）、真实 SQLite/Engine/Runtime/SetupService；不触碰真实账号、profile、LaunchAgent。测试与实现者的测试独立（假服务器自建），只复用低层测试替身。

---

## 2. 通过 / 失败矩阵

图例：✅ 通过（对抗性测试有断言）｜⚠️ 通过但有观察项（见 §4）｜❌ 失败/回归（本次为 0）

### 2.1 resume 爆炸（20 ended → 1 resume）

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 同 Thread 20 张 ended Ticket + 1 条 person 消息 ⇒ 恰好 1 次 resume/launch，其余 19 张保持 ended、无新 Assignment | ✅ | `verify-p0-engine` “resumes exactly one ended ticket…”，断言 launch=1、notice=1、pending 只属于 `tk_19`、其余 19 张仍 ended 且 assignments=1 |
| 选择规则：最近更新的可 resume Ticket | ✅ | 同上，`updatedAt` 递增构造，命中 `tk_19` |
| 显式 `meta.ticketId`：目标不在 Thread subscriptions 时仍 resume | ✅ | “honours an explicit meta.ticketId…” |
| open owner 场景：open Ticket 在 Thread 上时，消息给 open owner、ended 全部不 resume | ✅ | “lets an open owner take the follow-up…”（open 收到 input、delivery effect；launch/notice=0） |
| person 主动 stop 的 ended Ticket 不 resume | ✅ | “does not resume a stopped…” |
| 显式 meta + open owner 同时存在 | ⚠️ | 显式目标被 resume **且** open owner 也收到 input（双投递）。当前无 Source 写 `meta.ticketId`，属潜伏路径；见 §4-2 |

### 2.2 accept / decide / retry 幂等

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 同一 trigger 连续两次 accept ⇒ 1 Ticket / 1 Decision / 1 launch | ✅ | “creates one Ticket/Decision for a repeated accept”：第二次返回同一 decisionId/ticketId |
| 重复 accept 用不同 title 不产生第二张 | ✅ | 同上 |
| pending 已存在时连续 retry 不叠加 Assignment/launch | ✅ | “does not stack retries…”：assignments 数量不变、pending=1、launch=1 |
| `reevaluate` 后仍可二次决策（ignore），不新增 Ticket | ✅ | “still allows a second decision after an explicit reevaluate” |
| 重复 decide 且 outcome 不同（ignore/stop）⇒ 返回首次 accept decision（设计如此） | ✅ | “keeps the first decision…”；改变主意需先 `reevaluate`（上一条覆盖） |

### 2.3 管理 API（fence / 11 路由 / dispose / 重复启动）

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 恰好 11 条管理路由（state/action + setup state/permissions/models/telegram/github/ssh-key/watchdog/operator/config） | ✅ | `verify-p0-api-lock` “registers exactly the 11 management routes”（按路径集合精确比对） |
| 无 header ⇒ 403；非 loopback peer ⇒ 403；错误 method ⇒ 405 | ✅ | “rejects missing header, non-loopback peers and wrong methods” |
| 有 `connection` 服务：401/403 透传；`requestRejection` 抛错 ⇒ fail-closed 403 | ✅ | “uses the host connection fence…” |
| 无 `connection`：跨站 `Origin`/`Host` ⇒ 403；loopback Host/Origin ⇒ 200，并只 warn 一次 | ✅ | “fails closed on cross-site Host/Origin…” |
| stop 后 11 条路由全部移除 | ✅ | “disposes all routes…” + runtime 级 restart 测试 |
| 第二次 start 在同一 WebServer 上重新注册全部 11 条，不抛 duplicate；`setup/models` 不再泄漏 | ✅ | “runtime restart re-registers all routes…”（首实例 stop 后 routes=0，新实例 ready 后 routes=11，models 路由存在且可调用） |

### 2.4 stale lock

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 死 PID 记录 + 残留锁 ⇒ 自动清理并 ready | ✅ | `verify-p0-api-lock` “recovers a dead PID lock…” |
| 同 PID（进程内上一次 runtime）⇒ 清理并 ready | ✅ | “recovers a lock recorded by the same process” |
| 无 PID、锁龄 ≥30s ⇒ 清理并 ready | ✅ | “recovers an old lock without a PID record” |
| 无 PID、锁新鲜 ⇒ 拒绝（degraded，detail=`locked by an unknown process`，锁保留） | ✅ | “refuses a fresh lock…” |
| 活跃外部 PID ⇒ 拒绝且 detail 带 pid 与明确提示；不“偷锁” | ✅ | “refuses a live foreign PID…” |
| ready 后 stop 释放锁、删除 `runtime.pid` | ✅ | “recovers a dead PID lock…” 末尾断言 `<stateDir>.lock` 不存在 |

### 2.5 GitHub（邀请 / allowlist / 附件 / 重放）

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 默认 `acceptInvitations=allowlist`：可信 inviter（大小写不敏感）接受、不可信 inviter/owner 跳过 | ✅ | `verify-p0-github` “default (allowlist) accepts a trusted inviter…”（PATCH 仅 78） |
| 配置的 collaborator/owner 视为可信 | ✅ | “treats a configured collaborator/owner as trusted” |
| `off`：完全不请求 invitation 列表，不 PATCH | ✅ | “mode off never even lists invitations” |
| `all`：显式 opt-in 才接受不可信邀请 | ✅ | “mode all accepts an untrusted invitation” |
| 跳过状态跨轮稳定、不 crash | ✅ | “an allowlist skip is stable across repeated polls” |
| `create_repository` 命中既有仓库（422 exists）⇒ **0 次 collaborator PUT**，即使模型传 `collaborators:['attacker']` | ✅ | “does not invite anyone when create_repository hits an EXISTING repository” |
| 新建仓库只邀请配置的 collaborator；模型参数被忽略 | ✅ | “invites only configured collaborators for a NEW repository”（仅 alice） |
| 写操作 repo allowlist：显式列表外 ⇒ `repo_not_allowed` 且无 API 调用 | ✅ | “rejects writes to a repository outside the configured allowlist…” |
| 通配 `repositories:['*']`：token 主人仓库允许、陌生 owner 拒绝 | ✅ | “wildcard mode trusts the token owner…” |
| 附件：stateDir `work`/`downloads` 内普通文件上传；外部路径、符号链接、目录、不存在文件全部拒绝 | ✅ | `verify-p0-telegram-scripts` 附件两例（只上传 inside+download，上传体不含 secret/link；目录/缺失零上传） |
| 命令重放（同一 update 在 offset 未落盘后重放）⇒ 副作用执行 1 次 | ✅ | “runs a /retry command exactly once…” |
| 内联按钮回调重放（同 callback id）⇒ 动作 1 次、回调应答 1 次 | ✅ | “executes an inline button action once per callback id” |

### 2.6 uninstall 护栏 / watchdog

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| `--purge-state --force` 指向 `$HOME` / `$DSH_HOME` ⇒ 拒绝（黑名单不可被 --force 覆盖） | ✅ | `verify-p0-telegram-scripts` “refuses HOME and DSH_HOME even with --force” |
| 无 `.superagent-state` marker（legacy 布局）⇒ 默认拒绝；显式 `--force` 才接受 | ✅ | “refuses a non-marker directory without --force but accepts it with --force” |
| 有 marker + `--dry-run`：打印 purge plan、不删除任何文件 | ✅ | “--dry-run with the marker deletes nothing” |
| 有 marker 的真实 purge（实现者测试） | ✅ | `tests/packaging-scripts.spec.ts`（全量 check 内通过） |
| watchdog `--node` 绝对路径 / 相对路径拒绝、日志轮转、`watchdog-status.json` | ✅ | `tests/packaging-scripts.spec.ts` “install-launchd rendering / watchdog status and log rotation”（全量 check 内通过） |

### 2.7 personal（operator）PAT

| 子用例 | 结果 | 证据 |
| --- | --- | --- |
| 保存 operator PAT：校验 token、邀请 bot 到选中仓库（`push`）、由 bot token 自动接受邀请 | ✅ | `verify-p0-telegram-scripts` “saves a 0600 operator token…”（invited/accepted 精确断言） |
| 文件权限 0600、默认路径 `<stateDir>/secrets/github-operator-token` | ✅ | 同例（`statSync` mode & 0o777） |
| 响应与日志均不含 token | ✅ | 同例 + “never writes the operator token into logs” |
| `remove`：删除文件、清 KV、`operatorTokenConfigured=false`、通过 configEditor 清 `operatorTokenFile` | ✅ | “removes the operator token file and clears the configured path” |
| `create_repository`（新仓库）自动：邀请 operator 并接受其邀请（tool 级） | ✅ | `verify-p0-github` “with an operator PAT, a new repository invites the operator and accepts their invitation”（PUT collaborator=operator-me、PATCH 501、`operator.status=accepted`、结果不含 token） |

---

## 3. 已确认修复点（代码位置，供 review 对照）

| 主题 | 修复位置（工作区） |
| --- | --- |
| accept 幂等 | `src/core/engine.ts:506-521`（evalRun 为空时返回既有 Decision/Ticket） |
| retry 不叠加 | `src/core/engine.ts:740-744`（存在 pending 直接返回） |
| resume 唯一目标 | `src/core/engine.ts:1341-1450`（`resumeTargetFor`/`threadHasOpenOwner`/`resumable`/`explicitTicketRef`） |
| 11 路由 + 统一 fence + dispose | `src/app/api.ts:107-345`（`registerGuardedRoute`，`connection.requestRejection` + degraded Host/Origin，缺失 connection fail-closed 并 warn） |
| 路由装配/dispose | `src/app/runtime.ts:840`（`registerApi`）、`:1833`（shutdown `api` 一步 dispose 全部）；models 等不再在 runtime 单独注册 |
| stale lock | `src/app/runtime.ts:568,1733-1855`（`STATE_LOCK_STALE_MS=30s`、`runtime.pid`、`recoverStaleLock`、同/异 PID 判定、清晰拒绝文案） |
| GitHub 邀请策略 | `src/sources/github.ts:148-170,241-255,1049-1140`（调用点 `:670` 区域）（`acceptInvitations` off/allowlist/all + `invitationTrusted`） |
| worker GitHub 工具 | `src/tools/worker.ts:443-470,554-620,637-735`（collaborators 参数移除、仅 `created` 邀请、operator 邀请+接受、repo allowlist） |
| 附件护栏 | `src/sources/telegram.ts:994-1062`（`lstat` 非符号链接 + `realpath` + `work`/`downloads` 根） |
| 命令/回调重放 | `src/sources/telegram.ts:55-60,565-575,674-681,1065-1130`（KV 持久 dedupe，7 天 TTL，500 条上限） |
| uninstall 护栏 | `scripts/uninstall.sh:84-190,230-250`（黑名单、marker、legacy 检测、`--force`、`--dry-run` plan） |
| state marker | `src/app/watchdog.ts:48-72,120`（`writeStateMarker`，在 Watchdog.start 时写 0600 marker） |
| operator PAT | `src/app/setup.ts:1140-1360`（保存/邀请/接受/删除/清配置；0600；响应脱敏） |
| store 迁移 | `src/app/store.ts:865-1000`（先读 `schema_version` 再 DDL；v1→v2 增列并回填 `last_trigger_at`） |

---

## 4. 发现的回归 / 绕过 / 风险（均非 P0 阻塞）

1. **附件护栏是“防误用”，不是“防有 shell 的恶意 worker”**（P2，确认）：`allowedAttachmentPath` 只接受 `work/`、`downloads/` 下非符号链接普通文件，能阻止直接指向外部路径与 symlink；但 worker 本就有 shell 读权限，可先 `cp`/`ln` 到 work 目录再在报告里引用，从而绕过“路径来源”检查。若要真正防外泄，需要独立于 worker 的审批/白名单文件类型，或在 Worker 沙箱层禁用网络。当前修复对“prompt 注入诱导直接读任意文件”的场景有效，建议在 docs/003 明确边界。
2. **附件全部被拒且文本为空时 `send()` 返回 `failed`**（P2，确认）：`TelegramSource.send` 在无文本、附件全部被护栏拒绝时落到 `return 'failed'`，Outbox 会按退避重试并累计 failures（消息最终不会发出，但会持续重试）。建议返回 `sent`（视为“无可发送内容”）或 `gone`（不可挽回），并补测试。
3. **显式 `meta.ticketId` 与 open owner 共存会双投递**（P2，潜伏）：`resumeTargetFor` 先处理显式 meta，再判断 open owner，因此同一 person 消息会进入 open Ticket 且 resume 显式 ended Ticket（`verify-p0-engine` 已覆盖并标注）。当前没有 Source 写 `meta.ticketId`，不影响现网；建议未来引入该 meta 时加“open owner 优先”或“只投递一处”的规则。
4. **worker 仓库 allowlist 同时限制只读工具**（P2，行为变更）：`repositoryAllowedForWrites`（命名）实际在 client 之后对**所有**后续 action 生效，`get_issue/list_pulls/search` 也不能访问列表外仓库。对安全有利，但与“只限制写”的命名/直觉不符；建议改名（`repositoryAllowed`）并在 docs/003 说明。
5. **lock 恢复的保守边界**（P2，设计取舍）：`runtime.pid` 是唯一“活锁”证据；若锁由活跃进程持有但 pid 文件缺失/不可读，且锁龄 <30s，会拒绝启动（好于偷锁）；PID 被无关进程复用时也会拒绝（保守误报）。30s stale 与锁更新 10s 对齐 guardian 30s start 预算，合理。
6. **operator token 的 `tokenFile` 仍接受任意绝对路径**（P2，既有本地写入面）：`operatorTargetFile` 只要求绝对路径；与 CR-4 的 fence 修复叠加后风险受限（同源/本地），但建议后续限制在 `<stateDir>/secrets/**`。
7. **degraded fence（无 `connection` 服务）不强制 Host/Origin 存在**（P2，说明）：缺失时不阻断，仅 loopback+header+（若有则校验）Host/Origin；生产 DSH Web profile 有 connection 服务，走强 gate。已在代码中 warn 一次，符合“fail closed 优先、降级显式”的设计。
8. **测试维护**：`tests/e2e/verify-packaging.spec.ts` 两条断言随打包契约更新（`files` glob、client 产物压缩）而过期，已修正；这不是产品回归。

---

## 5. 剩余测试盲区（诚实声明）

1. **真实 DSH 安装/启动**：本报告只到“工作区 + 全量 check”；真实 `plugin_manager install_bundle`、profile 合并、面板渲染、真实 DSH 0.2.2-rc.1 宿主行为仍需 Lead 的安装冒烟（docs/verification.md §7）。
2. **真实 Telegram/GitHub 网络**：邀请/限流/权限边界用假 HTTP 验证；未打真实 API（无真实 token，符合任务约束）。
3. **真实 LLM 与 prompt 注入效果**：重复 accept/越权 repo 等改为代码层幂等/allowlist，无需依赖模型行为；但“模型是否会尝试”未用真实模型验证。
4. **SIGKILL 时机的命令/回调重放**：用“offset 未落盘后重放同一 update”模拟崩溃窗口；未对真实进程 SIGKILL（实现者/我之前的 `verify-recovery` 覆盖了 effect 队列的 SIGKILL，两者互补）。
5. **macOS launchd 实跑**：`install-launchd.sh --dry-run`/plist 渲染与 watchdog 单次/循环逻辑有测试；未真实 `launchctl bootstrap`。
6. **Windows**：uninstall.sh 基于 POSIX sh；Windows 不在本期目标（SETUP 也以 macOS 为主）。
7. **双进程并发**：锁测试覆盖“活跃外部 PID 拒绝”；未做两进程同时 startup 的真实竞态压测（JS 单线程 + proper-lockfile 语义下风险低）。

---

## 6. 复核清单（Lead 发布前）

1. `git status` 确认 P0 工作区改动完整并提交（当前 HEAD 不含修复）。
2. `./scripts/pnpmw check` 必须为 **32 files / 600 tests passed**（本报告基线）。
3. 真实安装冒烟按 `docs/verification.md §7`；额外确认：面板 setup 页 11 条路由可用（尤其 models/operator/watchdog）、`/setup/github/operator` 的 invite/accept/remove 在真实 GitHub 账号下工作。
4. 用真实 Telegram 私聊验证：20 张历史的 DM 线程里发一条消息只触发一个 Ticket（resume 不爆炸）；`/retry` 连点两次只重试一次。
5. 卸载演练：先 `uninstall.sh --purge-state --dry-run` 打印计划，再真实 purge（有 marker 应无 `--force`）。
6. 如需回滚：P0 修复均为工作区改动，`git checkout -- <file>` 可回到 97b4234 基线；数据库 schema 已升到 v2（v1 可原地迁移，v2 不能被旧版本打开——回滚代码前先备份 stateDir）。
