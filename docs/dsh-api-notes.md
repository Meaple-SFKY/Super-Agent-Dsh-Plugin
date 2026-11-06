# DSH 0.2.2-rc.1 API notes for a SuperAgent bundle

Everything a Host-side DSH bundle needs to: boot without ever breaking the harness, own one long-lived Router
session plus per-ticket Worker sessions, add tools / prompt sections / HTTP routes + a client panel, detect version
drift, and persist its own state.

## Provenance

| Source | Path | Notes |
|---|---|---|
| Runtime manifest | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json` | `@deepseek-ai/dsh 0.2.2-rc.1`, `cordis 4.1.0`, `schemastery 3.19.0`; packages pin `zod 4.4.3` |
| Compiled runtime | same asar `dsh/node_modules/@deepseek-ai/*/lib/*.js` | **no `.d.ts` ships in Desktop** — only `lib/*.js` |
| **Type catalog** | `…/dsh-tool-cordis/lib/types/api-catalog.js` (777 KB) | the public `.d.ts` text embedded as string literals: `grep -n "name: 'X'"` for the exact declaration of any exported type |
| Live contracts | `cordis_inspect_query` host `Service.listService` / `Event.listEvents` | authoritative for the running process |
| Reference implementation | github.com/deepseek-ai/dsh-superagent-prototype (MIT), built for `0.2.1-alpha.2` | `src/index.ts`, `src/app/{runtime,sessions,role-models}.ts`, `src/executor/dsh.ts`, `src/client/index.tsx`, `cordis.patch.yml`, `tsdown.config.ts` |
| In-runtime skill docs | `…/dsh-agent-preset/skills/cordis-plugin-development/references/*.md` + `templates/` | first-party instructions for third-party bundles |

Line numbers refer to the extracted copies in `research/vendor/dsh/node_modules/@deepseek-ai/`
(tools: `research/asar-ls.mjs`, `research/asar-extract.mjs` — read-only asar access).

---

## 1. Bundle and plugin mechanics

### 1.1 Manifest

```json
{ "name": "dsh-superagent", "type": "module", "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./locale/*.json": "./locale/*.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar"] },
           "manifestVersion": 1 },
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": "^0.2.2-rc.1" },
  "peerDependencies": { "@deepseek-ai/cordis": "4.1.0", "@deepseek-ai/dsh-tools": "0.2.2-rc.1" } }
```

`dsh.bundle` fields (`dsh-app-boot/lib/index.js`): `patch` = string **or string[]** of paths relative to the bundle
(`bundlePatchFiles()` throws `dsh.bundle.patch must be a file path or a list of file paths`); `platforms` = optional
non-empty Node platform list (`assertBundlePlatform()` → bundle skipped); `listedByDefault` = listing hint only.
A package without `dsh.bundle` is rejected: `profile bundle "<name>" declares no dsh.bundle in its package.json`.
Install only via `plugin_manager` `install_bundle` with the absolute package dir (it pnpms into
`$DSH_HOME/profiles/<p>/node_modules` and appends to `dsh.profile.bundles`; a directory install is *linked*).

### 1.2 `cordis.patch.yml`

Top-level YAML array. Row fields: `id`, `name`, `config`, `disabled`, `group: true`, `inject`, `intercept`,
`isolate`. `insert:` appends rows; a row with only `id` **overrides** an existing row and replaces its `config`
wholesale (never deep-merged).

```yaml
- insert:
    - id: dsh-superagent
      name: dsh-superagent
    - id: dsh-superagent-worker-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: dsh-superagent-worker, name: 执行器, order: 90,
                description: Dedicated to executor Sessions; not selectable by hand.,
                plugins: [{ id: tool-fs, name: '@deepseek-ai/dsh-tool-fs' }] }
```

- Groups: `name: cordis:group` + `group: true` with `config:` = nested row list (later patches may insert by id);
  `cordis:include` loads a YAML/JSON list from `config.path`.
- `disabled`: boolean/null/`!!js` expression on the Loader context (`!!js process.platform === 'win32'`);
  `isolate:` maps a service to `true` (per-entry realm) or a shared label.
- Presets are ordinary rows named `@deepseek-ai/dsh-agent-preset`
  (`dsh-agent-preset/lib/index.js`: `Config = z.object({ id, name, description, order, plugins })`,
  `static inject = ['agentPresets']`, `static [EntryGroup.key] = true`). The row `register()`s the definition.

### 1.3 Module export shape

`cordis-plugin-loader/lib/index.js:812` `unwrapExports()` = `exports.default ?? exports`, then again for `__esModule`.
So:

```js
export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'tools', 'systemPrompt', 'webServer']
export const Config = Schema.object({ stateDir: Schema.string().required() })
export async function apply(ctx, config) { /* ... */ }
```

- Also valid: `export default class X extends Service { static inject = […]; static Config = … }`.
- **Gotcha**: if the module has a `default` export *and* named `inject`/`Config`, the default wins and the named
  metadata is dropped. Use `static` on the class instead.
- `reusable` does **not** exist in Cordis 4.1.0 (v3 leftover); multi-instance comes from the Loader mounting the
  same module in several rows.
- `name` is optional metadata (`runtime.name`, loader logs).

### 1.4 Config schema: schemastery, not zod

```js
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({
  stateDir: Schema.string().required().description('Holds superagent.sqlite (absolute)'),
  maxWorkers: Schema.number().step(1).min(1).default(2).volatile(),
  paused: Schema.boolean().default(false).volatile(),
})
```

Resolved at **activation** (`fiber.resolveConfig()` → `internal/config` waterfall); an invalid `config` is a fiber
error (§1.5), not a crash. `.volatile()` fields are read via `config.field.get()` and update in place on change;
non-volatile changes dispose + re-apply. `static Config` on a `Service` class works the same.

### 1.5 What happens when `apply()` throws (verified in code)

1. `cordis/lib/index.js` `Fiber._reload()` catches: `this.ctx.logger.error(reason)`, sets `_error`,
   `epoch = INACTIVE`, state → `3` (error). Not re-thrown.
2. An **import** failure is caught in the loader entry (`_init()`): `ctx.logger.error(error); return` — no fiber.
3. End of boot, `auditStartupEntries()` (`dsh-app-boot/lib/index.js:5216`): required entries (bootstrap include /
   launcher-required ids) → throws `StartupError` (host fails to start); **everyone else → stderr warning only**,
   boot continues.

So a third-party `apply()` throw is isolated and the host keeps running — but our features are simply absent.
Diagnose with stderr and `plugin_manager list_plugins` → `fiberPhase`.

### 1.6 Context, services, disposal

- `ctx.tools` requires `inject`; `ctx.get('tools')` returns `T | undefined` with no requirement (soft deps:
  `settings`, `agentPresets`, `configEditor`).
- `ctx.inject(deps, cb)` runs `cb(childCtx)` when all deps are available; returns a disposable.
- Fiber-scoped disposal happens only through cordis primitives: `ctx.effect`, `ctx.on`, `ctx.inject`, service and
  tool/prompt registrations (each returns the effect disposer). Wrap anything else:

```js
ctx.effect(() => { const t = setInterval(tick, 30_000); t.unref?.(); return () => clearInterval(t) })
```

- `ctx.effect()` accepts a cleanup fn, a promise, a **generator** (yield disposers, torn down in reverse), or an
  async generator (living effect). Use the generator form when teardown order matters:

```js
ctx.effect(function* () { const handle = yield ctx.agents.create({ sessionId }); yield () => handle.dispose() })
```

- `ctx.fiber.entry` = the loader row, `ctx.fiber.restart()` re-applies, `ctx.fiber.await()` re-throws startup errors,
  `ctx.fiber.state`: 0 pending, 1 loading, 2 active, 3 error, 4 disposed, 5 unloading.

---

## 2. Sessions and agents

### 2.1 Two layers

| Layer | Service | Use |
|---|---|---|
| Session API (resumes cold sessions, owns presets/models/titles) | `ctx.sessionController` (`@deepseek-ai/dsh-api-session-controller`) | create-or-resume Router/Worker by id |
| Agent factory | `ctx.agents` (`dsh-agent`), `ctx.agentLoop` (`dsh-agent-loop`) | `setup(agentCtx, agent)`, `parentAgent`, seeds, `cancel()` |

`ctx.agents`: `create/resume(options)`, `get(id)`, `list()`, `roots()`, `isOwnedBy`, `register(agent)`,
`turnBoundaryOf(session)`, `withInitiator/currentInitiator`. `ctx.agentLoop`: `createAgent(ownerCtx, opts)`,
`resume(ownerCtx, opts)` (and legacy `create(id, opts, { cwd })`).

```ts
interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly parentAgent?: Agent                 // runtime ownership, not durable lineage
  readonly meta?: { cwd?: string; parentSession?: SessionId; isSeeded?: boolean;
                    origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }
  readonly inheritedEventCount?: SessionLogOffset
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions         // { provider?, model?, reasoningEffort?, maxTokens? }
  readonly signal?: AbortSignal
  readonly setup?: (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
}
interface ResumeAgentOptions { readonly resumeSessionId: SessionId; parentAgent?; agentOptions?; signal?; setup? }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
```

### 2.2 The live `Agent`

The **published** interface is minimal (`api-catalog.js:5417`): `interface Agent { readonly id: SessionId }`.
The runtime object is `ReactLoopAgent` (`dsh-agent-loop/lib/index.js:510`), surface merged in by that package's
module augmentation (add `import type {} from '@deepseek-ai/dsh-agent-loop'` if TS only sees the base package):

```ts
agent.id; agent.session; agent.ctx; agent.status            // 'idle' | 'running'
agent.model      // { current(), select(selection) }
agent.inbox      // { nextStep, nextTurn, remove(id), clear(), hasPending }
agent.send(msg, 'next-turn' | 'next-step', wakeup: boolean)
agent.followup(msg)  // next turn + wake
agent.steer(msg)     // next step + wake
agent.inject(msg)    // next step, no wake
agent.cancel({ kind: 'user' | 'parent' | 'hook' | 'disposed' }, { keepInbox?: boolean })
agent.whenIdle(): Promise<void>
agent.runMaintenance(job)   // throws if the agent already has active work
```

Messages come from `@deepseek-ai/dsh-llm`:

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
```

