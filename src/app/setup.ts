/**
 * Setup-wizard backend (docs/002-setup-api.md).
 *
 * Lets any user configure the plugin from the DSH panel without editing YAML:
 *
 *  - token validation + secret files (`<stateDir>/secrets/*`, 0700/0600);
 *  - account state without ever reading or echoing a token;
 *  - plugin configuration persisted through the DSH `configEditor` service
 *    (single source of truth), answered *before* the edit/restart happens;
 *  - the static permissions explanation.
 *
 * Security rules enforced here: the token only travels in a POST body, is
 * validated by the stateless `@deepseek-ai/dsh-superagent` source helpers
 * (dynamic import; never logged), is written atomically with mode 0600, and is
 * never included in a response, log line or health entry. Paths are either the
 * default under `stateDir` or an absolute path the user explicitly supplied.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { KeyValueStore } from '../core/ports.js'
import type { AppLogger } from './support.js'
import { errorMessage } from './support.js'

export const SETUP_STATE_PATH = '/superagent/api/setup/state'
export const SETUP_TELEGRAM_PATH = '/superagent/api/setup/telegram'
export const SETUP_GITHUB_PATH = '/superagent/api/setup/github'
export const SETUP_CONFIG_PATH = '/superagent/api/setup/config'
export const SETUP_PERMISSIONS_PATH = '/superagent/api/setup/permissions'
export const SETUP_SSH_KEY_PATH = '/superagent/api/setup/github/ssh-key'
export const SETUP_MODELS_PATH = '/superagent/api/setup/models'
export const SETUP_WATCHDOG_PATH = '/superagent/api/setup/watchdog'
export const SETUP_OPERATOR_PATH = '/superagent/api/setup/github/operator'

export const SETUP_PATHS = {
  state: SETUP_STATE_PATH,
  telegram: SETUP_TELEGRAM_PATH,
  github: SETUP_GITHUB_PATH,
  config: SETUP_CONFIG_PATH,
  permissions: SETUP_PERMISSIONS_PATH,
  sshKey: SETUP_SSH_KEY_PATH,
  models: SETUP_MODELS_PATH,
  watchdog: SETUP_WATCHDOG_PATH,
  operator: SETUP_OPERATOR_PATH,
} as const

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface SetupPermission {
  id: string
  title: string
  state: 'required' | 'optional' | 'not-required'
  detail: string
  restartRequired: boolean
}

export interface SetupAccountTelegram {
  configured: boolean
  enabled: boolean
  botUsername?: string
  tokenFile?: string
}

export interface SetupAccountGithub {
  configured: boolean
  enabled: boolean
  login?: string
  repositories: string[]
  count: number
  /** GitHub Source option: let the authenticated account's own events trigger work. */
  allowSelf: boolean
  /** GitHub logins invited as admin when a ticket creates a repository (wizard prefill). */
  collaborators: string[]
  /** Personal (operator) PAT configured for invitations/bootstrap. */
  operatorTokenConfigured: boolean
  operatorTokenFile?: string
  tokenFile?: string
}

/** Watchdog LaunchAgent status. */
export type WatchdogScriptName = 'watchdog.mjs' | 'install-launchd.sh' | 'uninstall.sh'

/** Commands for installs that ship the repository scripts (absolute, copy-safe). */
export interface SetupWatchdogCommands {
  dryRun: string
  install: string
  uninstall: string
}

export interface SetupWatchdogState {
  installed: boolean
  running: boolean
  label: string
  plistPath: string
  stateDir: string
  detail?: string
  /** Directory that contains the bundled scripts, when this install has them. */
  scriptsDir?: string
  /** Absolute manual commands; absent when the build does not ship the scripts. */
  manualCommands?: SetupWatchdogCommands
}

/** Result of one bounded child-process run (never thrown). */
export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

/** One effective provider/model/reasoning selection. */
export interface SetupModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface SetupModelsState {
  router: SetupModelSelection | null
  worker: SetupModelSelection | null
  default: SetupModelSelection | null
}

/** The subset of the DSH `llm` service the setup API uses. */
export interface LlmLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

export interface SetupGitIdentity {
  name: string
  email: string
  sshKeyFile: string
  /** True when the key file exists and is non-empty (private content is never read). */
  sshKeyConfigured: boolean
  /** Public key text (`<keyFile>.pub`), safe to show in the panel. */
  publicKey?: string
}

export interface SetupState {
  ok: true
  stateDir: string
  /** User-facing language for the bot (zh default). */
  language: 'zh' | 'en'
  /** Dedicated bot account repo-local git identity (paths only, no key content). */
  git: SetupGitIdentity
  /** Currently effective model selections (router/worker/default). */
  models: SetupModelsState
  /** Optional login-item watchdog state (installed/running). */
  watchdog: SetupWatchdogState
  plugin: { status: string; detail: string | null }
  accounts: { telegram: SetupAccountTelegram; github: SetupAccountGithub }
  permissions: SetupPermission[]
  restartRequired: boolean
}

/** HTTP-ready result returned by every setup operation. */
export interface SetupApiResult {
  status: number
  body: Record<string, unknown>
}

/** What `POST/PUT setup/config` accepts. */
export interface SetupConfigPatch {
  sources?: Record<string, unknown>
  policy?: Record<string, unknown>
  router?: Record<string, unknown>
  executor?: Record<string, unknown>
  quiet?: Record<string, unknown>
  /** User-facing language for the bot (zh default). */
  language?: 'zh' | 'en'
}

/** The surface `src/app/api.ts` mounts; `SetupService` implements it. */
export interface SetupApi {
  state(): Promise<SetupApiResult>
  permissions(): SetupApiResult
  saveTelegram(body: unknown): Promise<SetupApiResult>
  saveGithub(body: unknown): Promise<SetupApiResult>
  saveOperatorToken(body: unknown): Promise<SetupApiResult>
  removeOperatorToken(): Promise<SetupApiResult>
  persistOperatorTokenFile(operatorFile: string): boolean
  persistOperatorTokenClear(): boolean
  prepareConfig(body: unknown): Promise<{ result: SetupApiResult; patch?: SetupConfigPatch }>
  commitConfigSoon(patch: SetupConfigPatch): void
  listModels(): Promise<SetupApiResult>
  getWatchdog(force?: boolean): Promise<SetupApiResult>
  setWatchdog(enabled: boolean): Promise<SetupApiResult>
  generateGithubSshKey(): Promise<SetupApiResult>
  persistGitSshKey(keyFile: string): boolean
}

export interface ConfigEditorLike {
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited?: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> | void
}

export interface SetupRepository {
  fullName: string
  private: boolean
  pushedAt?: string | null
  archived?: boolean
  fork?: boolean
}

export interface TelegramHelpers {
  validate(token: string, options: { timeoutMs: number }): Promise<{ botUsername: string; botId?: number }>
}

