# 验证报告（独立 QA / M5）

最后更新：2026-11-06 17:05（Asia/Shanghai）
环境：DSH 0.2.2-rc.1，Node 26.13.0（bundled pnpm），macOS；`research/` 为本地提取物，不参与安装。
范围：`src/**` 静态审计 + 隔离/恢复/E2E/打包验证；不修改 `src/`，不 commit。
复跑入口：`./scripts/pnpmw check`（typecheck + build + 全量测试）。

---

## 1. 结论摘要

- 全量 `./scripts/pnpmw check`：**22 个测试文件 / 279 个测试全部通过**，构建产物 `lib/index.js`、`lib/engine.js`（含拆分 chunk）与 `lib/client.js` 齐全。
- 用户硬要求（DSH 不被拖垮、失败可见、崩溃自愈、数据不丢不坏、安静打扰、双渠道同一助手、可安装、版本兼容）均有自动化证据；**Lead 已完成真实安装**：`plugin_manager install_bundle` 返回 `application: applied`，插件 `ready`，API 200/403 正确，面板 slot 已注册（§8）。
- 静态审计共 18 项：3 项高危 + B1/B2/B3 三项中等风险已由 owner 修复并被回归测试锁定；剩余低风险见 §4.2（B4–B6 文档/实现差距，不影响启动与打扰策略）。

## 2. 方法与可复现命令

```sh
./scripts/pnpmw check        # tsc --noEmit && tsdown && build-client && vitest run  → 22 files / 268 tests
./scripts/pnpmw exec vitest run tests/verify-guardian.spec.ts     # 20 tests
./scripts/pnpmw exec vitest run tests/verify-recovery.spec.ts     # 11 tests
./scripts/pnpmw exec vitest run tests/e2e                       # 19 tests（见 §3）
```

约束全部遵守：离线（仅 127.0.0.1 假 HTTP 服务）、无真实 token（只用假串）、临时目录在 `os.tmpdir()` 下并在 `afterEach` 清理、不写 `src/`、不 git commit。

## 3. 自动化验证资产（本次新增，独立于实现者的测试）

| 文件 | 数量 | 覆盖内容 | 结果 |
| --- | --- | --- | --- |
| `tests/verify-guardian.spec.ts` | 20 | **编译产物 `lib/index.js` 黑盒**：每个用例复制一份 `lib/index.js` 到临时目录并写入自己的 `engine.js`，用最小 fake Cordis ctx 调 `apply()`。覆盖 engine 导入抛错、start 拒绝/挂起（含超时后迟到 handle 被 stop）、start 返回无 stop、不支持版本（`0.3.1`）、`SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED=1`、缺/相对 `stateDir`、非对象 config、`enabled:false`、`SUPERAGENT_DISABLED=1`、重复 apply、double dispose、**dispose 早于 boot（断言 engine.start 不被调用）**、**start 期间 dispose（断言迟到 handle 被 stop）**、恶意 ctx（logger 抛错/effect 抛错/裸 `{}`）、degraded 插件不阻塞后续 host 插件、**dispose→重新 apply 的 Cordis 重启安全** | ✅ 20/20 |
| `tests/verify-recovery.spec.ts` | 11 | 真实 `SqliteStore` + `Effects`，子进程 `SIGKILL`（fixture `tests/e2e/fixtures/recovery-child.mjs`）：提交后被杀→重启后 effect 恰好执行一次；`COMMIT` 前被杀→零残留；handler 执行中被杀→行保留并重试（**at-least-once 窗口内恰好 1 次重复，不丢行**）；更新 schema（99）被明确拒绝且 `integrity_check=ok`、原数据不变；事务回滚；kind+key 合并/seq 稳定；失败退避状态跨重启；`drain()` 等待 in-flight handler | ✅ 11/11 |
| `tests/e2e/verify-flow.spec.ts` | 5 | 真实 `TelegramSource`/`GithubSource` 打本地假 Bot API / 假 REST + 真 Runtime + 真 SQLite + 模拟 DSH host。覆盖：私聊消息→候选→accept→worker→`progress` 不发送→`ready` **恰好 1 条** Telegram 消息（chat_id 正确、≤200 字符、无重复）；`blocked` 恰好 1 条问题消息；GitHub @ 评论→accept→`ready` 恰好 1 条 issue 评论（含 `<!-- superagent:msg_… -->` 幂等 marker）；observe 模式下推断候选记录 `would_accept`、无 ticket、无任何外发；真实 SQLite 文件关闭重开 + host 重启后中断 Assignment 恢复（新 worker 收到 `[recovery]`、新 assignment running、router/worker session 均走 resume） | ✅ 5/5 |
| `tests/e2e/verify-plugin-boot.spec.ts` | 5 | **安装产物级**冒烟：直接 `apply()` 真实 `lib/index.js` + 真实 `lib/engine.js`（含 tsdown 拆分 chunk）跑真 Runtime/真 SQLite/模拟 host；断言 ready→router session→preset 选择→status 文件 ready→host 清理后 stopped 且 session 释放；host 缺服务时 apply 不抛；Runtime 在缺 `agents` 时 degraded 不崩溃；**假 Bot API + 安装产物全链路：真实 poll → 候选 → accept → worker assignment**；直接 `lib/engine.js` start/stop 干净 | ✅ 5/5 |
| `tests/e2e/verify-packaging.spec.ts` | 9 | 打包静态契约：`dsh.bundle.patch`、`dsh.client`、`manifestVersion`、所有 `exports` 目标存在（含 `lib/client.js`/`lib/engine.js`）、`files` 列出的资产存在、`engines.node`/`engines.dsh` 与 guardian `SUPPORTED_DSH` 一致、patch 内 preset id 与 runtime 选择一致、示例 profile 覆盖同一插件 id、示例不含真实 token、client 模块 id == 包名且 inject 为 bundle 名 | ✅ 9/9 |

