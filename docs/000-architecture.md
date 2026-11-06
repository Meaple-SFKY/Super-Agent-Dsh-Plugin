# 000 · 架构与设计决策

本文是实现的唯一架构契约。所有 teammate 以本文、`src/core/model.ts` 和 `src/core/ports.ts` 为准；偏离前先和 Lead 对齐。

## 1. 目标与非目标

**目标**

- 个人长期在线的 SuperAgent：持续监听 Telegram 与 GitHub，主动推进被授权的工作，只在需要本人决策或验收时打扰。
- 用户始终面对同一个助手：不需要管理 Session，跨渠道共享同一份全局记忆。
- 插件加载与初始化失败隔离：任何异常都不能阻止 DSH 本体启动。
- 长期运行可自愈：进程崩溃、Session 丢失、effect 卡死、CI/网络抖动都不需要人工重启。

**非目标（本期）**

- 多租户/团队共享实例；细粒度 admission table（原型里的单元格授权表）。
- 云端部署、多设备执行环境、远程 daemon（原型第 5 节的方向）。
- 通用 Source SDK；只实现 Telegram 与 GitHub。

## 2. 形态与运行位置

- 交付物是一个 DSH bundle（`dsh.bundle.patch` + `cordis.patch.yml`），安装进当前 DSH profile。
- bundle 只插入 **一个** Host 插件行 `dsh-superagent-personal`，指向 `src/index.ts`（guardian）。引擎在 `src/engine.ts`，由 guardian 动态 `import()`。这样任何引擎侧的加载/初始化错误都退化为“插件禁用 + 明确日志”，不影响 DSH 启动。
- 插件随 DSH 进程启动；macOS LaunchAgent 看门狗负责进程级存活（见 §8）。
- Web 面板（`src/client/`）是可选的观察/操作面：状态、待决策、暂停、重试。**所有决策也必须能在 Telegram 完成**，面板不是必需品。

## 3. 双层架构（Router / Worker）

- **Router 层**：一个长期驻留的 DSH Session（主 Session）。负责全局上下文、授权判断、跨任务协调、对用户说话。**不亲自执行具体任务**：没有写文件/改代码的工具，只有读、调度、回复、Ticket 管理工具。
- **Worker 层**：每个 Ticket 一个隔离的 DSH Session，拥有完整执行工具（bash、文件、搜索、web、subagent 等），在独立目录/worktree 里工作，通过结构化报告向 Ticket 汇报。Worker 不直接对用户说话。
- 参考文章的两层划分是逻辑职责，不要求 Router 只有一条 Session；我们先用单条驻留 Session，事件批处理自然发生。

## 4. 事件流水线

```
Source ──Trigger──▶ Thread ──batch──▶ Eval ──accept──▶ Ticket ──Assignment──▶ Worker
                  │                    │                 │
                  └──Subscription──────┴──fan-out────────┘
Source ◀──Channel── Outbox ◀──reply── Engine
```

- **Source**：拥有读位置、bot 身份、事件过滤。只把“可能是候选”的事件做成 Trigger。自己丢噪音，不把原始 payload 泄漏进领域层。
- **Trigger**：不可变事件；带 actor、addressed、thread、channel、meta。同一个 Trigger 只会存一次（幂等）。
- **Thread**：同一条对话/Issue/PR 的事件序列。同一 Thread 同时最多一个 Eval。Thread 保存订阅、队列、Eval、Decision 历史。
- **Eval**：先代码网关（allowlist、addressed、follow-up、bot 规则），再把候选送进主 Session 做语义研判。判定 accept/stop/ignore/unavailable。
- **Mandate**：accept 授予的授权快照（policy version、strength、rules、sender、via）。不可变；stop 撤销；policy 变更后 resume 前重新校验。
- **Ticket**：授权工作单元。open → ended；本人的消息可以 resume；只有主 Session 创建 Ticket。
- **Subscription**：Ticket 与 Thread 的多对多关系。订阅 Thread 的新事件直接扇出给 Ticket（快路径），不再走 Router。人的消息到达 Ticket 自己拥有的 Thread 时由 Worker 决定，不触发 Eval。
- **Report**：Worker 的结构化状态：`progress / waiting / ready / blocked / failed / dropped`。`blocked` 必须带一个具体问题；`ready` 表示可验收；`failed` 表示需要人处理。只有 `blocked/ready/failed` 会触发对外打扰。
- **Channel**：写回 Source 的地址（Telegram chat、GitHub issue/PR 评论）。

