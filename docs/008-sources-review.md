# 008 · Sources 可靠性 / 性能 / 安全审查

- **审查对象**：`src/sources/telegram.ts`、`src/sources/telegram-api.ts`、`src/sources/github.ts`、`src/sources/github-api.ts`、`src/sources/kind.ts`、`tests/sources-*.spec.ts`
- **代码版本**：`ff8a17c`（2026-11-06 工作树）
- **方式**：静态阅读 + 现有测试行为；**本任务不改代码**
- **结论**：功能与失败隔离整体扎实（可选配置、只写代码日志、无未捕获 Promise、token 不进错误），但存在 1 个**配额级性能风险**（wildcard 多仓库放大 + 单仓库错误无全局退避）和 2 个**安全风险**（自动接受任意邀请、出站附件路径未约束）。以下按严重度给出证据、量化与 5 个优先优化。

---

## 1. 摘要（按严重度）

| # | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| H1 | **高** | wildcard 仓库数线性放大请求，默认 60s 轮询在 ≥16 个活跃仓库（CI on）时超过 GitHub 5,000/hr 主配额 | `github.ts:888-1043`、`github.ts:210`、`github.ts:60-62` | 403 限流风暴、`errors` 累积、health error、事件延迟/丢失 |
| H2 | **高** | 单仓库/单 stream 失败不会降低轮询频率：`runLoop` 只在 **pollOnce 抛错**时指数退避，`result.errors` 仅计数后照常 `pollSeconds` 睡眠 | `github.ts:527-548`、`github.ts:533` | 配额耗尽或 5xx 时仍每 60s 重试全部仓库，放大限流 |
| H3 | **高** | 启动/discovery 刷新后**无条件接受** bot 收到的任意仓库邀请，随后 wildcard 自动纳入轮询 | `github.ts:732-860`（`acceptPendingInvitations`）、`github.ts:62`、`github.ts:145-160` | 任何人可把 bot 拉进恶意/垃圾仓库：不可信内容进入 Trigger、仓库数放大请求（DoS） |
| H4 | **高（安全）** | 出站附件路径来自 Worker report，Source 直接 `readFile` 任意绝对路径；multipart 文件名未消毒 | `telegram.ts:938-1002`、`telegram-api.ts:752-825`、`github-api.ts`（engine 侧见 `engine.ts:1565`） | 被提示注入的 Worker 可把本机任意可读文件（如 secrets）上传到 Telegram |
| M1 | 中 | 长期静默后 GitHub 游标可能停在很早的 `since`；issues 使用 `sort=updated&direction=asc`，>3 页截断时游标不前进，可能反复读旧页而非新事件 | `github-api.ts:1053-1060`、`github.ts:1400-1419` | 长停机/KV 恢复后事件延迟或"卡住"（不会静默丢，但可能长时间不推进） |
| M2 | 中 | reviews 放大：对窗口内每 1 个更新 PR 都要一次 `/pulls/{n}/reviews`，最多 10 次/轮 | `github.ts:988-1007`、`github.ts:60` | 活跃 PR 期每仓库 +600 req/hr |
| M3 | 中 | 入站媒体在长轮询循环内**串行下载**，下载期间不 `getUpdates`、不写 offset；`downloadFile` 先 `arrayBuffer()` 再校验大小 | `telegram.ts:570-577`、`telegram.ts:799-849`、`telegram-api.ts:827-846` | 大文件/慢网络阻塞该轮所有 update；20MB 缓冲内存尖峰 |
| M4 | 中 | 下载文件名 `<message_id>-<safeName>`：`message_id` 仅在同一 chat 内唯一，多 chat 会互相覆盖；无磁盘配额/清理；`writeFile` 的 0600 对已存在文件不生效 | `telegram.ts:315-321`、`telegram.ts:823-828` | 跨会话文件覆盖/隐私泄露、磁盘被填满 |
| M5 | 中 | 命令/`sa:` 回调在崩溃窗口可能重放：先执行副作用（stop/retry），后写 offset；无持久去重键 | `telegram.ts:505,526,702-760,851-879` | 崩溃/重启后 `/retry`、`⏹ 停止` 可能重复执行 |
| M6 | 中 | GitHub 文本/评论正文无长度上限直接进入 Trigger.text；自动接受邀请会把不可信仓库内容纳入 | `github.ts:1080-1150`、`telegram.ts` 入站受 Telegram 上限保护 | prompt 上下文膨胀、潜在注入面增大 |
| L1 | 低 | ETag 只在"单页且游标未变"时复用；多页、reviews、CI 均无条件请求 | `github-api.ts:644-690`、`github.ts:988-1043` | 活跃时条件请求收益下降 |
| L2 | 低 | Telegram 无入站限速（同一白名单用户可连续触发）；命令回执失败只被当 poison 跳过 | `telegram.ts:520-540`、`telegram.ts:851-879` | 单用户刷屏/成本，命令无回执 |
| L3 | 低 | `allowSelf` 下仅过滤带 `<!-- superagent:` marker 的自身输出；若 Worker 通过 `gh`/其它工具直接写评论（不带 marker）会自激 | `github.ts:1276-1310`、`github.ts:1119-1218`（`isOwnOutput` 过滤点） | 单账号模式的隐性循环风险 |