> 合计：本报告新增 50 个测试（20 + 11 + 5 + 5 + 9）；其余 218 个测试来自各 owner（core/store/effects/outbox/sources/runtime/tools/patch/client/guardian-isolation 等），作为交叉验证一并跑绿。

## 4. 静态审计清单（file:line / 严重度 / 状态）

### 4.1 已修复并回归

| # | 严重度 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | **HIGH** | guardian 非重启安全：模块级 `disposed` 永不复位，Cordis 在配置变更/`fiber.restart()` 时复用同一 apply → 首次 teardown 后插件永久 `stopped`。违反“改配置自动重启引擎/重启安全 apply”。 | 旧 `src/index.ts:65-68,339-343`；现改为 per-apply `Instance`（`src/index.ts:70-88`），`apply()` 每次新建实例 | ✅ 修复；`verify-guardian` 新增 “restarts after ready” 锁定 |
| A2 | **HIGH** | teardown 只在 `start()` 完成后注册：start 期间 fiber 被 dispose 时 `ctx.effect` 抛 `INACTIVE_EFFECT`，引擎无人拥有地运行，下一次 apply 被当重复忽略。 | 现 `src/index.ts:491-511`：`ctx.effect` 在调度 boot 前同步注册；boot 在版本探测后、start 返回后均复查 `disposed`（`:410,:442`），迟到 handle 由 `stopQuietly` 释放 | ✅ 修复；`verify-guardian` 的 “dispose before boot / during start” 锁定 |
| A3 | 中→低 | 来源事件在存储瞬时失败时被静默丢弃：`receive` 错误被 runtime 转成 `filtered`，Telegram 仍推进 offset、GitHub 仍推进游标。 | 现 `src/core/model.ts:88` 新增 `'failed'`；`src/app/runtime.ts:831-834` 返回 `failed`；`src/sources/telegram.ts:429-449` failed 不推进 offset 并抛出重试；`src/sources/github.ts:495-508` `ReceiveFailedError` 在 save cursor 前中止 | ✅ 修复（代码级；故障注入测试在 sources 自己的套件） |
| A4 | 中 | PR 打开事件未绑定 Ticket：source 的 `GithubPullInfo` 无 `thread` 字段而 runtime `onPullOpened` 要求 `pull.thread`，条件恒假 → Ticket 不订阅自己的 PR Thread。 | 现 `src/sources/github.ts:73-85`（含 `thread`）+ `:875-890` 传 `threadKeyFor(...)`；`src/app/runtime.ts:911-917` 消费 | ✅ 契约修复；runtime 侧 glue 仅代码核对（见 §6），未做自动化集成 |
| A5 | 中→低 | `quiet` 配置曾完全不生效：`minChars/quietHours` 被文档/示例宣传但无代码读取。 | 现 `src/app/runtime.ts:444-447` 把 `quiet.maxChars ?? quiet.minChars` 传给 engine 的 `maxMessageChars`（`src/core/engine.ts:146,1519` 截断）；`quietHours` 仍未实现（架构 §5 标注“可选”） | ⚠️ 部分修复；`quietHours` 为文档/功能缺口（LOW） |
| A6 | 低 | `runtime.exitSafeMode()` 曾有未 catch 的 floating promise。 | 现 `src/app/runtime.ts:786` 带 `.catch()` | ✅ 修复 |