### 2.3 Create-or-resume (canonical, `src/app/sessions.ts`)

```ts
async function ensure(id: SessionId, cwd: string, preset: string): Promise<Agent> {
  let r = await ctx.sessionController.resolveAgent(id)        // { agent } | { error: RemoteError }
  if ('error' in r && r.error.code === 'session/not-found') {
    await ctx.sessionController.create({ sessionId: id, cwd, agentPreset: preset })
    r = await ctx.sessionController.resolveAgent(id)
  }
  if ('error' in r) throw r.error
  return r.agent
}
```

`SessionCreateRequest = { workspaceId? , cwd?, sessionId?, agentPreset? }` (workspace xor cwd);
`resolveAgent` errors: `session/not-found | session/agent-busy | session/writer-held | gateway/internal`.
Mint ids with `SessionId(string)` (`@deepseek-ai/dsh-session`); the prototype uses deterministic `worker-<ticketId>`
so session → ticket is a string derivation. Rename: `ctx.sessionController.rename({ sessionId, title })`.

### 2.4 Preset, cwd, model per Worker

- **Declared** as `@deepseek-ai/dsh-agent-preset` rows in the bundle patch (§1.2).
- **Selected** at creation (`meta.agentPreset` / `sessionController.create({ agentPreset })`) → lands in
  `SessionHeader.agentPreset` + durable `agent-preset/selected`.