---

## 2. Telegram Source

### 2.1 长轮询成本

- `getUpdates` 默认 `timeout=25s`，空闲时再睡 `pollSeconds=1s`（`telegram.ts:173-181,477-483`）→ **空闲 ≈ 138 次/小时**（2.3 次/分钟）。有 update 时立即进入下一轮，不额外睡眠，单轮最多 100 条。
- 无官方"getUpdates 配额"，但长轮询是官方推荐方式；真正的成本在出站（每条消息 1 次 `sendMessage`、分片每条最多 1 次）与媒体（`getFile`+下载、multipart 上传）。
- `409 Conflict`（另一实例轮询）走 409 重试退避；`429` 按 `retry_after`（`telegram-api.ts:560-620`）。空闲时 138 req/hr 可忽略，但**同一 token 跑两个实例**会互相抢 update（offset 冲突），应视为不支持。

### 2.2 offset 持久化与恢复

- 每成功处理一个 update 后 `writeOffset(update.update_id+1)`（`telegram.ts:526`）；`receive` 返回 `failed`/抛错时**不推进**并抛出，外层退避重试（`telegram.ts:488-525`）。
- 首次安装 probe：`offset=-1` 只取最新一条，避免把 24h 历史全部变成 Ticket；失败时把 `OFFSET_KEY` 设为该 `update_id`（含端点），保证重试不跳过（`telegram.ts:477-520`）。
- 崩溃窗口：消息类 Trigger 有稳定 id（`telegram:msg:<chat>:<id>`），重放会被 Engine 去重；**命令副作用没有去重**（见 M5）。
- poison 消息（命令回执发送失败等）记录 warn 后推进 offset（`telegram.ts:495-507`），不会卡死；代价是该命令无回复。

### 2.3 媒体下载

- 路径：`<stateDir>/downloads/<message_id>-<safeName>`，目录 0700、文件 0600，默认上限 `maxDownloadBytes=20MB`（clamp 1KB–100MB），`files:false` 完全关闭（`telegram.ts:799-849`）。
- `safeFileName` 取 basename 并白名单字符（`telegram.ts:315-321`），可防路径穿越。
- 问题：串行下载阻塞轮询（M3）；`downloadFile` 先整体 `arrayBuffer` 再检查大小（`telegram-api.ts:827-846`）；`message_id` 跨 chat 冲突（M4）；无磁盘配额/保留策略；内容不做 MIME/大小之外的校验，落盘后 Worker 读取时应视为不可信文本/二进制（见 §5）。

### 2.4 callback 与键盘幂等

- 键盘只附在 `attention`/`result` 且带 `ticketId` 的消息（`telegram.ts:1007-1025`）；`sa:ack|retry|stop:<ticketId>` 严格正则匹配（`telegram.ts:702-760`）。
- 回调处理顺序：调用 `TelegramCommands` → `answerCallbackQuery` → `editMessageReplyMarkup` 移除按钮；失败仅 warn/debug，不影响轮询。
- 重放风险：双击（按钮移除前）与"副作用后、offset 落库前崩溃"都会重复执行 retry/stop。`retry/stop` 在上层是否幂等未被 Source 保证，建议加持久 dedupe（见 §8.4）。
- 普通 callback（非 `sa:`）→ Trigger id `telegram:callback:<callback.id>`，天然去重。

### 2.5 安全

