/**
 * Main plugin entry — the failure-isolation guardian.
 *
 * Load-time imports are deliberately minimal: Node built-ins plus schemastery
 * (a declared peer dependency, used synchronously to export `Config`, which
 * the Loader and the Settings page read before `apply()` runs). Everything
 * else — the engine and the host version helper — is loaded through a guarded
 * dynamic `import()` inside `apply()`. That way a broken engine build, a
 * missing host service after a DSH upgrade, or an incompatible Node/DSH
 * version can never make the DSH host fail to boot: the guardian reports a
 * clear degraded status, writes it under the state directory when it can, and
 * stops.
 *
 * The real application lives in `engine.ts` and is loaded on demand.
 *
 * Rules this file follows (see docs/dsh-api-notes.md §8):
 *  - `apply()` never throws and never rejects.
 *  - Every floating promise has `.catch()`; the host installs `installFailLoud`
 *    and would exit on an unhandled rejection.
 *  - The engine start is bounded; a hung start degrades instead of hanging the
 *    plugin forever.
 *  - Teardown is registered synchronously, before the bounded start begins, so
 *    a fiber disposed mid-start still owns (and can stop) the engine.
 *  - Per-apply state lives in an instance object: Cordis re-runs `apply()` on
 *    config change or `fiber.restart()` without re-importing the module, so
 *    module globals must not remember "this plugin was disposed".
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Plugin name; also the loader entry id used in `cordis.patch.yml`. */
export const name = 'dsh-superagent-personal'

/**
 * No static injections: the guardian must run even when the services the
 * engine needs are missing. The engine waits for its own dependencies.
 */
export const inject: string[] = []

/**
 * The plugin configuration schema. DSH validates the Loader row's `config`
 * with it before `apply()`, renders it in Settings, and the panel's setup API
 * persists through `configEditor` with the same schema. Defaults are safe:
 * disabled sources, `observe` mode, two workers.
 *
 * Unknown keys are preserved by the resolver but dropped by `simplify()`, so
 * every key the runtime reads is declared here.
 */
/**
 * Typed as a schema-shaped value on purpose: the module's declaration file should
 * not re-export schemastery's internal `Dict` type (which is not portable across
 * package managers). Runtime consumers use the value only, and tests cast it.
 */
