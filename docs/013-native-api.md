# 013 · Native API（MMAgent macOS App bridge）

版本：`1.1.0`（`GET /superagent/native/v1/state` 的 `native.version`；v1.1 增加 setup 向导端点）
适用：MMAgent v1 默认开启（`sources.native.enabled: true`）；可在 profile 里关闭。Telegram / GitHub 行为不变。

## 1. 发现与认证

启动后插件在 `<stateDir>/native.json` 写入（**0600**，原子 rename）：

```json
{
  "version": "1.1.0",
  "port": 47821,
  "token": "<64 hex chars>",
  "pid": 12345,
  "startedAt": "2026-11-07T00:00:00.000Z"
}
```

- 服务只绑定 **127.0.0.1**；默认端口 `47821`，被占用时依次尝试 `+1/+2`，最后交给系统分配（`port: 0` 表示直接由系统分配）。App 必须使用 `native.json` 里的 `port`，不要假设固定端口。
- App 启动时读取该文件；文件不存在 → 插件尚未 ready 或 `sources.native.enabled: false`（可 2 s 后重试）。
- 认证：每个请求带 `x-mmagent-token: <token>`，或 `Authorization: Bearer <token>`。缺失/错误 → `401 {"ok":false,"error":"unauthorized"}`（常量时间比较，token 不会出现在任何响应或日志中）。
- 额外防护：仅接受 loopback 连接；请求体上限 1 MB；每连接每秒 200 次请求（超出 `429 rate_limited`）。
- 配置文件字段：`sources.native.enabled`（**默认 true**，关掉即不监听）、`sources.native.port`（默认 47821）。
- 停止/重启时删除 `native.json`；App 收到 401/连接失败应重新读取该文件。

Base URL：`http://127.0.0.1:<port>/superagent/native/v1`

```bash
TOKEN=$(jq -r .token ~/Library/Application\ Support/.../native.json)
curl -s -H "x-mmagent-token: $TOKEN" http://127.0.0.1:47821/superagent/native/v1/state
```

## 2. 接口

所有响应均为 JSON（SSE 除外），成功均为 2xx。除 `events` 外均要求认证。

### GET `/state`

```json
{
  "ok": true,
  "plugin": { "status": "ready|degraded|starting", "detail": null, "version": "0.1.1" },
  "paused": false,
  "native": { "version": "1.1.0", "port": 47821, "pid": 12345, "startedAt": "..." },
  "tickets": {
    "active":   [{ "id": "tk_1", "title": "...", "stage": "working|queued|waiting|open", "lastReport": "ready|blocked|failed|null", "at": "..." }],
    "attention":[{ "id": "tk_1", "title": "...", "stage": "...", "lastReport": "blocked", "at": "..." }],
    "history":  [{ "id": "tk_0", "title": "...", "stage": "ended", "lastReport": "ready", "at": "..." }]
  },
  "sources": [{ "id": "telegram|github|native", "health": "ready|starting|error|off", "detail": null, "at": "..." }],
  "health":  [{ "name": "runtime|effects:launch|...", "state": "ready|degraded|error", "detail": null }]
}
```

`attention` 是 `latestReport.kind ∈ {blocked, ready, failed}` 的打开 Ticket；`history` 是最近结束的 Ticket。

### GET `/tickets?query=&status=&source=&before=&limit=`

搜索/历史页（Overview 仍用 `/state` 的 50 条小窗口）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `query` | — | 大小写不敏感，匹配 `id`、`title`、最新报告 `summary/question`、各 `inputs.text`；最多 200 字符 |
| `status` | `all` | `all` / `active`（打开且非 attention）/ `attention`（最新报告为 blocked/ready/failed）/ `history`（已结束） |
| `source` | — | `telegram` / `github` / `native`（按 Ticket 的 channels 过滤） |
| `before` | — | 上一页返回的 `nextBefore` 游标（`<updatedAt>|<id>`）；非法 → `400 invalid_before` |
| `limit` | `30` | 1..100；越界 → `400 invalid_limit` |