- token：只在请求 URL/请求头中出现，错误信息不含 token；日志只含方法/状态/描述；token 文件/env 读取失败只报变量名或路径，不报值。已由 `tests/sources-telegram.spec.ts` 覆盖。
- 入站白名单：DM 必须 `allowedUserIds`；群必须先匹配 `chats` 且发送者在 `allowedUserIds`，再按 @/回复/命令判定 addressed；陌生人消息在 media 下载之前就被过滤（`telegram.ts:540-553`）。
- 富文本：`markdownToTelegramHtml` 先转义 `& < >`，只生成受控标签，链接仅 `https?://`；`reply_markup` 内容为静态 JSON。
- 出站附件路径（H4）：`attachment.path` 来自 Engine/Worker report，Source 直接读；无白名单/目录限制，也无 symlink 防护。这是**最需要修的 inbound→outbound 权限边界**。
- 入站文本上限：Telegram 单条 ≤4096 字符、caption ≤1024，天然受限；但媒体/文件名、forward 等仍应按不可信处理。

---

## 3. GitHub Source

### 3.1 每仓库每轮请求矩阵（pollRepo，`github.ts:888-1043`）

| 数据流 | endpoint | 请求/轮（稳态） | 页上限 | 条件请求 |
|---|---|---|---|---|
| issues（含 PR） | `/repos/{r}/issues?state=open&sort=updated&direction=asc&since=…` | 1 | 3 页 | 仅第 1 页 ETag |
| pulls 生命周期 | `/repos/{r}/pulls?state=all&sort=updated&direction=desc` | 1（走到早于 since） | 3 页 | 仅第 1 页 ETag |
| PR reviews | `/repos/{r}/pulls/{n}/reviews` | 0–10（每个窗口内更新的 PR 一次） | 1 页 | 无 |
| issue comments | `/repos/{r}/issues/comments?sort=updated&direction=asc&since=…` | 1 | 3 页 | 仅第 1 页 ETag |
| review comments | `/repos/{r}/pulls/comments?…since=…` | 1 | 3 页 | 仅第 1 页 ETag |
| CI（`observeCi`） | `/repos/{r}`（默认分支，内存缓存一次）+ `/commits/{branch}/check-runs` + `/actions/runs` | 首次 3，之后 2 | — | 无 |
| wildcard discovery | `/user/repos` | 每 10 分钟 1–2 次（≤200 个） | 2 页 | 无 |
| invitations | `/user/repository_invitations` + PATCH | 每次 discovery 刷新 1–2 + 每个待处理 1 | 2 页 | 无 |

- **quiet + CI off**：4 次/仓库/轮，均为空页 → 游标不动 → 同一 URL 重放 ETag → **304 不计入主配额**（GitHub 文档行为），这是当前设计的最大优点。
- **active + CI on**：4 次 200 + CI 2 次（无条件，必计入）+ reviews 0–10 → **6–16 次/轮/仓库**。
- 分页：任一 stream 命中 >100 条时最多 3 页；`page.truncated` 为 true 时 `advance` 不前进（`github.ts:1400-1419`），下轮重读同样窗口（依赖 Trigger id 去重）。
- 每轮每仓库还有约 4–5 次 KV 写入（每个 stream `saveCursors`，`github.ts:940/1009/1022/1034`），16 仓库 = 60–80 次/分钟 SQLite 写。

### 3.2 限流与重试

- `GithubApi` 默认 `maxAttempts=3`，403 rate-limit/429 读 `Retry-After`/`X-RateLimit-Reset`，5xx/网络指数退避（`github-api.ts:560-620`）。单请求行为正确、错误带 `.status/.rateLimited/.retryAfterMs` 且 token-free。
- **缺口（H2）**：`pollOnce` 把每仓库错误收进 `result.errors` 返回而非抛出；`runLoop` 只按 `errors.length` 计数并照常睡 `pollSeconds`（`github.ts:533-537`）。因此配额耗尽时每轮仍会对每个仓库发起 4–12 次重试（3 attempts × streams），是限流风暴的放大器。
- 没有全局 `X-RateLimit-Remaining/Reset` 感知，也没有跨仓库的冷却；多个仓库同时 403 会各自重试。

### 3.3 wildcard 放大（H1）