export const Config: unknown = Schema.object({
  enabled: Schema.boolean().default(true).i18n({
    en: 'Master switch. Off keeps DSH running and the engine idle.',
    zh: '总开关。关闭后 DSH 正常运行，引擎不启动。',
  }),
  stateDir: Schema.string().default('').i18n({
    en: 'Absolute directory for the database, lock, secrets and worker checkouts.',
    zh: '绝对路径：数据库、锁、密钥文件和 Worker 工作目录。',
  }),
  language: Schema.union(['zh', 'en']).default('zh').i18n({
    en: 'Primary language the bot uses when it talks to you (not the panel UI language).',
    zh: '机器人对你说话、汇报时使用的语言（不是面板 UI 语言）。',
  }),
  router: Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    reasoningEffort: Schema.string().default(''),
  }).default({}).i18n({
    en: 'Model for the long-lived Router session; empty fields follow the DSH default model.',
    zh: '常驻 Router Session 使用的模型；留空沿用 DSH 默认模型。',
  }),
  sources: Schema.object({
    telegram: Schema.object({
      enabled: Schema.boolean().default(false).i18n({
        en: 'Receive direct messages and allowed group chats.',
        zh: '接收私聊和允许的群聊消息。',
      }),
      tokenEnv: Schema.string().default('').i18n({
        en: 'Environment variable holding the @BotFather token (alternative to tokenFile).',
        zh: '保存 @BotFather token 的环境变量名（与 tokenFile 二选一）。',
      }),
      tokenFile: Schema.string().default('').i18n({
        en: 'File holding the bot token; written by the setup wizard with mode 0600.',
        zh: '保存 bot token 的文件；向导会以 0600 写入。',
      }),
      allowedUserIds: Schema.array(Schema.string()).default([]).i18n({
        en: 'Telegram numeric user ids allowed to start work.',
        zh: '允许发起工作的 Telegram 数字 user id。',
      }),
      chats: Schema.array(Schema.string()).default([]).i18n({
        en: 'Optional Telegram group chat ids to listen to (mentions only).',
        zh: '可选：要监听的 Telegram 群 chat id（只处理 @）。',
      }),
      pollTimeoutSeconds: Schema.number().default(25).i18n({
        en: 'Telegram getUpdates long-poll timeout in seconds (0 makes it a plain poll).',
        zh: 'Telegram getUpdates 长轮询超时（秒）；0 表示普通轮询。',
      }),
      observeCallbacks: Schema.boolean().default(false).i18n({
        en: 'Turn inline-button presses into callback Triggers. Default false: buttons are ignored unless enabled.',
        zh: '把内联按钮点击转成 callback 候选。默认 false：未开启时按钮点击被忽略。',
      }),
      observeAllChatMessages: Schema.boolean().default(false).i18n({
        en: 'Admit unaddressed group messages (addressed: none). Default false.',
        zh: '接收群聊中未 @ 的消息（addressed: none）。默认 false。',
      }),
      replyToMessages: Schema.boolean().default(false).i18n({
        en: 'Reply under the Telegram message that caused a Trigger. Default false.',
        zh: '在触发工作的 Telegram 消息下回复。默认 false。',
      }),
      mentionPattern: Schema.string().default('').i18n({
        en: 'Extra literal @name considered an address of the bot.',
        zh: '额外视为 bot 名称的字面 @name。',
      }),
      processBacklog: Schema.boolean().default(false).i18n({
        en: 'On the first start, drain up to 24h of Bot API backlog instead of only the latest pending update.',
        zh: '首次启动时回灌最多 24 小时的 Bot API 积压，而不是只取最新一条。',
      }),
      maxDownloadBytes: Schema.number().default(20 * 1024 * 1024).i18n({
        en: 'Refuse to download Telegram media larger than this many bytes (default 20 MiB).',
        zh: '拒绝下载超过该字节数的 Telegram 媒体（默认 20 MiB）。',
      }),
      richText: Schema.boolean().default(true).i18n({
        en: 'Render rich text (Telegram HTML) for outgoing messages; off sends plain text.',
        zh: '对外消息使用富文本（Telegram HTML）；关闭则发送纯文本。',
      }),
      files: Schema.boolean().default(true).i18n({
        en: 'Allow sending and receiving files (documents/photos); downloads never feed the model directly.',
        zh: '允许收发文件（文档/图片）；下载的文件会落盘供 Worker 读取。',
      }),
      keyboards: Schema.boolean().default(true).i18n({
        en: 'Allow inline keyboards/buttons on outgoing messages; button presses only become Triggers when observeCallbacks is on.',
        zh: '允许对外消息附带内联按钮/键盘；只有在 observeCallbacks 开启时按钮点击才会成为候选。',
      }),
      pollSeconds: Schema.number().default(1).i18n({
        en: 'Idle delay after an empty long poll, in seconds (0.01–300). Default 1: the long poll already waits up to pollTimeoutSeconds.',
        zh: '空长轮询后的等待秒数（0.01–300）。默认 1：长轮询本身最多等待 pollTimeoutSeconds。',
      }),
    }).default({}),
    github: Schema.object({
      enabled: Schema.boolean().default(false).i18n({
        en: 'Receive issue, pull request, comment and CI events.',
        zh: '接收 Issue、PR、评论和 CI 事件。',
      }),
      tokenEnv: Schema.string().default('').i18n({
        en: 'Environment variable holding the GitHub token (alternative to tokenFile).',
        zh: '保存 GitHub token 的环境变量名（与 tokenFile 二选一）。',
      }),
      tokenFile: Schema.string().default('').i18n({
        en: 'File holding the GitHub token; written by the setup wizard with mode 0600.',
        zh: '保存 GitHub token 的文件；向导会以 0600 写入。',
      }),
      repositories: Schema.array(Schema.string()).default([]).i18n({
        en: 'Repositories to watch, as owner/name.',
        zh: '要监听的仓库列表，格式 owner/name。',
      }),
      login: Schema.string().default('').i18n({
        en: 'GitHub login of the token owner, used to detect @mentions.',
        zh: 'token 所属账号的 GitHub login，用于识别 @。',
      }),
      allowedLogins: Schema.array(Schema.string()).default([]).i18n({
        en: 'Optional extra logins treated as allowed askers.',
        zh: '可选：额外允许发起工作的 GitHub login。',
      }),
      collaborators: Schema.array(Schema.string()).default([]).i18n({
        en: 'GitHub logins invited as collaborators when the bot creates a repository (usually your personal account).',
        zh: 'bot 新建仓库时自动邀请为 collaborator 的 GitHub 登录名（通常是你的个人账号）。',
      }),
      botLogins: Schema.array(Schema.string()).default([]).i18n({
        en: 'Bot logins whose events are admitted as inferred candidates.',
        zh: '允许作为推断候选来源的 bot 登录名。',
      }),
      notifications: Schema.union(['auto', 'off', 'on']).default('auto').i18n({
        en: 'GitHub notification stream: auto (use it when the token can read notifications), off, or on.',
        zh: 'GitHub 通知流：auto（token 可读通知时使用）、off 或 on。',
      }),
      maxTextChars: Schema.number().default(16_000).min(1_000).max(64_000).i18n({
        en: 'Maximum characters of issue/PR text fed to the model (1k–64k, default 16k).',
        zh: '传给模型的 Issue/PR 文本上限（1k–64k，默认 16k）。',
      }),
      adaptivePolling: Schema.boolean().default(true).i18n({
        en: 'Poll repositories mentioned by the notifications stream first; off polls every repository on the normal schedule.',
        zh: '优先轮询通知流涉及的仓库；关闭后所有仓库按常规节奏轮询。',
      }),
      operatorTokenFile: Schema.string().default('').i18n({
        en: 'Path to the operator personal PAT file (0600, local only) used to invite the bot / accept repository invitations; the token content is never stored in configuration.',
        zh: '操作者个人 PAT 文件路径（本机 0600），用于邀请 bot/接受仓库邀请；token 内容不写入配置。',
      }),
      acceptInvitations: Schema.union(['off', 'allowlist', 'all']).default('allowlist').i18n({
        en: 'Which bot-account repository invitations may be accepted automatically: off, allowlist (inviter/owner in allowedLogins/collaborators; default) or all.',
        zh: 'bot 账号收到的仓库邀请如何自动接受：off（关）、allowlist（邀请者在 allowedLogins/collaborators 内，默认）或 all（全部）。',
      }),
      allowSelf: Schema.boolean().default(false).i18n({
        en: 'Allow events from the token owner account itself. Enable when the agent runs as your own GitHub account; its own output is still filtered by the agent marker.',
        zh: '允许 token 所属账号自己的事件触发。使用与 agent 相同的 GitHub 账号时开启；agent 自身输出仍按 marker 过滤。',
      }),
      observeIssues: Schema.boolean().default(false).i18n({
        en: 'Treat new issues as candidates even without a mention.',
        zh: '即使没有 @ 也把新 Issue 视为候选。',
      }),
      observePulls: Schema.boolean().default(false).i18n({
        en: 'Treat new pull requests as candidates even without a mention.',
        zh: '即使没有 @ 也把新 PR 视为候选。',
      }),
      observeComments: Schema.boolean().default(false).i18n({
        en: 'Treat new comments as candidates even without a mention.',
        zh: '即使没有 @ 也把新评论视为候选。',
      }),
      observeCi: Schema.boolean().default(false).i18n({
        en: 'Treat failing CI on the default branch as a candidate.',
        zh: '把默认分支的 CI 失败视为候选。',
      }),
      pollSeconds: Schema.number().default(60).i18n({
        en: 'Polling interval in seconds.',
        zh: '轮询间隔（秒）。',
      }),
    }).default({}),
    native: Schema.object({
      enabled: Schema.boolean().default(true).i18n({
        en: 'Local MMAgent bridge: loopback HTTP + SSE on 127.0.0.1. Writes <stateDir>/native.json for the app.',
        zh: '本地 MMAgent 桥：127.0.0.1 上的 HTTP + SSE，并在 <stateDir>/native.json 写发现文件。',
      }),
      port: Schema.number().default(47_821).min(0).max(65_535).i18n({
        en: 'Preferred loopback port (0 picks a free port; an occupied port falls through to the next candidate).',
        zh: '首选 loopback 端口（0 自动选择；被占用时尝试后续端口）。',
      }),
    }).default({}),
  }).default({}),
  policy: Schema.object({
    mode: Schema.union(['off', 'observe', 'auto']).default('observe').i18n({
      en: 'off: explicit requests only; observe: record candidates, send nothing; auto: accept matching inferred candidates.',
      zh: 'off：只接明确请求；observe：记录候选不发送；auto：按规则接受推断候选。',
    }),
    rules: Schema.array(
      Schema.object({
        id: Schema.string().required().i18n({ en: 'Stable rule id.', zh: '稳定的规则 id。' }),
        name: Schema.string().required().i18n({ en: 'Rule name.', zh: '规则名称。' }),
        enabled: Schema.boolean().default(true).i18n({ en: 'Rule switch.', zh: '规则开关。' }),
        instructions: Schema.string().default('').i18n({
          en: 'What proactive work this rule allows.',
          zh: '这条规则允许的主动工作说明。',
        }),
      }),
    ).default([]).i18n({ en: 'Proactive rules used in auto mode.', zh: 'auto 模式下使用的主动规则。' }),
  }).default({}),
  executor: Schema.object({
    model: Schema.string().default('').i18n({
      en: 'Optional Worker model id; empty uses the profile default.',
      zh: '可选：Worker 模型 id；留空使用 profile 默认模型。',
    }),
    reasoningEffort: Schema.string().default('').i18n({
      en: 'Optional reasoning effort for the Worker model; empty uses the model default.',
      zh: '可选：Worker 模型的 reasoning effort；留空使用模型默认值。',
    }),
    provider: Schema.string().default('').i18n({
      en: 'Optional Worker model provider.',
      zh: '可选：Worker 模型 provider。',
    }),
    maxWorkers: Schema.number().default(2).i18n({
      en: 'How many tickets may run at the same time.',
      zh: '同时运行的 Ticket 数。',
    }),
    prepare: Schema.string().default('').i18n({
      en: 'Optional shell command run in a new ticket directory before the Worker starts.',
      zh: '可选：Worker 启动前在 Ticket 目录执行的命令。',
    }),
    cloneUrl: Schema.string().default('').i18n({
      en: 'Optional git clone URL for new ticket directories.',
      zh: '可选：Ticket 目录使用的 git clone URL。',
    }),
    clone: Schema.boolean().default(true).i18n({
      en: 'Clone (or worktree) a checkout for each ticket.',
      zh: '为每个 Ticket 准备 clone/worktree。',
    }),
    defaultRepo: Schema.string().default('').i18n({
      en: 'Optional default repository for ticket checkouts.',
      zh: '可选：Ticket 检出使用的默认仓库。',
    }),
    prepareTimeoutMs: Schema.number().default(120_000).i18n({
      en: 'Timeout for the prepare command in milliseconds.',
      zh: 'prepare 命令超时（毫秒）。',
    }),
    gitTimeoutMs: Schema.number().default(120_000).i18n({
      en: 'Timeout for git operations in milliseconds.',
      zh: 'git 操作超时（毫秒）。',
    }),
    gitSshKeyFile: Schema.string().default('').i18n({
      en: 'Optional fallback: absolute path to an SSH private key for git. By default the host uses HTTPS with a credential helper generated from sources.github.tokenFile; leave empty to use that.',
      zh: '可选回退项：git 使用的 SSH 私钥绝对路径。默认由 host 用 sources.github.tokenFile 自动生成 credential helper 走 HTTPS；留空即使用默认方式。',
    }),
    gitName: Schema.string().default('').i18n({
      en: 'git commit author name for the bot account; empty derives it from sources.github.login.',
      zh: 'bot 账号的 git 提交作者名；留空由 sources.github.login 推导。',
    }),
    gitEmail: Schema.string().default('').i18n({
      en: 'git commit author email for the bot account; empty derives <login>@users.noreply.github.com.',
      zh: 'bot 账号的 git 提交邮箱；留空推导为 <login>@users.noreply.github.com。',
    }),
  }).default({}),
  quiet: Schema.object({
    minChars: Schema.number().default(100).i18n({
      en: 'Minimum length of an attention message; shorter messages are suppressed.',
      zh: '打扰消息的最小长度；更短的会被抑制。',
    }),
    maxChars: Schema.number().default(0).i18n({
      en: 'Optional hard cap for outbound messages; 0 uses minChars.',
      zh: '可选：对外消息硬上限；0 表示使用 minChars。',
    }),
  }).default({}),
  watchdog: Schema.object({
    stallMs: Schema.number().default(0).i18n({
      en: 'Optional stall threshold in milliseconds; 0 uses the runtime default.',
      zh: '可选停滞阈值（毫秒）；0 使用运行时默认值。',
    }),
    escalateMs: Schema.number().default(0).i18n({
      en: 'Optional escalation threshold in milliseconds.',
      zh: '可选升级阈值（毫秒）。',
    }),
    intervalMs: Schema.number().default(0).i18n({
      en: 'Optional stall-check interval in milliseconds.',
      zh: '可选停滞检查间隔（毫秒）。',
    }),
    silentMs: Schema.number().default(0).i18n({
      en: 'Optional silent-worker threshold in milliseconds.',
      zh: '可选无报告阈值（毫秒）。',
    }),
    silentMaxAttempts: Schema.number().default(0).i18n({
      en: 'Optional number of silent-worker retries.',
      zh: '可选无报告重试次数。',
    }),
  }).default({}),
  acknowledgeOnAccept: Schema.boolean().default(false).i18n({
    en: 'Send an acknowledgement when a ticket is accepted.',
    zh: '接单时发送确认消息。',
  }),
  passIntervalMs: Schema.number().default(2_000).i18n({
    en: 'Engine pass interval in milliseconds.',
    zh: '引擎轮询间隔（毫秒）。',
  }),
  heartbeatIntervalMs: Schema.number().default(30_000).i18n({
    en: 'Heartbeat interval written under stateDir for the watchdog.',
    zh: '写入 stateDir、供看门狗读取的心跳间隔（毫秒）。',
  }),
})

