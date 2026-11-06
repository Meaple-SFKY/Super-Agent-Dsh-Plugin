# 004 · 需求对齐：原型模式覆盖与路线偏移

对照对象：MIT 原型 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 7 篇文档、B 站三支视频的公开描述、以及我们自己的 `README.md` / `SETUP.md` / `docs/000-003` 与 `src/`。
本文只做对齐与差距分析，不改代码。

## 0. 结论摘要

- **核心域没有漂移。** 原型的第一性原理（最小人类注意力）和它推导出的 11 个领域概念（另加 Report/Attention/Disposition 等支撑项），我们都有对应实现，且多数是**逐条实现**而不是近似：Source/Trigger/Thread/Eval/Mandate/Ticket/Assignment/Subscription/Report/Attention/Disposition 全在 `src/core/`，幂等、读位置、gate、revalidate、policy 变更、fan-out、handback、observe 模式都能在 `src/core/engine.ts` 找到落点。
- **偏移发生在"交付层"，不在"模型层"。** Telegram 取代 Feishu、PAT REST 取代 `gh` CLI、LaunchAgent 取代 tmux + 小时巡检、面板设置向导取代手改 YAML——这些是个人版的合理取舍，符合原型的"少设置、少概念"精神，但代价是原型里几处**安全边界**和**调度语义**没有搬过来。
- **最值得补的不是功能，而是两个"语义缺口"**：①后台任务/槽位语义（原型：turn 结束后仍有 shell job 时继续占 slot、30 分钟上限、人插队槽位）；②Worker 的权限边界（原型：`worker-bin` 命令 shim、`worker-gitconfig`、`blockedCommands`、执行环境变量）。前者影响长任务的可靠交付，后者影响"一个拥有全队权限的 agent"的安全叙事。
- **授权模型是刻意的简化**（我们文档写明）：没有 admission table，名单外的人一律 `filtered`。对单用户个人版是正确取舍，但它同时关掉了"把某个群/某个仓库开放给任意人 @"这条路。
- 面板与可观测性是**最大的体验差距**：原型用 6 个标签页回答"现在需要我吗 / 系统健康吗 / 这件事的来龙去脉"，我们只有 Overview / Setup / Permissions 三个；Eval 历史、Trigger 列表、搜索、术语表、Prompt 编辑都没有。

状态口径：**✅ 已实现**（有代码与测试证据）· **◐ 部分**（机制在但语义比原型弱）· **✗ 未实现** · **★ 我们更好**（原型没有或不如我们适配个人场景）。

---

## 1. 方法与来源（含不确定性）

### 1.1 原型仓库（一手）

逐篇 `web_fetch` 自 `raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/`：

| 文档 | 提供的内容 |
|---|---|
| `docs/000-philosophy.md` | 第一性原理、对 agent 的 5 条约束、对设计的 4 条约束、责任条款 |
| `docs/001-domain.md` | 13 个概念及其规则、聚合、被拒绝的概念、术语表（中英） |
| `docs/002-authorization.md` | 两条路径（Eval / Subscription）、强度表、admission table、bot 规则、policy version、resume/stop、Eval 超时 |
| `docs/003-execution.md` | Ticket 的 8 个阶段、Executor、后台工作与 slot、prepare、并发、执行变量、merge、Ticket 结束、失败与恢复 |
| `docs/005-panel.md` | 三个问题、六个标签、记录阅读、Settings 分组、搜索、7 条面板原则 |
| `docs/006-deployment.md` | 独立 profile、agent GitHub 账号 + CLI wrapper、安装/启停脚本与退出码、小时巡检、管理 API、setup 检查、安全模型、升级、排障 |
| `SETUP.md` | 面向 agent 的一问一答式引导安装流程（每次一个问题、推荐答案、<300 字） |

### 1.2 B 站（二手、描述级证据）