### 4.2 仍开放（按风险排序）

| # | 严重度 | 问题 | 证据（file:line） | 建议 owner |
| --- | --- | --- | --- | --- |
| B1 | 中→已修 | **重复打扰**：`Engine.report` 不拒绝已 `ended` Assignment，也不按 `(kind, summary)` 去重。 | 现 `src/core/engine.ts` report()：ended assignment 直接返回；同 assignment 同 `(kind, summary)` 幂等；blocked→ready 不同 kind 仍生效。回归见 `tests/core-ticket.spec.ts`（4 例） | ✅ core-engine |
| B2 | 中→已修 | **guardian 状态与 runtime 相反**：Runtime 初始化失败仍返回 handle → guardian 记 ready。 | 现 Runtime 暴露 `status`/`detail`；`start()` 非 ready 时先 stop 再 throw（detail 经 redact）；`tests/runtime-watchdog.spec.ts` 缺 agents/invalid config 用例 | ✅ runtime |
| B3 | 中→已修 | **回合结束无报告 → 静默停摆**。 | 现 watchdog 第二扫描：open + 无 terminal report + 无 pending/running assignment + 静默超阈值 → 最多 2 次 retryTicket（KV 计数跨重启），用尽后 `watchdog:silent` health error；测试覆盖 | ✅ runtime |
| B4 | 低 | `store.migrate()` 先执行全部 `CREATE TABLE IF NOT EXISTS` 再读 `schema_version`；打开“更新 schema”的库时会先补表再拒绝（拒绝本身已验证无损：integrity ok、数据不变）。 | `src/app/store.ts:846-950`（DDL 在版本检查前） | core-engine（先读 meta 再 DDL） |
| B5 | 低 | 首次渲染 prompt 时用 `readFileSync` 同步读盘（一次性、阻塞 host 事件循环数十 µs 级）。 | `src/prompts/index.ts:54`（`loadMarkdown`），缓存后不再读 | runtime（改异步或在启动期预载） |
| B6 | 低 | `quiet.quietHours` 被 `RuntimeConfig` 类型接受但无实现，`docs/000-architecture.md` §5 仍称“可选时段”。 | `src/app/runtime.ts:103`、`src/core/engine.ts:43` 仅类型 | runtime（实现或从类型/文档移除） |

### 4.3 信息项 / 已复核无问题

