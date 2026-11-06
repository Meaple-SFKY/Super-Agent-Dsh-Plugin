# DSH 0.2.2-rc.1 — compiled type verification

Follow-up to `docs/dsh-api-notes.md`. That document was written against the Desktop asar, which ships **no `.d.ts`**.
The project now has the real `0.2.2-rc.1` packages in `node_modules`, so every API below was checked by **compiling**,
not by inference. Where the two documents disagree, this one wins.

## 0. How this was verified (reproducible)

```sh
# 1. repo-wide check with the probe in tests/fixtures/ (tsconfig includes tests/)
./scripts/pnpmw typecheck

# 2. isolated check of just the probe, same strict flags, no project noise
./scripts/pnpmw exec tsc --ignoreConfig --noEmit --strict --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --lib es2023,dom --types node research/typecheck-probe.ts
```

Results at time of writing:

- The full probe (`research/typecheck-probe.ts`, 143 lines) compiles with **0 errors** in both checks.
- Repo-wide `tsc` was red at verification time, but **never because of the probe** (2 errors when first checked,
  more later as `src/` and `tests/` were being edited concurrently — e.g. `src/app/runtime.ts:308 Cannot find name
  'Store'`, `tests/runtime-host.ts Agent is not assignable to FakeAgent`). Treat repo-wide `typecheck` as a moving
  target while the implementation lands: judge this document by the **isolated** command above, which only includes
  `research/typecheck-probe.ts`.
- **Negative controls** (7 deliberately wrong lines) all failed with precise messages, which proves the types are
  resolved rather than silently `any` — see §4.

Installed packages: `@deepseek-ai/{cordis@4.1.0, dsh-agent, dsh-agent-loop, dsh-agent-preset,
dsh-api-session-controller, dsh-app-boot, dsh-host-webserver, dsh-llm, dsh-scope, dsh-session,
dsh-session-persistence, dsh-settings, dsh-subprocess, dsh-system-prompt, dsh-tools}@0.2.2-rc.1, schemastery@3.19.0`.

## 1. Verdict table

| API | Import that must be in the program | Status |
|---|---|---|
| `ctx.sessionController.*` | `import type {} from '@deepseek-ai/dsh-api-session-controller'` | typed ✅ |
| `ctx.agents.*`, `Agent.*` (session/ctx/steer/…), `createUserMessage` | `import type { Agent } from '@deepseek-ai/dsh-agent'` | typed ✅ |
| `Agent` from `@deepseek-ai/dsh-agent/types` | — | **bare `{ id }` only** ❌ (see §5.1) |
| `ctx.tools.*`, `defineTool`, `ToolDefinition` | `import type {} from '@deepseek-ai/dsh-tools'` | typed ✅, args inferred |
| `ctx.systemPrompt.*`, `PromptSection` | `import type {} from '@deepseek-ai/dsh-system-prompt'` | typed ✅, order names checked |
| `ctx.webServer.*`, `WebRoute` | `import type {} from '@deepseek-ai/dsh-host-webserver'` | typed ✅ |
| `ctx.settings.*` | `import type {} from '@deepseek-ai/dsh-settings'` | typed ✅ |
| `ctx.sessionPersistence.*`, `ctx.llm.resolveCallConfig` | same package imports | typed ✅ |
| `ctx.agentPresets.*` | `import type {} from '@deepseek-ai/dsh-agent-preset'` | typed ✅ **via the preset package** (§5.2) |
| `ctx.skills.*` | `@deepseek-ai/dsh-skill` — **not installed** | `ctx.get('skills')` → `any` ⚠️ |
| `ctx.connection.requestRejection` | `@deepseek-ai/dsh-client-connection` — **not installed** | `ctx.get('connection')` → `any` ⚠️ |
| Client slots (`ctx.slots`, `dsh.client`) | client packages not installed | **unverified** ⚠️ (§6) |

Rule of thumb: a service appears on `Context` only if the package that declares it is imported **anywhere in the
program**. `ctx.get('name')` falls back to `any` (typed `undefined | any`), which compiles but proves nothing.

## 2. Exact types, per package

### 2.1 `@deepseek-ai/dsh-api-session-controller`

`lib/types/agent.d.ts`:

```ts
export type ApiSessionAgentError =
  RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>;
export type ApiSessionAgentResult = { readonly agent: Agent } | { readonly error: ApiSessionAgentError };
```

`lib/types/index.d.ts` — the service is `SessionController extends TypertRemoteService` (default export,
`Context.sessionController`):