/** Supported range, mirrored in package.json `engines.dsh`. */
export const SUPPORTED_DSH = '>=0.2.2-rc.1 <0.3.0'
/** Minimum Node version, mirrored in package.json `engines.node`. */
const MIN_NODE = [22, 19, 0] as const
/** Default bound for the engine's `start()`; overridable for tests/ops. */
const DEFAULT_START_TIMEOUT_MS = 30_000
/** Bound for engine `stop()` during teardown, so a hung engine cannot stall unload. */
const STOP_TIMEOUT_MS = 15_000
/** Status file names inside `<stateDir>`. */
const STATUS_FILE = 'superagent-status.json'
const DEGRADED_FILE = 'superagent-degraded.json'

/** Where the guardian writes its own state; readable by tests and the watchdog. */
export interface BootState {
  status: 'starting' | 'ready' | 'degraded' | 'stopped'
  detail?: string
  at: string
  /** Detected running DSH version, when detection succeeded. */
  dshVersion?: string
  /** Node version of the host process. */
  node?: string
  /** Absolute state directory from the configuration, when valid. */
  stateDir?: string
}

interface EngineHandle {
  stop(): Promise<void>
}

/**
 * One `apply()` invocation (one Cordis fiber). A restarted fiber gets a fresh
 * instance, which is what makes the plugin restart-safe.
 */