| # | 结论 | 证据 |
| --- | --- | --- |
| C1 | **无 token 泄漏路径**：token 只出现在 Telegram URL path / GitHub `authorization` 头；错误只含 method/description/status/path；token provider 错误不含值；status/heartbeat/degraded JSON、API `/state`、日志均无；示例配置无真实 token（打包测试断言）。 | `src/sources/telegram-api.ts:36-58,397-433`、`github-api.ts:89-120,474-524`、`src/sources/*/token provider`；`tests/e2e/verify-packaging.spec.ts` “示例不含真实 token” |
| C2 | **无未 catch 的 floating promise**（除已修复 A6）：所有 `void …` 均带 `.catch()`（`runtime.ts:753,1112`、`index.ts:314,516` 等）；effects handler 全部 `try/catch` 并 rethrow 给退避队列；`apply()` 全路径 try/catch。 | `grep -n "void \|\.then(" src/**/*.ts` 逐条核对；`tests/verify-guardian.spec.ts` 恶意 ctx 用例 |
| C3 | **timer/资源有主**：所有 `setInterval/setTimeout` 均 `unref()`（`runtime.ts:694-702,1156`、`effects.ts:184-187`、`watchdog.ts:71-78`、`support.ts:65-98`、`index.ts:303-308`、sources 的 sleep）；Runtime.stop 清理 timers/effects/sources/sessions/API/store/lock（`runtime.ts:1170-1215`）；boot smoke 验证 cleanup 后 session 释放、状态 stopped。 | 见左列 file:line；`verify-plugin-boot` 第 1 例 |
| C4 | **异常不逃逸 apply/监听器/effects**：engine 端口全部 `guard/guardVoid` 包装（`core/engine.ts:195-264,1773-1786`）；sessions 监听器回调 `runSafely`/try-catch；executor/watchdog/API handler 全 try-catch；API 两个 handler 外层 catch 保证不产生未处理拒绝。 | `src/core/engine.ts:226-261`、`src/app/sessions.ts:502-530`、`src/app/api.ts:220-261`、`src/app/watchdog.ts:71-77` |
| C5 | **at-least-once 窗口已文档化并测试**：崩溃在“外发成功后、receipt/effect 落库前”会重发。Telegram 侧无服务端幂等（Bot API 限制）；GitHub 侧 `createIssueComment` 用 `<!-- superagent:<msgId> -->` marker 去重（E2E 断言）。恢复测试显示 handler 崩溃后重试恰好 1 次重复、不丢行。 | `src/app/outbox.ts`（pending→send→settle）、`github-api.ts:806-831`、`tests/verify-recovery.spec.ts` handler-die 用例 |
| C6 | **engine 图顶层 import 的是必需 peer**：`sessions.ts:20,22`（dsh-llm/dsh-session）、`tools/*.ts`（dsh-tools）是 package `peerDependencies`，且 engine 本身由 guardian 动态导入；缺失时整插件 degrade 而非宿主崩溃（符合 §8.1 对“可选依赖”的要求）。 | `src/app/sessions.ts:18-22`、`src/tools/router.ts:10-12`、`src/tools/worker.ts:9-11` |
| C7 | **`lib/` 被 `.gitignore` 忽略**：安装前必须 `./scripts/pnpmw build`（SETUP §2.1 已有该步）；本报告的 guardian 黑盒测试同样要求先 build（缺失时给出明确报错）。 | `.gitignore:2`；`tests/verify-guardian.spec.ts` beforeAll 检查 |
| C8 | **tsdown 会拆分 chunk**（`lib/runtime-*.js`、`github-*.js`、`telegram-*.js`、`kind-*.js`）：`files: ["lib"]` 会整体带上；安装后缺任一 chunk 会表现为 engine 导入失败→degraded（boot smoke 验证真实产物可加载）。 | `lib/` 列表；`verify-plugin-boot` 第 1/5 例 |

## 5. 硬要求 → 证据映射