```ts
resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult>
create(request: SessionCreateRequest): Promise<SessionCreateValue>
selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
rename(request: SessionRenameRequest): Promise<SessionRenameValue>
modelCatalog(): Promise<ModelCatalog>
cancel(request: SessionCancelRequest): SessionCancelValue
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
fork(request: SessionForkRequest): Promise<SessionForkValue>
```

`lib/types/types.d.ts:264`:

```ts
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId   // exclusive with cwd — enforced at RUNTIME (RemoteError gateway/bad-request), not by the type
  readonly cwd?: string
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}
export interface SessionCreateValue {
  readonly sessionId: SessionId        // may differ from the requested id (reuse!)
  readonly agentPreset?: string
}
```

Domain classes also exported for `instanceof`: `ApiSessionNotFound`, `ApiSessionSubagentOwnership`,
`ApiSessionCwdConflict`, `ApiSessionPresetConflict`.

### 2.2 `@deepseek-ai/dsh-agent`

`lib/types/types.d.ts:12` — the published face:

```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent { readonly id: SessionId }
```

`lib/types/runtime-types.d.ts:164` — the **same package** augments it (`declare module './types.ts'`):

```ts
readonly options: AgentOptions          // { provider?, model?, reasoningEffort?, maxTokens? }
readonly session: Session
readonly model: Model                   // { current(), select(selection) }
readonly inbox: Inbox                   // { nextStep, nextTurn, ... }
readonly status: AgentStatus            // 'idle' | 'running'
readonly ctx: Context                   // agent-scoped: tools/systemPrompt registrations belong here
cancel(cause: AgentCancelCause, options?: CancelOptions): void        // CancelOptions = { keepInbox?: boolean }
whenIdle(): Promise<void>
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
followup(message: UserMessage): void
steer(message: UserMessage): void
inject(message: UserMessage): void
```

Factory options (`CreateAgentOptions` / `ResumeAgentOptions` / `AgentHandle` / `AgentSetup`) verified by compiling
`research/isolated/agents-create.ts`:

```ts
ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions: { provider, model },
                    setup: async (agentCtx, agent) => ({ commit() {} }) })   // → Promise<AgentHandle>
ctx.agents.resume({ resumeSessionId: id })                                   // → Promise<AgentHandle>
handle.agent; handle.dispose()
```

`setup` may return `void`, a `Promise<void>`, or `AgentSetupCommit`; `ctx.agents.get(id): Agent | undefined`.

### 2.3 `@deepseek-ai/dsh-llm`

`lib/types/message.d.ts`:

```ts
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
    readonly id?: never; readonly role?: never
}): T & Pick<UserMessage, 'id' | 'role'>;

interface MessageBase { readonly id: MessageId; readonly content: readonly ContentBlock[]; readonly source: MessageSource }
export interface UserMessage extends MessageBase { readonly role: 'user' }
export type Message = MessageRoleMap[keyof MessageRoleMap]   // system | developer | user | assistant | tool
```

So `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })` produces a `UserMessage`
(identity minted internally; never pass `id`/`role`).

### 2.4 `@deepseek-ai/dsh-tools`

`lib/types/contracts.d.ts`:

```ts
export interface ToolDefinition extends ToolSchema {   // ToolSchema = { name, description, parameters, deferLoading? }
    readonly output: ToolOutputDefinition               // { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta? }
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
    timeoutMs?: number
    isConcurrencySafe?(args: unknown): boolean
    presentCall?(args: unknown): ToolCallView | undefined
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
export interface ToolExecutionInput { callId; rootCallId?; name; schema?; arguments: unknown
                                      agent?: Agent; toolSet?; parent?; signal: AbortSignal }
export interface ToolExecution extends ToolExecutionInput { readonly rootCallId: ToolCallId
                                                            readonly token: ToolExecutionToken }
export interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void
                                                        concludeTurn(): void }
export interface ToolActivationContext { readonly agent: Agent; readonly modelSelection: Readonly<ModelSelection>
                                         readonly signal: AbortSignal }
export interface ToolRegistrationOptions { readonly when?: (c: ToolActivationContext) => boolean | Promise<boolean> }
```

`defineTool` (`lib/types/schema.d.ts:248`) is generic over the DSL and **infers argument types**:

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>): ToolDefinition
// parameters: { [key]: ValueSchemaSpec & { required?: true } }, inferred object root
// output.schema needs `additionalProperties` on every object node
// execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>>
```

### 2.5 `@deepseek-ai/dsh-system-prompt`

```ts
interface PromptSection { name: string; order: number
                          text: string | ((context: AssembleContext) => string)
                          interpolate?: boolean; complete?: boolean }