- **Mounted** (composition applied) by the registry: `await ctx.agentPresets.mount(agentCtx, presetId)`
  (`dsh-agent-preset-registry/lib/index.js:702`). `sessionController.create()` does it; a raw `ctx.agents.create()`
  with `setup` must do it itself:

```ts
await ctx.agents.create({
  sessionId: workerId, meta: { cwd, agentPreset: 'dsh-superagent-worker' },
  setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'dsh-superagent-worker') },
})
```
- Read back: `ctx.agentPresets.presetForSession(session)`, `composedPreset(agent.ctx)`,
  `serviceFor(agent, name)` (services the preset isolates). Change later: `agentPresets.select(agent, id)` —
  **throws `agent-preset/locked` after the first turn**, so presets must be right at creation.
- Model, best first: `agentOptions: { provider, model, reasoningEffort }` at creation (fallback route,
  `AgentModel.current()`); `agent.model.select({ provider, model })` (durable `model/selection`, survives resume);
  `ctx.sessionController.selectModel(...)` **also rewrites the global default** — avoid inside a plugin.
  Resolve a route first when adapter defaults matter: `await ctx.llm.resolveCallConfig({ provider, model })`.

### 2.5 Events and stop

```ts
ctx.on('agent/created', async ({ agent, source }) => { /* decorate before the first turn */ })
ctx.on('agent/disposed', ({ agent }) => release(agent))
ctx.on('agent/status', ({ agent, status }) => {})
ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {})
ctx.on('agent/error', ({ agent, turn, step, error }) => {})
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {})   // serial, awaited
ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end') { /* event.data.reason: completed|aborted|error|blocked|max-tokens|interrupted|forked */ }
  if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'user/message') {}
})
```

There is **no `agent/turn-end`**: turn end is `session/event` with `type === 'turn/end'`, or `await agent.whenIdle()`.
Stop: `agent.cancel({ kind: 'user' }, { keepInbox: true })` then `await agent.whenIdle()` (the only safe point to
dispose or re-prompt); `keepInbox` preserves queued messages for a later resume.

---

## 3. Tools

### 3.1 Registry (`dsh-tools/lib/index.js:415`, types `api-catalog.js:9482`)

```ts
register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void

interface ToolDefinition extends ToolSchema {           // ToolSchema = { name, description, parameters: Record<string, unknown>, deferLoading? }
  readonly output: ToolOutputDefinition                 // { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }
interface ToolExecutionInput { callId; rootCallId?; name; schema?; arguments: unknown
                               agent?: Agent; toolSet?: ResolvedToolSet; parent?; signal: AbortSignal }
interface ToolExecution extends ToolExecutionInput { readonly rootCallId: ToolCallId; readonly token: ToolExecutionToken }
interface ToolRegistrationOptions { readonly when?: (c: ToolActivationContext) => boolean | Promise<boolean> }
interface ToolActivationContext { readonly agent: Agent; readonly modelSelection: Readonly<ModelSelection>; readonly signal: AbortSignal }
```