| 用户硬要求 | 证据 | 结论 |
| --- | --- | --- |
| 插件加载/初始化失败绝不能阻止 DSH 启动 | `verify-guardian` 20 例（导入失败/start 拒绝/挂起/无 stop/版本/配置/kill switch/恶意 ctx）全部只 degrade 或 stop；degraded 不阻塞后续 host 插件；缺 host 服务时 apply 不抛 | ✅ 自动化 |
| 失败要可见、可诊断 | `superagent-status.json`/`superagent-degraded.json`、`bootState()`、Runtime health/panel `/superagent/api/state`、watchdog 读取同文件；`verify-guardian` 断言状态文件内容 | ✅ 自动化（文件级） |
| 进程崩溃/重启后自愈 | guardian dispose→re-apply 重启安全；真实 SQLite 关闭重开后中断 Assignment 恢复（`[recovery]` + resume session）；effect crash-retry | ✅ 自动化 |
| 数据不丢、不坏 | SIGKILL 后已提交 effect 仍在且只跑一次；未提交事务零残留；handler 崩溃不丢行；更新 schema 被拒绝且 `integrity_check=ok`、原数据不变 | ✅ 自动化 |
| 安静打扰（默认无 ack/progress；blocked/ready/failed 各恰好一条短消息） | `verify-flow` 的真实 HTTP 断言：progress/waiting 0 条；ready 1 条；blocked 1 条；重复 pump 不重发。observe 模式无外发 | ✅（重复报告场景见 B1） |
| 同一助手、Telegram + GitHub 双渠道 | 两个真实 Source 对假 HTTP 全链路 + 同一 Router session/ticket 语义 | ✅ 自动化 |
| 授权/白名单/observe 语义 | gate/engine 测试 + `verify-flow` observe `would_accept`、无 ticket/无外发；非白名单 actor 在 `verify-guardian`/`verify-flow` 的 harness 中不可达（core 测试覆盖） | ✅ |
| 可安装（bundle patch/preset/engines/exports） | `verify-packaging` 9 例 + owner 的 `patch-bundle.spec.ts` 11 例；真实 `plugin_manager install_bundle` 待 Lead | ✅ 静态；真实安装待做 |
| 版本兼容（0.2.2-rc.1、升级自禁用） | `engines.dsh` == guardian `SUPPORTED_DSH`（打包断言）；`0.3.1`/自检开关 → degraded 且不导入 engine | ✅ 自动化 |
| 长期运行/看门狗 | 脚本静态审查通过；未实际执行 launchd/重启循环 | ⚠️ 未验证（§6） |

## 6. 未验证 / 残余风险

1. ~~**真实 DSH 安装与宿主启动**（Lead 执行）~~ **已完成（§8）**：桌面版 `desktop` profile 安装成功、插件 ready、API 与面板 slot 正常。仍未验证：卸载、坏配置重启后的降级（黑盒测试覆盖，但未在真实宿主注入）。
2. **Web 面板视觉渲染**：slot 注册已在真实 client（`sidebar.panellist` occupant `superagent`、`main` key `superagent`）确认 active；未做截图/点击级验证（本环境无浏览器控制），按钮请求路径已由 mock + API 实测覆盖。
3. **真实 Telegram/GitHub 网络**：假 HTTP 覆盖了轮询/游标/发送/幂等 marker，但真实限速、长轮询超时、token 失效、GitHub Secondary Rate Limit 未打到真实服务。
4. **真实模型行为**：Router/Worker 的语义决策、quiet policy 的“模型不乱说话”、报告格式均用模拟 host 的 tool 调用验证，未用真实 LLM。
5. ~~**B1/B2/B3**~~ **已修复并回归**（§4.2）：B1 core-ticket 4 例，B2 runtime-watchdog 4 例，B3 watchdog 5 例；全量 279 绿。
6. **PR 绑定 glue**（A4）：source 回调 payload（含 `thread`）有 owner 测试，runtime `onPullOpened`→`bindThread` 仅代码核对；尝试在 E2E 中通过注入 source 验证时发现注入路径不经过 runtime 的 callback 装配（runtime 自建 source 才装配），故未纳入自动化；建议真实安装后用一次真实/回放 PR 验证。
7. **watchdog/launchd**：`scripts/watchdog.mjs`、`install-launchd.sh`、`setup.mjs` 仅静态审查（无 secret 打印、参数校验、退避/上限逻辑），未执行 `launchctl`。
8. **多 worker 并发**（`executor.maxWorkers>1`）：core/runtime 单测覆盖部分，E2E 用 1–2 个 worker，未做并发压力/锁竞争测试。
9. **`quietHours`**：未实现（B6）；`quiet.maxChars` 已生效。

## 7. 安装冒烟清单（Lead 执行）

前置：`./scripts/pnpmw check`（本报告 268/268 绿）→ `./scripts/pnpmw build`（`lib/` 被 gitignore，必须构建）。