interface PromptContext { name: string; order: number
                          text: string | ((context: AssembleContext) => string)
                          interpolate?: boolean; required?: boolean }
section(section: PromptSection): () => void
context(context: PromptContext): () => void
getSectionOrder(name: PromptSectionOrderName): number
getContextOrder(name: PromptContextOrderName): number
```

`PromptSectionOrderName` is a closed union (typo = compile error, the error message lists all 33 names):
`HARNESS_IDENTITY|DEPLOYMENT_PERSONA_PREFIX|PLAN_POLICY|TEAM_POLICY|PTC_ONLY|FILE_REFERENCE|TOOL_BASH|TOOL_PWSH|TOOL_READ|TOOL_WRITE|TOOL_EDIT|TOOL_APPLY_PATCH|TOOL_GLOB|TOOL_GREP|TOOL_JOBS|TOOL_PTY|TOOL_WEB_SEARCH|TOOL_WEB_FETCH|TOOL_LSP|TOOL_SESSION_QUERY|TOOL_GOAL|TOOL_SCHEDULE|TOOL_WORKFLOW|TOOL_RALPH|TOOL_SUBAGENT|TOOL_REPORT|TOOL_COMPUTER_USE|MCP_SERVERS|TOOLS_SDK|DELIVERABLE_FILE_REFERENCES|STRUCTURED_OUTPUT|HARNESS_SOURCE|WEB_SURFACE|DEPLOYMENT_PERSONA_SUFFIX`
(`PromptContextOrderName`: `WORKING_DIRECTORY|SANDBOX_POLICY|APPROVAL_POLICY|SUBAGENT_DELEGATION|TEAM_IDENTITY|HARNESS_SOURCE|WEB_SURFACE`).
`AssembleContext` is `{ scope?: ScopeKey; signal?: AbortSignal }`; the concrete `agent` field is added by
`@deepseek-ai/dsh-agent`'s `assembleContextFor(agent, signal)` — so read `context.scope`, not `context.agent`, unless
you cast.

### 2.6 `@deepseek-ai/dsh-host-webserver`

```ts
export type WebRouteKind = 'exact' | 'prefix'
export interface WebRoute { kind: WebRouteKind; path: string
                            handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }
export type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>
export interface WebResourceRoute { kind: WebRouteKind; path: string; resource: WebResource }
register(route: WebRoute | WebResourceRoute): () => void
```

`PeerScope` (`@deepseek-ai/dsh-typert-protocol`): `{ id, ctx, principal, signal, interactions, dispose(): Promise<void> }`
— still only reachable in-process (`readResource`), never passed to an HTTP resource. `ctx.connection.requestRejection`
is not typed locally (§5.3).

### 2.7 `@deepseek-ai/dsh-agent-preset`

```ts
export type Config = PresetDefinition                     // from dsh-agent-preset-registry
export default class AgentPreset { static inject: string[]; static Config }
export interface PresetDefinition {
  readonly id: string; readonly name?: string; readonly description?: string; readonly order?: number
  readonly plugins: readonly (Omit<EntryOptions, 'id' | 'disabled'> & { id?: string; disabled?: EntryOptions['disabled'] | JsExpr })[]
}
```

Registry methods, typed through the preset package's transitive augmentation:

```ts
ctx.agentPresets.mount(ctx: Context, id?: string): Promise<{ id: string }>
ctx.agentPresets.select(agent: Agent, agentPreset: string): Promise<string>   // throws agent-preset/locked after turn 1
ctx.agentPresets.presetForSession(session: Session): string | null
ctx.agentPresets.resolve(id?: string): Promise<AgentPreset>
```

## 3. Probe: the compile-checked core of `sessions.ts`

Full file: `research/typecheck-probe.ts` (143 lines, compiles clean). The parts a Session manager needs:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'                    // Events: 'session/event'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'              // augmented Agent
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-preset'

export async function ensureSession(ctx: Context, id: SessionId, cwd: string, preset: string): Promise<Agent> {
  let result = await ctx.sessionController.resolveAgent(id)
  if ('error' in result && result.error.code === 'session/not-found') {
    const created = await ctx.sessionController.create({ sessionId: id, cwd, agentPreset: preset })
    result = await ctx.sessionController.resolveAgent(created.sessionId)
  }
  if ('error' in result) throw result.error       // RemoteError is an Error — safe to throw
  return result.agent
}

export function decorate(ctx: Context, agent: Agent): (() => void)[] {
  return [
    agent.ctx.systemPrompt.section({
      name: 'superagent:role', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
      interpolate: false, text: () => 'You are the worker.',
    }),
    agent.ctx.tools.register(defineTool({
      name: 'ticket_create', description: 'Queue one ticket.',
      parameters: { title: { type: 'string', required: true }, priority: { type: 'integer', enum: [1, 2, 3] } },
      output: { schema: { type: 'object', additionalProperties: false,
                          properties: { ticketId: { type: 'string', required: true } } },
                render: (_args, value) => [{ type: 'text', text: `queued ${value.ticketId}` }] },
      async execute(args, exec) {                    // args.title: string, args.priority: number | undefined
        return { ticketId: `${exec.agent?.id ?? 'agentless'}:${args.title}` }
      },
    })),
    agent.ctx.tools.restrict({ allow: ['ticket_create', 'read'] }),
  ]
}

export async function talk(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
}

export async function presets(ctx: Context, agent: Agent, session: Session): Promise<void> {
  await ctx.agentPresets.mount(agent.ctx, 'superagent-worker')
  await ctx.agentPresets.select(agent, 'superagent-worker')
  const current: string | null = ctx.agentPresets.presetForSession(session)
}

export function route(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact', path: '/superagent/tickets',
    handler: async (req, res) => {
      const gate = ctx.get('connection') as { requestRejection(req: unknown): number | undefined } | undefined
      const rejection = gate?.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).byteLength }))
    },
  })
}
```