`register` validates the whole definition up front and throws `TypeError` without `output { schema, render }`;
`run_code` is reserved (PTC) and refused. `defineTool()` (exported) converts a schema-spec DSL
(`{ type, description, required, items, properties, enum }`) to JSON Schema and validates args before `execute`:

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name: 'superagent_ticket',
  description: 'Queue a ticket for a worker session.',
  parameters: { title: { type: 'string', required: true, description: 'One line' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { ticketId: { type: 'string', required: true } } },
            render: (_a, v) => [{ type: 'text', text: `Ticket ${v.ticketId} queued` }] },
  async execute(args, exec) {
    if (!exec.agent) throw new Error('requires an owning session')
    return { ticketId: createTicket(args.title, exec.agent.id) }
  },
}))
```

### 3.2 Which session is calling

`exec` carries `agent?: Agent` (plus `callId`, `rootCallId`, `name`, `arguments`, `signal`, `toolSet`, `parent`,
`schema`, and `ToolRunContext`'s `deferContext`/`concludeTurn`). Read `exec.agent?.session` / `exec.agent.id` and
throw when absent; never infer the caller from ambient state.

### 3.3 Scoping a tool to one agent/session

| Goal | Mechanism |
|---|---|
| Tool exists only for one agent (+ its subagents) | register through `agent.ctx.tools.register(...)` in `setup(agentCtx)` or an `agent/created` listener — `ScopedLayers` keyed by scope, own layer exempt from restrictions |
| Remove inherited tools | `agent.ctx.tools.restrict({ allow: [...] })` / `{ deny: [...] }` — throws on unknown names, empty filters, and outside a scoped context |
| Block dynamically | `agent.ctx.tools.guard(exec => string | undefined)` — the string is the refusal |
| Per-step availability | `register(def, { when: ({ agent, modelSelection, signal }) => … })` |

Duplicates within one layer throw; a scoped registration shadows a global one; `restrict()` on a non-scoped context
throws `tools.restrict() requires a scoped context (agent.ctx)`.

---

## 4. System prompt

```ts
section(section: PromptSection): () => void
context(context: PromptContext): () => void
variable(name: string, provider: (c: AssembleContext) => string | undefined): () => void
tools(provider: (c: AssembleContext) => ToolProviderResult): () => void
suppressRuntimeContext(): () => void
getSectionOrder(name: PromptSectionOrderName): number
getContextOrder(name: PromptContextOrderName): number

// api-catalog.js:7609 / :7589 — exact
interface PromptSection { readonly name: string; readonly order: number
                          readonly text: string | ((context: AssembleContext) => string)   // '' drops it
                          readonly interpolate?: boolean; readonly complete?: boolean }
interface PromptContext { readonly name: string; readonly order: number
                          readonly text: string | ((context: AssembleContext) => string)
                          readonly interpolate?: boolean; readonly required?: boolean }
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }   // at runtime also `agent` (assembleContextFor(agent, signal)) and `toolSet`
```

- Sections render into the system prompt, contexts into the per-request runtime context; both ordered by `order`.
- Use the central orders, not magic numbers: sections `HARNESS_IDENTITY` −1000, `DEPLOYMENT_PERSONA_PREFIX` 0,
  `PLAN_POLICY` 500, `TEAM_POLICY` 600, `PTC_ONLY` 800, `TOOL_*` 1000–3000, `MCP_SERVERS` 3100, `STRUCTURED_OUTPUT` 9900,
  `DEPLOYMENT_PERSONA_SUFFIX` 10200; contexts `WORKING_DIRECTORY` 100, `SANDBOX_POLICY` 110, `APPROVAL_POLICY` 115,
  `SUBAGENT_DELEGATION` 120, `TEAM_IDENTITY` 125, `HARNESS_SOURCE` 200, `WEB_SURFACE` 210.
- `{{variable}}` interpolation is strict (unknown/undefined → throws at assembly); set `interpolate: false` when text
  contains `${{ … }}` (the prototype does, its prompts are templates).
- Duplicate names **within one layer** throw with a hint to use `agent.ctx`.

Append a role prompt without disturbing existing sessions — decorate the agent scope, never the global one:

```ts
ctx.on('agent/created', ({ agent }) => {
  agent.ctx.effect(() => agent.ctx.systemPrompt.section({
    name: 'superagent:worker-role',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    interpolate: false,
    text: () => composeRolePrompt(agent),
  }))
})
```

Assembly runs **every model step**, so a new section appears on the next request with no history rewrite; a `text`
function is re-evaluated per assembly; disposing removes it; undecorated sessions are untouched because scoped
sections only contribute in their own scope. `complete: true` means "this section is the whole prompt" — use only
when truly replacing it. Related: `system-prompt/change`, `system-prompt/assemble` (waterfall used by
`role-models.ts` to inject `{{model}}`/`{{provider}}`).

---

## 5. Web / HTTP and the client panel

### 5.1 `ctx.webServer.register` (`dsh-host-webserver/lib/index.js:374`, types `api-catalog.js:9905`)

```ts
register(route: WebRoute | WebResourceRoute): () => void
registerUpgrade(route: { path: string; handler(req, socket: Duplex, head: Buffer): void | Promise<void> }): () => void
registerFallback(fallback: WebRoute['handler'] | Pick<WebResourceRoute, 'resource'>): () => void   // one owner

type WebRouteKind = 'exact' | 'prefix'
interface WebRoute { kind: WebRouteKind; path: string
                     handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }  // node:http