interface Instance {
  ctx: Context
  config: unknown
  state: BootState
  handle?: EngineHandle
  booting: boolean
  disposed: boolean
  /** True once `ctx.effect` accepted the teardown registration. */
  cleanupRegistered: boolean
}

/** Last state reported by any instance; `bootState()` is a diagnostic view. */
let lastState: BootState = { status: 'starting', at: new Date().toISOString() }
/** The live instance, when one exists (single-row deployments have one). */
let current: Instance | undefined

/** Read the last boot state, for diagnostics, the panel and tests. */
export function bootState(): BootState {
  return { ...lastState }
}

function setState(instance: Instance, status: BootState['status'], detail?: string, extra: Partial<BootState> = {}): void {
  const next: BootState = {
    ...extra,
    status,
    ...(detail === undefined ? {} : { detail }),
    at: new Date().toISOString(),
  }
  instance.state = next
  lastState = { ...next }
}

function serverLog(ctx: Context, level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const text = error === undefined ? message : `${message}: ${String(error)}`
  try {
    ctx.logger?.[level]?.(text)
  } catch {
    // Logging must never throw out of the guardian.
  }
}

/**
 * Persist the current boot state under the configured state directory, best
 * effort. The status file always reflects the latest attempt; the degraded
 * file exists only while the plugin is degraded. A write failure is silent: it
 * must never change the boot result.
 */
