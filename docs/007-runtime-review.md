# 007 · Runtime / Session / Executor 架构与性能审查

- 审查对象：`src/app/{runtime,sessions,executor,assessor,api,setup,health,watchdog}.ts`、`src/tools/*`、`src/prompts/*`、`cordis.patch.yml`（preset）、对应 runtime/tools 测试。
- 基线：工作区 commit `ff8a17c`（2026-11-06），`./scripts/pnpmw check` 当时全绿（25 files / 471 tests）。
- 方法：**静态审查**（源码 + 默认值 + 测试行为），未做真实压测/采样；文中所有"≈/预计"均为静态推算，标注 `[需实测]` 的结论必须在真机上用 §8 的方法测量后再动手。
- 约束：本任务只产出本文件，没有改任何代码。

---

## 1. 运行模型（一张图）

```
DSH Host boot
  └─ guardian src/index.ts (apply) ──dynamic import──► src/engine.ts start()
       └─ Runtime.initialize()                      [runtime.ts:662-861]
            acquireLock(stateDir)                    (proper-lockfile，防双实例)
            openStore(sqlite)                        (schema 版本、WAL)
            preloadPrompts()                         (md→cache，失败回落 builtin)
            createEffects / createOutbox / createEngine
            new Sessions / Executor / Assessor / SetupService / Watchdog
            registerApi + setup routes (state/action/setup/ssh-key/models/watchdog)
            await ensureRouter()                     (create|resume + preset mount + prompt)
            await createSources()                    (dynamic import telegram/github)
            installTimers(); effects.start()
            void afterStart(): sources.startAll(); executor.recover()
            ready + heartbeat

数据流（每个事件）:
Source.poll ---► Engine.sources.receive()  [同步, SQLite txn]
   ┊  (≤2s) ──► Runtime pass timer ─► Engine.evaluateDue() ─► startEval()
   ┊  (≤2s) ──► Effects pump ─► assessment handler ─► Assessor.deliver()
   ┊           Router Session 一个 turn（模型调用，时长由 LLM）
   ┊           Router 调 superagent_route(accept) ─► Engine.decide() ─► Ticket+Assignment+(launch effect)
   ┊  (≤2s) ──► Effects pump ─► launch handler ─► Executor.launch()
   ┊           prepareWorkspace(mkdir/git clone/git config) ─► Sessions.ensureWorker()
   ┊           assignment message ─► agent.followup() ─► assignmentStarted()
   ┊           Worker Session 第一个 turn（模型调用）
   ┊           Worker 调 superagent_report ─► Engine.report() ─► Outbox ─► reply effect
   ┊  (≤2s) ──► Effects pump ─► Outbox reply handler ─► Source.send()
```

关键事实：**所有跨模块推进都是轮询驱动的**（Runtime pass 2s、Effects pump 2s、Outbox reply 串行 1、GitHub 轮询 60s 默认）。

---

## 2. 启动与恢复耗时

### 2.1 时序列（`runtime.ts:662-861`）

| # | 步骤 | 代码 | 预计耗时 | 说明 |
|---|---|---|---|---|
| 1 | mkdir stateDir + 目录锁 | 665-668 | 1–5ms（本地） / 数十 ms（网络盘） | 锁失败重试 5 次×300ms 后抛错→degraded |
| 2 | SQLite open + schema/迁移 | 669-675 | 5–30ms `[需实测]` | `node:sqlite` 同步打开 |
| 3 | prompt 预读 | 682-687 | 1–5ms | 3 个 md，失败回落 builtin |
| 4 | Effects/Outbox/Engine/Setup 构造 | 690-810 | <5ms | 纯内存对象 |
| 5 | 注册 10 条 HTTP 路由（state/action + 5 setup + ssh-key/models/watchdog） | 812-819 | <1ms | webServer 可用时 |
| 6 | **ensureRouter()** | 822 | **20–200ms `[需实测]`** | resume=读持久化+恢复事件+`preset mount`（挂 Router 的 Cordis 组合）+ prompt 注册；首次 create 更贵 |
| 7 | createSources() | 825 | 10–60ms `[需实测]` | 两个 dynamic import + 构造；不 await 网络 |
| 8 | timers + effects.start + heartbeat | 828-848 | <5ms | 之后立即 `ready` |
| 9 | afterStart（detached） | 851-862 | 变长 | `sources.startAll()` 顺序 await（Telegram 首个 getUpdates 立即返回，GitHub 首轮 poll）；然后 `executor.recover()` |