- `repositories: ["*"]` 由 `/user/repos` 解析（≤200，10 分钟刷新，失败 30s→10min 退避）后**每仓库独立跑 4–6 条 stream**（`github.ts:732-860,888-1043`）。
- 设 `poll=60s`、CI on、稳态活跃：
  - 1 仓库：6–16 req/轮 ⇒ **360–960 req/hr**
  - 16 仓库：**5,760–15,360 req/hr** > 5,000/hr
  - 200 仓库（上限）：**72,000–192,000 req/hr**（灾难）
- 即使 CI off、全部 quiet（304 不计费），16 仓库也会产生 ~3,840 次 HTTP/小时与 3,840 次条件请求开销；CI on 时其中 1,920 次是**无条件计入配额**的。
- 修复方向：自适应轮询/订阅优先/上限（§8.1、§8.2）。

### 3.4 Cursor / 恢复

- 每 repo 一个 `github:cursors:<owner/repo>` 对象（issues/pulls/issueComments/reviewComments/reviews 各自 since+etag），`advance` 在页非空且未截断时把游标推向 `roundStartedAt − 5s`（`github.ts:895,1400-1419`），重叠 5s 用 Trigger id 去重。
- 优点：崩溃时已处理事件不重复产生副作用；PR 生命周期 `trackedPulls` 在回调**之前**持久化（`github.ts:954-980`），`pullOpened/threadClosed` 不重复。
- 风险 M1：空页时游标**刻意不推进**（为了 ETag），因此长期静默后 `since` 可能非常旧。issues 用 `sort=updated&direction=asc`（`github-api.ts:1053-1060`），恢复后第一轮先读"最旧"的更新；若 >3 页，`truncated` 阻止推进 → 下轮仍读同样旧页面，形成**滞后/近似 livelock**，直到窗口内更新数量下降。pulls 用 desc 并有 `sawOlder` 终止，风险较小。
- 404 仓库：wildcard 下移除并刷新 discovery（task-25）；显式列表 warn 一次并继续轮询。删除仓库的 KV 状态被清理；重新加入的仓库从 `now−5s` 起，**重新加入前的事件不补**（预期行为，需在文档说明）。

### 3.5 CI 与 reviews

- CI：默认 `observeCi=false`；开启后每轮 2 次无条件请求，首次 3 次。baseline 只在 fingerprint 变化时发 Trigger（失败/恢复），首轮只建立基线。限流时 403 与 checks/actions 的权限回退已处理（task-11/25）。
- reviews：只对"窗口内更新且非 self"的 PR 拉 reviews，最多 10 个/轮；无 per-PR 游标/ETag，PR 活跃期间每轮全量拉取。M2。

### 3.6 安全（GitHub）

- token：仅 env/file，错误/日志/health 均不含 token；`allowSelf=false` 默认，单账号模式需显式开启。
- `allowSelf=true` 时用 `<!-- superagent:` marker 过滤自身评论/PR body；marker 由 `createIssueComment/createPullRequest` 自动写入。**绕过风险**：Worker 若用 `gh` 或其它客户端直接写评论（不带 marker），会被当作新事件自激。依赖 Worker 只通过 `superagent_github` 写入。
- **H3 自动接受邀请**：`acceptPendingInvitations` 在启动与每次 discovery 刷新后无条件接受 bot 的所有待处理邀请并刷新 discovery。任何人可邀请 bot 进入自己的仓库 → 仓库自动进入 wildcard 轮询、不可信 issue/评论成为 Trigger（最终由 Engine 白名单/评估过滤，但配额与内容暴露已发生）。建议改为可配置邀请白名单/仅接受 operator 邀请，或在 wildcard 关闭时不做自动接受。
- 入站注入：issue/comment/PR body 原样进入 `Trigger.text`，未截断；Engine/Worker 必须以"数据"处理。文本长度无上限（GitHub 评论最大 65,536 字符），多仓库时可显著增加上下文与模型成本（M6）。

---

## 4. 量化：API 配额估算

假设：GitHub 认证 REST **5,000 req/hr**（经典/细粒度 PAT 同量级）；条件请求 304 不计主配额；单请求重试最多 3 次。`pollSeconds=60`。

### 4.1 每轮每仓库计费请求（非 304）