| 链接 | 拿到的信息 | 可信度 |
|---|---|---|
| [BV1LYxd6EEAH](https://www.bilibili.com/video/BV1LYxd6EEAH/)「20分钟讲清楚DSH-SuperAgent」 | 描述原文：DeepSeek 发布 Super-agent，"一款可以持续，主动，高效 跨会话处理任务的 Agent"，视频讲工作流与行业启发 | 高（官方简介原文） |
| [BV1dTxn6EEnb](https://www.bilibili.com/video/BV1dTxn6EEnb/)「超级agent!deepseek harness 发表新时代agent设计架构」 | 描述：开源 Super-agent 的**常驻自主 agent 架构**与**实现部分设计的原型插件**；页面相关标题出现"ReActive 架构解析""双层架构、事件驱动与看门狗" | 中（描述 + 相关推荐标题，非正文） |
| BV1bV4w6xEXU | 三次检索均未返回该视频的描述或标题 | — 未获取 |
| [opus 1265361021143351318](https://www.bilibili.com/opus/1265361021143351318) | 被验证码拦截，未获取 | — 未获取 |
| 二手解读 | [阿里云开发者社区架构解析](https://developer.aliyun.com/article/1779111)、[CSDN 拆解](https://blog.csdn.net/qq_36034945/article/details/169923026)、[知乎](https://zhuanlan.zhihu.com/p/2100292955890361081)、[GitHub 分析仓库](https://github.com/Zekk-creator/deepseek-super-agent-analysis) | 中（标题与摘要提到 Router/Worker 双层、事件驱动、Thread Subscription、异步执行与持久化、Watchdog、最小注意力） |

**不确定性**：视频与 opus 只提供了"常驻 / 主动 / 跨会话 / 双层 / 事件驱动 / 看门狗"这类**模式名**，没有任何规则细节。本文所有关于规则、状态机、字段的判断**只依据原型 7 篇文档与代码**，不依据视频。视频只用于证明"我们抓住的模式名与官方叙事一致"。

### 1.3 我们的实现（一手）

`README.md`、`SETUP.md`、`docs/000-architecture.md`（架构契约）、`docs/001-interfaces.md`、`docs/002-setup-api.md`、`docs/003-capabilities.md`、`docs/verification.md`（QA 审计），以及 `src/` 约 21k 行。下文引用的 `file:line` 均来自当前工作区。

---

## 2. 原型模式提炼

### 2.1 第一性原理与推论

> **Take as little human attention as possible, and give as much value as possible.**

对 agent：只在被请求或书面规则允许时行动；只在人必须行动或能用到结果时说话；一次只问一个具体问题；按影响停止而不是按工作量停止；诚实报告（草稿标未完成、失败就是失败）。
对设计：**少概念**（业务需求变成某个概念的属性或 prompt 文本，不新增概念）、**少设置**（一个默认值能覆盖就删设置）、**面板只显示需要人的东西**、文档按顺序可读。
责任：起步要窄（短名单 + observe）、噪音大就改 prompt/暂停而不是加解释消息、不做量、对自己说的话负责。

### 2.2 概念流水线

```
Source ──Trigger──▶ Thread ──batch──▶ Eval(gate → assessment) ──accept──▶ Ticket(Mandate)
   ▲                    │                                              │
   └──Channel── Outbox ─┴── Subscription fan-out ◀────────────────────┘
                                                          Assignment ──▶ Executor(Session+目录)
```

我们的 `docs/000-architecture.md` §4（第 33–50 行）是同一张图的直接翻译，概念名一一对应。

### 2.3 原型的 12 组机制（用作对照表的分组）

1. **Source**：读位置、bot 身份、事件过滤、自有消息丢弃、翻译为 Thread + Channel。
2. **Trigger / Thread / Correlation / Channel**：不可变、幂等、Thread 串行 Eval、关联只加上下文不路由。
3. **Policy**：版本化的规则 + 每 Source 的名单/bot 列表/admission table/accept mode。
4. **Eval**：gate（代码）→ assessment（模型）；超时重排、三次 `unavailable`；observe 记 "would accept"。
5. **Mandate**：授权快照（policy version/strength/rules/sender/via），不可变，stop 撤销，resume 前 revalidate。
6. **Ticket / Assignment / Report**：Ticket 定义自己的状态，Assignment 独立 pending→running→ended，Report 6 态，只有 blocked/ready/failed 打扰。
7. **Subscription**：多对多、fan-out 绕过 gate、人的跟进由 Executor 拥有、handback、release follow-ups、context-only。
8. **Executor**：每 Ticket 一个 Session + 目录；5s shell 转后台；后台工作占 slot、30 分钟上限、交接；并发 + 人插队 slot；prepare（10 分钟）；执行变量；blocked commands；merge 规则在 prompt。
9. **Attention**：结构化问题、一次一个、面板"待人工决定"。
10. **面板**：三个问题、六个标签、搜索、术语表、Settings 分组（含 Prompt 编辑/历史）。
11. **部署**：独立 profile、agent GitHub 账号 + CLI wrapper、tmux 启停脚本与四档退出码、小时巡检、管理 API、`worker-bin`/`worker-gitconfig` 安全模型。
12. **失败与恢复**：stored work（先存后做）、退避、顺序、Source/Channel 失败分类、pause、重启恢复、UX 的诚实状态。

---

## 3. 覆盖对照表

### 3.1 哲学与注意力

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| 只在被请求/规则允许时行动 | gate + rules + accept mode | `src/core/gate.ts:60-124`、`policy.mode` | ✅ |
| observe 先记录不行动 | `observe` 记 `would accept` | `src/core/engine.ts:528-536`（`would_accept`） | ✅ |
| 安静：只在 blocked/ready/failed 说话 | 三态才打扰 | `src/core/engine.ts:1537` `queueAttention` 只在三态入列 | ✅ |
| 默认不确认（ack） | 规则可抑制 ack；默认安静 | `src/index.ts:283` `acknowledgeOnAccept` 默认 false | ★ 更彻底 |
| 一条结果一条消息、单条短 | ≤100 字风格 | `quiet.maxChars`、`src/core/engine.ts:1593-1611` | ✅ |
| 一次只问一个具体问题 | 结构化 Attention 字段 | `src/core/model.ts:219-220`（`question?: string`，自由文本） | ◐ |
| 命令不占模型调用 | —— | `src/sources/telegram.ts` 本地解析 `/status` 等；`docs/003-capabilities.md` §2 | ★ |
| 说人话、双语文案 | 面板单语言 + 术语表 | `language`（zh/en，默认 zh）（`src/index.ts:67`）、engine 文案 `text({zh,en})` | ★ 个人版更好 |
| 责任条款（起步窄、别做量） | 000-philosophy Responsibility | `SETUP.md` 未逐条转述 | ◐ |

### 3.2 领域模型与持久化

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| Source：读位置 / bot 身份 / 过滤 / 自有消息 | 各 Source 自持 | Telegram offset `src/sources/telegram.ts:53,452-515`；GitHub 游标 `src/sources/github.ts:1366-1379`；确定性 Trigger id 保证重放幂等 | ✅ |
| Trigger 不可变 + 接收幂等 | 一个 Trigger 只建一次 Ticket | `src/core/engine.ts:327` `receiveTrigger`、`ensureDisposition` 1740 | ✅ |
| Thread：同一 Thread 串行 Eval、期间到达的并入下一批 | 聚合根 | `src/core/engine.ts:1095` `startEval`、`thread.eval`/`thread.queued` | ✅ |
| Correlation：多 Thread 关联，只加上下文不路由 | 显式概念 | `Trigger.correlations`（`model.ts:76`）；`engine.ts:342` 登记 Thread；候选 prompt 只列出 key（`prompts/index.ts:324-325`），内容要 Router 自己用 `superagent_read_thread` 取 | ◐ |
| Channel：写回地址 | 概念 + 实现 | `OutboundMessage.channel`、`src/app/outbox.ts` | ✅ |
| Disposition：每个 Trigger 的去向 | 概念 | `src/core/model.ts:193`、`engine.ts:1726-1746` | ✅ |
| Policy 版本化 + 变更通知到 Ticket | 版本号进 Mandate，change 下发 | `src/core/gate.ts:159-199` `policyEffects`、`engine.ts:1057` `policyChanged` | ✅ |
| Effect 工作队列：事务内入队、提交后执行、退避、合并 | stored work | `src/app/effects.ts`（351 行）、`docs/000-architecture.md` §6 | ✅ |
| Outbox：receipt 状态机、按 Ticket+会话保序、drop 仅两类原因 | Channel 失败语义 | `src/app/outbox.ts:11-12,18,176-199` | ✅ |
| SQLite 单文件 + 事务/命令 | 原型是 stateDir + 文件/DB | `src/app/store.ts`（983 行，`node:sqlite`）、`docs/000-architecture.md` §6 | ✅ |
| 单 pass 锁 / 心跳 / safe mode | 原型无对应（watchdog 在 006） | `src/app/runtime.ts`、`src/app/watchdog.ts`、`heartbeatIntervalMs` | ★ |

### 3.3 授权

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| Gate：名单 + addressed + follow-up + bot | 三档强度 + 单元格表 | `src/core/gate.ts:60-81`（explicit / inferred / not_admitted） | ◐ 少一档 |
| Admission table（接收范围 × 名单 × 是否 @） | 核心机制 | 明确不做（`docs/000-architecture.md:16,52-57`，`gate.ts:4-13` 注释） | ✗ 刻意 |
| 名单外的人 → inferred follow-up | 可为推断候选 | 直接 `not_admitted`（`gate.ts:80`） | ✗ 收窄 |
| Bot 规则（名单内 bot → inferred） | 有 | `gate.ts:65-70` | ✅ |
| accept mode off/observe/auto + 每条 rule 至多一次 | 有 | `engine.ts:515-545`、`admitsInferred` `gate.ts:118` | ✅ |
| Mandate 不可变；stop 撤销；policy 不撤销 | 有 | `engine.ts:702` `stopTicket`、`gate.ts:130-147` `revalidateMandate` | ✅ |
| resume 前 revalidate（含 policy 变更后） | 有 | `engine.ts:1363` `tryResume`（失败则消息回到候选） | ✅ |
| Executor 拥有人的跟进；主 Session 只能 stop | 有 | `fanOut` 返回 `owned`（`engine.ts:1322`），owner 时不进 Eval；但未持久化“哪条消息被拥有” | ◐ |
| handback（超出范围交回） | 有 + 去重 | `engine.ts:930` `handback`、`src/tools/worker.ts` `superagent_handback` | ✅ |
| 结束后释放未读跟进 | 有 | `engine.ts:1484` `requeueUnreadFollowUps` | ✅ |
| Policy 名单从群成员同步 | Feishu 同步 | 静态 `allowedUserIds` / `allowedLogins`（`src/index.ts` sources 配置） | ✗ |

### 3.4 执行

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| 每 Ticket 一个 Session + 独立目录 | `worker-<ticketId>` + `<root>/work/<name>` | `src/app/sessions.ts`（`superagent-worker-<ticketId>`）、`src/app/executor.ts:187` | ✅ |
| Router / Worker preset 分离（Router 只读调度） | 两个 preset、5s shell | `cordis.patch.yml`、`docs/003-capabilities.md:9-22` | ✅ |
| prepare 命令（克隆/worktree），失败即 Ticket 失败 | 10 分钟、输出记录、不自动重试 | `executor.ts:348-390`（默认 180s、`git clone` + 可选命令） | ◐ 超时更短、失败语义较简 |
| 报告协议 6 态，blocked 必带问题 | 有 | `src/core/model.ts` Report、`src/tools/worker.ts` `superagent_report` | ✅ |
| 后台工作：turn 结束后仍占 slot、30 分钟上限、交接释放 slot | 核心调度语义 | **无**（sessions 只做 LRU 上限 `sessions.ts:739`，无 slot/交接/30min） | ✗ |
| 并发上限 + 给人多一个 slot | 有 | 仅 `maxWorkers`（`runtime.ts:725`），无“人插队”语义 | ◐ |
| 执行环境变量 `DSH_SUPERAGENT_*` | 8 个变量，命令与 prompt 共用 | 无 | ✗ |
| `blockedCommands`（禁运行命令） | 有 | 无 | ✗ |
| merge 规则在 prompt（默认不自动 merge） | 有；host 无 merge 逻辑 | `src/tools/worker.ts:752` 强制 `confirm:true`；`src/prompts/worker.md:125-131` | ★ 更硬（代码兜底） |
| PR 跟随 / 关闭后结束 Ticket / 聊天频道收尾 | 有 | `engine.ts:1512` `followsDone`、`1527` `readyOutcome` | ✅ |
| retry（同 Session/目录/分支） | 有 | `engine.ts:723` `retryTicket`、面板/命令/API | ✅ |
| 重启恢复（interrupted → 恢复说明） | 有 | `executor.ts:256-289` `recover`、`engine.ts:1027` `assignmentInterrupted` | ✅ |
| 停滞检测（长时间无 report） | `requestStatus` | `engine.ts:665` `requestStatus` + watchdog | ✅ |
| transient 失败三次退避重试 | 有（408/429/5xx） | `src/app/effects.ts` 退避 + `src/app/executor.ts` 重试 | ✅ |

### 3.5 面板与可观测

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| 三个问题（需要我吗/健康吗/来龙去脉） | 面板总纲 | Overview 覆盖前两个，第三个缺失 | ◐ |
| 六个标签（Overview/Source/Trigger/Eval/Execution/Settings） | 有 | 三个（overview/setup/permissions，`src/client/main.js:3621-3625`） | ◐ |
| Ticket 8 阶段精确标签 | 有 | 4 档（`runtime.ts:1735-1745`：working/queued/waiting/open） | ◐ |
| 待人工决定列表 | 有 | `ApiState.tickets.attention`（`api.ts:66-73`） | ✅ |
| 搜索（Trigger/Thread/Ticket） | 有 | 无 | ✗ |
| 术语表（?） | 有 | 无 | ✗ |
| Settings 分组 + 保存历史 | 有 | 设置向导（4 步）+ 权限页，无历史/无分组保存条 | ◐ |
| Prompt 编辑 / 全文 / 历史 / 默认升级对比 | 有（005 整节） | Prompt 是代码文件（`src/prompts/*.md`），不可在面板编辑 | ✗ |
| 一键设置向导（token 校验/仓库多选/SSH key 生成） | 无（SETUP 是 agent 问答） | `src/app/setup.ts` 8 个端点 + `src/client/main.js` 向导 | ★ |
| 模型选择（Router/Worker 从 DSH 可用模型选） | 有 eval/executor model 配置 | `GET /setup/models`、向导下拉、`setup/state.models` | ★ 更易用 |
| 权限页（说明需要/不需要哪些系统权限） | 无 | Permissions 标签 + 运行时条目本地化 | ★ |
| 看门狗一键开关 | 无（脚本手动） | `POST /setup/watchdog` + 面板开关 | ★ |

### 3.6 部署与运维

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| 独立 profile（与日常 profile 隔离） | 强制（`superagent` profile） | 装进当前 `desktop` profile（`README.md:43`、`SETUP.md` §2.2-2.3） | ✗ 关键差异 |
| agent GitHub 账号 + CLI wrapper（`gh-agent`） | 强制 | 专用 bot 账号 + 细粒度 PAT + SSH key（`SETUP.md` §1.3、`src/index.ts` github 配置） | ◐ 等价的隔离思路 |
| 启停脚本 + 四档退出码 + 小时巡检 | `scripts/dsh-superagent start/stop/status` | LaunchAgent 看门狗（`scripts/watchdog.mjs` + plist + `install-launchd.sh`），无 start/stop/status CLI | ◐ 更自动、更少诊断 |
| 管理 API（`/orchestrator/api/*`，header + 同源校验） | 有，且文档化为 agent 可用 | `/superagent/api/*`（`api.ts:26-35`、`setup.ts:28-35`），header `x-superagent-request` | ✅ |
| 安装：`dsh plugin add link:$PWD` + profile patch 示例 | 有 | `SETUP.md` §2.3（link 或 tarball）+ 向导 | ★ 更低门槛 |
| 升级：备份 DB、重启、prompt “Default updated” | 有 | `SETUP.md` §6；无 prompt 版本对比 | ◐ |
| 安全模型：`worker-bin` shim、`worker-gitconfig`、PATH 前置、拒绝未写入文件 | 有（006 整节） | 无；Worker 以宿主用户全权运行 | ✗ |
| 排障表（20+ 症状） | 有 | `SETUP.md` §7 | ✅ |

### 3.7 失败隔离与恢复

| 机制 | 原型 | 我们（证据） | 状态 |
|---|---|---|---|
| 插件加载失败不影响 DSH 启动 | 靠 bundle 机制 + 失败提示 | guardian 零依赖 + 动态 import + degraded 状态（`src/index.ts`、`src/engine.ts`、`tests/guardian-*`） | ★ 更硬（硬性要求） |
| 单 Source 失败隔离 | Source 自持错误 | `docs/verification.md` §4、health 分条目 | ✅ |
| crash 恢复 / 幂等 / 不重复发送 | stored work + 读位置 | `tests/verify-recovery.spec.ts`、`tests/e2e`、QA 报告 | ✅ |
| pause 处理（停 dispatch/新 Eval/回复，Source 继续记录） | 有 | `engine.ts:779` `pause`、`runtime.ts` / API / 面板 / `/pause` | ✅ |
| Eval 超时重排、三次 unavailable | 有 | `engine.ts:1148` `expireEval`（3 次 → unavailable） | ✅ |
| unavailable 在面板/health 呈现 | `evals` health + 面板 24h 窗口 | 引擎记录 decision；面板无 Eval 视图，仅 health 文本 | ◐ |

---

## 4. 路线偏移分析

### 4.1 合理增强（符合个人版目标，建议保留）

1. **Telegram 取代 Feishu**：个人场景不需要企业 IM，Bot API 自建成本远低于飞书应用审核；代价是失去"群成员名单同步"和富文本卡片能力（我们用 HTML + inline keyboard 补了一部分）。
2. **PAT REST 取代 `gh` CLI**：少一个必须登录的本地依赖，安装只需粘 token；代价是失去 CLI 的凭据隔离（见 4.2 第 2 条）。
3. **LaunchAgent 取代 tmux + 小时巡检**：少一个"要人记得配"的巡检任务，进程级自愈更直接；代价是诊断入口从 `status` 四档退出码退化成一个心跳文件 + 面板状态。
4. **面板一键设置向导**：把原型 SETUP.md 里"由 agent 一问一答"的流程产品化，符合"少设置"原则的更高实现。
5. **多仓库 / 通配自动发现**：原型限定单仓库；个人版跨项目更实用。
6. **专用 bot 账号 + 自动邀请 collaborator + SSH key 生成**：把原型"必须手建 agent 账号 + 手写 wrapper"缩短为向导几步。
7. **语言开关（默认中文）**：原型面向英文团队；个人版中文优先。
8. **附件/图片端到端（Telegram 入站落盘 + `read_image`、出站 `sendDocument/Photo`）**：原型没有等价能力。
9. **SQLite + 持久 effect + outbox 顺序保证**：与原型 stored work 等价，但我们把它收敛成单文件 + 单写入口，个人部署更容易备份。

### 4.2 需要警惕的偏移（按风险排序）

1. **同 profile 安装（✗ 关键）**：原型强制独立 profile，理由是"插件会改进程级 PATH/git 设置，且需要独立重启和升级"。我们装进 `desktop` profile：Worker 的 git 身份/SSH 配置、插件重启都会作用到用户日常 Session 上；虽然我们用 repo-local config 而不是全局 config（`worker.md:86-100` 明确"never global"），但**插件重启会打断用户自己的对话**这一条仍然成立。
2. **Worker 没有权限边界（✗）**：原型用 `worker-bin` shim + `worker-gitconfig` + `blockedCommands` 把"能做什么"变成进程环境事实；我们靠 prompt + `confirm:true` + 仓库约定。对"拥有全队权限的 agent"来说，**prompt 不是安全边界**——这与原型 000 文档里"responsibility / 拥有它说的话"的责任叙事不匹配。当前缓解是专用 bot 账号（爆炸半径限于 bot 的 PAT 范围）。
3. **没有 admission table（✗ 刻意）**：单用户场景正确，但把"开放某个群的任意人 @ 即可请求"这条路封死了；`gate.ts:80` 让名单外的人连 inferred 都没有，未来要扩展受众必须改 gate。
4. **调度语义缺失（✗）**：原型"turn 结束但 shell job 还在 → 继续占 slot、不报 waiting、30 分钟上限、人插队 slot"是**长任务可靠交付**的核心；我们只有 LRU 上限，长任务要么占着 Session 要么被误判空闲。`docs/000-architecture.md` §7 提了"长时间无 report → requestStatus"，但没有 slot 概念。
5. **可观测性退化（◐）**：原型的 6 个标签是**可诊断性**设计，不是装饰。我们只有 Overview，出问题时只能看 health 文本或 SQLite；Eval 为什么 ignore、Trigger 被谁过滤、Ticket 卡在哪个阶段，都缺少可点开的记录。
6. **Prompt 不可编辑（✗）**：原型允许改团队段落并保留历史、升级时对比默认值；我们的 prompt 在 `src/prompts/*.md`，改一句要重新构建。对"把行为写成 prompt 而不是设置"这条原则来说，交付形态偏工程化。

### 4.3 中性差异（不算偏移，记录在案）

- 原型的 Queue/Decision 记录粒度（Thread 级 Decision 历史）在我们是 `decision` 表 + `disposition`；语义等价。
- 原型 GitHub 走 notifications + 订阅线程轮询；我们走仓库级轮询 + 游标。代价：**通过编辑 Issue 正文补 @ 不会触发**（原型 006 也明确这一限制），以及没有"订阅线程两周轮询窗口"的概念。
- 原型有 context-only subscription 的完整语义；我们有 `thread.context` + `followForContext`（`engine.ts:958`），但没有"Executor 只能丢弃自己 Ticket 的订阅"这类细粒度约束。
- 原型的术语表/双语面板；我们有 zh/en 但没术语表。
- 原型 Correlation 会把相关 Thread 的最近内容作为上下文喂给 Eval；我们只在候选消息里给出 thread key，由 Router 主动读（省 token，但多一次工具调用）。

---

## 5. 差距清单（按价值/成本排序）

> 价值 = 对"个人常驻 SuperAgent 可靠交付 + 不打扰"的贡献；成本 = 改动面（S/M/L）与回归风险。

| # | 差距 | 为什么值得 | 成本 | 建议 |
|---|---|---|---|---|
| 1 | **后台任务与槽位语义**：turn 结束后 job/subagent 仍在跑时保留 slot、30 分钟上限、交接释放 slot、人插队 slot | 长任务（跑测试、起服务、CI 等待）是 Worker 的常态；当前 LRU 会在任务未完成时把 Session 判为可回收，且并发上限会误伤人的追问 | L（`sessions.ts` + `executor.ts` + engine 的 assignment/turn 语义） | 先做"turn 结束时仍有后台任务 → 不置 waiting + 不回收 Session"，再补 30 分钟上限与 +1 人插队槽位 |
| 2 | **Worker 权限边界**：`blockedCommands` + 执行环境变量 + PATH/git 隔离 | 把"agent 能做什么"从 prompt 变成环境事实；个人版可以直接复用 `DSH_SUPERAGENT_*` 变量让 prepare/prompt 一致 | M（executor 的 spawn env + 配置 + 文档） | 先做 `blockedCommands`（校验 argv[0]，最便宜）+ 6 个 `DSH_SUPERAGENT_*` 变量；shim/PATH 隔离作为二期 |
| 3 | **Ticket 8 阶段 + 结构化 Attention** | 面板与通知文案的精确性、以及"卡在哪一步"的可诊断性；把 `question?: string` 升级成结构化字段（一次一个问题） | S–M（模型 + engine stage 计算 + 面板标签） | 先补齐 8 个阶段的派生函数（纯计算，不改状态机），面板直接用 |
| 4 | **可观测面板：Eval/Trigger/Ticket 详情** | 出问题时"为什么没接/为什么 ignore/被谁过滤"目前只能查 DB；原型把它当作核心价值 | M（`api.ts` 增加只读端点 + 面板两个视图） | 先加 `GET /superagent/api/decisions?limit=` 与一个"最近决策"列表，复用现有 decision 表 |
| 5 | **Eval unavailable 的可行动呈现** | 原型规定"24h 内、仍是最新 Decision、未 dismissed 才提醒"；我们只记 health 文本，等于静默失败 | S（engine 已有 decision + dismiss；补 API/面板/命令） | 在 `/status` 与 Overview 显示最近 unavailable，并提供"重新评估"动作（engine 已有 `reevaluate`） |
| 6 | **独立 profile / 启停与诊断** | 避免插件重启打断日常对话；`status` 四档退出码是运维接口 | M（脚本 + 文档；不改代码） | 至少把"推荐独立 profile"写进 SETUP 首屏，并补一个 `scripts/dsh-superagent status` 只读诊断 |
| 7 | **Admission table（最小版）** | 未来开放群/仓库给他人 @；单用户当前不需要 | M（gate + 配置 + 面板） | 先只做一格：`unlistedAddressed`（explicit / ignore）（按 Source/范围），不动三档强度模型 |
| 8 | **Prompt 可编辑 + 版本** | 行为调整不应要求重新构建；原型把 prompt 当产品面 | M–L（配置存储 + 面板编辑器 + 默认值对比） | 先把"团队段落"抽成 `Config.policy.prompt`（纯文本追加到 role prompt），历史与对比后置 |
| 9 | **Follow-up 所有权持久化 + handback 事件化** | 当前 `owned` 只在一次 fan-out 内有效；重放/重启后语义靠 disposition 推断 | M（model + engine） | 在 disposition 上记录 `ownedBy: ticketId`，handback 时清空并作为事件暴露 |
| 10 | **Correlation 带内容进 Eval** | 现在只给 Router 一串 thread key，要它自己再读一次；原型把相关 Thread 的近期内容直接放进评估上下文，减少一次往返 | S（assessor 组装 batch 时附带相关 Thread 最近 N 条） | 低成本高信息量，先做 |

---

## 6. 路线结论

1. **模型层：对齐。** 原型的 11 个概念、gate/assessment 两层、Mandate 生命周期、Subscription 快路径、stored work、重启恢复，我们都有实现且有测试；`docs/000-architecture.md` 可以看成原型 001/002/003 的个人版重写。
2. **交付层：有意偏移，方向正确。** Telegram/向导/模型选择/语言/看门狗是"个人版可用性"的必要投入，符合第一性原理，而不是把项目做成另一个产品。
3. **语义层：两处真缺口。** ①调度（后台任务与 slot）；②权限边界（blockedCommands/执行环境）。这两项直接关系到"常驻可靠"和"拥有全权但不失控"，建议排在所有 UI 工作之前。
4. **可观测层：一处体验缺口。** 面板只回答"现在需要我吗"，回答不了"为什么会这样"；补两个只读视图（决策、Ticket 详情）收益最高、风险最低。
5. **不建议追平的部分**：admission table 全量、Feishu、`gh` CLI wrapper、tmux 小时巡检、prompt 版本对比——这些是原型为"团队/多来源"付的成本，个人版追平会违背"少设置"原则。若未来要开放给多人，再按第 5 节 #7、#8 顺序补。