**结论**：`ready` 不等待 sources 真正 ready，也不等待 recover。面板在 ready 后的一小段时间内可能看到 sources=`starting`、历史 Assignment 尚未恢复——这是设计选择（宿主启动不被拖住），但"ready"语义应理解为"控制面就绪"。

### 2.2 恢复路径（`executor.ts:267-315`, `sessions.ts:305-360`, `engine.assignmentInterrupted`）

- 对每个 open Ticket 的 running Assignment：`engine.assignmentInterrupted()`（结束旧 Assignment、插入 `resume` Input、创建新的 pending Assignment、enqueue launch effect），然后**逐个 `await executor.launch()`**。
- 每次 launch 可能包含：`git clone`（无 `.git` 时，网络）、3 条 `git config --local`（3 个子进程）、session resume（读日志）、assignment message。
- 顺序执行 ⇒ **N 个断点 Assignment 的恢复时间 ≈ N × (clone + resume + git config)**。20 个中断的 worker × 每次 clone 2s ≈ 40s 才恢复完，期间 launch effect 也在排队。`[需实测]`
- **重复恢复竞态（低概率但真实）**：`assignmentInterrupted` 会 enqueue launch effect，而 effects pump 在 afterStart 之前就已启动；若 pump 恰好在"interrupt 完成、recover 调 launch"的间隙执行该 launch effect，会先完成 launch（Assignment→running），随后 `Executor.launch` 仍会执行（它只拒绝 `state==='ended'`，不拒绝 `running`），导致**同一条 assignment message 被投递两次**。建议给 `Executor.launch` 加 `if (assignment.state !== 'pending') return`（与 launch effect handler 的守卫一致），成本 1 行。
- 崩溃窗口（at-least-once）：launch handler 在 assignmentStarted 前失败→assignment 仍 pending，重启会重投；assignmentStarted 后崩溃→resume 继续。重复投递 assignment 不破坏正确性（worker 收到两条相同任务），但浪费 token。`[需实测]` 频率极低。

### 2.3 会话创建/恢复成本

- `Sessions.openSession`（`sessions.ts:420-481`）：`sessionExists(stat)` → `agents.create/resume`（60s 超时） → `setup` 回调里 **`agentPresets.mount`（每个 worker 打开十余个插件行、约 16 个工具/辅助插件的组合）** + prompt section + 工具注册（7 个 `defineTool` 现场编译 schema） + `ensureDurableSelection`。
- 每个 **新 Ticket** 都完整构建一次 worker 组合与工具集；已持久化的 Ticket 走 resume（不再创建事件，但仍 mount preset 组合）。**preset mount 与工具注册是 worker 启动抖动的主要怀疑点** `[需实测]`（建议在 setup 回调打点）。
- Router 只创建一次；worker 每个 ticket 至多一个（cap 见 §4）。

---

## 3. Trigger → Eval → Assignment → Worker 延迟构成

设事件在 `t0` 到达 Source：