| 场景 | issues | pulls | issue-comments | review-comments | reviews | CI | 合计/轮 | /hr/仓库 |
|---|---|---|---|---|---|---|---|---|
| quiet，CI off | 0（304） | 0 | 0 | 0 | 0 | 0 | 0 | **0**（但仍 240 次 HTTP） |
| quiet，CI on | 0 | 0 | 0 | 0 | 0 | 2 | 2 | **120** |
| active，CI off | 1 | 1 | 1 | 1 | 0–10 | 0 | 4–14 | **240–840** |
| active，CI on | 1 | 1 | 1 | 1 | 0–10 | 2 | 6–16 | **360–960** |
| 最坏（多页+10 reviews+CI） | 3 | 3 | 3 | 3 | 10 | 2 | **24** | **1,440** |

### 4.2 多仓库（wildcard）

| 仓库数 | 场景 | 计费 req/hr | 结论 |
|---|---|---|---|
| 1 | active CI on | 360–960 | 安全 |
| 5 | active CI on | 1,800–4,800 | 接近上限（reviews 多则超） |
| 10 | active CI on | 3,600–9,600 | **超限**（高活跃时） |
| 16 | quiet CI off | ~0（3,840 次 304 HTTP） | 主配额安全，连接/延迟成本 |
| 16 | quiet CI on | 1,920 | 安全但占 38% |
| 16 | active CI on | 5,760–15,360 | **超限**（用户实测场景） |
| 200（上限） | active CI on | 72,000–192,000 | 灾难性 |

- discovery：`/user/repos` 1–2 次/10min（6–12/hr）+ invitations 1–2 次/刷新（≤12/hr）+ 每个待处理邀请 1 次 PATCH；相对上述可忽略，但首次发现 200 仓库时有一波 2 页请求。
- 限流期间每次失败请求仍有最多 3 次尝试 → 上述计费在最坏情况下再 ×3。
- 安全仓库数（CI on、active、留 20% 余量）：`5000×0.8/(6×60) ≈ 11` 个；若 reviews 常态 ≤2 则约 16 个。**默认 60s 下建议 wildcard ≤8–10 个仓库；>10 应改用 300s 或通知流。**

### 4.3 Telegram

| 场景 | 请求量 | 说明 |
|---|---|---|
| 空闲长轮询 | ~138/hr | 25s timeout + 1s gap |
| 每条消息 | 1 次 `sendMessage`/分片（>4096 字符 2+） | 出站主要成本 |
| 媒体 | 1 `getFile` + 1 下载 + 1 `sendPhoto/Document` | 不计入官方公开配额，但受 429/带宽限制 |
| 命令 | 1 次 `sendMessage` 回执 | 无模型调用 |

Telegram 无公开 REST 配额，关注 429/FloodWait（已有退避）与"同一 token 单实例"约束。

---

## 5. 延迟

| 事件 | 检测延迟（默认配置） | 说明 |
|---|---|---|
| Telegram DM/命令 | 立即（长轮询） | 命令回执 1 次 API RTT |
| Telegram 带媒体 | 立即 + **下载耗时** | 下载在 Trigger 之前且串行（M3）；20MB 慢链路可数分钟，阻塞该轮后续 update |
| GitHub issue/评论/PR | 0–60s（poll 间隔）+ 0–3s（4–6 次 RTT） | 多页/reviews 时 +RTT；comments 走 repo 级流，无 per-thread 订阅加速 |
| GitHub CI 变化 | 0–60s | 无条件 2 次请求；首轮只建 baseline |
| 新仓库进入监听 | ≤10min（discovery 周期） | operator 邀请 bot 后：接受→立即 discovery 最快 1 轮；手动加 wildcard 外的显式仓库需重启/重配 |
| 错误/限流 | 正常 poll 间隔；**抛错路径** 1s→60s 指数退避 | 单仓库错误不触发退避（H2），可能持续每 60s 撞限流 |
| 重启恢复 | 立即首轮 poll；Telegram 待处理 backlog 按 offset 重放（probe 首次仅最新一条） | GitHub 首次发现的新仓库不补历史 |

---

## 6. 可靠性矩阵