export interface GithubHelpers {
  validate(token: string, options: { timeoutMs: number }): Promise<{ login: string }>
  listRepositories(token: string, options: { timeoutMs: number }): Promise<SetupRepository[]>
  /** Invite `login` to `repo` (operator token). */
  addCollaborator?(
    token: string,
    repo: string,
    login: string,
    permission: 'pull' | 'triage' | 'push' | 'maintain' | 'admin',
    options: { timeoutMs: number },
  ): Promise<{ alreadyCollaborator: boolean }>
  /** Pending repository invitations of the authenticated (bot) account. */
  listInvitations?(
    token: string,
    options: { timeoutMs: number },
  ): Promise<Array<{ id: number; repository: string }>>
  acceptInvitation?(
    token: string,
    invitationId: number,
    options: { timeoutMs: number },
  ): Promise<{ status: string }>
  /** Accept the pending invitation for one repository (matched by full name). */
  acceptForRepo?(
    token: string,
    repo: string,
    options: { timeoutMs: number },
  ): Promise<{ status: string; invitationId?: number }>
}

export interface SetupDeps {
  stateDir: string
  kv: KeyValueStore
  logger: AppLogger
  /** Current plugin status for `GET setup/state`. */
  plugin: () => { status: string; detail: string | null }
  /** The config the running plugin started with (raw, from the profile row). */
  currentConfig: () => Record<string, unknown> | undefined
  /** Reuse the same validator the runtime uses (returns an error message or undefined). */
  validateConfig: (candidate: unknown) => string | undefined
  /** DSH configuration service; absent on leaner hosts (→ 501). */
  configEditor: () => ConfigEditorLike | undefined
  /** The Loader entry of this plugin (`ctx.fiber.entry`), read at commit time. */
  hostEntry: () => unknown
  /** Current user-facing language (from the running config). */
  language?: () => 'zh' | 'en'
  /** Effective bot git identity (defaults already resolved from the GitHub login). */
  gitIdentity?: () => { name: string; email: string; sshKeyFile: string }
  /** ssh-keygen runner (tests inject a fake; default runs the real binary). */
  runSshKeygen?: (args: string[]) => Promise<void>
  /** DSH llm service (model catalog); absent on leaner hosts (→ 501). */
  llm?: () => LlmLike | undefined
  /** Currently effective model selections for `GET setup/state`. */
  models?: () => SetupModelsState
  /** Validate one provider/model(/reasoningEffort) before saving; returns an error message. */
  validateModel?: (provider: string, model: string, reasoningEffort?: string) => Promise<string | undefined>
  /** Bounded child-process runner for the watchdog scripts (tests inject a fake). */
  runProcess?: (file: string, args: string[], timeoutMs: number) => Promise<ProcessResult>
  /** Resolve a bundled script (watchdog.mjs / install-launchd.sh / uninstall.sh). */
  scriptPath?: (name: WatchdogScriptName) => string | undefined
  /** Test seam: override the LaunchAgent label / plist path. */
  watchdogLabel?: () => string
  watchdogPlistPath?: () => string
  redact?: (text: string) => string
  timeoutMs?: number
  /** Test seam for the post-response commit. Defaults to an unref'ed timer. */
  schedule?: (run: () => void) => void
  loadTelegramHelpers?: () => Promise<TelegramHelpers | undefined>
  loadGithubHelpers?: () => Promise<GithubHelpers | undefined>
}

const TOKEN_KIND = { telegram: 'telegram-token', github: 'github-token' } as const
const KV_TELEGRAM = 'superagent.setup.telegram'
const KV_GITHUB = 'superagent.setup.github'
const KV_OPERATOR = 'superagent.setup.githubOperator'
const KV_RESTART = 'superagent.setup.restartPending'
const MAX_TOKEN_CHARS = 512
const DEFAULT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Default source helpers (stateless, dynamic import per docs/002 §1)
// ---------------------------------------------------------------------------

async function defaultTelegramHelpers(): Promise<TelegramHelpers | undefined> {
  try {
    const module = (await import('../sources/telegram-api.js')) as unknown as {
      validateTelegramToken?: (token: string, options?: { timeoutMs?: number }) => Promise<{ ok: boolean; id: number; username: string }>
    }
    const validate = module.validateTelegramToken
    if (typeof validate !== 'function') return undefined
    return {
      async validate(token, options) {
        const result = await validate(token, { timeoutMs: options.timeoutMs })
        return { botUsername: result.username, botId: result.id }
      },
    }
  } catch {
    return undefined
  }
}