### 授权简化（相对原型）

- 每个 Source 一个 `allowed` 名单（Telegram user id / GitHub login）+ `bots` 名单 + 仓库列表。
- 强度只有 `explicit`（名单内的人直接 @/私聊，或对已有 Ticket 的 Thread 跟进）和 `inferred`（名单内 bot；`auto` 模式才会接单）。
- 无 admission table；名单外的人一律不产生候选（记 `filtered`）。
- accept mode：`off`（只接明确请求）/ `observe`（记录“本来会接”但不接）/ `auto`（推断候选也接）。默认 `observe`。
- 主动规则：若干条人写的 rule（id/name/instructions），只在 `auto` 下生效；每条 accept 记录命中的 rule。

## 5. 交互与注意力

- **Telegram 是主界面**：私聊即主 Thread；“同一个助手”靠唯一 Router Session + 持久记忆。群聊可选，只处理 @。
- **安静规则**：默认不发 ack、不发 progress。仅在 `blocked`（需要决策）、`ready`（需要验收，例如 PR 已开）、`failed`（失败）时发一条短消息；单条 ≤100 字（可配置）。同一 Ticket 的多个进展合并。
- **命令**：`/status`、`/pause`、`/resume`、`/stop <ticket>`、`/retry <ticket>`、`/tickets`、`/help`。命令由 Source 直接解析，不占模型调用。
- **observe 模式**：主动行为只落库并在面板/`/status` 可见，不对外发消息；本人确认后切 `auto`。
- **静默时段**（可选）：在配置里指定，非紧急消息延迟到时段结束。

## 6. 持久化

单文件 SQLite（`node:sqlite`，无原生依赖），位于 `<stateDir>/superagent.sqlite`；`<stateDir>` 由 profile patch 指定。`Store` 是唯一写入口；Engine 的命令同步执行、每个命令一个事务。

表（概念）：

| 表 | 内容 |
| --- | --- |
| `trigger` | 每个 Trigger 的不可变 JSON、at、source、thread |
| `disposition` | Trigger 去向：filtered/queued/eval/decision/ticket id、handback、ack |
| `thread` | ThreadState（订阅、context、queued、eval、expired、decisions 索引） |
| `ticket` | Ticket 聚合（mandate、follows、inputs、assignments、latestReport） |
| `decision` | Decision 记录，按 Thread 可排序 |
| `effect` | 持久 effect 队列：kind+key 唯一、payload、due、attempts、lastError |
| `outbox` | 每条待发消息的 receipt（pending/sent/dropped、失败次数） |
| `kv` | schema 版本、settings 版本、router session id、Source 读位置等 |

规则：effect 在事务内 enqueue、提交后执行；失败指数退避；同一 kind+key 合并。所有外部调用都有幂等键。旧记录暂不自动清理（后续加 retention）。

## 7. 执行器与恢复

- Worker = DSH Session，使用 bundle patch 里的 `superagent-worker` preset（完整执行工具，无“问人/展示/调度”工具）；Router 使用 `superagent-router` preset（读 + 调度 + 回复，无写盘/改代码）。
- 每个 Ticket 的目录：`<stateDir>/work/<ticketId>`，默认 `git clone`（或 `git worktree`，可配置）。GitHub remote 用 SSH（本机已有 key）或 token。
- 启动流程：launch effect → 准备目录 → 创建/恢复 Session → 注入 assignment（Ticket 摘要 + 首条 Trigger + 验收标准）→ `assignmentStarted`。
- 报告协议：Worker 只通过 `superagent_report` 工具汇报；`blocked` 必填 question；`ready` 带 PR 引用。工具调用失败不会丢报告（幂等写入）。
- 恢复：
  - 进程重启后，`running` 的 Assignment 标记 `interrupted`，用恢复说明重新 launch（同 Ticket、同目录，新 Session 或 resume 旧 Session）。
  - Session 丢失/创建失败 → 重试 + 熔断，连续失败把 Ticket 标 `failed` 并通知。
  - 长时间无 report → `requestStatus`；仍无进展 → 中断并重开（可配置阈值）。
  - 所有轮询循环有退避与 jitter，网络错误不改变读位置。

## 8. 失败隔离与自愈（硬要求）

分层：