## 4. Negative controls (evidence the types are real)

Each of these lines was compiled and **rejected**; the message is quoted verbatim.

| Wrong line | Diagnostic |
|---|---|
| `agent.followup('not a message')` | `TS2345: Argument of type 'string' is not assignable to parameter of type 'UserMessage'` |
| `agent.cancel({ kind: 'nope' })` | `TS2322: Type '"nope"' is not assignable to type '"user" \| "parent" \| "hook" \| "disposed"'` |
| `ctx.sessionController.create({ sessionId: 5 })` | `TS2322: Type 'number' is not assignable to type 'SessionId'` |
| `ctx.sessionController.resolveAgent('plain-string')` | `TS2345: Argument of type 'string' is not assignable to parameter of type 'SessionId'` |
| `ctx.tools.register({ name: 'x' })` | `TS2345: … is not assignable to parameter of type 'ToolDefinition'` (missing `output`/`execute`) |
| `ctx.systemPrompt.getSectionOrder('NOT_A_SECTION')` | `TS2345: … not assignable to '"DEPLOYMENT_PERSONA_PREFIX" \| … \| "DEPLOYMENT_PERSONA_SUFFIX"'` |
| `ctx.webServer.register({ kind: 'weird', path: '/x' })` | `TS2322: Type '"weird"' is not assignable to type 'WebRouteKind'` |
| `ctx.nonexistentService` | `TS2339: Property does not exist on type 'Context'` |

Inference proof inside `defineTool.execute`: `args.title.toFixed(2)` → `TS2551: Property 'toFixed' does not exist on
type 'string'`; `args.priority.toUpperCase()` → `TS18048: 'args.priority' is possibly 'undefined'` and
`TS2339: … on type 'number'`.

## 5. Footguns this check exposed