```json
{
  "ok": true,
  "items": [
    { "id": "tk_1", "title": "Fix build", "state": "open|ended", "stage": "working|queued|waiting|open|ended",
      "source": "native", "thread": "native:task:<uuid>", "lastReport": "ready|blocked|failed|null",
      "createdAt": "...", "updatedAt": "...", "endsAt": "..." }
  ],
  "nextBefore": "2026-01-01T00:00:00.000Z|tk_1",
  "total": 12
}
```
- 排序：`updatedAt` 降序、`id` 降序；`nextBefore` 只在还有下一页时出现；`total` 是过滤后（未截断）总数。
- 搜索深度为最近 **2 000** 张 Ticket（store 的 recent-window 查询），历史页足够；更早数据用 `/tickets/:id` 直接查。
- 校验错误：`status` 非法 `400 invalid_status`，`source` 非法 `400 invalid_source`，`limit`/`before` 同上。

### GET `/tickets/:id`

```json
{
  "ok": true,
  "ticket": {
    "id": "tk_1",
    "title": "Fix the build",
    "state": "open|ended",
    "stage": "working|queued|waiting|open",
    "source": "native",
    "thread": "native:task:<uuid>",
    "createdAt": "...",
    "updatedAt": "...",
    "waitingForPerson": false,
    "inputs":   [{ "id": "in_1", "kind": "trigger|resume|text|policy", "at": "...", "person": true, "text": "...", "readAt": null }],
    "reports":  [{ "kind": "ready|blocked|failed|progress", "summary": "...", "at": "...", "question": "..." }],
    "files":    [{ "path": "/abs/path/report.png", "name": "report.png", "kind": "photo|document", "caption": "" }],
    "attachments": [{ "path": "/abs/path/report.png", "kind": "photo" }],
    "assignments": [{ "id": "as_1", "state": "pending|running|ended", "createdAt": "...", "startedAt": "...", "endedAt": "...", "sessionId": "..." }],
    "ends": { "reason": "ready", "at": "..." }
  }
}
```

`files`/`attachments` 均为本机**绝对路径**（Worker 生成并随报告提交的文件）。未知 id → `404 {"ok":false,"error":"not_found"}`。

### GET `/events`（SSE）

`Content-Type: text/event-stream`。认证头同其他接口。

- 连接后先发 `event: snapshot`（`data` 同 `/state` 的裁剪版 `{ok,snapshot}`），随后是增量事件；每 15 s 发送 `: ping` 心跳。
- 事件格式：`id: <n>` / `event: <type>` / `data: <json>`；`id` 单调递增，可作 `Last-Event-ID` 重连（插件内存保留最近 500 条；更早请用 `/messages` 补发消息）。
- 事件类型：
  - `snapshot`：连接初始状态。
  - `ticket`：Ticket 新增或 stage/lastReport 变化 `{ticket:{id,title,stage,lastReport,at}}`。
  - `attention`：Ticket 进入 attention（blocked/ready/failed）`{ticket}`。
  - `message`：插件发给用户的出站消息：`{message:{...OutboundMessage}, inboxId, thread, ticketId, purpose}`
    - 顶层 `thread` / `ticketId` / `purpose` 便于 App 不解析 `message` 内部结构就做路由/分组（`ticketId` 可能为 `null`）。
  - `result`：Ticket 结束 `{ticket}`。
- 断线重连：带 `Last-Event-ID: <last id>`；未带时重新收到 snapshot。

JavaScript 示例：

```js
const es = new EventSource(url + '/events') // 浏览器 EventSource 不能带自定义头
// 原生 App 用 URLSession/URLRequest 带 x-mmagent-token；或 Bearer。
```

### POST `/tasks`

