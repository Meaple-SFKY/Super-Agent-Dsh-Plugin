# 003 · 能力矩阵

本文件记录 SuperAgent 当前实际启用的 DSH / Telegram / GitHub 能力，以及刻意不启用的项目和原因。实现以 `cordis.patch.yml`（agent preset）、`src/index.ts`（Config）、`src/sources/*` 与 `src/tools/*` 为准；本文件随能力变更同步。

## 1. DSH 能力

| 能力 | 状态 | 说明与原因 |
| --- | --- | --- |
| Goal（`dsh-tool-goal`） | **已启用（Worker）** | Worker preset 挂载 `@deepseek-ai/dsh-tool-goal`，大型任务可建立持久目标并跨回合推进（默认连续 3 回合 blocked 后停止）。Router 不使用 goal：主 Session 只负责评估/调度，不自己执行长期任务。 |
| read_image / 附件读取 | **已启用（Router + Worker）** | 两个 preset 的 `tool-fs` 都显式 `readImage: true`（默认就是 true，这里写出来便于审计）。Router 仍 `write:false, edit:false`，只能看图不能写盘。Worker 还能读取 Telegram 下载的附件文件（落盘在 Ticket 目录/stateDir）。 |
| Subagent | **已启用（Worker）** | Worker 可 `spawn` 子智能体（`agentPreset: standard`），用于并行探索；子智能体的 shell 等待 60s，不继承 Worker 的 5s shell。Router 不挂 subagent。 |
| Todo | **已启用（Worker）** | `tool-todo`（`allowParallelInProgress: true`）。 |
| Web search | **已启用（Worker，搜索）** | `tool-web` 开启搜索、`fetch: false`；网页抓取只走 host 的 `web_fetch` 或 Worker 自己的 curl，避免模型侧抓取长页面。Router 不挂 web。 |
| Compaction / Skills / Agent instructions | **已启用（两者）** | compaction group、`skill-filesystem` + `tool-skill`、`agent-instructions`（64KB）、time-context。Worker 额外有 persona。 |
| Shell / Jobs（5s 前台） | **已启用（两者）** | 前台命令/等待超过 5s 自动转后台 job；避免长命令阻塞 Router 处理新候选或 Worker 处理人的消息。 |
| Workflow engine | **暂不启用** | `@deepseek-ai/dsh-workflow-*` 未挂载：实验性、与固定 Router/Worker preset 的确定性冲突；需要时作为独立 opt-in。 |
| Agent Team | **暂不启用** | 实验性多智能体协作；个人单用户场景收益有限，稳定性风险更高，后续单独评估。 |
| Plan mode | **暂不启用** | Router 的判断流程已在 prompt 内完成，Worker 直接执行 Ticket；Plan 模式会引入额外审批环节。 |
| Worktrees（`tool-worktree`） | **可选** | 工具未挂载；Executor 的 `prepare` 命令可以自行使用 `git worktree`（SETUP 示例），由用户掌控目录策略。 |
| Scheduling / Goals UI / Plugin manager / Plugin market | **不挂载** | Router/Worker 不应自行安装插件或改调度；这些属于宿主操作。 |
| Computer Use / Voice / Browser use | **宿主级可选** | 不属于本 bundle；需要时在 DSH 安装对应官方插件，理解其 macOS 权限要求。 |
| Sessions / Presets | **已启用** | `superagent-router` / `superagent-worker` 两个 `dsh-agent-preset`；Session id 稳定（`superagent-router`、`superagent-worker-<ticket>`）。 |