type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>
interface WebResourceRoute { kind: WebRouteKind; path: string; resource: WebResource }
```

- `exact` = `Map.get(pathname)`; else **longest** prefix where `pathname === prefix || startsWith(prefix + '/')`;
  no match → 404 (the SPA owner holds the fallback). Duplicate `(kind, path)` **throws**. No `method` field.
- `handler` sees every method and reads the node stream (bodies are never buffered for you).
- `resource` is reached **only for GET/HEAD** (otherwise `405` + `Allow: GET, HEAD` before your code) and is called
  `resource(request)` with **no peer**; `PeerScope` arrives only via in-process `readResource(request, peer)`.
  **A JSON POST API must therefore be a `handler`.**
- `getOrigin()` → `http://127.0.0.1:<port>`; only a concrete local bind address is allowed (wildcard throws).
- Always `ctx.effect(() => ctx.webServer.register(route))` — `register` returns the disposer.

**Nothing gates plugin routes.** Host/Origin fence, `sec-fetch-site`, CSRF (`Origin` == `Host`) and the `dsh-auth-*`
cookie (HttpOnly, SameSite=Strict, `Path=/`) live in `dsh-client-connection` and protect only its `/api` route.
One-call gate for your route — always use it:

```ts
const rejection = ctx.connection.requestRejection(req)   // 403 (untrusted Host / cross-site / bad Origin) | 401 | undefined
```

(If you cannot depend on `connection` being mounted, use `ctx.get('connection')?.requestRejection(req) ?? 403` so a
profile without the Web carrier fails closed instead of exposing the route.)

```ts
export const inject = ['webServer', 'connection']
ctx.effect(() => ctx.webServer.register({
  kind: 'exact', path: '/superagent/tickets',
  handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      res.writeHead(415); res.end(); return
    }
    const chunks: Buffer[] = []; let size = 0                    // bound the body yourself
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > 1_000_000) { req.resume(); res.writeHead(413); res.end(); return }
      chunks.push(chunk as Buffer)
    }
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(await handle(body)))
  },
}), 'superagent: POST /superagent/tickets')
```

Read-only, public, no auth possible: `{ kind: 'prefix', path: '/superagent/health',
resource: async () => Response.json({ ok: true }) }`. The page may `fetch('/superagent/tickets', …)` same-origin; the
cookie rides along, and no CORS configuration exists.

### 5.2 `dsh.client` manifest (`dsh-client-modules/lib/index.js:86`)

```json
{ "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "client": { "platform": "web", "immediately": true,
                       "inject": ["@deepseek-ai/dsh-client-ui-sidebar"],
                       "external": ["@deepseek-ai/dsh-client-ui-primitives"] } } }
```

- Exactly **four** accepted keys (unknown ones silently dropped): `platform` (only `"web"` is served), `immediately`
  (**prefetch tier only**, not ordering), `inject` (bundles that must arrive first; a failure cascades by name),
  `external` (runtime `require` targets → module-graph edges, cycle-checked).
- `exports["./client"]` is **mandatory**; a missing file raises `MissingClientBundleError` (“run `pnpm run build`”).
- Discovery iterates **live Loader entries** — the Host row must exist (an empty `apply(){}` suffices). Served as
  `/plugins/?<pkg>/client.js&rev=<12 hex>` by the `{kind:'prefix', path:'/plugins'}` resource route.