```json
// request
{
  "text": "修复构建并提交 PR",
  "clientTaskId": "mac-uuid-1",
  "attachments": ["/Users/me/Desktop/bug.png", "/Users/me/Desktop/log.txt"]
}
// response 200
{ "ok": true, "ticketId": "tk_1|null", "threadId": "native:task:<uuid>", "triggerId": "tr_native_...", "status": "accepted|pending" }
```

`attachments`（可选）：本机**绝对路径**数组，最多 10 个。有效项会归一化为
`{path, name, kind: 'photo'|'document', size}`（图片扩展名 → `photo`）写入 `Trigger.meta.attachments`，Worker 可用
`read_image`/`read_file` 读取、也可在报告里用 `files` 回传。
**宽容策略**：不存在/非普通文件/相对路径/非字符串/超过 10 个不会让任务失败——无效项被忽略，前 10 个有效项提交，
响应带 `warnings: string[]` 说明原因（例如 `"attachment ignored (does not exist): /…"`）。App 可展示这些警告。

- 每个任务创建一个**独立 Thread** `native:task:<uuid>`（不会 resume 其他 Ticket/Thread），actor=`local`，addressed=`direct`。
- `ticketId` 由 Router 判定接受后产生：通常立即返回；若模型尚未决定则在最多 1.5 s 后返回 `ticketId: null, status: "pending"`，随后通过 SSE `ticket` 事件给出 ticketId（用 `threadId` 关联）。
- 错误：`400 invalid_text`（text 空/超 20 000 字符）、`400` bridge 拒绝。

### POST `/tickets/:id/reply`

```json
{ "text": "继续，先补测试" }
// 200 { "ok": true, "triggerId": "tr_native_..." }
```

- 使用该 Ticket 的 native Thread，并在 Trigger `meta.ticketId` 显式指向该 Ticket（避免 Core 的“一条消息最多 resume 一个 ended Ticket”规则把追问路由到别的 Ticket）。
- 未知 ticket → `404`；空文本 → `400 invalid_text`。

### POST `/actions`

```json
{ "ticketId": "tk_1", "action": "ack" | "retry" | "stop" }
```
- `retry`/`stop` 复用 Runtime 现有 Engine 路径（同面板 action）。
- `ack` 目前是客户端确认（服务端返回 `{ok:true,result:"acknowledged ..."}`，不改变 Ticket）；App 可用它确认已读 attention。
- 非法 action → `400 invalid_action`；未知 ticket → `400`。

### GET `/messages?since=<inboxId>`

```json
{ "ok": true, "messages": [{ "id": 1, "at": "...", "message": { "...OutboundMessage" } }], "nextSince": 1 }
```
- 插件发给用户的出站消息持久化在 `<stateDir>/native-inbox.jsonl`（0600，内存保留最近 500 条），用于 App 离线补发。
- `since` 为上次收到的 `inboxId`；缺省返回当前内存窗口全部。

## 3. 错误码汇总

| HTTP | error | 含义 |
|---|---|---|
| 401 | `unauthorized` | 缺失/错误 token |
| 403 | `forbidden` | 非 loopback 连接 |
| 404 | `not_found` | 未知路径/Ticket |
| 400 | `invalid_text` | 空文本或超过 20 000 字符 |
| 400 | `invalid_action` | action 不是 ack/retry/stop |
| 429 | `rate_limited` | 超过每秒请求上限 |
| 500 | `internal_error` | 未预期错误（详情只在插件日志） |
| 503 | `not_ready` | Source 尚未启动完成 |

## 4. v1 范围与限制

- 只读 `state/tickets/events/messages`；写操作仅 `tasks`、`reply`、`actions`。
- 不暴露模型列表/模型切换（v1 只读，模型在 DSH/面板配置）。
- 不支持删除 Ticket、取消排队中的任务（用 `actions.stop`）。
- 任务附件只支持本机文件路径（v1 无二进制上传）；附件内容由 Worker 读取，SSE 的 `message` 事件里若插件回传文件会带绝对路径。
- SSE backlog 只在内存（进程重启后靠 snapshot + `/messages` 重建视图）；`/messages` 窗口 500 条。
- 端口/token 每次进程启动都会重新生成；App 不要缓存 token。

