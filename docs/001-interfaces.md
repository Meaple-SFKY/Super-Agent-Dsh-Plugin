# 001 · 跨模块接口约定

本文件固定 teammate 之间必须对齐的接口，避免并行开发时各写一套。

## 1. Source 模块导出形态

每个来源模块（`src/sources/telegram.ts`、`src/sources/github.ts`）导出：

```ts
export const kind: SourceKind<TelegramConfig>   // id/title/description/create
export default kind
export function createSource(config: TelegramConfig, ctx: SourceContext): Source
```

`SourceKind.create` 内部完成 token 读取、轮询循环、健康上报；`runtime` 只负责按配置创建、start/stop，并把 `ctx` 接好。

## 2. Telegram 命令接口（sources 定义，runtime 实现并注入）

```ts
export interface TelegramCommands {
  status(): Promise<string>
  pause(): Promise<string>
  resume(): Promise<string>
  tickets(): Promise<string>
  stopTicket(ticketId: string): Promise<string>
  retryTicket(ticketId: string): Promise<string>
}
```

- 命令回复由 Telegram Source 直接发送，不进入 Router Session、不消耗模型调用。
- `status` 返回一段简短文本（≤100 字）：运行状态、来源健康、活跃/待决策 Ticket 数、pause 状态。

## 3. 管理 HTTP API（runtime 实现，packaging 的面板消费）

路径前缀 `/superagent/api`，仅接受 loopback，要求请求头 `x-superagent-request: 1`，否则 403。

`GET /superagent/api/state` 返回：

```jsonc
{
  "ok": true,
  "plugin": { "status": "ready|degraded|starting|stopped", "detail": null, "version": "0.1.0" },
  "paused": false,
  "sources": [{ "id": "telegram", "health": "ready|starting|error|off", "detail": null, "at": "ISO" }],
  "tickets": {
    "active": [{ "id": "t_...", "title": "...", "stage": "working", "lastReport": "progress", "at": "ISO" }],
    "attention": [{ "id": "t_...", "title": "...", "kind": "blocked|ready|failed", "question": "...", "at": "ISO" }]
  },
  "health": [{ "name": "effects:launch", "state": "ready|error", "detail": null }]
}
```

`POST /superagent/api/action`，body：

```jsonc
{ "action": "pause" | "resume" | "retry" | "stop" | "check", "ticketId": "t_..." }
```

返回 `{ "ok": true, "result": "..." }` 或 `{ "ok": false, "error": "..." }`。

面板只做只读展示 + 上述动作；不做设置编辑（本期）。

## 4. Engine 与 Runtime 的分工

- `runtime` 实现 `ExecutorPort`、`AssessorPort`、`SourceScopePort`、`OutboxPort` 的发送端，并注册 Effects handlers。
- `core-engine` 只依赖 ports，不 import `src/app/*` 或 `src/sources/*`。
- `packaging` 只依赖 `src/app/api.ts` 的 HTTP 形状与 `src/index.ts`；不 import 运行时实现。

## 5. 配置形态（runtime 校验）

```ts
interface PluginConfig {
  enabled?: boolean
  stateDir: string
  sources?: {
    telegram?: { enabled?: boolean; tokenEnv?: string; tokenFile?: string; allowedUserIds?: string[]; chats?: string[] }
    github?: { enabled?: boolean; tokenEnv?: string; tokenFile?: string; repositories?: string[]; login?: string; observeIssues?: boolean; observePulls?: boolean; observeComments?: boolean; observeCi?: boolean }
  }
  policy?: { mode?: 'off' | 'observe' | 'auto'; rules?: Array<{ id: string; name: string; enabled?: boolean; instructions: string }> }
  executor?: { model?: string; maxWorkers?: number; prepare?: string }
  quiet?: { minChars?: number; quietHours?: { from: string; to: string } }
}
```

密钥只从 `tokenEnv` / `tokenFile` 读取；任何日志、错误信息、面板响应都不得包含 token。