async function persistState(instance: Instance): Promise<void> {
  const dir = instance.state.stateDir
  if (dir === undefined || !isAbsolute(dir)) return
  const body = `${JSON.stringify({ plugin: name, ...instance.state }, null, 2)}\n`
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeAtomic(join(dir, STATUS_FILE), body)
    if (instance.state.status === 'degraded') {
      await writeAtomic(join(dir, DEGRADED_FILE), body)
    } else {
      await unlink(join(dir, DEGRADED_FILE)).catch(() => undefined)
    }
  } catch {
    // Best effort by contract.
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

function nodeTooOld(): string | undefined {
  const raw = process.versions.node ?? '0.0.0'
  const parts = raw.split('.').map(part => Number.parseInt(part, 10))
  const [major = 0, minor = 0, patch = 0] = parts
  if (major > MIN_NODE[0]) return undefined
  if (major < MIN_NODE[0]) return `Node ${raw} is older than ${MIN_NODE.join('.')}`
  if (minor > MIN_NODE[1]) return undefined
  if (minor < MIN_NODE[1]) return `Node ${raw} is older than ${MIN_NODE.join('.')}`
  return patch >= MIN_NODE[2] ? undefined : `Node ${raw} is older than ${MIN_NODE.join('.')}`
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseVersion(raw: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/**
 * Whether the running DSH version is inside `SUPPORTED_DSH`. Returns
 * `undefined` for a string that is not a version at all; callers decide
 * whether an unknown version is fatal (it is not: the host's `engines.dsh`
 * gate is authoritative, this is the defensive second check).
 */
export function isSupportedDshVersion(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const version = parseVersion(raw)
  if (version === undefined) return undefined
  if (version.major !== 0 || version.minor !== 2) return false
  return version.patch >= 2
}

function configEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true
  const value = (config as { enabled?: unknown }).enabled
  return value !== false
}

function configuredStateDir(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object') return undefined
  const value = (config as { stateDir?: unknown }).stateDir
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : undefined
}

/**
 * Validate the configuration without a schema import. A missing dependency can
 * therefore never fail the module load; invalid configuration is reported as a
 * degraded status instead.
 */
function validateConfig(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object') return 'configuration must be an object'
  const stateDir = (config as { stateDir?: unknown }).stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) return 'configuration.stateDir is required'
  if (!isAbsolute(stateDir)) return 'configuration.stateDir must be an absolute path'
  return undefined
}

function startTimeoutMs(): number {
  // Operational escape hatch; tests use a small value to exercise the timeout
  // path without waiting 30 s. Kept in the 50 ms–2 min range so a typo cannot
  // disable the bound.
  const raw = process.env.SUPERAGENT_START_TIMEOUT_MS
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 120_000) return parsed
  }
  return DEFAULT_START_TIMEOUT_MS
}