## 5. Setup 向导 API（v1.1）

原生 App 的配置向导直接复用插件的 `SetupService`（与 Web 面板同一套校验、0600 密钥写入、configEditor 持久化），因此**不需要**在 App 里重复实现 token 校验。所有端点与其余 Native API 使用相同 token 认证、loopback 限制与请求体上限；响应结构与 setup API 一致（`{ok:true,...}` 或 `{ok:false,error,description}`），**任何响应都不含 token/私钥内容**。

前缀：`/superagent/native/v1/setup`

| 方法/路径 | body | 说明 |
|---|---|---|
| `GET /state` | — | 与 Web 面板 `GET setup/state` 相同：`stateDir`、`language`、`git`、`models`、`watchdog`、`plugin`、`accounts`（telegram/github/native）、`permissions`、`restartRequired`、`onboardingComplete`。 |
| `POST /telegram` | `{token}` | 校验 Bot token（`getMe`），写 `<stateDir>/secrets/telegram-token` 0600；返回 `botUsername`/`tokenFile`。错误 `400 invalid_token`。 |
| `POST /github` | `{token, personalToken?}` | 校验 GitHub PAT，写 `<stateDir>/secrets/github-token` 0600；返回 `login`、`repositories[]`、`tokenFile`。 |
| `POST /github/operator` | `{token, repositories?, botLogin?}` 或 `{remove:true}` | 个人 PAT 邀请 bot 为 push collaborator、让 bot 接受邀请、写 `secrets/github-operator-token` 0600；返回 `invited/accepted/warnings`（`remove` 删除该文件并清配置）。 |
| `POST /github/ssh-key` | — | 生成/返回 bot 的 ed25519 **公钥**与 `keyFile`（私钥不返回），并写 `executor.gitSshKeyFile`。 |
| `GET /models` | — | DSH `llm` 的 provider/model 目录（与面板相同；`llm` 不可用时 `501 llm_unavailable`）。 |
| `PUT /config`（也接受 POST） | `{config:{sources?,policy?,router?,executor?,quiet?,language?}}` | 校验后通过 configEditor 持久化；返回 `{ok:true,restarting:true}`。**响应先写出，随后插件重启**：App 应轮询/重读 `native.json`（端口/token 会变）并等待 `/setup/state` 可访问。成功后写 `<stateDir>/setup-complete.json`（state.onboardingComplete=true）。 |

示例：
```bash
BASE=http://127.0.0.1:$PORT/superagent/native/v1/setup
curl -s -H "x-mmagent-token: $TOKEN" $BASE/state
curl -s -H "x-mmagent-token: $TOKEN" -H 'content-type: application/json' -d '{"token":"123:ABC"}' $BASE/telegram
curl -s -H "x-mmagent-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"config":{"sources":{"native":{"enabled":true}},"policy":{"mode":"auto"}}}' -X PUT $BASE/config
```
向导顺序建议：`state` → `telegram`/`github`（二选一或都配）→ 可选 `github/operator`、`github/ssh-key` → `models` 选择 → `config` 保存 → 重新读 `native.json` 继续。

## 6. App 连接流程（推荐）

1. 轮询读取 `<stateDir>/native.json`（0600），拿到 port/token。
2. `GET /state` 验证；失败则重新读文件（插件重启会换 token/端口）。
3. 打开 `GET /events`（带 token，保存最后 event id）。
4. 新任务 `POST /tasks`，用返回的 `threadId`/SSE `ticket` 事件关联后续状态。
5. 追问 `POST /tickets/:id/reply`；attention 上执行 `ack`/`retry`/`stop`。
6. 断线：重新读 `native.json` → `GET /events`（Last-Event-ID）→ `GET /messages?since=...` 补消息。