| 阶段 | 默认延迟 | 代码/默认值 | 可优化 |
|---|---|---|---|
| Source 轮询 | Telegram ≤~0.1s（25s long-poll 返回）；GitHub **≤60s** | `telegram.ts:172-173`（pollTimeout 25s/poll 1s）、`github.ts:210`（pollSeconds 60，min 10） | 降 GitHub poll 间隔（成本：API 配额）；事件驱动 webhook 不在本期 |
| receive→evaluateDue | **0–2s** | `runtime.ts:1145` passInterval=2000 | ✅ 事件触发（§6-1） |
| evaluateDue 内 startEval | 同一 pass | `engine.ts:290-321`（单 pass 锁，最多 20 次内循环） | — |
| eval→assessment effect | **0–2s** | `effects.ts:93` pump 2s，assessment concurrency 1 | ✅ 事件触发 |
| Assessor.deliver → Router turn | 模型调用时长 | `assessor.ts`；Router 串行 turn | 内容大小（§5） |
| Router decide → accept | 同 turn | — | — |
| accept→launch effect | **0–2s** | pump 2s，launch concurrency 1（**全局串行**） | ✅ 事件触发 + 并发度 |
| launch: dir prepare | `mkdir` ~1ms；`git clone` **0.5–30s**（有 repository 且目录无 .git）；`git config` 3 子进程 ~30–100ms；prepare 命令最长 180s | `executor.ts:348-386` | 预留仓库/缓存 clone；git config 合并为一次 `git -c` 不适用（repo-local） |
| ensureWorker | resume ~10–100ms `[需实测]`；create + preset mount 更高 | `sessions.ts:420-481` | 会话预热 / 池化（§6-2） |
| assignment message → Worker 首 turn | 模型调用时长 | `executor.ts:175-215` | batch/延迟 |
| Worker report → user message | **0–2s** pump + reply concurrency 1 + Source.send 延迟 | `outbox.ts` reply handler concurrency=1；跨 ticket 串行 | 增加 reply 并发/按 channel 并行 |

**端到端典型值（静态推算）**：Telegram 明确请求 → 用户看到"已完成" ≈
`0.1s(poll)+0~2s(pass)+0~2s(pump)+Router turn(2–20s)+0~2s(pump)+clone(0.5–10s)+session(0.05–0.5s)+Worker turn(数秒–数分钟)+0~2s(pump)+send(0.1–1s)`。
不含两次模型生成，**框架固定开销约 3–8s**，其中 2–4s 纯属 2s 轮询粒度；GitHub 起源再加 0–60s 轮询。`[需实测]`

**单 pass 锁**：`runtime.ts` passBusy + `engine.ts:290` passing 双重保护；长 pass 只会跳过后续 tick，不会堆积。**没有** 每 Source 的 pass 触发。

---

## 4. 并发模型

| 资源 | 并发上限 | 位置 | 备注 |
|---|---|---|---|
| Engine pass | 1/tick（busy 跳过） | `runtime.ts:1145`, `engine.ts:290` | 内循环最多 20 次状态推进 |
| assessment effect | 全局 1 | `effects.ts` 默认 `concurrency:1` | 一次只投递一个候选，Router 本来串行 |
| launch effect | **全局 1** | 同上 | 一个 git clone 会阻塞所有 ticket 启动 |
| delivery effect | 全局 1 | 同上 | 输入注入串行 |
| reply effect | 全局 1 + 每 ticket/channel 顺序（5s Defer） | `outbox.ts:72-132` | 慢 Telegram 请求会阻塞其他来源的外发 |
| relay/notice | ordered，1 | `effects.ts:95` | 内部消息 |
| Router model turn | 1 | DSH agent 语义 | 候选排队 → 上下文越长越慢 |
| Worker sessions | **软上限** `maxWorkers`（默认 2） | `sessions.ts:738-752` | 只在 `ensureWorker` 之后回收**空闲**会话；并发 launch 串行但可先后创建多个，全部 running 时可超过上限（无排队/拒绝） |
| Router↔Worker | 独立 session/fiber | — | Router 的 turn 不会被 Worker 阻塞 |
| Telegram/GitHub Source | 各自 1 个轮询循环 | sources | GitHub 逐 repo 顺序 fetch（sources 所有） |

**瓶颈排序（静态判断）**：① launch 全局串行 + clone 使多 ticket 排队；② reply 全局串行可能被慢 Source 拖住；③ 单 pass/单 pump 的 2s 粒度；④ Router 串行 turn 在候选突发时排队；⑤ worker 数量软上限导致内存/模型成本随 ticket 增长。