| 场景 | 行为 | 风险 |
|---|---|---|
| Telegram update 重放 | 稳定 Trigger id + Engine 去重 | 命令/`sa:` 副作用不去重（M5） |
| Telegram `receive='failed'` | 不推进 offset、本轮抛错、下轮重试 | 正确 |
| Telegram 首次安装 | `offset=-1` 只取最新一条 | 丢失 24h 历史（有意） |
| Telegram KV 丢失 | 重新按新安装处理 | 仅最近一条，其余丢失（可接受，需文档） |
| GitHub 单 stream 失败 | 不推进该 stream 游标，重试整窗口；Trigger 去重 | 正确；但无全局退避（H2） |
| GitHub 进程崩溃 | 已保存游标不重复副作用（PR 回调先落盘） | 未保存的窗口重读，去重兜底 |
| GitHub long idle | 空页不推进游标以复用 ETag；恢复时窗口可能很大 | asc issues + 3 页截断 → M1 滞后 |
| 仓库删除/失联 | wildcard 移除+刷新，显式列表 warn 一次 | 重新加入不补历史 |
| 并发 poll | 每 Source 单 loop，`start()` 幂等；无重叠 | 同一 token 跑两个实例会争 offset/重复发送（运营约束） |
| 网络断开 | fetch 失败 → Telegram per-request 退避；GitHub 抛 GithubApiError(status 0) → errors → 照常下一轮 | 无全局退避，弱网时请求量不降 |
| 附加文件 | 文本优先；单个附件失败 warn 不阻塞；无文本且全失败返回 failed | 正确；重复发送受 at-least-once 影响（Telegram 无幂等） |

---

## 7. 安全威胁模型

| 资产/入口 | 现状 | 结论/建议 |
|---|---|---|
| Telegram/GitHub token | 仅 env/file；日志/health/错误不带 token；测试覆盖 | 良好；注意 token 文件权限与进程环境可见性 |
| 入站 Telegram 文本/媒体 | 仅白名单 user/chat；群需 addressed；媒体落盘后交 Worker | 内容必须视为不可信（prompt injection）；建议把下载文件标注 untrusted 并在 Worker prompt 中提示 |
| 入站 GitHub 内容 | 白名单（allowLogins/botLogins）+ allowSelf marker；wildcard 自动接受邀请 | H3：邀请方不可信会扩大攻击面；M6：文本无上限 |
| 出站 Telegram 附件路径 | Worker 提供任意绝对路径，Source 直接读 | **H4：需 ticket/state 目录 allowlist + realpath 校验 + 大小/数量/mime 限制**；multipart 文件名/长度消毒 |
| 出站富文本 | HTML 转义、标签白名单、链接仅 https?、URL 属性转义 | 良好 |
| callback 数据 | `sa:` 严格正则；其余 callback → Trigger（Engine 去重） | 良好；副作用幂等见 M5 |
| 附件下载路径 | safeFileName + 固定 downloads 目录；0700/0600 | 路径穿越已防；跨 chat 覆盖与磁盘配额见 M4 |
| URL 校验 | 出站 markdown 链接仅 `https?://`；下载 URL 由 Bot API file_path 构造（token 在 URL，不落日志） | 良好；错误不打印 URL |

---

## 8. 五个优先优化（按收益/风险排序）

### P0-1. 配额感知 + 自适应轮询 + 仓库上限（解决 H1/H2）
- 读 `X-RateLimit-Remaining/Reset`；剩余 <20% 时对整个 Source 进入全局冷却（按 reset 等待，而不是每仓库重试）。
- `runLoop` 对 `result.errors` 中 403/429/5xx 实施指数退避（当前只计数不降频）；连续限流 ≥3 次时把 `pollSeconds` 临时提升到 300–900s 并写 health。
- 自适应 cadence：一个 poll 周期内无新事件的仓库，轮询间隔指数增长到 5–15min；有开放 Ticket/近期事件/CI 失败的仓库保持 60s。
- wildcard 软上限（如 >10 仓库时默认 poll≥300s，>50 时要求显式确认/改通知流）；health 显示估算 req/hr 与剩余配额。
- 预期：16 仓库活跃场景从 5.8k–15k/hr 降到 <1.5k/hr，且限流风暴自我抑制。

### P0-2. 用通知流替代 repo-wide 轮询（解决 H1/M2/L1，最大结构收益）
- 参考原型：`GET /notifications`（1 次/轮，全部仓库、支持 `since`/ETag）发现"哪个 thread 有活动"，然后只对 **有订阅/打开 Ticket/明确 mention 的 Thread** 拉 comments/reviews/CI；未订阅的 wildcard 仓库不再每轮 4–6 次请求。
- 保留当前 repo 级流作为"通知不可用（403/404）"的降级路径。
- 预期：16+ 仓库时请求从 O(repos) 降为 O(active threads)+1，通常 80–95% 削减；reviews 不再对每个更新 PR 全量拉取。