1. **guardian（`src/index.ts`）**：零运行时 import；Node 版本门禁；动态加载引擎；`apply()` 不抛错；启动超时；失败写 degraded 状态与清晰日志；`enabled:false` / `SUPERAGENT_DISABLED=1` 手动 kill switch。
2. **Engine 内部**：每个 effect handler 独立 try/catch；失败按 kind 重试/退避；连续失败进入熔断；严重错误进入 **safe mode**：暂停 Sources、保留状态、记录原因、尝试通过 Telegram 告知（若 Telegram 自身不可用则只落库）。
3. **外部看门狗**（`scripts/watchdog.mjs` + LaunchAgent）：每分钟检查 DSH 进程与插件心跳文件/SQLite 新鲜度；异常时先尝试重启 DSH，再通知；连续失败停止重启并留日志，避免重启风暴。
4. **升级兼容**：`engines.dsh` 锁定 `<0.3.0`；guardian 运行时再检查；DSH 升级后先跑 `/status` 与自检，不兼容则插件自禁用且 DSH 正常启动。

## 9. 配置

宿主配置（profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-superagent-personal
  name: dsh-superagent-personal
  config:
    enabled: true
    stateDir: /Users/<you>/.dsh/state/superagent
    sources:
      telegram: { enabled: true, tokenEnv: SUPERAGENT_TELEGRAM_TOKEN, allowedUserIds: ["<id>"] }
      github: { enabled: true, tokenEnv: SUPERAGENT_GITHUB_TOKEN, repositories: ["owner/repo"] }
    policy: { mode: observe }
```

- 密钥只从环境变量/本地文件/钥匙串读取，绝不写入仓库或日志。
- 其余行为（模型、并发、超时、静默时段、规则文本）走插件设置/管理 API，改后尽快生效（能热更的热更，需要重启的自动重启引擎）。
- 所有可调项都要有合理默认值；默认配置即可安全运行（observe、单仓库、单用户）。

## 10. 模块边界与团队分工

| 范围 | 文件 | Owner |
| --- | --- | --- |
| 领域模型/端口契约 | `src/core/model.ts`, `src/core/ports.ts`, `src/sources/kind.ts` | Lead（变更需通告） |
| 领域引擎 | `src/core/engine.ts`, `src/core/*.ts`, `tests/core-*.spec.ts` | core-engine |
| 存储/效果/Outbox | `src/app/store.ts`, `src/app/effects.ts`, `src/app/outbox.ts`, `tests/store-*.spec.ts` | core-engine |
| Telegram / GitHub | `src/sources/telegram*.ts`, `src/sources/github*.ts`, `tests/sources-*.spec.ts` | sources |
| Router/Worker 会话 | `src/app/sessions.ts`, `src/app/executor.ts`, `src/app/assessor.ts` | runtime |
| Tools / prompts | `src/tools/*.ts`, `src/prompts/*.md` | runtime |
| Runtime 装配/健康/看门狗 | `src/app/runtime.ts`, `src/app/health.ts`, `src/app/watchdog.ts` | runtime |
| 打包/guardian/panel/安装 | `src/index.ts`, `src/engine.ts`, `src/client/*`, `cordis.patch.yml`, `scripts/*`, `examples/*` | packaging |
| 管理 API | `src/app/api.ts` | runtime + packaging 共同，接口先定 |
| 集成测试/验收/文档 | `tests/e2e/*`, `docs/*`, `SETUP.md` | QA + Lead |

## 11. 测试策略

- 纯领域：in-memory repositories，覆盖 receive/dup、gate、eval、fan-out、resume/stop、rework、policy 变更、并发 pass。
- 存储：同一套 repository 契约分别跑内存与 SQLite。
- 适配器：Telegram/GitHub 用本地 fake HTTP server（可复现 update/json），校验读位置、幂等、过滤、发送。
- 集成：模拟 DSH host（只实现本插件用到的 Service 接口），跑通“消息 → 接单 → worker 报告 → 回复”；崩溃注入（在 effect 执行后/事务提交前 kill）后重启续跑。
- 隔离：故意让 engine 抛错/缺依赖，断言 guardian 返回 degraded 且 host 启动流程完成。

## 12. 里程碑

- M0 脚手架 + 契约 + guardian 骨架（Lead）
- M1 核心引擎 + SQLite + effect 队列（core-engine）
- M2 Telegram + GitHub 来源（sources）
- M3 Router/Worker Session + 执行器 + tools + prompts（runtime）
- M4 bundle 打包 + preset + panel + 看门狗 + 安装（packaging）
- M5 集成/恢复测试 + 文档 + 真机安装验收（Lead + QA）