---

## 5. 工具层、Prompt 与上下文成本

### 5.1 Prompt 体积（精确字节，`src/prompts/*.md`）

| 角色 | 文本 | 字节 | 粗略 token（英文≈4B/token） |
|---|---|---|---|
| Router system | router.md + admission.md + language rule | 4350+2865+≈250 ≈ **7.4KB** | ≈1.8–2.0k |
| Worker system | worker.md + language rule | 9212+≈250 ≈ **9.4KB** | ≈2.2–2.4k |

- 模板只读一次并 cache（`prompts/index.ts:68,101-137`），每次 session 创建时把**静态字符串**注册为 prompt section；DSH 每个 model step 会重新组装/渲染，但**不会重新读盘**。prompt 模板"重复编译"不是问题；真正每步重复的是**system prompt + 工具 schema** 的 token。
- 语言规则每次追加约 150–250B，可忽略。

### 5.2 工具 schema / 输出

| 项 | 现状 | 风险 |
|---|---|---|
| Worker 工具数 | 7 个 `superagent_*` + preset 16 个 DSH 工具（bash/pwsh/fs/fs-search/jobs/subagent/subagent-control/todo/goal/web/skill…）| 每步全量 schema；worker 的 `superagent_github` 是最大的一个（action enum 15 项 + ≈45 个参数字段，静态估计 ≈4–6KB JSON） `[需实测 token]` |
| Router 工具数 | 7 个 `superagent_*` + bash/pwsh/fs/jobs/skill 等 | 每步 schema ≈4–6KB `[需实测]` |
| 工具定义构建 | **每个 worker session 重新 `workerToolDefinitions(deps)`（7 个 defineTool 编译 schema）** | 创建抖动；deps 每 runtime 不变，可缓存一次共享 |
| 大输出 | `renderJson` 总截断 12KB；`get_pull_files` 每文件 patch 1200B×30 ≈36KB→被 12KB 截断（可能导致 JSON 不完整/模型难解析）；`worker_context` 含 20 条 thread + 最近报告；`get_issue`/`get_pull` body 2KB | token 峰值不稳定；建议结构化截断（每项 + 总量） |
| GitHub 调用 | 每次 action **新建 GithubApi** + token provider（每次读 token 文件），且 `defineTool` 未声明 `isConcurrencySafe` ⇒ 同一 turn 多个 GitHub 调用**串行** | 多读调用（get_issue + list_checks）串网络 RTT；只读动作可并行，写动作保持串行 |
| Report files | 最多 10 个，`existsSync` 同步校验 | 可忽略 |

### 5.3 上下文增长

- **Router**：candidate 消息（thread 窗口 12 条+batch+related tickets，静态估计 4–6KB/条 `[需实测]`）+ 决策历史；Router preset **有** compaction/basic + tool-result-pruner（threshold 8192 chars），风险受控。
- **Worker**：assignment（3–6KB）+ 全部对话 + 工具输出；**worker preset 没有 compaction / tool-result-pruner**（`cordis.patch.yml` 对比：Router 有 compaction group，Worker 没有）。长 ticket（数小时/上百步）上下文无限增长 ⇒ token 成本、延迟、甚至上下文溢出；worker 也没有空闲 TTL（会话要等 cap 回收）。**这是长期运行最值得修的一处。**

---

## 6. 资源生命周期与泄漏清单