1. **建独立 profile**，`plugin_manager install_bundle` 目标填本仓库绝对路径（`link:`）；安装结果无 `engines.dsh`/`engines.node` 报错。
2. **行存在且激活**：`plugin_manager list_plugins` 中 `dsh-superagent-personal` 的 `fiberPhase` 为 active（`status 3` 以外的错误态立即检查 stderr/`superagent-status.json`）。
3. **坏配置隔离**：故意把 `stateDir` 设为不可写/相对路径或删掉 → DSH 仍正常启动；`<stateDir>/superagent-degraded.json`（可写时）与日志含明确原因；`bootState`/panel 显示 degraded。
4. **正常配置**：`stateDir` 绝对路径 + `sources.telegram.allowedUserIds` + 假/真 token；启动后检查：
   - `<stateDir>/superagent-status.json` = `ready`，`superagent-heartbeat.json` 新鲜（< 2 分钟）；
   - `GET http://127.0.0.1:<port>/superagent/api/state` 带 `x-superagent-request: 1` → `ok:true`、`plugin.status=ready`；**不带 header → 403**；
   - Telegram 私聊 `/status` 返回 ≤100 字状态且不经过模型；
   - 面板侧边栏出现 Superagent 入口，页面能读出 sources/tickets（client bundle 由 `/plugins/...` 提供）。
5. **重启/配置变更**：修改插件行配置触发 fiber 重启 → 插件重新 `ready`（A1 回归），未完成 Ticket 的 Assignment 恢复为 `[recovery]`。
6. **kill switch**：`SUPERAGENT_DISABLED=1` 启动 → DSH 正常、status `stopped`；`enabled:false` 同理。
7. **密钥泄漏检查**：DSH 日志、`superagent-*.json`、`/superagent/api/state` 响应、`watchdog.log` 中 grep token 前缀应为 0 命中。
8. **看门狗**：`node scripts/watchdog.mjs --state-dir <dir> --dry-run --json` 在健康态退出 0；不存在的 state dir 退出 2；`install-launchd.sh --dry-run` 能渲染 plist（真正 `launchctl load` 可选）。
9. **卸载**：`plugin_manager remove` → DSH 正常启动；state 保留；`./scripts/uninstall.sh --purge-state` 需显式确认才删数据。

## 8. 附录：关键命令与产物证据

```text
$ ./scripts/pnpmw check
tsdown … lib/index.js 16.31 kB, lib/engine.js 0.41 kB, lib/runtime-*.js 210.32 kB,
        lib/github-*.js 44.23 kB, lib/telegram-*.js 29.59 kB, lib/kind-*.js 0.50 kB
vitest: Test Files 22 passed (22) · Tests 268 passed (268)

$ ./scripts/pnpmw exec vitest run tests/verify-guardian.spec.ts
Tests 20 passed — 含 “restarts after ready (config change / fiber.restart())”、
“never starts the engine when disposed before the boot microtask”、
“stops a handle that resolves after a dispose during start”

$ ./scripts/pnpmw exec vitest run tests/verify-recovery.spec.ts
Tests 11 passed — SIGKILL(commit-then-die / mid-transaction / handler-die / clean-run)、
newer-schema 拒绝、rollback、coalesce、backoff-across-restart、drain

$ ./scripts/pnpmw exec vitest run tests/e2e
Tests 19 passed — verify-flow(5) + verify-plugin-boot(5) + verify-packaging(9)
```

证据缺口（诚实声明）：§6 的 1–9 项均无自动化证据；其余结论均可由上述命令复现。

## 8. 真实安装记录（2026-11-06 17:00，Lead）

环境：DSH Desktop 0.2.2-rc.1，profile `desktop`，Node 24.21.0，stateDir `~/.dsh/state/superagent`。