### P0-3. 附件安全与下载解耦（解决 H4/M3/M4）
- 出站路径 allowlist：只允许 `<stateDir>/work/...`（Ticket 目录）与 `<stateDir>/downloads/...` 内的文件，`realpath` 后校验前缀、拒绝符号链接/隐藏目录；限制 10 个/条、单文件大小与 mime，multipart `name` 字符/长度消毒。
- 下载移出长轮询：进有界队列（并发 2–4）、流式写入并先按 `Content-Length`/`file_size` 校验、超限中止；下载完成后再 `receive`（或先 receive 再异步补 meta，需 Engine 配合）。
- 文件名加入 chat id/唯一 nonce，避免跨会话覆盖；旧文件按 TTL/容量清理；`fs.open(..., 'wx')` + 显式 chmod 确保 0600。

### P1-4. 命令/回调幂等（解决 M5）
- 为 `/retry` `/stop` 与 `sa:` 动作记录持久 dedupe key（如 `telegram:cmd:<update_id>:<action>:<ticketId>`，带 TTL）；在调用 Engine 前写入（或写入"in-flight"，成功后标记 done），崩溃重放时跳过。
- 按钮点击在首次处理后立即 `editMessageReplyMarkup` 并记录 `(chatId,messageId,action)` 去重；`ack` 幂等。
- 命令回执失败可进 outbox（复用现有队列）而非仅日志。

### P2-5. ETag/游标/正文预算（解决 M1/M6/L1）
- 把"空页不推进游标"扩展为"首屏内容未变化就不推进"，使 ETag 在活跃但无新增时也能命中；多页场景对第 1 页持续条件请求。
- issues 恢复策略：检测到 `since` 过旧且页满时改为 `direction=desc` 先取最新一页，再逐步回补（或游标直接推进到 `roundStart−5s` 并接受 5s 外漏读，由后续 mention/notification 补偿），避免 M1 卡住。
- reviews 改为 per-PR `reviewsSince`（只拉新 review）或按 PR 缓存 ETag。
- 入站 GitHub 文本截断（如 16KB + `… [truncated]`）并写入 `meta.truncated`，控制 prompt/存储成本；大附件内容在 Worker prompt 中显式标注 untrusted。

---

## 9. 测试与可观测性缺口

- 缺少 poll 级限流测试：`X-RateLimit-Remaining: 0` + 16 仓库时（当前实现会持续 60s 重试），以及全局退避断言。
- 缺少 M1 回归测试（旧 `since` + 3 页截断后的推进策略）。
- 缺少命令/`sa:` 崩溃窗口去重测试（当前只有 happy path callback 测试）。
- 缺少磁盘配额/保留、跨 chat 同名 `message_id` 附件覆盖、附件路径越权（`../`、symlink）测试。
- 缺少每 poll 请求计数/耗时的可观测指标（health 只有 repo 数与 sanitized 摘要）；建议增加 `req/poll`、`304 ratio`、`remaining quota`、`download queue depth` 到 health/诊断。
- 建议补 `docs`：wildcard 推荐仓库数 vs pollSeconds 表、Telegram 单实例约束、附件安全说明。

---

## 10. 附录：公式与关键行号

**每仓库每轮计费请求**（非 304）：
```
req_active = streams_hit(4) + reviews(0..10) + ci(observeCi ? 2 : 0)     // 每流最多 3 页时 streams_hit 可到 12
req_quiet  = ci(observeCi ? 2 : 0)                                      // 其余 stream 304 不计数
per_hour   = req * (3600 / pollSeconds)
wildcard   = sum(per_hour over repos) + discovery(~20/hr) + writes
```
**安全仓库数**（active、CI on、20% 余量）：`5000 * 0.8 / (6 * 60) ≈ 11`；reviews 活跃时按 8–16 req/轮下降到 **5–8 个**。

关键代码位置：Telegram 轮询 `telegram.ts:458-527`、下载 `telegram.ts:799-849`、回调 `telegram.ts:664-760`、上传/下载 `telegram-api.ts:752-846`；GitHub 轮询 `github.ts:888-1043`、自动发现/邀请 `github.ts:732-860`、退避 `github.ts:527-548`、游标 `github.ts:1400-1419`、条件请求 `github-api.ts:560-690`。