async function defaultGithubHelpers(): Promise<GithubHelpers | undefined> {
  try {
    const module = (await import('../sources/github-api.js')) as unknown as {
      validateGithubToken?: (token: string, options?: { timeoutMs?: number }) => Promise<{ ok: boolean; login: string; id: number }>
      listGithubRepositories?: (
        token: string,
        options?: { timeoutMs?: number },
      ) => Promise<Array<{ fullName: string; private: boolean; pushedAt: string | null; archived: boolean; fork: boolean }>>
      addGithubCollaborator?: (
        token: string,
        repo: string,
        username: string,
        permission?: 'pull' | 'triage' | 'push' | 'maintain' | 'admin',
        options?: { timeoutMs?: number },
      ) => Promise<{ alreadyCollaborator: boolean }>
      listRepositoryInvitations?: (
        token: string,
        options?: { timeoutMs?: number },
      ) => Promise<Array<{ id: number; repository: string }>>
      acceptRepositoryInvitation?: (
        token: string,
        invitationId: number,
        options?: { timeoutMs?: number },
      ) => Promise<{ status: string }>
      acceptInvitationForRepo?: (
        token: string,
        repo: string,
        options?: { timeoutMs?: number },
      ) => Promise<{ status: string; invitationId?: number }>
    }
    const validate = module.validateGithubToken
    const list = module.listGithubRepositories
    const addCollaborator = module.addGithubCollaborator
    const listInvitations = module.listRepositoryInvitations
    const acceptInvitation = module.acceptRepositoryInvitation
    const acceptForRepo = module.acceptInvitationForRepo
    if (typeof validate !== 'function' || typeof list !== 'function') return undefined
    return {
      async validate(token, options) {
        const result = await validate(token, { timeoutMs: options.timeoutMs })
        return { login: result.login }
      },
      async listRepositories(token, options) {
        return list(token, { timeoutMs: options.timeoutMs })
      },
      ...(typeof addCollaborator === 'function'
        ? {
            async addCollaborator(token: string, repo: string, login: string, permission: 'push' | 'admin' | 'pull' | 'triage' | 'maintain', options: { timeoutMs: number }) {
              return addCollaborator(token, repo, login, permission, { timeoutMs: options.timeoutMs })
            },
          }
        : {}),
      ...(typeof listInvitations === 'function'
        ? {
            async listInvitations(token: string, options: { timeoutMs: number }) {
              const invitations = await listInvitations(token, { timeoutMs: options.timeoutMs })
              return invitations.map(invitation => ({ id: invitation.id, repository: invitation.repository }))
            },
          }
        : {}),
      ...(typeof acceptInvitation === 'function'
        ? {
            async acceptInvitation(token: string, invitationId: number, options: { timeoutMs: number }) {
              const result = await acceptInvitation(token, invitationId, { timeoutMs: options.timeoutMs })
              return { status: result.status }
            },
          }
        : {}),
      ...(typeof acceptForRepo === 'function'
        ? {
            async acceptForRepo(token: string, repo: string, options: { timeoutMs: number }) {
              const result = await acceptForRepo(token, repo, { timeoutMs: options.timeoutMs })
              return {
                status: result.status,
                ...(result.invitationId !== undefined ? { invitationId: result.invitationId } : {}),
              }
            },
          }
        : {}),
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Merge plain objects recursively; arrays and scalars replace. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const current = next[key]
    next[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value
  }
  return next
}

function isUnder(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

/** Bound one external call; the loser keeps a rejection handler attached. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

class SetupError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, description: string) {
    super(description)
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// SetupService
// ---------------------------------------------------------------------------

export class SetupService implements SetupApi {
  private readonly deps: SetupDeps
  private readonly logger: AppLogger
  private commit?: Promise<void>
  private readonly timeoutMs: number

  constructor(deps: SetupDeps) {
    this.deps = deps
    this.logger = deps.logger
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Clear the "restart pending" marker once a fresh runtime is up. */
  markRestarted(): void {
    try {
      this.deps.kv.delete(KV_RESTART)
    } catch {
      // best effort
    }
  }

  // -- static content ------------------------------------------------------

  permissions(): SetupApiResult {
    return {
      status: 200,
      body: {
        ok: true,
        permissions: [
          {
            id: 'filesystem',
            title: 'State directory only',
            state: 'required',
            detail:
              `SuperAgent reads and writes only under ${this.deps.stateDir} ` +
              '(SQLite, per-ticket work dirs, secrets with mode 0600, heartbeat). It never touches other folders.',
            restartRequired: false,
          },
          {
            id: 'network',
            title: 'Outbound HTTPS',
            state: 'required',
            detail: 'Telegram Bot API (api.telegram.org) and the GitHub REST API only. No inbound port is opened.',
            restartRequired: false,
          },
          {
            id: 'macos-screen-recording',
            title: 'Screen Recording',
            state: 'not-required',
            detail: 'SuperAgent never captures the screen, windows or audio.',
            restartRequired: false,
          },
          {
            id: 'macos-accessibility',
            title: 'Accessibility',
            state: 'not-required',
            detail: 'SuperAgent does not control other apps or synthesize input events.',
            restartRequired: false,
          },
          {
            id: 'macos-full-disk-access',
            title: 'Full Disk Access',
            state: 'not-required',
            detail: 'Only the state directory is accessed; system-wide disk access is unnecessary.',
            restartRequired: false,
          },
          {
            id: 'telegram-bot',
            title: 'Telegram bot token',
            state: 'optional',
            detail:
              'Create a bot with @BotFather and paste its token in this wizard. A bot cannot start a chat: press Start/mention it once.',
            restartRequired: true,
          },
          {
            id: 'github-token',
            title: 'GitHub fine-grained token',
            state: 'optional',
            detail:
              'Needs Contents, Issues and Pull requests read/write (Checks and Actions read-only for CI). Repositories are selected in the wizard.',
            restartRequired: true,
          },
          {
            id: 'watchdog',
            title: 'Background watchdog (optional)',
            state: 'optional',
            detail:
              'Login item + LaunchAgent keep DSH alive across crashes. Disabled by default; install manually with scripts/install-launchd.sh.',
            restartRequired: false,
          },
          {
            id: 'restart',
            title: 'Restart required after setup changes',
            state: 'required',
            detail:
              'Saving configuration restarts the plugin (non-volatile DSH config). The wizard polls setup/state until the plugin is ready again.',
            restartRequired: true,
          },
        ] satisfies SetupPermission[],
      },
    }
  }

  // -- model catalog -------------------------------------------------------

  /**
   * List the provider routes and models the DSH `llm` service can currently
   * route. A single failing provider is reported under `errors` instead of
   * failing the whole answer; a missing `llm` service is a 501.
   */
  async listModels(): Promise<SetupApiResult> {
    const llm = this.deps.llm?.()
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      return {
        status: 501,
        body: {
          ok: false,
          error: 'llm_unavailable',
          description: 'the DSH llm service is unavailable on this host; models cannot be listed',
        },
      }
    }
    const timeoutMs = this.deps.timeoutMs ?? 5_000
    let infos: Array<{ id: string; name: string }>
    try {
      infos = llm.listProviders()
    } catch (error) {
      return this.failure(new SetupError(502, 'llm_error', this.sanitize(errorMessage(error))))
    }
    const errors: Array<{ provider: string; error: string }> = []
    const rows = await Promise.all(
      infos.map(async (info, index) => {
        try {
          const models = await withTimeout(llm.listModels(info.id), timeoutMs, `listModels(${info.id})`)
          return {
            index,
            provider: {
              id: info.id,
              name: info.name,
              models: (Array.isArray(models) ? models : []).map(model => ({
                id: model.id,
                name: model.name,
                ...(typeof model.description === 'string' ? { description: model.description } : {}),
                ...(Array.isArray(model.inputModalities)
                  ? { inputModalities: model.inputModalities.map(String) }
                  : {}),
              })),
            },
          }
        } catch (error) {
          errors.push({ provider: info.id, error: this.sanitize(errorMessage(error)) })
          return undefined
        }
      }),
    )
    const providers = rows
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .sort((left, right) => left.index - right.index)
      .map(row => row.provider)
    return {
      status: 200,
      body: {
        ok: true,
        providers,
        ...(errors.length > 0 ? { errors } : {}),
      },
    }
  }

  // -- login-item watchdog -------------------------------------------------

  private watchdogCache?: { at: number; value: SetupWatchdogState }

  private watchdogLabel(): string {
    return this.deps.watchdogLabel?.() ?? (process.env.SUPERAGENT_WATCHDOG_LABEL?.trim() || 'com.sfky.superagent.watchdog')
  }

  private watchdogPlistPath(): string {
    return this.deps.watchdogPlistPath?.() ?? join(homedir(), 'Library', 'LaunchAgents', `${this.watchdogLabel()}.plist`)
  }

  /** Bounded child-process runner; resolves with a code, never rejects. */
  private async runProcess(file: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    const runner = this.deps.runProcess
    if (runner) return runner(file, args, timeoutMs)
    return new Promise<ProcessResult>(resolve => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : -1
          resolve({
            code,
            stdout: String(stdout ?? '').slice(-4000),
            stderr: `${String(stderr ?? '')}${error && !stderr ? `\n${error.message}` : ''}`.slice(-4000),
          })
        },
      )
    })
  }

  /** Read the LaunchAgent state (cached briefly; `force` bypasses the cache). */
  private watchdogCommands(): { scriptsDir?: string; manualCommands?: SetupWatchdogCommands } {
    const install = this.deps.scriptPath?.('install-launchd.sh')
    const uninstall = this.deps.scriptPath?.('uninstall.sh')
    const watchdog = this.deps.scriptPath?.('watchdog.mjs')
    if (!install || !uninstall || !watchdog) return {}
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const stateDir = quote(this.deps.stateDir)
    return {
      scriptsDir: dirname(install),
      manualCommands: {
        dryRun: `node ${quote(watchdog)} --state-dir ${stateDir} --dry-run`,
        install: `sh ${quote(install)} --state-dir ${stateDir}`,
        uninstall: `sh ${quote(uninstall)} --state-dir ${stateDir}`,
      },
    }
  }

  async probeWatchdog(force = false): Promise<SetupWatchdogState> {
    const cached = this.watchdogCache
    if (!force && cached && Date.now() - cached.at < 10_000) return cached.value
    const label = this.watchdogLabel()
    const plistPath = this.watchdogPlistPath()
    let installed = false
    try {
      installed = (await stat(plistPath)).isFile()
    } catch {
      installed = false
    }
    let running = false
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      const result = await this.runProcess('launchctl', ['print', `gui/${uid}/${label}`], 5_000)
      running = result.code === 0
    } catch {
      running = false
    }
    const commands = this.watchdogCommands()
    const value: SetupWatchdogState = {
      installed,
      running,
      label,
      plistPath,
      stateDir: this.deps.stateDir,
      ...(commands.scriptsDir === undefined ? {} : { scriptsDir: commands.scriptsDir }),
      ...(commands.manualCommands === undefined ? {} : { manualCommands: commands.manualCommands }),
      ...(installed
        ? { detail: running ? 'installed and running' : 'installed but not loaded' }
        : { detail: 'not installed (login item disabled)' }),
    }
    this.watchdogCache = { at: Date.now(), value }
    return value
  }

  async getWatchdog(force = false): Promise<SetupApiResult> {
    const state = await this.probeWatchdog(force)
    return { status: 200, body: { ok: true, ...state } }
  }

  /**
   * Enable/disable the login-item watchdog by running the repo scripts.
   * Script output goes to the plugin log only; the response carries a generic
   * detail so host paths/outputs never reach the panel.
   */
  async setWatchdog(enabled: boolean): Promise<SetupApiResult> {
    const scriptName = enabled ? 'install-launchd.sh' : 'uninstall.sh'
    const script = this.deps.scriptPath?.(scriptName)
    const manual = `sh <bundle>/scripts/${scriptName} --state-dir ${this.deps.stateDir}`
    if (!script) {
      return {
        status: 501,
        body: {
          ok: false,
          enabled,
          error: 'watchdog_script_unavailable',
          description: `the watchdog script is not available in this build; run manually: ${manual}`,
        },
      }
    }
    try {
      const info = await stat(script)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      return {
        status: 501,
        body: {
          ok: false,
          enabled,
          error: 'watchdog_script_unavailable',
          description: `the watchdog script is missing (${script}); run manually: ${manual}`,
        },
      }
    }
    let result: ProcessResult
    try {
      result = await this.runProcess('sh', [script, '--state-dir', this.deps.stateDir], 30_000)
    } catch (error) {
      result = { code: -1, stdout: '', stderr: errorMessage(error) }
    }
    this.logger.info(`watchdog ${enabled ? 'install' : 'uninstall'} script finished`, {
      script: scriptName,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    const state = await this.probeWatchdog(true)
    if (result.code !== 0) {
      return {
        status: 500,
        body: {
          ok: false,
          enabled,
          installed: state.installed,
          running: state.running,
          error: 'watchdog_script_failed',
          description: enabled
            ? 'could not install the watchdog; see the DSH log for the script output'
            : 'could not uninstall the watchdog; see the DSH log for the script output',
        },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        enabled,
        installed: state.installed,
        running: state.running,
        detail: state.detail ?? null,
      },
    }
  }

  // -- generated SSH key ---------------------------------------------------

  /** Default directory for the SuperAgent-generated bot SSH key. */
  defaultSshKeyDir(): string {
    return join(this.deps.stateDir, 'secrets', 'github-ssh')
  }

  /** Default private-key path (`<stateDir>/secrets/github-ssh/id_ed25519`). */
  defaultSshKeyFile(): string {
    return join(this.defaultSshKeyDir(), 'id_ed25519')
  }

  private manualSshKeyCommand(keyFile: string): string {
    return `ssh-keygen -t ed25519 -f ${keyFile} -N "" -C "superagent-bot"`
  }

  private async sshKeygen(args: string[]): Promise<void> {
    const runner = this.deps.runSshKeygen
    if (runner) {
      await runner(args)
      return
    }
    await new Promise<void>((resolve, reject) => {
      execFile('ssh-keygen', args, { timeout: 20_000, windowsHide: true }, (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        const detail = String(stderr ?? '').slice(0, 300)
        const wrapped = new Error(`ssh-keygen failed${detail ? `: ${detail}` : `: ${error.message}`}`)
        ;(wrapped as NodeJS.ErrnoException).code = code
        reject(wrapped)
      })
    })
  }

  /**
   * Generate (or return) the dedicated bot SSH key pair.
   *
   * Idempotent: an existing private key is never overwritten; its public half is
   * returned. Only the public key is ever read back, and the response never
   * contains private key material.
   */
  async generateGithubSshKey(): Promise<SetupApiResult> {
    const keyDir = this.defaultSshKeyDir()
    const keyFile = this.defaultSshKeyFile()
    const publicFile = `${keyFile}.pub`
    try {
      const exists = await this.fileConfigured(keyFile)
      if (exists) {
        const publicKey = await this.readPublicKey(publicFile)
        if (!publicKey) {
          throw new SetupError(
            409,
            'ssh_key_pair_incomplete',
            `the private key exists but ${publicFile} is missing; regenerate manually: ${this.manualSshKeyCommand(keyFile)}`,
          )
        }
        return { status: 200, body: { ok: true, publicKey, keyFile, created: false } }
      }
      await mkdir(keyDir, { recursive: true, mode: 0o700 })
      await chmod(keyDir, 0o700).catch(() => undefined)
      try {
        await this.sshKeygen(['-t', 'ed25519', '-f', keyFile, '-N', '', '-C', 'superagent-bot', '-q'])
      } catch (error) {
        return this.sshKeyUnavailable(error, keyFile)
      }
      await chmod(keyFile, 0o600).catch(() => undefined)
      await chmod(publicFile, 0o644).catch(() => undefined)
      const publicKey = await this.readPublicKey(publicFile)
      if (!publicKey) {
        throw new SetupError(
          500,
          'ssh_key_generation_failed',
          `ssh-keygen succeeded but ${publicFile} is missing or empty; run manually: ${this.manualSshKeyCommand(keyFile)}`,
        )
      }
      return { status: 200, body: { ok: true, publicKey, keyFile, created: true } }
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Read the public half only; private key content is never read. */
  private async readPublicKey(publicFile: string): Promise<string | undefined> {
    try {
      const text = (await readFile(publicFile, 'utf8')).trim()
      return text.length > 0 && !text.includes('PRIVATE KEY') ? text : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Point `executor.gitSshKeyFile` at the generated key. Returns true when the
   * configEditor is available and the write was scheduled (the plugin restarts
   * right after the HTTP response is flushed).
   */
  persistGitSshKey(keyFile: string): boolean {
    try {
      const editor = this.deps.configEditor()
      const entry = this.deps.hostEntry()
      if (!editor || entry === undefined) return false
      const current = (this.deps.currentConfig()?.executor as Record<string, unknown> | undefined)?.gitSshKeyFile
      if (current === keyFile) return true
      this.commitConfigSoon({ executor: { gitSshKeyFile: keyFile } })
      return true
    } catch (error) {
      this.logger.warn('could not persist the generated git SSH key path', { error: this.sanitize(errorMessage(error)) })
      return false
    }
  }

  /** Failure path for ssh-keygen being missing (501 with a manual command). */
  private sshKeyUnavailable(error: unknown, keyFile: string): SetupApiResult {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      return {
        status: 501,
        body: {
          ok: false,
          error: 'ssh_keygen_unavailable',
          description: `ssh-keygen is not available on this host; generate the key manually: ${this.manualSshKeyCommand(keyFile)}`,
        },
      }
    }
    return this.failure(error)
  }

  // -- account state -------------------------------------------------------

  async state(): Promise<SetupApiResult> {
    const config = this.deps.currentConfig() ?? {}
    const sources = isRecord(config.sources) ? config.sources : {}
    const telegramConfig = isRecord(sources.telegram) ? sources.telegram : {}
    const githubConfig = isRecord(sources.github) ? sources.github : {}
    const telegramFile = this.configTokenFile(telegramConfig, 'telegram')
    const githubFile = this.configTokenFile(githubConfig, 'github')
    const telegramConfigured = await this.fileConfigured(telegramFile)
    const githubConfigured = await this.fileConfigured(githubFile)
    const telegramCache = this.cached<{ botUsername?: string }>(KV_TELEGRAM) ?? {}
    const githubCache = this.cached<{ login?: string; repositories?: string[] }>(KV_GITHUB) ?? {}
    const configuredRepositories = Array.isArray(githubConfig.repositories)
      ? githubConfig.repositories.filter((entry): entry is string => typeof entry === 'string')
      : []
    const repositories =
      githubCache.repositories && githubCache.repositories.length > 0 ? githubCache.repositories : configuredRepositories
    const restartRequired = this.deps.kv.get<boolean>(KV_RESTART) === true
    const language = this.deps.language?.() ?? (config.language === 'en' ? 'en' : 'zh')
    const executorConfig = isRecord(config.executor) ? config.executor : {}
    const githubLogin = typeof (isRecord(sources.github) ? sources.github.login : undefined) === 'string'
      ? String((sources.github as Record<string, unknown>).login)
      : ''
    const resolvedGit = this.deps.gitIdentity?.() ?? {
      name: typeof executorConfig.gitName === 'string' && executorConfig.gitName ? executorConfig.gitName : githubLogin,
      email:
        typeof executorConfig.gitEmail === 'string' && executorConfig.gitEmail
          ? executorConfig.gitEmail
          : githubLogin
            ? `${githubLogin}@users.noreply.github.com`
            : '',
      sshKeyFile: typeof executorConfig.gitSshKeyFile === 'string' ? executorConfig.gitSshKeyFile : '',
    }
    const defaultKeyFile = this.defaultSshKeyFile()
    const configuredKeyFile = resolvedGit.sshKeyFile.length > 0 ? resolvedGit.sshKeyFile : ''
    const effectiveKeyFile = configuredKeyFile
      ? configuredKeyFile
      : (await this.fileConfigured(defaultKeyFile))
        ? defaultKeyFile
        : ''
    const publicKey = effectiveKeyFile ? await this.readPublicKey(`${effectiveKeyFile}.pub`) : undefined
    const git: SetupGitIdentity = {
      name: resolvedGit.name,
      email: resolvedGit.email,
      sshKeyFile: effectiveKeyFile,
      sshKeyConfigured: effectiveKeyFile.length > 0 ? await this.fileConfigured(effectiveKeyFile) : false,
      ...(publicKey ? { publicKey } : {}),
    }

    const models = this.deps.models?.() ?? { router: null, worker: null, default: null }
    const watchdog = await this.probeWatchdog()

    const state: SetupState = {
      ok: true,
      stateDir: this.deps.stateDir,
      language,
      git,
      models,
      watchdog,
      plugin: this.deps.plugin(),
      accounts: {
        telegram: {
          configured: telegramConfigured,
          enabled: telegramConfig.enabled !== false,
          ...(telegramCache.botUsername ? { botUsername: telegramCache.botUsername } : {}),
          ...(telegramConfigured ? { tokenFile: telegramFile } : {}),
        },
        github: {
          configured: githubConfigured,
          enabled: githubConfig.enabled !== false,
          ...(githubCache.login ? { login: githubCache.login } : {}),
          repositories,
          count: repositories.length,
          allowSelf: githubConfig.allowSelf === true,
          collaborators: Array.isArray(githubConfig.collaborators)
            ? githubConfig.collaborators.filter((entry): entry is string => typeof entry === 'string')
            : [],
          operatorTokenConfigured: await this.fileConfigured(this.operatorTokenPath().path),
          ...(this.operatorTokenPath().configured ? { operatorTokenFile: this.operatorTokenPath().path } : {
            ...(await this.fileConfigured(this.defaultOperatorTokenFile())
              ? { operatorTokenFile: this.defaultOperatorTokenFile() }
              : {}),
          }),
          ...(githubConfigured ? { tokenFile: githubFile } : {}),
        },
      },
      permissions: this.permissions().body.permissions as SetupPermission[],
      restartRequired,
    }
    return { status: 200, body: state as unknown as Record<string, unknown> }
  }

  private cached<T>(key: string): T | undefined {
    try {
      return this.deps.kv.get<T>(key)
    } catch {
      return undefined
    }
  }

  private configTokenFile(source: Record<string, unknown>, kind: 'telegram' | 'github'): string {
    const configured = source.tokenFile
    if (typeof configured === 'string' && configured.length > 0) return configured
    return this.defaultTokenFile(kind)
  }

  private defaultTokenFile(kind: 'telegram' | 'github'): string {
    return join(this.deps.stateDir, 'secrets', TOKEN_KIND[kind])
  }

  private async fileConfigured(path: string): Promise<boolean> {
    try {
      const info = await stat(path)
      return info.isFile() && info.size > 0
    } catch {
      return false
    }
  }

  // -- token endpoints -----------------------------------------------------

  async saveTelegram(body: unknown): Promise<SetupApiResult> {
    return this.saveToken('telegram', body)
  }

  async saveGithub(body: unknown): Promise<SetupApiResult> {
    return this.saveToken('github', body)
  }

  private async saveToken(kind: 'telegram' | 'github', body: unknown): Promise<SetupApiResult> {
    try {
      if (!isRecord(body)) throw new SetupError(400, 'invalid_request', 'request body must be a JSON object')
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token.length === 0) throw new SetupError(400, 'invalid_token', `${kind} token is required`)
      if (token.length > MAX_TOKEN_CHARS) {
        throw new SetupError(400, 'invalid_token', `${kind} token is implausibly long`)
      }
      const tokenFile = this.resolveTokenFile(body.tokenFile, kind)
      const helpers =
        kind === 'telegram' ? await (this.deps.loadTelegramHelpers ?? defaultTelegramHelpers)() : undefined
      const githubHelpers = kind === 'github' ? await (this.deps.loadGithubHelpers ?? defaultGithubHelpers)() : undefined
      if (kind === 'telegram' && !helpers) {
        throw new SetupError(501, 'validation_unavailable', 'Telegram token validation is unavailable in this build')
      }
      if (kind === 'github' && !githubHelpers) {
        throw new SetupError(501, 'validation_unavailable', 'GitHub token validation is unavailable in this build')
      }

      let response: Record<string, unknown>
      if (kind === 'telegram') {
        const validated = await this.validate(() => helpers!.validate(token, { timeoutMs: this.timeoutMs }), kind)
        await this.writeSecret(tokenFile, token)
        this.cache(KV_TELEGRAM, { botUsername: validated.botUsername, botId: validated.botId })
        response = {
          ok: true,
          botUsername: validated.botUsername,
          ...(validated.botId !== undefined ? { botId: validated.botId } : {}),
          tokenFile,
        }
      } else {
        const validated = await this.validate(() => githubHelpers!.validate(token, { timeoutMs: this.timeoutMs }), kind)
        let repositories: SetupRepository[] = []
        try {
          repositories = await githubHelpers!.listRepositories(token, { timeoutMs: this.timeoutMs })
        } catch (error) {
          // The token is valid; repository listing can fail on scope/rate limits.
          this.logger.warn('github repository listing failed during setup', { error: this.sanitize(errorMessage(error)) })
        }
        await this.writeSecret(tokenFile, token)
        const fullNames = repositories.map(repository => repository.fullName).slice(0, 200)
        this.cache(KV_GITHUB, { login: validated.login, repositories: fullNames })
        response = {
          ok: true,
          login: validated.login,
          repositories: repositories.slice(0, 200),
          tokenFile,
        }
      }
      return { status: 200, body: response }
    } catch (error) {
      return this.failure(error)
    }
  }

  private async validate<T>(run: () => Promise<T>, kind: 'telegram' | 'github'): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const message = this.sanitize(errorMessage(error))
      const name = error instanceof Error ? error.name : ''
      const details = (error ?? {}) as { code?: unknown; status?: unknown; rateLimited?: unknown }
      const httpStatus =
        typeof details.status === 'number' ? details.status : typeof details.code === 'number' ? details.code : undefined
      if (details.rateLimited === true || httpStatus === 429) {
        throw new SetupError(429, 'rate_limited', message || `${kind} API rate limit reached; retry later`)
      }
      // 401/403/404 and other 4xx answers mean the token itself is unusable;
      // transport failures, timeouts and 5xx are upstream problems (502).
      const invalid =
        name.endsWith('TokenValidationError') &&
        httpStatus !== undefined &&
        httpStatus !== 0 &&
        httpStatus !== 408 &&
        httpStatus < 500
      throw new SetupError(
        invalid ? 400 : 502,
        invalid ? 'invalid_token' : 'validation_failed',
        message || `${kind} token validation failed`,
      )
    }
  }

  // -- personal (operator) PAT ---------------------------------------------

  /** Default file for the personal PAT used to invite/accept repositories. */
  defaultOperatorTokenFile(): string {
    return join(this.deps.stateDir, 'secrets', 'github-operator-token')
  }

  /** Path of the configured (or default) operator PAT. */
  private operatorTokenPath(): { path: string; configured: boolean } {
    const sources = isRecord(this.deps.currentConfig()?.sources) ? (this.deps.currentConfig()!.sources as Record<string, unknown>) : {}
    const github = isRecord(sources.github) ? sources.github : {}
    const configured = typeof github.operatorTokenFile === 'string' ? github.operatorTokenFile.trim() : ''
    return configured
      ? { path: configured, configured: true }
      : { path: this.defaultOperatorTokenFile(), configured: false }
  }

  private async readTokenFile(path: string): Promise<string | undefined> {
    try {
      const token = (await readFile(path, 'utf8')).trim()
      return token.length > 0 ? token : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Save a personal (operator) PAT and use it to bootstrap the bot account:
   * invite the bot as a push collaborator on the selected repositories, then
   * let the bot accept the pending invitations. Per-repository failures are
   * warnings (the token is still saved); the response never contains tokens.
   */
  async saveOperatorToken(body: unknown): Promise<SetupApiResult> {
    try {
      if (!isRecord(body)) throw new SetupError(400, 'invalid_request', 'request body must be a JSON object')
      if (body.remove === true) return this.removeOperatorToken()
      const token =
        typeof body.personalToken === 'string'
          ? body.personalToken.trim()
          : typeof body.token === 'string'
            ? body.token.trim()
            : ''
      if (token.length === 0) throw new SetupError(400, 'invalid_token', 'operator token is required')
      if (token.length > MAX_TOKEN_CHARS) throw new SetupError(400, 'invalid_token', 'operator token is implausibly long')

      const helpers = await (this.deps.loadGithubHelpers ?? defaultGithubHelpers)()
      if (!helpers) throw new SetupError(501, 'validation_unavailable', 'GitHub token validation is unavailable in this build')

      let login: string
      try {
        login = (await helpers.validate(token, { timeoutMs: this.timeoutMs })).login
      } catch (error) {
        const message = this.sanitize(errorMessage(error))
        const name = error instanceof Error ? error.name : ''
        throw new SetupError(name.endsWith('TokenValidationError') ? 400 : 502, 'invalid_token', message)
      }

      const config = this.deps.currentConfig() ?? {}
      const sources = isRecord(config.sources) ? config.sources : {}
      const github = isRecord(sources.github) ? sources.github : {}
      const requestedRepositories = Array.isArray(body.repositories)
        ? body.repositories.filter((entry): entry is string => typeof entry === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry))
        : Array.isArray(github.repositories)
          ? github.repositories.filter((entry): entry is string => typeof entry === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry))
          : []

      const botLogin =
        typeof body.botLogin === 'string' && body.botLogin.trim()
          ? body.botLogin.trim()
          : await this.resolveBotLogin(github, helpers)
      if (!botLogin) {
        throw new SetupError(
          400,
          'bot_login_unknown',
          'save the bot token first (or set sources.github.login) so the bot account can be invited',
        )
      }

      const warnings: string[] = []
      const invited: Array<{ repo: string; login: string; status: 'invited' | 'already' }> = []
      if (requestedRepositories.length === 0) {
        warnings.push('no repositories selected; the operator token was saved but the bot was not invited anywhere')
      }
      for (const repo of requestedRepositories.slice(0, 200)) {
        const add = helpers.addCollaborator
        if (!add) {
          warnings.push('collaborator helpers are unavailable in this build; add the bot manually')
          break
        }
        try {
          const result = await add(token, repo, botLogin, 'push', { timeoutMs: this.timeoutMs })
          invited.push({ repo, login: botLogin, status: result.alreadyCollaborator ? 'already' : 'invited' })
        } catch (error) {
          warnings.push(`could not invite the bot to ${repo}: ${this.sanitize(errorMessage(error))}`)
        }
      }

      const accepted: Array<{ repo: string; status: string; invitationId?: number }> = []
      const botToken = await this.botToken(github)
      if (!botToken) {
        if (invited.length > 0) warnings.push('bot token is not available; the bot cannot accept invitations automatically')
      } else {
        for (const repo of invited.map(entry => entry.repo)) {
          try {
            const result = helpers.acceptForRepo
              ? await helpers.acceptForRepo(botToken, repo, { timeoutMs: this.timeoutMs })
              : await this.acceptWithList(helpers, botToken, repo)
            accepted.push({
              repo,
              status: result?.status ?? 'none',
              ...(result?.invitationId !== undefined ? { invitationId: result.invitationId } : {}),
            })
          } catch (error) {
            warnings.push(`could not accept the invitation for ${repo}: ${this.sanitize(errorMessage(error))}`)
          }
        }
      }

      const operatorFile = this.resolveTokenFile(body.tokenFile, 'github') === this.defaultTokenFile('github')
        ? this.defaultOperatorTokenFile()
        : this.operatorTargetFile(body.tokenFile)
      await this.writeSecret(operatorFile, token)
      this.cache(KV_OPERATOR, { login, at: this.deps.kv.get<unknown>(KV_GITHUB) ?? null })

      return {
        status: 200,
        body: {
          ok: true,
          operator: login,
          login,
          operatorTokenConfigured: true,
          operatorTokenFile: operatorFile,
          invited,
          accepted,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      }
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Remove the saved personal PAT (file + configured path) — tolerant of missing files. */
  async removeOperatorToken(): Promise<SetupApiResult> {
    try {
      const target = this.operatorTokenPath().path
      let removed = false
      try {
        await rm(target, { force: true })
        removed = true
      } catch (error) {
        this.logger.warn('could not delete the operator token file', { error: this.sanitize(errorMessage(error)) })
      }
      try {
        this.deps.kv.delete(KV_OPERATOR)
      } catch {
        // best effort
      }
      return {
        status: 200,
        body: {
          ok: true,
          removed,
          operatorTokenConfigured: false,
          operatorTokenFile: target,
          restarting: this.persistOperatorTokenClear(),
        },
      }
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Clear `sources.github.operatorTokenFile` in the config (response-first restart). */
  persistOperatorTokenClear(): boolean {
    try {
      const editor = this.deps.configEditor()
      const entry = this.deps.hostEntry()
      if (!editor || entry === undefined) return false
      const sources = isRecord(this.deps.currentConfig()?.sources) ? (this.deps.currentConfig()!.sources as Record<string, unknown>) : {}
      const github = isRecord(sources.github) ? sources.github : {}
      if (github.operatorTokenFile === '' || github.operatorTokenFile === undefined) return true
      this.commitConfigSoon({ sources: { github: { operatorTokenFile: '' } } })
      return true
    } catch (error) {
      this.logger.warn('could not clear the operator token path', { error: this.sanitize(errorMessage(error)) })
      return false
    }
  }

  /** Validate a body-supplied operator token file (absolute) or fall back to default. */
  private operatorTargetFile(raw: unknown): string {
    if (raw === undefined || raw === null || raw === '') return this.defaultOperatorTokenFile()
    if (typeof raw !== 'string') throw new SetupError(400, 'invalid_token_file', 'tokenFile must be a string')
    const value = raw.trim()
    if (value.length === 0) return this.defaultOperatorTokenFile()
    if (value.includes('\0')) throw new SetupError(400, 'invalid_token_file', 'tokenFile contains a NUL byte')
    if (!isAbsolute(value)) throw new SetupError(400, 'invalid_token_file', 'tokenFile must be an absolute path')
    return value
  }

  private async resolveBotLogin(
    github: Record<string, unknown>,
    helpers: GithubHelpers,
  ): Promise<string | undefined> {
    if (typeof github.login === 'string' && github.login.trim()) return github.login.trim()
    const cached = this.cached<{ login?: string }>(KV_GITHUB)
    if (typeof cached?.login === 'string' && cached.login) return cached.login
    const botToken = await this.botToken(github)
    if (!botToken) return undefined
    try {
      return (await helpers.validate(botToken, { timeoutMs: this.timeoutMs })).login
    } catch {
      return undefined
    }
  }

  private async botToken(github: Record<string, unknown>): Promise<string | undefined> {
    const configured = typeof github.tokenFile === 'string' && github.tokenFile ? github.tokenFile : undefined
    return this.readTokenFile(configured ?? this.defaultTokenFile('github'))
  }

  private async acceptWithList(
    helpers: GithubHelpers,
    botToken: string,
    repo: string,
  ): Promise<{ status: string; invitationId?: number } | undefined> {
    if (!helpers.listInvitations || !helpers.acceptInvitation) return undefined
    const invitations = await helpers.listInvitations(botToken, { timeoutMs: this.timeoutMs })
    const lower = repo.toLowerCase()
    const match = invitations.find(invitation => invitation.repository.toLowerCase() === lower)
    if (!match) return { status: 'none' }
    const result = await helpers.acceptInvitation(botToken, match.id, { timeoutMs: this.timeoutMs })
    return { status: result.status, invitationId: match.id }
  }

  /** Point `sources.github.operatorTokenFile` at the saved file (response-first restart). */
  persistOperatorTokenFile(operatorFile: string): boolean {
    try {
      const editor = this.deps.configEditor()
      const entry = this.deps.hostEntry()
      if (!editor || entry === undefined) return false
      const sources = isRecord(this.deps.currentConfig()?.sources) ? (this.deps.currentConfig()!.sources as Record<string, unknown>) : {}
      const github = isRecord(sources.github) ? sources.github : {}
      if (github.operatorTokenFile === operatorFile) return true
      this.commitConfigSoon({ sources: { github: { operatorTokenFile: operatorFile } } })
      return true
    } catch (error) {
      this.logger.warn('could not persist the operator token path', { error: this.sanitize(errorMessage(error)) })
      return false
    }
  }

  private resolveTokenFile(raw: unknown, kind: 'telegram' | 'github'): string {
    if (raw === undefined || raw === null || raw === '') return this.defaultTokenFile(kind)
    if (typeof raw !== 'string') throw new SetupError(400, 'invalid_token_file', 'tokenFile must be a string')
    const value = raw.trim()
    if (value.length === 0) return this.defaultTokenFile(kind)
    if (value.includes('\0')) throw new SetupError(400, 'invalid_token_file', 'tokenFile contains a NUL byte')
    if (!isAbsolute(value)) throw new SetupError(400, 'invalid_token_file', 'tokenFile must be an absolute path')
    return value
  }

  private async writeSecret(tokenFile: string, token: string): Promise<void> {
    const directory = dirname(tokenFile)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (isUnder(this.deps.stateDir, directory)) {
      // Keep the wizard-owned secrets directory private even if it already existed.
      await chmod(directory, 0o700).catch(() => undefined)
    }
    const temporary = `${tokenFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(temporary, `${token}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => undefined)
    await rename(temporary, tokenFile)
    await chmod(tokenFile, 0o600).catch(() => undefined)
  }

  private cache(key: string, value: Record<string, unknown>): void {
    try {
      this.deps.kv.set(key, value)
    } catch (error) {
      this.logger.warn('could not cache setup metadata', { error: this.sanitize(errorMessage(error)) })
    }
  }

  // -- configuration -------------------------------------------------------

  async prepareConfig(body: unknown): Promise<{ result: SetupApiResult; patch?: SetupConfigPatch }> {
    try {
      if (!isRecord(body)) throw new SetupError(400, 'invalid_request', 'request body must be a JSON object')
      const desired = isRecord(body.config) ? body.config : undefined
      if (!desired) throw new SetupError(400, 'invalid_request', 'config must be a JSON object')
      const patch: SetupConfigPatch = {}
      for (const key of ['sources', 'policy', 'router', 'executor', 'quiet'] as const) {
        const value = desired[key]
        if (value === undefined) continue
        if (!isRecord(value)) throw new SetupError(400, 'invalid_config', `${key} must be a JSON object`)
        patch[key] = value
      }
      const language = desired.language
      if (language !== undefined) {
        if (language !== 'zh' && language !== 'en') {
          throw new SetupError(400, 'invalid_config', 'language must be zh or en')
        }
        patch.language = language
      }
      if (Object.keys(patch).length === 0) {
        throw new SetupError(400, 'invalid_config', 'config must contain sources, policy, router, executor, quiet or language')
      }
      this.assertSafePatch(patch)
      const base = this.deps.currentConfig() ?? {}
      const merged = deepMerge(base, patch as Record<string, unknown>)
      const problem = this.deps.validateConfig(merged)
      if (problem) throw new SetupError(400, 'invalid_config', problem)
      await this.validateModelSelections(patch)
      if (this.deps.configEditor() === undefined || this.deps.hostEntry() === undefined) {
        throw new SetupError(
          501,
          'config_editor_unavailable',
          'This host does not expose the DSH configEditor service; edit the profile patch manually.',
        )
      }
      return {
        result: { status: 200, body: { ok: true, restarting: true } },
        patch,
      }
    } catch (error) {
      return { result: this.failure(error) }
    }
  }

  /**
   * Validate explicit model routes against the DSH llm service before writing
   * any config. A missing `llm` service cannot validate, so structural checks
   * only are applied there (the route still fails loudly on first use).
   */
  private async validateModelSelections(patch: SetupConfigPatch): Promise<void> {
    const validate = this.deps.validateModel
    if (!validate) return
    const checks: Array<{ scope: string; provider: string; model: string; effort?: string }> = []
    const router = isRecord(patch.router) ? patch.router : undefined
    if (router && typeof router.provider === 'string' && typeof router.model === 'string') {
      checks.push({
        scope: 'router',
        provider: router.provider,
        model: router.model,
        ...(typeof router.reasoningEffort === 'string' ? { effort: router.reasoningEffort } : {}),
      })
    }
    const executor = isRecord(patch.executor) ? patch.executor : undefined
    if (executor && typeof executor.provider === 'string' && typeof executor.model === 'string') {
      checks.push({
        scope: 'executor',
        provider: executor.provider,
        model: executor.model,
        ...(typeof executor.reasoningEffort === 'string' ? { effort: executor.reasoningEffort } : {}),
      })
    }
    for (const check of checks) {
      let problem: string | undefined
      try {
        problem = await validate(check.provider, check.model, check.effort)
      } catch (error) {
        problem = this.sanitize(errorMessage(error))
      }
      if (problem) {
        throw new SetupError(400, 'invalid_model', `${check.scope}: ${problem}`)
      }
    }
  }

  private assertSafePatch(patch: SetupConfigPatch): void {
    for (const [sourceId, source] of Object.entries((patch.sources ?? {}) as Record<string, unknown>)) {
      if (!isRecord(source)) throw new SetupError(400, 'invalid_config', `sources.${sourceId} must be a JSON object`)
      if (source.tokenFile !== undefined) {
        if (typeof source.tokenFile !== 'string' || source.tokenFile.trim().length === 0) {
          throw new SetupError(400, 'invalid_config', `sources.${sourceId}.tokenFile must be a non-empty string`)
        }
        if (!isAbsolute(source.tokenFile)) {
          throw new SetupError(400, 'invalid_config', `sources.${sourceId}.tokenFile must be an absolute path`)
        }
      }
      if (source.operatorTokenFile !== undefined) {
        if (typeof source.operatorTokenFile !== 'string' || source.operatorTokenFile.trim().length === 0) {
          throw new SetupError(400, 'invalid_config', `sources.${sourceId}.operatorTokenFile must be a non-empty string`)
        }
        if (!isAbsolute(source.operatorTokenFile)) {
          throw new SetupError(
            400,
            'invalid_config',
            `sources.${sourceId}.operatorTokenFile must be an absolute path`,
          )
        }
      }
    }
    const mode = (patch.policy as Record<string, unknown> | undefined)?.mode
    if (mode !== undefined && mode !== 'off' && mode !== 'observe' && mode !== 'auto') {
      throw new SetupError(400, 'invalid_config', 'policy.mode must be off, observe or auto')
    }
    this.assertModelPatch('router', patch.router)
    this.assertModelPatch('executor', patch.executor)
  }

  /** Structural checks for one provider/model/reasoningEffort patch. */
  private assertModelPatch(scope: 'router' | 'executor', value: Record<string, unknown> | undefined): void {
    if (!value) return
    const provider = value.provider
    const model = value.model
    const effort = value.reasoningEffort
    for (const [field, candidate] of [
      ['provider', provider],
      ['model', model],
      ['reasoningEffort', effort],
    ] as const) {
      if (candidate !== undefined && candidate !== '' && typeof candidate !== 'string') {
        throw new SetupError(400, 'invalid_config', `${scope}.${field} must be a string`)
      }
      if (typeof candidate === 'string' && candidate.length > 200) {
        throw new SetupError(400, 'invalid_config', `${scope}.${field} is implausibly long`)
      }
    }
    const hasProvider = typeof provider === 'string' && provider.trim().length > 0
    const hasModel = typeof model === 'string' && model.trim().length > 0
    if (hasProvider !== hasModel) {
      throw new SetupError(400, 'invalid_config', `${scope}.provider and ${scope}.model must be set together`)
    }
  }

  /**
   * Schedule the persistence until after the HTTP response has been written.
   * The DSH configEditor restarts this plugin for non-volatile fields, so the
   * response must be flushed first (docs/002 §2).
   */
  commitConfigSoon(patch: SetupConfigPatch): void {
    const run = (): void => {
      this.commit = this.applyConfig(patch).catch((error: unknown) => {
        this.logger.error('could not persist the setup configuration', { error: this.sanitize(errorMessage(error)) })
      })
    }
    const schedule = this.deps.schedule ?? ((fn: () => void) => {
      const timer = setTimeout(fn, 25)
      timer.unref?.()
    })
    try {
      this.deps.kv.set(KV_RESTART, true)
    } catch {
      // best effort
    }
    try {
      schedule(run)
    } catch (error) {
      this.logger.error('could not schedule the setup configuration commit', { error: this.sanitize(errorMessage(error)) })
    }
  }

  /** Await the scheduled commit (tests/tools; not used by the HTTP path). */
  async waitForCommit(timeoutMs = 2_000): Promise<void> {
    if (!this.commit) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 10)
        timer.unref?.()
      })
    }
    if (!this.commit) return
    await Promise.race([
      this.commit,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  }

  /** Persist the patch through the DSH configEditor (single source of truth). */
  async applyConfig(patch: SetupConfigPatch): Promise<void> {
    const editor = this.deps.configEditor()
    const entry = this.deps.hostEntry()
    if (!editor || entry === undefined) {
      throw new SetupError(501, 'config_editor_unavailable', 'the DSH configEditor service is unavailable')
    }
    await editor.edit(entry, current => {
      const base = this.deps.currentConfig() ?? {}
      return deepMerge(deepMerge(base, current ?? {}), patch as Record<string, unknown>)
    })
    this.logger.info('setup configuration persisted; the plugin will restart')
  }

  // -- error handling ------------------------------------------------------

  private failure(error: unknown): SetupApiResult {
    if (error instanceof SetupError) {
      return {
        status: error.status,
        body: { ok: false, error: error.code, description: this.sanitize(error.message) },
      }
    }
    this.logger.error('setup request failed', { error: this.sanitize(errorMessage(error)) })
    return {
      status: 500,
      body: { ok: false, error: 'internal_error', description: this.sanitize(errorMessage(error)) || 'internal error' },
    }
  }

  private sanitize(text: string): string {
    const redact = this.deps.redact ?? ((value: string) => value)
    return redact(text).slice(0, 500)
  }
}