## 2. Telegram 能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 文本消息（收发） | **已启用** | 私聊为主；群聊只处理 @ 或允许的 `chats`。超长消息按 4096 字符切分。 |
| 富文本 / HTML | **已启用（默认开）** | `sources.telegram.richText: true`（默认）→ 以 Telegram HTML 渲染；关闭则纯文本。 |
| 文件 | **已启用（默认开）** | 接收文档/图片并落盘供 Worker 读取（`maxDownloadBytes` 默认 20MB）；发送走 Bot API `sendDocument`。面板/Config 开关 `files`。 |
| 图片 | **已启用（默认开）** | 入站图片落盘，Worker/Router 用 `read_image`（来自 `tool-fs`）查看；出站 `sendPhoto`。 |
| 内联按钮 / callback | **已启用（默认开，安全默认不触发）** | 消息可带 `reply_markup`；按钮点击只有 `observeCallbacks: true` 时才转成候选 Trigger（默认 false，避免误触接单）。Config 开关 `keyboards`。 |
| Thread topic（论坛 topic） | **已启用** | 群 topic 的 `message_thread_id` 会编码进 Thread key（`telegram:chat:<id>:topic:<topic>`），回复也带 `message_thread_id`。 |
| 本地命令 | **已启用** | `/status`、`/pause`、`/resume`、`/tickets`、`/stop`、`/retry`、`/help` 由 Source 直接解析，不占模型调用。 |
| Bot 主动发起会话 | **不支持（Telegram 限制）** | bot 不能先私聊用户；首次需要用户点 Start / 发消息。向导会给出 `https://t.me/<bot>` 链接。 |
| OAuth / 扫码登录 | **不支持** | Telegram 只提供 bot token；由 @BotFather 创建。 |
| 语音 / 视频通话 | **不支持** | 语音文件可按文件接收，但不做转写；视频通话不处理。 |

## 3. GitHub 能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Issue 读取 / 评论 | **已启用** | 轮询配置仓库的 Issue 评论与 `observeIssues`（未 @ 也可作为候选）；回复以 bot 账号发评论。 |
| 新建 Issue | **暂不提供工具** | 当前 `superagent_github` 没有 create_issue；需要时用 `comment` 在现有 Issue/PR 交付。 |
| PR 读取 / 评论 / review | **已启用** | `superagent_github` 支持 `pull_request`（创建 PR，带 `<!-- superagent:<ticket> -->` marker）、`comment`、`review`（含行内评论）。 |
| PR merge | **API 已支持，工具按需** | `github-api.mergePull` 已存在；`superagent_github` 提供 `merge_pull`（merge/squash/rebase），仅 Worker scope。 |
| CI / Checks / Actions | **已启用（默认只读）** | 轮询 check-runs，403/404 时回退 Actions runs；只报摘要，不刷屏。PAT 只需 Actions: Read（Checks: Read 可选）。 |
| 搜索 | **已启用** | `superagent_github` 的 `search`（issues/PR）与 Source 的搜索辅助；用于找相关上下文。 |
| 创建仓库 | **已启用（Worker）** | `create_repository`（默认 private），自动邀请 `sources.github.collaborators` 为 admin；bot 新建仓库后个人账号作为 collaborator。 |
| 分支 / 提交 | **已启用** | Worker 通过 git（专用 bot SSH key）push 分支、开 PR；commit 身份由 `executor.gitName/gitEmail` 推导。 |
| 自建仓库邀请 bot | **需一次手动（或提供个人 PAT 后自动）** | 现有仓库需把 bot 加为 Write collaborator；提供个人 PAT 时可由工具/向导辅助接受邀请。 |
| GitHub Enterprise Server | **不支持** | 仅 github.com REST API 与通知模型。 |
| 修改 Issue/PR 标题或关闭 Issue | **暂不提供工具** | 保留给人；避免 agent 自行关闭用户线程。 |
| Fine-grained PAT 权限 | **最小集** | Contents / Issues / Pull requests 读写；Actions 或 Checks 只读（CI）；Metadata 自动包含。 |

## 4. 与面板/配置的对应关系

- 能力开关落在 `sources.telegram.richText/files/keyboards`（默认 `true`），向导「Telegram 能力」区域可逐项关闭；关闭只影响机器人，不影响 bot 账号。
- GitHub 能力由各自的工具参数与 Source 配置控制（`repositories`、`observe*`、`allowSelf`、`collaborators`、`executor.git*`），不做额外全局开关。
- DSH 能力由 `cordis.patch.yml` 的 preset 决定；要新增/移除工具行需改 preset 并重启插件（agent preset 变更需要新 Session 才完全生效）。