| 资源 | 创建/归属 | 释放 | 备注 |
|---|---|---|---|
| Router Agent/Session | 1 个，runtime 生命周期 | `Sessions.stop` | 长期驻留，符合设计 |
| Worker Agent/Session | 每 ticket（resume 复用） | `Sessions.stop`、`enforceWorkerCap`（仅空闲超出 cap 时）、ticket ended 时 executor.interrupt | **无 idle TTL / 无 ready 后主动 dispose**；cap 是软的（§4） |
| Worker 工作目录 `<stateDir>/work/<ticketId>` | 每 ticket clone | **从不清理** | 长时间运行磁盘持续增长（完整 git 历史）；需要 retention |
| SQLite 行（triggers/decisions/effects/receipts/tickets） | 持续追加 | **无 retention/compaction** | 与 docs/000 §6 的"暂不清理"一致，但需监控 DB 大小 |
| DSH session 日志（每 worker） | persistence | 无清理 | 与工作目录一起增长 |
| timers | runtime pass/heartbeat/watchdog，均 `.unref()` | `stop()` 清理 | ✅ |
| Agent 事件订阅 | `agent.ctx.on('agent/status'/'error')` | `disposeRecord` 中 disposer；agent scope 卸载兜底 | ✅ |
| Effects/Outbox handler | 构造时注册 | Effects.stop | ✅ |
| 子进程（git/prepare/ssh-keygen/watchdog/launchctl） | execFile 全部带 timeout（git 180s/prepare 180s/ssh-keygen 20s/watchdog 30s/launchctl 5s） | 超时即杀 | ✅ |
| HTTP 路由/监听 | registerApi + 3 个 setup 扩展路由 | stop 时 disposer | ✅ |
| `Sessions.startedAt` / `warned` / watchdog maps | 有界 | dispose/清除 | ✅（`warned` 键按 role/preset，有界） |
| `effectStats` | 按 effect kind | 不清理 | 有界（6 种） |
| heartbeat 写入 | 30s 一次，串行链 | 不积压（链只保留最新 Promise） | ✅ |
| **Recovery 竞态** | §2.2 重复 assignment message | — | 10 行内可修 |

---

## 7. 崩溃/恢复语义核对

| 场景 | 行为 | 风险 |
|---|---|---|
| 进程在 effect 入队后、执行前崩溃 | 重启后 effect 重跑（at-least-once） | 幂等性由 handler 保证：launch handler 检查 pending；delivery/inputsDelivered 幂等；report 由 core 幂等 |
| 进程在 launch 投递后、assignmentStarted 前崩溃 | assignment 仍 pending → 重启重投 | 重复 assignment 消息（浪费 token，无错误） |
| 进程在 worker turn 中崩溃 | assignment running → interrupted → 新 pending + recovery note + 重新 launch | 恢复会再次 clone/组 session；见 §2.2 |
| Session 丢失（persistence 无记录） | 新建同 id session，工作目录还在 | worker 失去对话记忆，但目录/分支还在；可接受，日志应显式 |
| 模型配置变更后重启 | 显式 router/executor 路由 → 对比 durable selection 并 select（task-39 跟进）；未显式配置 → 保留 durable | ✅ 已覆盖测试 |
| 宿主退出（优雅） | 不再补 `turnEnded`，Assignment 保持 running，下次启动按 interrupted 恢复 | 设计如此 |
| 磁盘满/DB 损坏 | openStore 抛错 → engine start 抛错 → guardian degraded + 清理 | ✅ 有测试 |
| 两个插件实例（同 stateDir） | 目录锁拒绝第二个 | ✅ |

---

## 8. 测量计划（先量后改）

建议在以下位置加 `performance.now()` 计时日志/指标（全部受 debug 开关或低采样率控制，避免日志本身成为成本）：

1. **启动**：`engine.ts start → Runtime ready`、`ensureRouter`、`createSources`、`sources.startAll`、`executor.recover`、每个 session create/resume、preset mount、工具注册。
2. **流水线**：`receive→startEval`、`startEval→assessment enqueued→handled→Router turn start/end`、`decide→launch handled`、`launch→assignmentStarted`、`followup→first turn start`、`report→reply sent`。用现有 `ticketId/assignmentId/evalId` 关联。
3. **Effect 队列**：各 kind 的 pending 数、等待时长、失败/退避次数（`Effects.health()` 已有 pending/failures，可周期性写 health/log）。
4. **Session**：每个 session 的创建耗时、turn 时长、token usage（DSH session event 中已有 usage）、上下文 tokens（可用 `ctx.tokenMeter` 若存在）。
5. **资源**：进程 RSS、agent 数（`ctx.agents.list()`）、worker 数、`<stateDir>/work` 大小、SQLite 大小、pending effects、open tickets。
6. **场景基准**（离线 fake host）：a) 100 条 Telegram trigger 突发（测 Router 排队/批处理）；b) 10 个 ticket 同时 accept（测 launch 串行与 clone）；c) 20 个 running assignment 的重启恢复；d) 4 小时 worker 会话（测上下文增长/compaction 缺失）。
7. **GitHub**：轮询间隔 60s 对"CI 失败→触发修复"的端到端延迟影响；多只读调用串行 vs 并行。