/** Read `version` from a package.json path; used only as a fallback. */
async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Missing or unreadable; try the next source.
  }
  return undefined
}

/**
 * Detect the running DSH version. Every source is optional and guarded; the
 * helper never throws and never imports a dependency at module load time.
 */
export async function detectDshVersion(ctx: Context): Promise<string | undefined> {
  const fromEnv = (process.env.DSH_VERSION ?? process.env.DSH_CLIENT_VERSION ?? '').trim()
  if (fromEnv.length > 0) return fromEnv

  // 1. The authoritative accessor of the host runtime.
  try {
    const boot: unknown = await import('@deepseek-ai/dsh-app-boot')
    if (boot !== null && typeof boot === 'object') {
      const getter = (boot as { getDshRuntimeVersion?: () => unknown }).getDshRuntimeVersion
      if (typeof getter === 'function') {
        const version = getter()
        if (typeof version === 'string' && version.length > 0) return version
      }
    }
  } catch {
    // Not resolvable in this deployment; fall through.
  }

  // 2. The profile context names the profile directory; the dsh package there
  //    may be the one that launched us.
  try {
    const profile = ctx.get?.('profileContext') as { dir?: unknown } | undefined
    if (profile !== undefined && typeof profile.dir === 'string' && profile.dir.length > 0) {
      const version = await readPackageVersion(join(profile.dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      if (version !== undefined) return version
    }
  } catch {
    // Optional service; ignore.
  }

  // 3. Resolve `@deepseek-ai/dsh`'s own metadata from the host module graph.
  try {
    // A variable specifier keeps TypeScript from resolving a package that may
    // not be installed in this workspace; the import stays runtime-resolved.
    const specifier = '@deepseek-ai/dsh/package.json'
    const metadata: unknown = await import(/* @vite-ignore */ specifier, { with: { type: 'json' } })
    if (metadata !== null && typeof metadata === 'object') {
      const version = (metadata as { default?: { version?: unknown }; version?: unknown }).default?.version
      if (typeof version === 'string' && version.length > 0) return version
      const direct = (metadata as { version?: unknown }).version
      if (typeof direct === 'string' && direct.length > 0) return direct
    }
  } catch {
    // No package metadata; the version stays unknown.
  }

  return undefined
}

/** Resolve or reject with a bound; a late resolution is stopped, not leaked. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        if (settled) {
          // The caller already degraded; release whatever arrived late.
          void Promise.resolve()
            .then(() => (value as unknown as EngineHandle | undefined)?.stop?.())
            .catch(() => undefined)
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function stopQuietly(target: EngineHandle | undefined, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  if (target === undefined || typeof target.stop !== 'function') return
  try {
    await withTimeout(Promise.resolve().then(() => target.stop()), timeoutMs, 'engine stop()')
  } catch {
    // Cleanup failures (including a hung stop) must not affect the host.
  }
}

async function loadEngine(ctx: Context, config: unknown): Promise<EngineHandle> {
  const runtime: unknown = await import('./engine.js')
  if (runtime === null || typeof runtime !== 'object') {
    throw new Error('engine module did not export an object')
  }
  const start = (runtime as { start?: unknown }).start
  if (typeof start !== 'function') {
    throw new Error('engine module does not export start()')
  }
  const started: unknown = await (start as (ctx: Context, config: unknown) => Promise<unknown>)(ctx, config)
  if (started === null || typeof started !== 'object' || typeof (started as EngineHandle).stop !== 'function') {
    throw new Error('engine start() returned no stop()')
  }
  return started as EngineHandle
}

/** Mark the plugin degraded, persist it and log one clear line. */
async function degrade(instance: Instance, detail: string, error?: unknown): Promise<void> {
  setState(instance, 'degraded', detail, { ...instance.state })
  await persistState(instance)
  serverLog(instance.ctx, 'error', 'Superagent failed to start and was disabled; DSH is unaffected', error)
}

function earlyExit(instance: Instance, status: 'stopped' | 'degraded', detail: string, message: string): Promise<void> {
  setState(instance, status, detail, { stateDir: configuredStateDir(instance.config) })
  return persistState(instance).then(() => {
    serverLog(instance.ctx, status === 'degraded' ? 'warn' : 'info', message)
  })
}

async function boot(instance: Instance): Promise<void> {
  const { ctx, config } = instance
  if (instance.disposed) {
    setState(instance, 'stopped', 'host disposed the plugin before it started', { stateDir: configuredStateDir(config) })
    await persistState(instance)
    return
  }

  if (!configEnabled(config)) {
    await earlyExit(instance, 'stopped', 'disabled by configuration (enabled: false)', 'Superagent is disabled by configuration; the host starts normally.')
    return
  }

  if (process.env.SUPERAGENT_DISABLED === '1') {
    await earlyExit(instance, 'stopped', 'disabled by SUPERAGENT_DISABLED=1', 'Superagent is disabled by SUPERAGENT_DISABLED=1; the host starts normally.')
    return
  }

  const nodeProblem = nodeTooOld()
  if (nodeProblem !== undefined) {
    await earlyExit(instance, 'degraded', nodeProblem, `Superagent is disabled: ${nodeProblem}. Update Node or set enabled: false.`)
    return
  }

  const configProblem = validateConfig(config)
  if (configProblem !== undefined) {
    await earlyExit(instance, 'degraded', configProblem, `Superagent is disabled: ${configProblem}. See examples/profile.cordis.patch.yml.`)
    return
  }

  const stateDir = configuredStateDir(config)
  setState(instance, 'starting', undefined, {
    ...instance.state,
    node: process.versions.node,
    ...(stateDir === undefined ? {} : { stateDir }),
  })
  await persistState(instance)

  const dshVersion = await detectDshVersion(ctx)
  if (instance.disposed) {
    setState(instance, 'stopped', 'host disposed the plugin during version detection', { stateDir })
    await persistState(instance)
    return
  }
  if (dshVersion !== undefined) {
    setState(instance, 'starting', undefined, { ...instance.state, dshVersion })
    // Self-test switch: pretend the running host is incompatible, so the
    // degraded path can be exercised without changing the installed DSH. It is
    // documented in SETUP.md and checked before any engine import.
    if (process.env.SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED === '1') {
      await degrade(instance, `DSH ${SUPPORTED_DSH} required (simulated incompatible host)`)
      serverLog(ctx, 'warn', 'Superagent is disabled: the running DSH version is outside the supported range. The host starts normally.')
      return
    }
    const supported = isSupportedDshVersion(dshVersion)
    if (supported === false) {
      await degrade(instance, `running DSH ${dshVersion} is outside the supported range ${SUPPORTED_DSH}`)
      serverLog(ctx, 'warn', `Superagent is disabled: DSH ${dshVersion} is outside ${SUPPORTED_DSH}. The host starts normally.`)
      return
    }
  }

  const timeoutMs = startTimeoutMs()
  let started: EngineHandle
  try {
    started = await withTimeout(loadEngine(ctx, config), timeoutMs, 'engine start()')
  } catch (error) {
    await degrade(instance, error instanceof Error ? error.message : String(error), error)
    return
  }

  if (instance.disposed) {
    // The fiber was disposed while the engine was starting; release it and do
    // not keep a handle that nobody owns.
    await stopQuietly(started)
    setState(instance, 'stopped', 'host disposed the plugin during start', { stateDir })
    await persistState(instance)
    return
  }

  instance.handle = started
  setState(instance, 'ready', undefined, { ...instance.state, stateDir, node: process.versions.node })
  await persistState(instance)
  serverLog(ctx, 'info', `Superagent engine started (dsh ${dshVersion ?? 'unknown'}).`)
}

/** The teardown body shared by the registered effect. Safe to run twice. */
async function teardown(instance: Instance): Promise<void> {
  instance.disposed = true
  const stopped = instance.handle
  instance.handle = undefined
  if (current === instance) current = undefined
  setState(instance, 'stopped', 'host disposed the plugin', { stateDir: configuredStateDir(instance.config) })
  await persistState(instance)
  await stopQuietly(stopped)
}

/**
 * Cordis entry point. It never throws and never rejects: every failure becomes
 * a degraded state with a log line. `boot` runs in the background so that a
 * slow engine start cannot delay the host's own startup path.
 */
export function apply(ctx: Context, config: unknown): void {
  try {
    const previous = current
    if (previous !== undefined && !previous.disposed && (previous.booting || previous.handle !== undefined)) {
      serverLog(ctx, 'warn', 'Superagent is already running; ignoring a duplicate apply().')
      return
    }

    const instance: Instance = {
      ctx,
      config,
      state: { status: 'starting', at: new Date().toISOString(), stateDir: configuredStateDir(config) },
      booting: true,
      disposed: false,
      cleanupRegistered: false,
    }
    current = instance

    // Register the teardown synchronously, before the bounded start: if the
    // fiber is disposed during start(), `ctx.effect` would throw
    // INACTIVE_EFFECT afterwards and the engine would be left unowned.
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => async () => {
          await teardown(instance)
        })
        instance.cleanupRegistered = true
      }
    } catch (error) {
      // The fiber is already inactive; do not start anything.
      instance.disposed = true
      instance.booting = false
      if (current === instance) current = undefined
      setState(instance, 'stopped', 'host disposed the plugin before it started', {
        stateDir: configuredStateDir(config),
      })
      serverLog(ctx, 'warn', 'Superagent was disposed before it could start; nothing was loaded.', error)
      return
    }

    // A microtask boundary keeps a synchronous loader return non-blocking and
    // guarantees nothing thrown here can escape into the host.
    void Promise.resolve()
      .then(() => boot(instance))
      .catch((error: unknown) => {
        // degrade() is internally guarded; the extra catch keeps a future
        // change from turning this into an unhandled rejection.
        void degrade(instance, error instanceof Error ? error.message : String(error), error).catch(() => undefined)
      })
      .finally(() => {
        instance.booting = false
      })
  } catch (error) {
    // Defensive: nothing above should throw, but the host must keep running.
    lastState = {
      status: 'degraded',
      ...(error instanceof Error ? { detail: error.message } : { detail: String(error) }),
      at: new Date().toISOString(),
      stateDir: configuredStateDir(config),
    }
    try {
      ctx.logger?.error?.('Superagent guardian failed synchronously; DSH is unaffected', error)
    } catch {
      // Ignore.
    }
  }
}