| 检查 | 结果 |
| --- | --- |
| profile patch 写入配置行（`scripts/setup.mjs --profile desktop --write-patch`） | ✅ 原文件已备份到 `/tmp/cordis.patch.yml.backup-*`，追加 `dsh-superagent-personal` 配置行（sources 暂关闭、observe） |
| `plugin_manager install_bundle`（绝对路径、link 安装） | ✅ `application: applied`；profile pnpm 链接成功，无 `engines` 警告（仅 peer 链接提示） |
| 插件状态文件 | ✅ `superagent-status.json`: `status:"ready"`、`dshVersion:"0.2.2-rc.1"`；无 `superagent-degraded.json` |
| 心跳 | ✅ `superagent-heartbeat.json` 新鲜（pid 存在、`router:true`、`safeMode:false`） |
| 管理 API | ✅ `GET /superagent/api/state`（带 `x-superagent-request: 1`）返回 `ok:true`、`plugin.status=ready`、health runtime/effects/sessions:router ready；**无 header → 403** |
| 面板 slot | ✅ client `Slots.listSubTree`: `sidebar.panellist` 有 occupant `superagent`（order 20，active），`main` 有 key `superagent`（active） |
| 看门狗 | ✅ `watchdog.mjs --dry-run --json` → `healthy`；`install-launchd.sh --dry-run` 渲染 plist 成功（未 `launchctl load`） |
| token 泄漏 | ✅ status/heartbeat/API 响应中 grep token 前缀 0 命中 |
| 提交与推送 | ✅ `main` 已推送到 `github.com/Meaple-SFKY/Super-Agent-Dsh-Plugin` |

待完成（需要操作者）：写入 Telegram bot token、GitHub PAT（`~/.config/superagent/`，600）、填写 allowedUserIds/repositories/login，启用 sources 并重启插件；之后按 §7 复核 `/status`、真实消息链路与 watchdog 安装。

## 9. 真机验收记录（2026-11-06 19:00–19:20，Lead）

中文语言、新仓库与生命周期修复后的真实环境验收：

| 场景 | 结果 |
| --- | --- |
| 安装/重载 | 多次 `plugin_manager set_plugin` 重启插件均恢复 `ready`，sources ready，无 degraded 文件 |
| 一键设置 API | `POST setup/telegram` / `POST setup/github` 校验并原子写入 `<stateDir>/secrets/*`（0600/0700）；`PUT setup/config` 经 DSH `configEditor` 持久化并在线重启生效（`language: zh`、`repositories: ["*"]`、`allowSelf: true`） |
| 单账号 GitHub | `allowSelf: true` 下，自己的 issue/comment 能触发；agent 自己的评论/PR 带隐藏 marker，不会自激 |
| 自动发现仓库 | 新建仓库后 GitHub 来源从 16 → 17 repo(s) (auto)，无需改配置 |
| Telegram 新建仓库 | 用户在 Telegram 发起「新建私有仓库 superagent-demo-1…」：Router 接单 → Worker 调 `create_repository` → `git init` → SSH push `main` → 中文 result `已完成，请验收：私有仓库已建并推送 main：https://github.com/Meaple-SFKY/superagent-demo-1` |
| 中文优先 | worker 报告/结果评论为中文；`/status` 命令回复已本地化；可通过设置向导切换到 English |
| 单条结果、无重复 | 修复后 CineNest #3 仅 1 条中文 result 评论，无 “…” 空消息、无 worker 重复评论 |
| ready 生命周期 | 真实 ticket ready 后自动 `ended(completed)`，`/superagent/api/state` 的 active/attention 立即清空；同 Thread 后续人消息可按原 Mandate resume（core 测试覆盖） |
| safe mode 通知 | 连续失败只发一条 ≤140 字中文提示（含 /resume 指引），完整错误链仅留在日志/health/panel.detail |
| 面板 | 第二轮排版（16px/1.7、28px 卡片 padding、31px 页面标题）已在线；设置向导包含机器人语言、仓库多选、allowSelf、watchdog/权限说明。视觉细节仍需用户主观确认 |
| 已知限制 | GitHub issue close 不再影响 ended ticket（ready 是终态）；PR merge 后的 outcome backfill 需要后续独立语义；面板 UI 语言跟随 DSH，机器人语言独立 |

完整证据：`git log --oneline`（功能分步提交）、`docs/002-setup-api.md`、`docs/dsh-api-notes.md`，以及 `./scripts/pnpmw check`（25 files / 373 tests）。