---

## 9. 五个最有效的优化（按优先级）

### ① 事件驱动的 pass/pump 唤醒（替代固定 2s 轮询）
- **收益**：消除每个流水线节点的 0–2s 平均 1s 等待；Telegram 请求→Router 开始、accept→launch、report→用户消息三处叠加，**P50 约省 2–3s，P95 约 4–6s**；CPU 空转明显下降（空闲时也会每 2s 扫两次 SQLite）。
- **风险**：重入与竞态（已有单 pass 锁/launch guard，需补 `assignment.state==='pending'` 守卫）；effect 入队发生在 transaction 内，需要 commit 后唤醒（core `Effects.enqueue` 加 post-commit hook 或 runtime 在 Source.receive/Decide 后主动 `pump()`）。
- **改动面**：`src/app/effects.ts`（wake 信号）+ `src/app/runtime.ts`（receive/decide 后触发）+ 可选 `src/core/engine.ts` 的 post-command 回调。中。
- **先量**：pass/pump 的空转 CPU 与各节点等待分布；确认 DSH 事务/事件边界可安全回调。

### ② Worker 生命周期：硬上限 + 空闲 TTL + ready/ended 后释放
- **收益**：常驻内存与模型上下文成本可预测；避免"软 cap 下 N 个 running worker 全留存"；减少长跑后空闲 fiber（每个 worker 是一棵 Cordis 插件树）。预计几十 MB/worker 级别 + 每 worker 的 session 写句柄。
- **风险**：冷启动恢复变慢（resume 成本，需测）；可能丢弃未报告上下文（有持久化+recovery note 兜底）。
- **改动面**：`sessions.ts`（TTL/硬上限/排队或 Defer）、`executor.ts`（launch 时准入）、`runtime.ts`（配置字段）。小。
- **先量**：单 worker 的 RSS/句柄成本、resume vs create 耗时、真实并发 ticket 数。

### ③ Worker 侧上下文治理（compaction/pruner + 输出上限）
- **收益**：长 ticket 的每步 token 与延迟不再线性增长；降低上下文溢出导致失败的概率；这是"长期在线"最直接的成本项。
- **风险**：压缩可能丢细节（报告/验收信息可能被剪）；需要保留 `latestReport`/关键路径白名单。
- **改动面**：`cordis.patch.yml`（worker preset 加 compaction-basic/command-compact/tool-result-pruner，与 Router 对齐；packaging owner）+ `src/tools/worker.ts`/`src/prompts`（结构化截断大输出：pull files/worker_context）。小（配置）+ 小（工具）。
- **先量**：真实长 ticket 的 turn token 曲线、上下文峰值、compaction 触发前后质量。

### ④ Router 候选批处理 / 合并（突发时降 LLM 调用）
- **收益**：多个候选并发时，将 N 次 Router turn 合并为 1 次（或 300–800ms 去抖合并同 thread/批次），显著降 token 与排队延迟；当前每个 candidate 一条 followup 且 Router 串行。
- **风险**：决策延迟略增；跨 thread 合并会牺牲判定粒度（建议只合并同 Source/同批 trigger，或 debounce 后逐条附在同一 message 里）。
- **改动面**：`assessor.ts` + `runtime.ts`（assessment effect 消费队列/去抖）+ 可能 `prompts` 的候选块格式。中。
- **先量**：真实候选突发频率、Router turn 时长与 token/候选、单批候选数上限。