### 5.1 `Agent` must be imported from the package root

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'        // ✅ session/ctx/steer/followup/cancel/whenIdle present
import type { Agent } from '@deepseek-ai/dsh-agent/types'  // ❌ TS2339: Property 'session' does not exist
```

The augmentation lives in `runtime-types.d.ts` (`declare module './types.ts'`) and is loaded by the root entry's
`export * from './runtime-types.ts'`. The `/types` subpath pulls `types.d.ts` alone, so the reactor is bare `{ id }`.
`docs/dsh-api-notes.md` previously credited `@deepseek-ai/dsh-agent-loop` for this — **wrong**; the loop package only
implements it (`ReactLoopAgent implements Agent`). No extra import is needed beyond the root package.

### 5.2 `ctx.agentPresets` needs the preset package, not the registry

`@deepseek-ai/dsh-agent-preset-registry` is not a dependency of this project (it exists only inside
`node_modules/.pnpm`), so `import type {} from '@deepseek-ai/dsh-agent-preset-registry'` fails to resolve from our
files. Importing **`@deepseek-ai/dsh-agent-preset`** is enough: that package's types import `PresetDefinition` from the
registry, which loads the registry's `declare module '@deepseek-ai/cordis' { interface Context { agentPresets } }`.
Verified: mount/select/presetForSession all typecheck with no cast.

### 5.3 Two services stay untyped

- `ctx.skills` — `@deepseek-ai/dsh-skill` is not installed. Use `ctx.get('skills')` and narrow by hand (the probe
  shows the shape it registers: `{ name, description, content }`).
- `ctx.connection` — `@deepseek-ai/dsh-client-connection` is not installed; `requestRejection` is typed `any` via
  `ctx.get`. Add both packages as `peerDependencies` + `devDependencies` if we want real types (they ship with DSH).

### 5.4 Session create is looser than the runtime

`SessionCreateRequest` has **every field optional**; the "workspaceId xor cwd" rule is only a runtime `RemoteError`
(`gateway/bad-request`). Likewise `create()` returns `{ sessionId, agentPreset? }` — **not** an Agent — and the
returned `sessionId` may differ from the requested one when a blank session was reused. Always re-`resolveAgent` rather
than holding the requested id.

### 5.5 The model is a durable selection, not a constructor field

`agentOptions` is only the fallback route (`AgentModel.current()`); a recorded `model/selection` wins. Use
`agent.model.select({ provider, model })` to write one durably, and avoid `sessionController.selectModel()` in a
plugin because it also rewrites the deployment default (its own JSDoc says "save the default in the background").

### 5.6 Other compile-level notes

- `ContentBlock` text nodes are `{ type: 'text', text: string }`; `createUserMessage` freezes messages, so build a new
  one per delivery (never reuse an `id`).
- `tools.restrict({ allow })` accepts only names the registry already knows; a typo compiles but throws at runtime.
- `defineTool` object output schemas **require** `additionalProperties` (compile error otherwise).
- `ctx.on('session/event', …)` needs `import type {} from '@deepseek-ai/dsh-session'`; `ctx.on('agent/*')` needs
  `@deepseek-ai/dsh-agent`. Without those imports the event name is not a key of `Events` and the handler parameters
  are implicitly `any` (which `noImplicitAny` would reject only if the listener itself is untyped).

## 6. Client plugin registration — still unverified

No `@deepseek-ai/dsh-client-*` package is installed, so client types cannot be compiled here. What is known:

- The client half is a **classic script** (`window.__ModuleLoader__.load({ id: <exact package name>, factory })`),
  served from `/plugins/?<pkg>/client.js&rev=<12hex>`; `exports["./client"]` is mandatory; `dsh.client` accepts
  `platform: 'web'`, `immediately`, `inject`, `external` only.
- Slot ids from the shipped bundles: `main` (keyed root panel), `sidebar.panellist` (root list entry),
  `sidebar.right.pane.tab` (+ `.title`), `shell.overlay`, `conversation.composer.dock`, `plugins.row.config`.
- Registration shape from the first-party template (`…/skills/cordis-plugin-development/templates/decoration/client.js`):

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react'); const h = React.createElement
    function Decoration() { return h('svg', { viewBox: '0 0 64 64', width: 48, height: 48 }) }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'my-decoration', order: 5 }, Decoration))
    } }
  },
})
```

For our panel (`main` + `sidebar.panellist`), the reference implementation (`dsh-superagent-prototype`
`src/client/index.tsx`) registers:

```ts
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, Mounted))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
```

**Status: source-derived, not compile-checked, not live-checked.** `Slots.listSubTree` times out without an attached
page; props types (`MainPanelId`, `SidebarPanelIconOwnerProps`, `PluginConfigViewProps`) come from client packages we
do not have. Treat the panel as the last milestone and verify it against a live page.

## 7. Recommendations

1. **Fix the two failing test files** before adding more tests, so `./scripts/pnpmw typecheck` is a usable gate.
2. **Add `@deepseek-ai/dsh-skill` and `@deepseek-ai/dsh-client-connection`** to `peerDependencies` *and*
   `devDependencies` (both ship with DSH) — that turns `ctx.skills` / `ctx.connection` from `any` into real types and
   makes the route gate compile-checked.
3. Keep `research/typecheck-probe.ts` in the repo as the executable API contract; re-run the two commands in §0 when
   bumping the runtime version. Do not move it into `tests/` — it is documentation, not a test.
4. When `sessions.ts` lands, mirror its surface against §3: every line there is known to compile.