- Baseline modules (do not list in `external`): `react`, `react/jsx-runtime`, `react-dom(/client)`,
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`, `dsh-client-ui-{slots,primitives,dockkit}`.

### 5.3 Minimal client module

A **classic script** (no `type="module"`, so no ESM import/export):

```js
window.__ModuleLoader__.load({
  id: 'dsh-superagent',                      // === package name, exactly
  factory(require) {
    const React = require('react'); const h = React.createElement
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dshSuperagent',
          { en: { panel: 'Superagent' }, zh: { panel: 'Superagent' } }))
        const t = ctx.locale.bind('dshSuperagent')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-superagent', order: 10, label: () => t('panel'), locale: 'dshSuperagent' },
          function Icon({ size }) { return h('svg', { width: size, height: size, viewBox: '0 0 24 24' }) }))
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'dsh-superagent', locale: 'dshSuperagent' },
          function Panel() { return h('div', null, 'Superagent') }))
      },
    }
  },
})
```

- Build: any browser bundler emitting CJS-in-a-closure. Reference `tsdown.config.ts`: `format: 'cjs'`,
  `platform: 'browser'`, externals `react`, `react/jsx-runtime`, `react-dom`,
  `banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {'`,
  `footer: 'return module.exports; } });'`. No DSH tooling required.
- Slot keys (from shipped client bundles; live `Slots.listSubTree` needs an attached page): `main` (**keyed**, root
  panel — the launcher calls `ctx.layout.selectPanel(id)` and throws unless a `main` entry has that key),
  `sidebar.panellist` (root list entry), `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` (keyed,
  per-session, paired with `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title })`),
  `shell.overlay`, `conversation.composer.dock`, `plugins.row.config`.
- Registration options: `{ name, key?, id?, order?, label?, priority?, select?, inject?, children?, store?, locale? }`,
  second argument the React component; always wrapped in `ctx.slots.inject(slot, …)` (undeclared slot throws).
- Client `inject` names in first-party code: `slots`, `locale`, `sessions` (Remote `ISessions` from
  `@deepseek-ai/dsh-api-session-controller/client`), `uiWorkspace`, optional `configForms`.
- Data path: `ctx.remote.<ns>.<method>()` (typed RPC, the only transport carrying a `PeerScope`) or same-origin
  `fetch()` to your own route (no peer — gate it yourself).
- Factories stay side-effect free; register styles/timers/listeners in `apply` via `ctx.effect`/`ctx.on`; never mount
  a second app on `document.body`.
- A panel costs a client build, slot props and locale. The Host-only fallback: automatic Settings page (§7.4) + a
  route serving a small HTML page.

---

## 6. Version and compatibility

### 6.1 Reading the running version

`dsh-app-boot` exports the authoritative accessor (it reads **its own** runtime `package.json`):

```js
import { getDshRuntimeVersion, evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
const running = getDshRuntimeVersion()               // '0.2.2-rc.1'
evaluatePluginCompatibility(myManifest, {}, running) // undefined | { name, version, runtimeVersion, requirements, exempted }
```

Call it **inside `apply()`**, not at module top level (§8.1). Fallbacks: `ctx.get('profileContext')` =
`{ name, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays }` → the runtime manifest is
`<dir>/node_modules/@deepseek-ai/dsh/package.json`; `ctx.typert.listPackages()` also reports package records.

### 6.2 Three enforcement gates (all `dsh-app-boot`)

1. **Bundle load** — `loadProfileDirectory()`: unmet requirement → throw `pluginCompatibilityWarning(issue)`, bundle
   pushed to `skippedBundles`, launcher prints `dsh: skipping profile bundle "<name>": …`, nothing is imported.
2. **Row preflight** — `prepareProfileEntries()`/`preflight()`: every composed row with unmet requirements gets
   `disabled: true` and stderr gets
   `dsh: disabling profile plugin row "<id>": Plugin <name>@<ver> is incompatible with dsh <ver>: …`.
   A `cordis:include` reaching a denied plugin is denied whole.
3. **Install/update** — `plugin-manager` evaluates the same way and refuses; the only override is an exact-version
   exemption in `<profile>/compatibility.json` (`{ "<name>@<version>": ["0.2.2-rc.1"] }`), granted by
   `dsh plugin allow-version` or the manager UI.

Semantics: an own `engines.dsh` decides **alone** (peers ignored); otherwise **every** `@deepseek-ai/dsh*` peer must
match. Prereleases participate (`includePrerelease: true`), so `^0.2.2-rc.1` does not cover `0.3.0` — intended.

### 6.3 What throws, and the defensive gate

With `engines.dsh` declared, **nothing of ours runs** on a mismatched runtime (gate 1/2 deny before import) — there
is no exception to catch, only the stderr line and a `disabled` row. Without a gate, our code loads and fails later
(`ctx.tools.register is not a function`, `Cannot read properties of undefined (reading 'section')`) into the fiber
error path: logged, non-fatal, features silently gone. Make even that case harmless:

```js
export async function apply(ctx, config) {
  const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
  const semver = await import('semver')
  const running = getDshRuntimeVersion()
  if (!semver.satisfies(running, '>=0.2.2-rc.1 <0.3.0', { includePrerelease: true })) {
    ctx.logger.warn('dsh-superagent: unsupported dsh %s — staying inert', running)
    return
  }
  /* … */
}
```

---

## 7. Persistence and state

### 7.1 What the host provides

| Service | Key | Verdict |
|---|---|---|
| `ctx.storage` | `storage` | hub only: `mount(form, facility)`, `form(form)` (throws `form-not-mounted`), `get domain()`, `backend: BackendRegistry`. `StorageForms` is an **empty interface**; `json` is a *backend* (`storageBackendServiceKey('json') === 'storage.backend.json'`), not a form |
| `ctx.storageDomain` | `storageDomain` | **recommended store**: `open(spec)`, `get(name)`, `closeAll()`. Profile-global, zod-validated, atomic, serialized |
| `ctx.settings` | `settings` | namespace **is the Loader entry id**; no registration API. A page appears automatically for `.volatile()` Config fields. `describe()`, `configure({auto:false}, fiber)`, `update/replace/mutate(ns, …, expectedRevision)`, event `settings/document-updated` |
| `ctx.profileContext` | boot-provided | `{ dir, home, patchPath, installAnchor, … }` — where our own directory may live |
| `dshHomePath` | boot-provided | `ctx.dshHomePath(...segments)`; prefer `resolveDshHome()` from `@deepseek-ai/dsh-home-paths` |

### 7.2 `storageDomain` (exact, `dsh-storage-domain/lib/index.js`)

```ts
interface DomainSpec {                                   // version REQUIRED; `initial` lives under `global`
  name: string                                           // /^[a-z][a-z0-9_]*$/, one open per name
  version: number; layout?: 'single' | 'per-record'; compatibleVersions?: number[]
  invalidRecords?: 'backup-and-skip'
  global?: { schema: ZodType<G>; initial: G }
  tables: Record<string, { valueSchema: ZodType<V> }>    // built with domainTable(zodSchema)
}
interface Domain<S> { name; global: { get(): G; set(v: G): Promise<void> }; table(n): KvTable; close(): Promise<void> }
interface KvTable<K, V> { get(key): V | undefined; entries(); keys(); readonly size   // synchronous, in-memory
                          put(key, value): Promise<void>                             // upsert
                          update(key, fn): Promise<V>                                // 'missing-key' — no upsert
                          delete(key): Promise<boolean>; deleteMany(keys): Promise<number> }
```

Writes serialize per domain, persist first, then mutate memory, then emit `domain/changed`. **The caller owns
`close()`** — a domain left open blocks reopening after a restart.

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
const tickets = defineDomain({
  name: 'superagent_tickets', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
  global: { schema: z.object({ lastId: z.number() }), initial: { lastId: 0 } },
  tables: { tickets: domainTable(z.object({ id: z.string(), state: z.enum(['open', 'done']) })) },
})
export const inject = ['storageDomain']
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(tickets)
  ctx.effect(() => () => domain.close(), 'superagent.ticketDomain')
  await domain.table('tickets').put('t-1', { id: 't-1', state: 'open' })
}
```

On disk (backend `dsh-storage-json`, root `!!js dshHomePath('storages')` = `~/.dsh/storages`): `<name>.json` for
`single`, `<name>/<table>/<key>.json` for `per-record` (key `/^[a-zA-Z0-9_-]+$/`). Prefer `per-record` when it grows.

### 7.3 Escape hatch: plugin-owned SQLite

First-party code uses **`node:sqlite`** (`DatabaseSync`), never `better-sqlite3`; no native build step. Bundled Node
is 24.21, so no flag:

```ts
const { DatabaseSync } = await import('node:sqlite')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(dir, 'superagent.db'))
db.exec('PRAGMA journal_mode = WAL')
```

Copy the guards: `PRAGMA application_id` + `user_version` (reject foreign files), `0o600`/`0o700`, one
`proper-lockfile` lock on the state dir (the prototype locks `stateDir` before opening `orchestrator.sqlite`,
`onCompromised` aborting all work). Convention: `<resolveDshHome()>/<plugin-id>/` — the prototype takes a required
`stateDir` Config supplied by the profile. Never write into `~/.dsh/storages` or `~/.dsh/sessions`.

### 7.4 User knobs

`.volatile()` Config fields give a Settings page for free, namespaced by the row `id` (renaming the row orphans
user values — pick once). Secrets: `Schema.string().role('secret').volatile()`, or `ctx.credentials.modifyRecord()`
for real credentials.

---

## 8. Gotchas for a bundle that must never break host boot

1. **Top-level imports are unguarded** — a failing module-level import kills the whole plugin load. Keep optional
   imports (`@deepseek-ai/dsh-app-boot`, client packages, `proper-lockfile`, `node:sqlite`) inside `apply()` via
   `await import(...)`.
2. **Bare imports resolve from the Loader base URL** (`loader.internal.import(name, ctx.baseUrl)` — the profile's
   module graph), not your package dir. Keep third-party runtime deps to what `plugin_manager` installs; declare
   `@deepseek-ai/*` as `peerDependencies`; prefer `ctx.get(...)` over importing services.
3. **Async `apply()` rejection = inert fiber**, not a crash — never `await` unbounded work (network, model call,
   another agent's turn) in `apply`; run it in a `ctx.effect(() => async () => …)` you own and log failures.
4. **Unhandled rejections are fatal**: `installFailLoud()` (`dsh-app-boot/lib/index.js:4963`) exits `1` on any
   uncaught exception/unhandled rejection. Every floating promise needs `.catch()`; `timer.unref?.()` for timers.
5. **Own every resource through `ctx.effect`** (timers, sockets, watchers, child processes, abort controllers);
   `cancel()` agents you started and `await whenIdle()` before disposing. A *hanging* disposer stalls restart.
6. **Never write the profile** (`package.json`, `cordis.patch.yml`, `compatibility.json`). Self-configure via
   `ctx.get('configEditor').edit(ctx.fiber.entry, current => …)`; `.volatile()` fields update in place, others restart.
7. **Treat optional services as optional**: `agentPresets`, `settings`, `configEditor`, `skills` may be absent on a
   lean profile — check `ctx.get()` and degrade.
8. **Do not block critical-path events**: `agent/created`, `agent/pre-step`, `agent/turn-stopping`,
   `tools/pre-execute` are serial/awaited per turn. Keep handlers short and non-awaiting.
9. **Restart-safe `apply()`**: it runs again after config change / in-process restart while child agents may still be
   live (`ctx.agents.get(id)`) and a stale SQLite lock can fail the second run. Lock the state dir, be idempotent.
10. **`ctx.fiber.state === 3`** (exposed as `fiberPhase` in `plugin_manager list_plugins`) is the first thing to check
    when a row is silent.

---

## 9. Recommended plugin skeleton (TypeScript)

```
dsh-superagent/
  package.json  cordis.patch.yml  tsdown.config.ts  locale/{en,zh}.json  icon.svg
  src/index.ts            # Loader entry: name/inject/Config/apply
  src/app/runtime.ts      # Service('orchestrator'): lifecycle, store, loops
  src/app/sessions.ts     # ensure()/decorate()/prompt() helpers
  src/client/index.tsx    # optional panel
```

`src/index.ts` — the only thing the Loader imports:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-loop'      // augments Agent with session/ctx/cancel/whenIdle
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { Runtime } from './app/runtime.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'tools', 'systemPrompt', 'webServer']

export const Config = Schema.object({
  stateDir: Schema.string().required().description('Directory holding superagent.sqlite (absolute)'),
  maxWorkers: Schema.number().step(1).min(1).default(2).volatile(),
  paused: Schema.boolean().default(false).volatile(),
})

export async function apply(ctx: Context, config): Promise<void> {
  const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
  const semver = await import('semver')
  const running = getDshRuntimeVersion()
  if (!semver.satisfies(running, '>=0.2.2-rc.1 <0.3.0', { includePrerelease: true })) {
    ctx.logger.warn('dsh-superagent: unsupported dsh %s — inert', running); return
  }
  // We ship our own panel, so disable the auto-generated Settings page for this entry.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  const runtime = new Runtime(ctx, config)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready                    // never rejects: Runtime logs and stays inert
  ctx.logger.info('dsh-superagent ready')
}
```

`src/app/runtime.ts` — ownership, and a teardown that always runs:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export class Runtime extends Service {
  readonly ready: Promise<void>
  private readonly stopped = new AbortController()
  constructor(ctx: Context, readonly config: { stateDir: string }) {
    super(ctx, 'orchestrator')                       // later rows read ctx.orchestrator
    this.ready = this.start().catch(error =>            // never rejects: apply() must not throw
      ctx.logger.error('dsh-superagent start failed: %s', String(error)))
  }
  get lifetime(): AbortSignal { return this.stopped.signal }
  private async start(): Promise<void> {
    // mkdir+lock stateDir · open store · ensure() the Router session · install event listeners
    // · register routes · await readiness of whatever the first turn needs
  }
  async stop(): Promise<void> {
    this.stopped.abort()
    const ours = this.ctx.agents.list().filter(isOurs)
    for (const agent of ours) agent.cancel({ kind: 'user' }, { keepInbox: true })
    await Promise.allSettled(ours.map(agent => agent.whenIdle()))
    // then dispose per-agent registrations, close the store, release the directory lock
  }
}
```

Wiring is the code already shown: `ensure()` for create-or-resume (§2.3), on `agent/created` the three scoped
registrations `agent.ctx.systemPrompt.section` / `agent.ctx.tools.register` / `agent.ctx.tools.restrict` (§3.3, §4),
and the gated management route (§5.1). `cordis.patch.yml` holds one plugin row plus one
`@deepseek-ai/dsh-agent-preset` row per preset (§1.2). Keep `stateDir` **out** of the bundle patch — the profile
supplies it (`- id: dsh-superagent` / `config: { stateDir: /… }`), so a fresh profile boots with the row alive and the
user configures it in Settings.

## 10. Open questions and risky assumptions

1. **No `.d.ts` in the Desktop asar.** Signatures here were reconstructed from compiled JS + JSDoc + live Inspect +
   the embedded `api-catalog.js` + the public prototype (built for `0.2.1-alpha.2`). Install
   `@deepseek-ai/dsh-*@0.2.2-rc.1` types and typecheck before writing production code.
2. **Client slot ids are source-derived, not live-verified** (`Slots.listSubTree` timed out without an attached page).
   Slot *props* in particular are unverified.
3. **`Agent` is augmented out-of-band** — `dsh-agent` publishes `{ id }` only; the rest comes from
   `@deepseek-ai/dsh-agent-loop` augmentation. A missing `import type {} from '…/dsh-agent-loop'` makes correct code
   fail to compile.
4. **`ModelSelection` is not exported as a standalone type** in the catalog; treat it as
   `{ provider: string; model: string; reasoningEffort?: ReasoningEffortId }`.
5. **`requestBody` modes other than `'buffered'`** (for `ctx.connection.fetch.register`) are not exercised in shipped
   code — unverified; use raw `webServer` handlers for POSTs (also because resources are GET/HEAD only).
6. **Preset drift**: `agentPresets.select()` refuses after the first turn (`agent-preset/locked`); the reference
   implementation re-selects on `agent-preset/selected` because the Web UI may silently choose a default preset for a
   fresh session. Assume this race and handle the event.
7. **Bundle upgrade**: a linked directory install is re-read on restart, but *replacing* an installed package needs a
   dsh restart to load a fresh module generation (HMR cannot swap it). Plan a "restart to update" UX.
8. **`engines.dsh` trade-off**: tight range ⇒ silently skipped on the next DSH upgrade (safe, dead); loose ⇒ loads and
   may break. Recommended: tight range + the inert `semver.satisfies` guard in `apply()` (§6.3).
9. **`storageDomain` is profile-global**, not per-session: model per-session state as a table keyed by session id.
   No `sqlite` storage *form* exists; `dsh-session-query-sqlite` is not a storage backend.
10. **Live-agent cost**: each Worker is a Cordis fiber tree with its own preset composition. Cap concurrency in config
    and `dispose()` / `cancel()` handles you no longer need; dozens of idle workers are not free.