### ⑤ 启动/恢复并行化 + 会话/工具定义复用
- **收益**：a) `afterStart` 中 `sources.startAll` 与 `executor.recover` 可以并行（互不依赖）；b) recover 用有界并发（如 3）而不是逐个 await，20 个 assignment 的恢复从 O(N×克隆) 变为有界并发；c) `workerToolDefinitions` 按 deps 缓存一次（当前每 worker 重新编译 7 个 schema；工具 schema 跨 session 不变），减少 worker 创建抖动；d) GitHub 只读调用声明 `isConcurrencySafe: () => true` 让同一 turn 的读调用并行（写操作保持串行）。
- **风险**：并行 recover 的重复 launch 竞态（补 `state==='pending'` 守卫、复用 `launching` guard）；并发 git clone 的 CPU/IO 峰值。
- **改动面**：`runtime.ts`/`executor.ts`/`sessions.ts`/`tools/*`，全部小改动。启动耗时预计省 10–100ms + 恢复大幅缩短 `[需实测]`。
- **先量**：recover 各阶段耗时、worker create 的 preset mount/tool-register 分项、并行 clone 对磁盘/网络影响。

### 明确"测出来再改"的项
- 工具 schema 的实际 token 占用与它对首 token 延迟的影响（再决定拆分 `superagent_github` 或 `deferLoading`）。
- 每个 worker 的常驻内存与 cold resume 成本（决定 TTL/池策略）。
- Router 候选消息平均大小与 compaction 触发频率（决定候选窗口 12/8 是否过大）。
- GitHub 轮询 60s 是否是端到端痛点（若是，降间隔或加 webhook 是另一层设计）。
- 2s pass/pump 改为事件驱动的真实收益（先加计时日志，比较 P50/P95）。
- 恢复竞态的实际触发率（先加 guard 修复，再观测日志）。

---

## 10. 其他发现（小问题/一致性）

1. **`Executor.launch` 未拒绝 `running` assignment**（§2.2）：与 launch effect handler 的 `state==='pending'` 守卫不一致，恢复路径有低概率重复投递。1 行修复。
2. **`maxWorkers` 是软上限**：`enforceWorkerCap` 只回收空闲会话；`launch` 没有准入控制。建议在 `Executor.launch` 前检查活跃 worker 数，超出时 `Defer`（effect 重试）而不是无界创建。
3. **`ready` 早于 sources/recover**：health/面板短时间显示 sources=starting；如需更准的"ready"，可把 sources.startAll 纳入 ready（但会拖慢宿主启动）——保持现状更稳妥，文档说明即可。
4. **`get_pull_files`/大输出的结构化截断**：目前只做整段 JSON 12KB 截断，可能产生不可解析片段；建议改为"逐项截断 + `truncated:true`"并降低单文件 patch 上限。
5. **Reply 串行**：Outbox reply handler 全局 concurrency=1，一个慢 Telegram/GitHub 写会阻塞其他来源；可考虑按 `channel.source` 分区并发（保持每 ticket 顺序）。
6. **GitHub 客户端每次 action 新建**：可缓存 client（token/文件读取、retry policy 复用），但注意 token 轮换；收益小，测后再做。
7. **工作目录/session 日志/SQLite 无 retention**：长期在线必须监控；工作目录（完整 git clone）是最容易失控的一项。
8. **Worker preset 缺 compaction**：见 §5.3/§9-③，建议与 Router 对齐（保留 5s shell/job 语义）。

---

## 11. 结论

系统当前架构是"同步领域内核 + 持久 effect 队列 + 轮询驱动适配器"，正确性/自愈设计较完整（幂等、恢复、safe mode、锁），主要性能天花板来自 **固定的 2s 轮询粒度、全局串行的 effect 调度、以及 worker 会话/上下文的长期增长**。上述 5 项优化中，①③④风险低、收益明确，②⑤需要在真机测过内存/恢复成本后落地；所有量化项都列在 §8 的测量计划里，建议先加计时日志跑 24h 真实流量，再按数据决定优先级。
