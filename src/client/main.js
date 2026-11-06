/**
 * Superagent panel — dashboard, one-click setup wizard and permissions page.
 *
 * This is a plain-JavaScript dynamic Client module (the `window.__ModuleLoader__`
 * format DSH loads for a bundle's `dsh.client` entry). It registers
 *  - one entry in the left sidebar's panel list, and
 *  - the page that entry opens in the layout's keyed `main` slot.
 *
 * Pages:
 *  - Overview: plugin/source health, tickets waiting for a person, active
 *    tickets, component health, pause/resume/retry/stop.
 *  - Setup: a stepper wizard (Telegram -> GitHub -> behavior -> finish) that
 *    validates tokens through `/superagent/api/setup/*` and saves the plugin
 *    configuration with `PUT /superagent/api/setup/config`; it then polls until
 *    the restarted plugin is ready.
 *  - Permissions: what SuperAgent does and does not need from macOS, plus the
 *    optional watchdog commands.
 *
 * Every request carries `x-superagent-request: 1`; every failure is rendered
 * inside the page — the host page is never affected. The factory catches its
 * own errors, and a bundle that cannot load degrades to a no-op module.
 *
 * The module deliberately has no build-time dependencies: React comes from the
 * browser module table, and styling is one scoped stylesheet using DSH theme
 * tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-superagent-personal',
  factory(require) {
    'use strict'
    try {
      return build(require)
    } catch (error) {
      // A broken panel must never take the page down; leave the host untouched.
      console.warn('[superagent] panel failed to load:', error)
      return { inject: [], apply() {} }
    }
  },
})

function build(require) {
  const React = require('react')
  const h = React.createElement

  const NS = 'superagent'
  const PANEL_ID = 'superagent'
  const API = '/superagent/api'
  const FENCE_HEADERS = { 'x-superagent-request': '1' }
  const REQUEST_TIMEOUT_MS = 8000
  const STATE_POLL_MS = 5000
  const SETUP_POLL_MS = 5000
  const RESTART_POLL_MS = 2000
  const RESTART_WAIT_MS = 60000
  const MAX_WORKERS = 8

  const API_PATHS = {
    state: `${API}/state`,
    action: `${API}/action`,
    setupState: `${API}/setup/state`,
    setupTelegram: `${API}/setup/telegram`,
    setupGithub: `${API}/setup/github`,
    setupConfig: `${API}/setup/config`,
    setupPermissions: `${API}/setup/permissions`,
    permissions: `${API}/permissions`,
  }

  // -- locale -----------------------------------------------------------------

  const ZH = {
    'app.title': 'Superagent',
    'panel': 'Superagent',
    'app.subtitle': '常驻在线的个人助手 · Telegram + GitHub',
    'nav.overview': '看板',
    'nav.setup': '设置',
    'nav.permissions': '权限',
    'common.refresh': '刷新',
    'common.retry': '重试',
    'common.back': '返回',
    'common.next': '下一步',
    'common.save': '保存',
    'common.skip': '暂时跳过',
    'common.loading': '正在加载…',
    'common.notConfigured': '未配置',
    'common.configured': '已配置',
    'common.optional': '可选',
    'common.recommended': '推荐',
    'common.required': '必需',
    'common.updated': '更新于',
    'common.error': '出错了',
    'common.tryAgain': '再试一次',
    'common.restartRequired': '需要重启插件后生效',
    'common.show': '显示',
    'common.hide': '隐藏',
    'common.copy': '复制',
    'common.restarting': '插件重启中…',
    'common.noValue': '—',
    'status.ready': '运行中',
    'status.starting': '启动中',
    'status.degraded': '已降级',
    'status.stopped': '已停止',
    'status.paused': '已暂停',
    'status.running': '处理中',
    'status.off': '关闭',
    'status.error': '异常',
    'overview.title': '看板',
    'overview.attention': '待你处理',
    'overview.active': '进行中',
    'overview.sources': '来源',
    'overview.sourcesHealthy': '来源健康',
    'overview.health': '组件健康',
    'overview.noAttention': '没有需要你处理的事项',
    'overview.noAttentionHint': 'Worker 只有在需要决策、验收或失败时才会打扰你。',
    'overview.noActive': '没有进行中的 Ticket',
    'overview.noActiveHint': '在 Telegram 或 GitHub 里 @ 它，或在允许的私聊里直接下指令。',
    'overview.noSources': '还没有启用的来源',
    'overview.noSourcesHint': '打开「设置」完成 Telegram 或 GitHub 的配置。',
    'overview.noHealth': '运行时还没有上报组件健康',
    'overview.waitingForYou': '等待你的决定',
    'overview.pluginDetail': '插件详情',
    'overview.setupBannerTitle': '还差一步就能开始',
    'overview.setupBannerBody': '用向导连接 Telegram 与 GitHub，不需要手改配置文件。',
    'overview.openSetup': '开始设置',
    'overview.pause': '暂停处理',
    'overview.resume': '恢复处理',
    'overview.retry': '重试',
    'overview.stop': '停止',
    'overview.offlineTitle': '无法连接 Superagent',
    'overview.offlineBody': '插件可能正在重启、已降级或未运行。DSH 本身不受影响。',
    'overview.apiHint': '接口：GET /superagent/api/state',
    'overview.reportTip': '最近报告',
    'overview.settings': '设置',
    'setup.title': '设置向导',
    'setup.apiOffline': '设置接口暂时不可用：插件可能未就绪或正在重启。',
    'setup.subtitle': '三步连接来源，一步保存生效。保存后插件会自动重启，无需重启 DSH。',
    'setup.progress': '已完成 {done}/{total}',
    'setup.step.telegram': 'Telegram',
    'setup.step.github': 'GitHub',
    'setup.step.behavior': '行为',
    'setup.step.finish': '完成',
    'setup.reconfigure': '重新配置',
    'setup.configuredNotice': '当前来源已配置。重新走一遍向导会覆盖 token、仓库选择与 allowSelf 选项。',
    'setup.restartNote': '保存后插件会自动重启；向导会轮询直到重新就绪。',
    'telegram.title': '连接 Telegram',
    'telegram.desc': 'Telegram 是它的主界面：私聊下指令、接收需要你决策或验收的消息。',
    'telegram.howto1': '在 Telegram 里打开 @BotFather，发送 /newbot，按提示取一个名字。',
    'telegram.howto2': '复制 BotFather 返回的 token（只显示一次）。',
    'telegram.howto3': '把 token 粘贴到下面；校验通过后点 Start 打开与 bot 的对话。',
    'telegram.tokenLabel': 'Bot token',
    'telegram.tokenPlaceholder': '123456789:AA…（只在本机保存，不回显）',
    'telegram.tokenHint': 'token 只会写入本机文件（0600），不会出现在日志或配置里。',
    'telegram.validate': '校验并保存',
    'telegram.validating': '正在校验…',
    'telegram.success': 'Telegram 已连接',
    'telegram.bot': 'bot',
    'telegram.start': '打开与 bot 的对话',
    'telegram.startHint': 'bot 不能主动发起会话，需要你先点 Start / 发送一条消息，它才能回复你。',
    'telegram.skip': '先跳过 Telegram',
    'telegram.skipped': '已跳过 Telegram，本次不会启用该来源。',
    'telegram.error': '校验失败',
    'telegram.botfather': '打开 @BotFather',
    'telegram.noOauth': 'Telegram 没有可用的 OAuth：必须由你创建 bot 并粘贴 token。',
    'github.title': '连接 GitHub',
    'github.desc': 'GitHub 用来接收 Issue、PR、评论与 CI 事件，并以 agent 身份提交分支和 PR。',
    'github.permsTitle': '这个 fine-grained PAT 需要',
    'github.permContents': 'Contents: Read and write',
    'github.permIssues': 'Issues: Read and write',
    'github.permPulls': 'Pull requests: Read and write',
    'github.permChecks': 'Checks: Read（看 CI 结果）',
    'github.permActions': 'Actions: Read（看 CI 日志）',
    'github.tokenLabel': 'Fine-grained PAT',
    'github.tokenPlaceholder': 'github_pat_…（只在本机保存，不回显）',
    'github.tokenHint': '只勾选需要它工作的仓库；建议单独建一个机器账号。',
    'github.validate': '校验并读取仓库',
    'github.validating': '正在校验…',
    'github.success': 'GitHub 已连接',
    'github.login': '账号',
    'github.repos': '选择要监听的仓库',
    'github.searchRepos': '搜索仓库…',
    'github.selectAll': '全选',
    'github.selectNone': '全不选',
    'github.selected': '已选 {count} 个',
    'github.allowSelf': '我使用自己的 GitHub 账号（允许我自己的事件触发）',
    'github.allowSelfHint': '默认关闭，避免 agent 自己的评论/PR 事件反过来触发新工作。大多数人用自己的账号当 agent 时需要打开；有专用机器账号时保持关闭（只处理别人的事件）。',
    'github.private': '私有',
    'github.pushed': '最近推送',
    'github.emptyRepos': '这个 token 看不到任何仓库；确认授权范围。',
    'github.skip': '先跳过 GitHub',
    'github.skipped': '已跳过 GitHub，本次不会启用该来源。',
    'github.error': '校验失败',
    'github.selectAtLeastOne': '至少选择一个仓库。',
    'github.fineGrained': 'fine-grained PAT',
    'behavior.title': '行为设置',
    'behavior.desc': '决定谁能让它干活，以及它有多主动。之后可以在设置里随时修改。',
    'behavior.allowedUsers': '允许的 Telegram user id',
    'behavior.allowedUsersHint': '多个用逗号分隔；只接受数字 id。可给 @userinfobot 发消息获取。',
    'behavior.mode': '接受模式',
    'behavior.modeObserve': 'observe · 先观察',
    'behavior.modeObserveHint': '记录“本来会接”的工作但不执行，适合头几天校准。',
    'behavior.modeAuto': 'auto · 自动接单',
    'behavior.modeAutoHint': '按规则自动接受推断出的候选；建议先跑几天 observe。',
    'behavior.modeOff': 'off · 只接明确请求',
    'behavior.modeOffHint': '只有明确 @ 或私聊指定的事情才会开工。',
    'behavior.workers': '并行 Worker 数',
    'behavior.workersHint': '同时运行的 Ticket 上限，笔记本建议 1–2。',
    'behavior.errorUsers': '请至少填一个允许的 Telegram user id，或跳过 Telegram。',
    'behavior.errorMode': '请选择接受模式。',
    'behavior.telegramSkipped': 'Telegram 未启用，可留空；启用 Telegram 后必须填写。',
    'finish.title': '保存并启用',
    'finish.desc': '确认下面的内容，保存后插件会自动重启以加载新配置。',
    'finish.summary': '即将保存',
    'finish.telegram': 'Telegram',
    'finish.github': 'GitHub',
    'finish.mode': '接受模式',
    'finish.workers': 'Worker 数',
    'finish.save': '保存并启用',
    'finish.saving': '正在保存…',
    'finish.restarting': '插件重启中，正在等待就绪…',
    'finish.restartWait': '最多等待 60 秒；如果没有恢复，请查看 DSH 日志。',
    'finish.done': '设置完成',
    'finish.doneHint': '插件已重新就绪。去 Telegram 发一条 /status 试试。',
    'finish.timeout': '插件还没有恢复',
    'finish.timeoutHint': '配置已保存，但插件在 60 秒内没有回到 ready。检查 DSH 日志或稍后刷新。',
    'finish.error': '保存失败',
    'finish.openDashboard': '打开看板',
    'finish.reconfigure': '再配置一次',
    'finish.restartNote': '部分设置需要插件重启后生效；向导会自动等待。',
    'finish.noTelegram': '未配置（跳过）',
    'finish.noGithub': '未配置（跳过）',
    'permissions.title': '权限与安全边界',
    'permissions.subtitle': 'SuperAgent 只做你明确允许的事；以下是它需要和不需要的系统权限。',
    'permissions.screen': '屏幕录制',
    'permissions.screenDetail': '不需要。面板和 Worker 都不会截屏；只有你另外安装 Computer Use 插件时才与 DSH 相关。',
    'permissions.accessibility': '辅助功能',
    'permissions.accessibilityDetail': '不需要。SuperAgent 不模拟键鼠输入。',
    'permissions.disk': '完全磁盘访问',
    'permissions.diskDetail': '不需要。它只读写 stateDir 与 Worker 工作目录，以及 Telegram/GitHub 网络请求。',
    'permissions.network': '网络访问',
    'permissions.networkDetail': '需要。访问 Telegram Bot API 与 GitHub API；只监听本机 loopback 的管理接口。',
    'permissions.shell': '本机命令与文件',
    'permissions.shellDetail': 'Worker 会以你的 macOS 用户身份执行命令（可读写你能访问的文件）。想隔离时，给 agent 用独立系统账号。',
    'permissions.watchdog': '看门狗（可选）',
    'permissions.watchdogDetail': '登录自启并在 DSH 崩溃后重启它。默认不安装；不装也能用，只是进程退出后不会自动恢复。',
    'permissions.watchdogOff': '默认关闭',
    'permissions.watchdogCommands': '手动安装与检查',
    'permissions.restart': '生效方式',
    'permissions.restartDetail': '保存配置后插件会自动重启；不需要重启整个 DSH。个别系统级改动（例如更换 stateDir）需要重启 DSH。',
    'permissions.none': '不需要',
    'permissions.required': '需要',
    'permissions.notRequired': '不需要',
    'permissions.optional': '可选',
    'permissions.api': '运行时权限项',
    'permissions.apiEmpty': '运行时还没有上报权限项。',
    'action.paused': '已暂停处理',
    'action.resumed': '已恢复处理',
    'action.retried': '已请求重试',
    'action.stopped': '已停止 Ticket',
    'action.failed': '操作失败',
    'action.unknown': '未知操作',
    'time.justNow': '刚刚',
  }

  const EN = {
    'app.title': 'Superagent',
    'panel': 'Superagent',
    'app.subtitle': 'A personal always-on agent · Telegram + GitHub',
    'nav.overview': 'Overview',
    'nav.setup': 'Setup',
    'nav.permissions': 'Permissions',
    'common.refresh': 'Refresh',
    'common.retry': 'Retry',
    'common.back': 'Back',
    'common.next': 'Continue',
    'common.save': 'Save',
    'common.skip': 'Skip for now',
    'common.loading': 'Loading…',
    'common.notConfigured': 'Not configured',
    'common.configured': 'Configured',
    'common.optional': 'Optional',
    'common.recommended': 'Recommended',
    'common.required': 'Required',
    'common.updated': 'Updated',
    'common.error': 'Something went wrong',
    'common.tryAgain': 'Try again',
    'common.restartRequired': 'Restart the plugin to apply',
    'common.show': 'Show',
    'common.hide': 'Hide',
    'common.copy': 'Copy',
    'common.restarting': 'Restarting the plugin…',
    'common.noValue': '—',
    'status.ready': 'Running',
    'status.starting': 'Starting',
    'status.degraded': 'Degraded',
    'status.stopped': 'Stopped',
    'status.paused': 'Paused',
    'status.running': 'Working',
    'status.off': 'Off',
    'status.error': 'Error',
    'overview.title': 'Overview',
    'overview.attention': 'Waiting for you',
    'overview.active': 'In progress',
    'overview.sources': 'Sources',
    'overview.sourcesHealthy': 'Sources healthy',
    'overview.health': 'Components',
    'overview.noAttention': 'Nothing needs your attention',
    'overview.noAttentionHint': 'Workers only interrupt for a decision, a review, or a failure.',
    'overview.noActive': 'No active tickets',
    'overview.noActiveHint': 'Message it on Telegram, or @ it in an allowed GitHub thread.',
    'overview.noSources': 'No source is enabled yet',
    'overview.noSourcesHint': 'Open Setup to connect Telegram or GitHub.',
    'overview.noHealth': 'The runtime has not reported component health yet',
    'overview.waitingForYou': 'Waiting for your decision',
    'overview.pluginDetail': 'Plugin detail',
    'overview.setupBannerTitle': 'One step left',
    'overview.setupBannerBody': 'Connect Telegram and GitHub in the wizard — no YAML editing required.',
    'overview.openSetup': 'Open setup',
    'overview.pause': 'Pause processing',
    'overview.resume': 'Resume processing',
    'overview.retry': 'Retry',
    'overview.stop': 'Stop',
    'overview.offlineTitle': 'Superagent is not answering',
    'overview.offlineBody': 'The plugin may be restarting, degraded, or stopped. DSH itself is unaffected.',
    'overview.apiHint': 'API: GET /superagent/api/state',
    'overview.reportTip': 'Latest report',
    'overview.settings': 'Settings',
    'setup.title': 'Setup wizard',
    'setup.apiOffline': 'The setup API is unavailable right now; the plugin may be starting or restarting.',
    'setup.subtitle': 'Three steps to connect the sources, one to save. The plugin restarts automatically — DSH stays up.',
    'setup.progress': '{done}/{total} done',
    'setup.step.telegram': 'Telegram',
    'setup.step.github': 'GitHub',
    'setup.step.behavior': 'Behavior',
    'setup.step.finish': 'Finish',
    'setup.reconfigure': 'Reconfigure',
    'setup.configuredNotice': 'Sources are already configured. Re-running the wizard overwrites tokens, repository choices and the allowSelf option.',
    'setup.restartNote': 'Saving restarts the plugin; the wizard polls until it is ready again.',
    'telegram.title': 'Connect Telegram',
    'telegram.desc': 'Telegram is its main surface: send instructions in direct messages and receive anything that needs your decision or review.',
    'telegram.howto1': 'Open @BotFather in Telegram, send /newbot and pick a name.',
    'telegram.howto2': 'Copy the token BotFather returns (it is shown once).',
    'telegram.howto3': 'Paste it below. When it validates, press Start to open the conversation with your bot.',
    'telegram.tokenLabel': 'Bot token',
    'telegram.tokenPlaceholder': '123456789:AA… (stored locally, never shown again)',
    'telegram.tokenHint': 'The token is written only to a local file (0600); it never appears in logs or configuration.',
    'telegram.validate': 'Validate and save',
    'telegram.validating': 'Validating…',
    'telegram.success': 'Telegram connected',
    'telegram.bot': 'bot',
    'telegram.start': 'Open the bot chat',
    'telegram.startHint': 'A bot cannot start a conversation. Press Start or send it a message first, then it can reply.',
    'telegram.skip': 'Skip Telegram for now',
    'telegram.skipped': 'Telegram skipped; this source stays disabled.',
    'telegram.error': 'Validation failed',
    'telegram.botfather': 'Open @BotFather',
    'telegram.noOauth': 'Telegram has no OAuth for bots: you create the bot and paste its token.',
    'github.title': 'Connect GitHub',
    'github.desc': 'GitHub delivers issues, pull requests, comments and CI events, and lets the agent push branches and open pull requests as itself.',
    'github.permsTitle': 'The fine-grained PAT needs',
    'github.permContents': 'Contents: Read and write',
    'github.permIssues': 'Issues: Read and write',
    'github.permPulls': 'Pull requests: Read and write',
    'github.permChecks': 'Checks: Read (CI results)',
    'github.permActions': 'Actions: Read (CI logs)',
    'github.tokenLabel': 'Fine-grained PAT',
    'github.tokenPlaceholder': 'github_pat_… (stored locally, never shown again)',
    'github.tokenHint': 'Grant it only the repositories it should work in; a separate machine account is safer.',
    'github.validate': 'Validate and list repositories',
    'github.validating': 'Validating…',
    'github.success': 'GitHub connected',
    'github.login': 'Account',
    'github.repos': 'Repositories to watch',
    'github.searchRepos': 'Search repositories…',
    'github.selectAll': 'Select all',
    'github.selectNone': 'Select none',
    'github.selected': '{count} selected',
    'github.allowSelf': 'I use my own GitHub account (let my own events trigger work)',
    'github.allowSelfHint': 'Off by default so the agent’s own comments and pull requests cannot trigger more work. Most people running the agent as themselves should turn it on; keep it off with a dedicated machine account that should only react to other people.',
    'github.private': 'Private',
    'github.pushed': 'Last push',
    'github.emptyRepos': 'This token cannot see any repository; check its access scope.',
    'github.skip': 'Skip GitHub for now',
    'github.skipped': 'GitHub skipped; this source stays disabled.',
    'github.error': 'Validation failed',
    'github.selectAtLeastOne': 'Select at least one repository.',
    'github.fineGrained': 'fine-grained PAT',
    'behavior.title': 'Behavior',
    'behavior.desc': 'Decide who may give it work and how proactive it is. You can change these later in Setup.',
    'behavior.allowedUsers': 'Allowed Telegram user ids',
    'behavior.allowedUsersHint': 'Comma-separated numeric ids. Ask @userinfobot for yours.',
    'behavior.mode': 'Accept mode',
    'behavior.modeObserve': 'observe · watch first',
    'behavior.modeObserveHint': 'Records what it would accept but runs nothing. Good for the first days.',
    'behavior.modeAuto': 'auto · accept automatically',
    'behavior.modeAutoHint': 'Accepts matching inferred candidates. Run observe for a few days first.',
    'behavior.modeOff': 'off · explicit requests only',
    'behavior.modeOffHint': 'Only work addressed to it explicitly starts.',
    'behavior.workers': 'Parallel workers',
    'behavior.workersHint': 'Maximum tickets running at once; 1–2 on a laptop.',
    'behavior.errorUsers': 'Add at least one allowed Telegram user id, or skip Telegram.',
    'behavior.errorMode': 'Choose an accept mode.',
    'behavior.telegramSkipped': 'Telegram is off, so this may stay empty; enabling Telegram requires at least one id.',
    'finish.title': 'Save and enable',
    'finish.desc': 'Review the summary, then save. The plugin restarts automatically to load the new configuration.',
    'finish.summary': 'About to save',
    'finish.telegram': 'Telegram',
    'finish.github': 'GitHub',
    'finish.mode': 'Accept mode',
    'finish.workers': 'Workers',
    'finish.save': 'Save and enable',
    'finish.saving': 'Saving…',
    'finish.restarting': 'Restarting the plugin; waiting for it to be ready…',
    'finish.restartWait': 'Waits up to 60 seconds. If it does not recover, check the DSH log.',
    'finish.done': 'Setup complete',
    'finish.doneHint': 'The plugin is ready again. Send /status on Telegram to try it.',
    'finish.timeout': 'The plugin did not come back yet',
    'finish.timeoutHint': 'The configuration was saved but the plugin was not ready within 60 seconds. Check the DSH log or refresh later.',
    'finish.error': 'Save failed',
    'finish.openDashboard': 'Open the dashboard',
    'finish.reconfigure': 'Configure again',
    'finish.restartNote': 'Some settings apply after the plugin restarts; the wizard waits for it.',
    'finish.noTelegram': 'Not configured (skipped)',
    'finish.noGithub': 'Not configured (skipped)',
    'permissions.title': 'Permissions and boundaries',
    'permissions.subtitle': 'SuperAgent does only what you allow. Here is what it needs — and what it does not.',
    'permissions.screen': 'Screen recording',
    'permissions.screenDetail': 'Not needed. Neither the panel nor a worker captures the screen; only a separately installed Computer Use plugin involves DSH.',
    'permissions.accessibility': 'Accessibility',
    'permissions.accessibilityDetail': 'Not needed. SuperAgent never synthesizes keyboard or mouse input.',
    'permissions.disk': 'Full disk access',
    'permissions.diskDetail': 'Not needed. It reads and writes stateDir and worker directories and talks to Telegram/GitHub over the network.',
    'permissions.network': 'Network access',
    'permissions.networkDetail': 'Required. It calls the Telegram Bot API and the GitHub API; the management API listens on loopback only.',
    'permissions.shell': 'Local commands and files',
    'permissions.shellDetail': 'A worker runs commands as your macOS user (it can touch anything you can). Use a dedicated OS account if you want isolation.',
    'permissions.watchdog': 'Watchdog (optional)',
    'permissions.watchdogDetail': 'Starts at login and restarts DSH after a crash. Off by default; without it the process simply stays down until you reopen it.',
    'permissions.watchdogOff': 'Off by default',
    'permissions.watchdogCommands': 'Install and check manually',
    'permissions.restart': 'When changes apply',
    'permissions.restartDetail': 'Saving configuration restarts the plugin automatically; DSH itself stays up. A few system-level changes (such as stateDir) need a DSH restart.',
    'permissions.none': 'Not needed',
    'permissions.required': 'Required',
    'permissions.notRequired': 'Not needed',
    'permissions.optional': 'Optional',
    'permissions.api': 'Runtime permissions',
    'permissions.apiEmpty': 'The runtime has not reported permission entries yet.',
    'action.paused': 'Processing paused',
    'action.resumed': 'Processing resumed',
    'action.retried': 'Retry requested',
    'action.stopped': 'Ticket stopped',
    'action.failed': 'Action failed',
    'action.unknown': 'Unknown action',
    'time.justNow': 'just now',
  }

  const DICTS = { zh: ZH, en: EN }
  /** Bind a translator to a locale service, with an English fallback. */
  function makeTranslator(locale) {
    if (locale && typeof locale.bind === 'function') {
      try {
        return locale.bind(NS)
      } catch {
        // Fall back to the static dictionary.
      }
    }
    return key => EN[key] || key
  }

  function interpolate(text, vars) {
    if (!vars || typeof text !== 'string') return text
    return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
  }

  // -- pure helpers (also exported for tests) ---------------------------------

  function listOf(value) {
    if (Array.isArray(value)) return value
    return []
  }

  function asText(value, fallback) {
    if (typeof value === 'string' && value.trim().length > 0) return value
    return fallback === undefined ? '' : fallback
  }

  function asNumber(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function parseUserIds(value) {
    const parts = String(value || '')
      .split(/[\s,，;；]+/)
      .map(part => part.trim())
      .filter(Boolean)
    const seen = new Set()
    const ids = []
    for (const part of parts) {
      if (!seen.has(part)) {
        seen.add(part)
        ids.push(part)
      }
    }
    return ids
  }

  function repoEntry(value) {
    if (typeof value === 'string' && value.length > 0) {
      return { fullName: value, private: false, pushedAt: '' }
    }
    if (value && typeof value === 'object' && typeof value.fullName === 'string') {
      return {
        fullName: value.fullName,
        private: value.private === true,
        pushedAt: typeof value.pushedAt === 'string' ? value.pushedAt : '',
      }
    }
    return undefined
  }

  function normalizeSetupAccounts(setup) {
    const accounts = setup && typeof setup === 'object' ? setup.accounts : undefined
    const telegram = accounts && typeof accounts.telegram === 'object' ? accounts.telegram : {}
    const github = accounts && typeof accounts.github === 'object' ? accounts.github : {}
    const repositories = listOf(github.repositories).map(repoEntry).filter(Boolean)
    return {
      telegram,
      github,
      repositories,
    }
  }

  function isSetupConfigured(setup) {
    const { telegram, github } = normalizeSetupAccounts(setup)
    return telegram.configured === true || github.configured === true
  }

  function expectedAccounts(wizard) {
    return {
      telegram: wizard.telegram.status === 'validated' && wizard.telegram.skipped !== true,
      github: wizard.github.status === 'validated' && wizard.github.skipped !== true,
    }
  }

  function accountsMatch(setup, expected) {
    const { telegram, github } = normalizeSetupAccounts(setup)
    if (expected.telegram && telegram.configured !== true) return false
    if (expected.github && github.configured !== true) return false
    return true
  }

  function defaultWizard() {
    return {
      open: false,
      step: 0,
      telegram: { status: 'idle', token: '', botUsername: '', tokenFile: '', error: '', skipped: false },
      github: { status: 'idle', token: '', login: '', tokenFile: '', repositories: [], selected: [], allowSelf: false, error: '', skipped: false },
      behavior: { allowedUserIds: '', mode: 'observe', maxWorkers: 2 },
      finish: { status: 'idle', error: '', elapsed: 0 },
    }
  }

  function wizardFromSetup(setup) {
    const base = defaultWizard()
    const { telegram, github, repositories } = normalizeSetupAccounts(setup)
    const existing = repositories.map(repo => repo.fullName).filter(Boolean)
    return {
      ...base,
      open: true,
      telegram: {
        ...base.telegram,
        status: telegram.configured === true ? 'validated' : 'idle',
        botUsername: typeof telegram.botUsername === 'string' ? telegram.botUsername : '',
      },
      github: {
        ...base.github,
        status: github.configured === true ? 'validated' : 'idle',
        login: typeof github.login === 'string' ? github.login : '',
        repositories,
        selected: [...existing],
        allowSelf: github.allowSelf === true,
      },
      behavior: {
        ...base.behavior,
        mode: 'observe',
        maxWorkers: 2,
      },
    }
  }

  const WIZARD_STEPS = ['telegram', 'github', 'behavior', 'finish']

  function stepLabels(t) {
    return [
      t('setup.step.telegram'),
      t('setup.step.github'),
      t('setup.step.behavior'),
      t('setup.step.finish'),
    ]
  }

  function stepStates(wizard) {
    const states = []
    for (let index = 0; index < WIZARD_STEPS.length; index += 1) {
      if (index < wizard.step) states.push('done')
      else if (index === wizard.step) states.push('current')
      else states.push('todo')
    }
    return states
  }

  function canAdvance(step, wizard) {
    if (step === 0) return wizard.telegram.status === 'validated' || wizard.telegram.skipped === true
    if (step === 1) {
      if (wizard.github.skipped === true) return true
      return wizard.github.status === 'validated' && listOf(wizard.github.selected).length > 0
    }
    if (step === 2) {
      if (!['off', 'observe', 'auto'].includes(wizard.behavior.mode)) return false
      const workers = asNumber(wizard.behavior.maxWorkers, 0)
      if (workers < 1 || workers > MAX_WORKERS) return false
      if (wizard.telegram.status === 'validated' && parseUserIds(wizard.behavior.allowedUserIds).length === 0) return false
      return true
    }
    return true
  }

  function behaviorError(wizard, t) {
    if (!['off', 'observe', 'auto'].includes(wizard.behavior.mode)) return t('behavior.errorMode')
    const workers = asNumber(wizard.behavior.maxWorkers, 0)
    if (workers < 1 || workers > MAX_WORKERS) return t('behavior.workersHint')
    if (wizard.telegram.status === 'validated' && parseUserIds(wizard.behavior.allowedUserIds).length === 0) {
      return t('behavior.errorUsers')
    }
    return ''
  }

  function buildConfig(wizard) {
    const telegramEnabled = wizard.telegram.status === 'validated' && wizard.telegram.skipped !== true
    const githubEnabled = wizard.github.status === 'validated' && wizard.github.skipped !== true
    const telegram = { enabled: telegramEnabled }
    if (telegramEnabled) {
      telegram.allowedUserIds = parseUserIds(wizard.behavior.allowedUserIds)
      if (wizard.telegram.tokenFile) telegram.tokenFile = wizard.telegram.tokenFile
    }
    const github = { enabled: githubEnabled }
    if (githubEnabled) {
      github.repositories = listOf(wizard.github.selected)
      github.allowSelf = wizard.github.allowSelf === true
      if (wizard.github.login) github.login = wizard.github.login
      if (wizard.github.tokenFile) github.tokenFile = wizard.github.tokenFile
    }
    return {
      sources: { telegram, github },
      policy: { mode: wizard.behavior.mode },
      executor: { maxWorkers: asNumber(wizard.behavior.maxWorkers, 2) },
    }
  }

  function repositoryChoices(setup) {
    return normalizeSetupAccounts(setup).repositories
  }

  function errorText(result) {
    if (result && typeof result.error === 'string' && result.error.length > 0) return result.error
    return 'request failed'
  }

  function formatTime(value) {
    if (typeof value !== 'string' || value.length === 0) return ''
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    try {
      return parsed.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' })
    } catch {
      return value
    }
  }

  // -- HTTP -------------------------------------------------------------------

  function createApi() {
    async function request(path, options) {
      const init = options || {}
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = setTimeout(() => {
        try {
          controller?.abort()
        } catch {
          // ignore
        }
      }, REQUEST_TIMEOUT_MS)
      try {
        const headers = { ...FENCE_HEADERS }
        if (init.body !== undefined) headers['content-type'] = 'application/json'
        const response = await fetch(path, {
          method: init.method || 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        })
        let data
        try {
          data = await response.json()
        } catch {
          data = undefined
        }
        if (!response.ok) {
          const issue = data && Array.isArray(data.issues) && data.issues[0] ? data.issues[0].message : ''
          const primary = asText(data && data.error, issue)
          const description = asText(data && data.description)
          return {
            ok: false,
            status: response.status,
            data,
            error: description && description !== primary ? `${primary || 'request failed'}: ${description}` : primary || `HTTP ${response.status}`,
          }
        }
        if (data && data.ok === false) {
          return { ok: false, status: response.status, data, error: asText(data.error, 'request refused') }
        }
        return { ok: true, status: response.status, data }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, status: 0, error: /abort/i.test(message) ? 'request timed out' : message }
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      request,
      get: path => request(path),
      post: (path, body) => request(path, { method: 'POST', body }),
      put: (path, body) => request(path, { method: 'PUT', body }),
    }
  }

  // -- design tokens and stylesheet ------------------------------------------

  const T = {
    text: 'var(--dsw-alias-label-primary)',
    secondary: 'var(--dsw-alias-label-secondary)',
    tertiary: 'var(--dsw-alias-label-tertiary)',
    border: 'var(--dsw-alias-border-l2)',
    borderSoft: 'var(--dsw-alias-border-l1)',
    card: 'var(--dsw-alias-bg-layer-1)',
    layer2: 'var(--dsw-alias-bg-layer-2)',
    base: 'var(--dsw-alias-bg-base)',
    hover: 'var(--dsw-alias-interactive-bg-hover)',
    ok: 'var(--dsw-alias-state-success-primary)',
    okSoft: 'var(--dsw-alias-state-success-tertiary)',
    warn: 'var(--dsw-alias-state-warn-primary)',
    warnSoft: 'var(--dsw-alias-state-warn-tertiary)',
    error: 'var(--dsw-alias-state-error-primary)',
    errorSoft: 'var(--dsw-alias-state-error-secondary)',
    brand: 'var(--dsw-alias-brand-primary)',
    accent: 'var(--dsw-alias-state-business-primary)',
    radius: 'var(--dsw-radius-lg)',
    radiusSm: 'var(--dsw-radius-md)',
    shadow: 'var(--dsw-elevation-soft)',
  }

  const CSS = `
.sa-root {
  height: 100%;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.sa-container { max-width: 1000px; margin: 0 auto; padding: 0 28px 72px; }
.sa-header {
  position: sticky; top: 0; z-index: 20;
  background: var(--dsw-alias-bg-base);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.sa-header-inner {
  max-width: 1000px; margin: 0 auto; padding: 16px 28px 12px;
  display: flex; flex-direction: column; gap: 14px;
}
.sa-headrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sa-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sa-brandmark {
  width: 38px; height: 38px; border-radius: 12px; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-primary-foreground);
  background: linear-gradient(145deg, var(--dsw-alias-brand-primary), color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, #1b2a4a));
  box-shadow: var(--dsw-elevation-panel);
}
.sa-brandtext { min-width: 0; }
.sa-brandtitle { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.25; letter-spacing: .1px; }
.sa-brandsub { margin: 1px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-headspacer { flex: 1 1 auto; }
.sa-tabs {
  display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  max-width: 100%; overflow-x: auto; scrollbar-width: none;
}
.sa-tabs::-webkit-scrollbar { display: none; }
.sa-tab {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 1; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  transition: background .14s ease, color .14s ease, box-shadow .14s ease;
}
.sa-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.sa-tab[aria-selected='true'] {
  color: var(--dsw-alias-label-primary); font-weight: 600;
  background: var(--dsw-alias-bg-module-platform);
  box-shadow: var(--dsw-elevation-stroke), 0 1px 3px rgba(0,0,0,.06);
}
.sa-tab:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.sa-main { max-width: 1000px; margin: 0 auto; padding: 26px 28px 0; display: flex; flex-direction: column; gap: 18px; }
.sa-pagehead { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.sa-pagetitle { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: .1px; }
.sa-pagedesc { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; max-width: 68ch; }
.sa-grid { display: grid; gap: 16px; }
.sa-grid--stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sa-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sa-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  box-shadow: var(--dsw-elevation-soft);
  padding: 18px 20px;
  min-width: 0;
}
.sa-card--flat { box-shadow: none; background: var(--dsw-alias-bg-layer-2); }
.sa-card--hero { padding: 20px 22px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.sa-card--banner {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  background: linear-gradient(120deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-1) 62%);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, var(--dsw-alias-border-l2));
}
.sa-hero-orb { flex: 0 0 auto; }
.sa-hero-text { min-width: 0; flex: 1 1 260px; }
.sa-hero-title { margin: 0; font-size: 18px; font-weight: 650; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sa-hero-detail { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; word-break: break-word; }
.sa-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sa-cardhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.sa-cardtitle { margin: 0; font-size: 13.5px; font-weight: 650; letter-spacing: .1px; display: flex; align-items: center; gap: 8px; }
.sa-cardcount { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.sa-cardsub { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.sa-cardactions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.sa-stat { display: flex; align-items: center; gap: 14px; }
.sa-stat-icon {
  width: 42px; height: 42px; border-radius: 13px; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
.sa-stat-icon--warn { color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
.sa-stat-icon--ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
.sa-stat-icon--error { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-secondary); border-color: transparent; }
.sa-stat-value { font-size: 24px; font-weight: 680; line-height: 1.1; font-variant-numeric: tabular-nums; }
.sa-stat-label { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sa-row {
  display: flex; align-items: center; gap: 10px; min-width: 0;
  padding: 9px 10px; border-radius: 9px;
  transition: background .12s ease;
}
.sa-row + .sa-row { margin-top: 2px; }
.sa-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sa-row--stack { align-items: flex-start; }
.sa-rowmain { min-width: 0; flex: 1 1 auto; }
.sa-rowtitle { font-size: 13px; font-weight: 550; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; }
.sa-rowmeta { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; }
.sa-rowmeta--wrap { white-space: normal; word-break: break-word; }
.sa-rowactions { margin-left: auto; display: flex; gap: 6px; flex: 0 0 auto; }
.sa-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-label-tertiary); }
.sa-dot--ok { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.sa-dot--warn { background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); }
.sa-dot--error { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.sa-dot--idle { background: var(--dsw-alias-label-tertiary); }
.sa-dot--pulse { animation: sa-pulse 2.2s ease-in-out infinite; }
.sa-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 550; line-height: 1;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
  background: transparent; white-space: nowrap;
}
.sa-pill--ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.sa-pill--warn { color: var(--dsw-alias-state-warn-label); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 34%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.sa-pill--error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.sa-pill--plain { color: var(--dsw-alias-label-secondary); }
.sa-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; font-weight: 520; line-height: 1; cursor: pointer;
  transition: background .13s ease, border-color .13s ease, transform .05s ease, opacity .13s ease;
  white-space: nowrap; text-decoration: none;
}
.sa-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sa-btn:active { transform: translateY(1px); }
.sa-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.sa-btn[disabled] { opacity: .45; cursor: not-allowed; transform: none; }
.sa-btn--primary {
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent; font-weight: 600;
}
.sa-btn--primary:hover { background: var(--dsw-alias-button-primary-hover); }
.sa-btn--ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.sa-btn--ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sa-btn--danger { color: var(--dsw-alias-state-error-primary); }
.sa-btn--danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.sa-btn--sm { height: 27px; padding: 0 9px; font-size: 12px; border-radius: 8px; }
.sa-btn--block { width: 100%; }
.sa-link { color: var(--dsw-alias-link); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.sa-link:hover { text-decoration: underline; }
.sa-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sa-label { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }
.sa-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.sa-input, .sa-textarea, .sa-select {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  padding: 8px 11px; min-height: 34px; outline: none;
  transition: border-color .13s ease, box-shadow .13s ease;
}
.sa-input:focus, .sa-textarea:focus, .sa-select:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); }
.sa-input:disabled, .sa-textarea:disabled { opacity: .55; cursor: not-allowed; }
.sa-input::placeholder, .sa-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.sa-textarea { min-height: 74px; resize: vertical; font-family: var(--dsw-font-family); word-break: break-all; }
.sa-inputrow { display: flex; gap: 8px; align-items: center; }
.sa-inputrow > .sa-input { flex: 1 1 auto; }
.sa-alert {
  display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px;
  border-radius: var(--dsw-radius-md); font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
}
.sa-alert--error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); }
.sa-alert--warn { color: var(--dsw-alias-state-warn-label); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); }
.sa-alert--ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, transparent); }
.sa-alert-icon { flex: 0 0 auto; margin-top: 1px; }
.sa-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  text-align: center; padding: 26px 18px; color: var(--dsw-alias-label-secondary);
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent);
}
.sa-empty-icon {
  width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2);
}
.sa-empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sa-empty-hint { font-size: 12px; line-height: 1.5; max-width: 48ch; }
.sa-steps { display: flex; align-items: center; gap: 0; margin: 2px 0 4px; flex-wrap: wrap; }
.sa-step { display: flex; align-items: center; gap: 9px; min-width: 0; }
.sa-step + .sa-step { flex: 1 1 auto; }
.sa-stepline { flex: 1 1 24px; height: 2px; min-width: 18px; margin: 0 4px; border-radius: 2px; background: var(--dsw-alias-border-l2); }
.sa-stepline--done { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, transparent); }
.sa-stepnum {
  width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 650; border: 1.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
}
.sa-step--done .sa-stepnum { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.sa-step--current .sa-stepnum { color: var(--dsw-alias-label-primary-foreground); border-color: transparent; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.sa-steplabel { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sa-step--current .sa-steplabel { color: var(--dsw-alias-label-primary); font-weight: 600; }
.sa-step--done .sa-steplabel { color: var(--dsw-alias-label-secondary); }
.sa-radio {
  display: flex; align-items: flex-start; gap: 11px; padding: 12px 13px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); transition: border-color .13s ease, background .13s ease;
}
.sa-radio + .sa-radio { margin-top: 8px; }
.sa-radio:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sa-radio[data-checked='true'] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
.sa-radio:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.sa-radio-mark { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l3); flex: 0 0 auto; margin-top: 1px; display: flex; align-items: center; justify-content: center; }
.sa-radio[data-checked='true'] .sa-radio-mark { border-color: var(--dsw-alias-brand-primary); }
.sa-radio[data-checked='true'] .sa-radio-mark::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.sa-radio-body { min-width: 0; }
.sa-radio-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sa-radio-hint { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.sa-checkrow { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; min-width: 0; }
.sa-checkrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sa-checkrow input { accent-color: var(--dsw-alias-brand-primary); width: 15px; height: 15px; flex: 0 0 auto; }
.sa-checkrow-name { font-size: 12.5px; font-weight: 520; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-checkrow-meta { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); flex: 0 0 auto; }
.sa-repolist { max-height: 240px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 4px; margin-top: 8px; background: var(--dsw-alias-bg-base); }
.sa-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sa-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; font-size: 11.5px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
}
.sa-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.sa-code {
  margin: 8px 0 0; padding: 10px 12px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-markdown-code-block); border: 1px solid var(--dsw-alias-border-l1);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-all; color: var(--dsw-alias-label-primary);
}
.sa-summary { display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); overflow: hidden; }
.sa-summary-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 13px; background: var(--dsw-alias-bg-layer-1); font-size: 12.5px; }
.sa-summary-row + .sa-summary-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.sa-summary-key { flex: 0 0 108px; color: var(--dsw-alias-label-secondary); }
.sa-summary-val { min-width: 0; flex: 1 1 auto; word-break: break-word; }
.sa-spinner {
  width: 15px; height: 15px; border-radius: 50%; flex: 0 0 auto;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-label-tertiary) 40%, transparent);
  border-top-color: var(--dsw-alias-brand-primary); animation: sa-spin .8s linear infinite;
}
.sa-progress { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 10px; }
.sa-progress-fill { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary); transition: width .4s ease; }
.sa-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sa-inline--end { justify-content: flex-end; }
.sa-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 14px 0; }
.sa-note { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.55; }
.sa-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.sa-list { display: flex; flex-direction: column; gap: 1px; }
.sa-kv { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; padding: 4px 0; }
.sa-kv-key { color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.sa-kv-val { min-width: 0; word-break: break-word; }
.sa-fade { animation: sa-fade .18s ease-out; }
.sa-footerbar { display: flex; align-items: center; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.sa-footerbar .sa-spacer { flex: 1 1 auto; }
.sa-toast {
  position: sticky; bottom: 16px; margin-top: 6px; align-self: flex-end;
  display: inline-flex; align-items: center; gap: 8px; padding: 9px 13px;
  border-radius: 999px; font-size: 12.5px; box-shadow: var(--dsw-elevation-prominent);
  background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label);
  animation: sa-fade .18s ease-out;
}
@keyframes sa-spin { to { transform: rotate(360deg); } }
@keyframes sa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes sa-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
@media (max-width: 820px) {
  .sa-container, .sa-header-inner, .sa-main { padding-left: 16px; padding-right: 16px; }
  .sa-grid--stats, .sa-grid--two { grid-template-columns: 1fr; }
  .sa-brandsub { display: none; }
  .sa-card { padding: 15px 15px; }
  .sa-summary-key { flex-basis: 84px; }
}
@media (prefers-reduced-motion: reduce) {
  .sa-root *, .sa-root *::before, .sa-root *::after { animation: none !important; transition: none !important; }
}
`

  // -- icons ------------------------------------------------------------------

  const ICON_PATHS = {
    activity: ['M3 12h3.5l2.5-7 4 14 2.5-7H21'],
    alert: ['M12 3 2.8 19.6h18.4L12 3Z', 'M12 9v4.6', 'M12 16.6h.01'],
    check: ['m4 12.5 4.6 4.6L20 6.5'],
    checkCircle: ['M21 11.2V12a9 9 0 1 1-5.3-8.2', 'm8.5 11.5 3 3 8-8'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.2v5l3.2 1.9'],
    pause: ['M9 5v14', 'M15 5v14'],
    play: ['m8 5 11 7-11 7V5Z'],
    stop: ['M7 7h10v10H7z'],
    retry: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4.5V10h-5.5'],
    refresh: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M20.5 4v5h-5'],
    external: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M9.5 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-4'],
    telegram: ['M21 4.2 3.2 11.1l5.4 2.1 2.1 5.6 3-4 5.1 2.9L21 4.2Z', 'm8.6 13.2 8.2-6.5-5.2 8.9'],
    github: ['M6.2 4.5v9.7a3.3 3.3 0 0 0 3.3 3.3h3.2', 'M17.8 17.5v-4.2a3.3 3.3 0 0 0-3.3-3.3H8.2', 'M6.2 4.5a1.9 1.9 0 1 0 0 .01', 'M17.8 19.4a1.9 1.9 0 1 0 0-.01'],
    shield: ['M12 3.2 5 6v5.9c0 4.1 3 7.3 7 8.9 4-1.6 7-4.8 7-8.9V6l-7-2.8Z', 'm8.8 12 2.2 2.2 4.4-4.4'],
    settings: ['M4 7h9.5', 'M17.5 7H20', 'M4 17h2.5', 'M10.5 17H20', 'M15.5 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z', 'M8.5 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z'],
    key: ['M14.8 9.2a3.8 3.8 0 1 0-3.4 3.8L9 15.4H6.6v2.4H4.2v2.4H7.8l5.2-5.2', 'M16.6 7.4h.01'],
    users: ['M16.5 20v-1.8a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.2V20', 'M9.7 11.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z', 'M21 20v-1.8a3.6 3.6 0 0 0-2.7-3.5', 'M15.4 4.1a3.6 3.6 0 0 1 0 7'],
    cpu: ['M7 7h10v10H7z', 'M9.5 3.5V7', 'M14.5 3.5V7', 'M9.5 17v3.5', 'M14.5 17v3.5', 'M3.5 9.5H7', 'M3.5 14.5H7', 'M17 9.5h3.5', 'M17 14.5h3.5'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm16.2 16.2 4.3 4.3'],
    eye: ['M2.5 12s3.4-6.2 9.5-6.2S21.5 12 21.5 12s-3.4 6.2-9.5 6.2S2.5 12 2.5 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
    lock: ['M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5Z', 'M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7'],
    repo: ['M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15.5H7.5A2.5 2.5 0 0 0 5 21V5.5Z', 'M8.5 7.5H15'],
    spark: ['M12 3.2l1.9 5.2 5.2 1.9-5.2 1.9L12 17.4l-1.9-5.2L4.9 10.3l5.2-1.9L12 3.2Z'],
    x: ['M6 6l12 12', 'M18 6 6 18'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5.4', 'M12 7.7h.01'],
    bot: ['M12 3v2.4', 'M7.6 5.4h8.8A2.6 2.6 0 0 1 19 8v8.4a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 16.4V8a2.6 2.6 0 0 1 2.6-2.6Z', 'M9.4 11.2h.01', 'M14.6 11.2h.01', 'M9.4 14.6h5.2'],
    globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3.4 12h17.2', 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z'],
    copy: ['M9 9h9.5A1.5 1.5 0 0 1 20 10.5v9A1.5 1.5 0 0 1 18.5 21h-9A1.5 1.5 0 0 1 8 19.5v-9A1.5 1.5 0 0 1 9.5 9Z', 'M16 9V4.5A1.5 1.5 0 0 0 14.5 3h-9A1.5 1.5 0 0 0 4 4.5v9A1.5 1.5 0 0 0 5.5 15H8'],
    arrowRight: ['M4.5 12h15', 'M13.5 6l6 6-6 6'],
  }

  function Icon(props) {
    const size = props.size === undefined ? 16 : props.size
    const color = props.color === undefined ? 'currentColor' : props.color
    const strokeWidth = props.strokeWidth === undefined ? 1.7 : props.strokeWidth
    if (props.name === 'logo') {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto', color },
        },
        h('circle', { cx: 12, cy: 12, r: 3.1, fill: 'currentColor' }),
        h('ellipse', {
          cx: 12,
          cy: 12,
          rx: 9.2,
          ry: 4.6,
          stroke: 'currentColor',
          strokeWidth: 1.8,
          transform: 'rotate(-32 12 12)',
        }),
        h('circle', { cx: 19.4, cy: 8.1, r: 1.9, fill: 'currentColor' }),
      )
    }
    const paths = ICON_PATHS[props.name] || ICON_PATHS.info
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: color,
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
      paths.map((d, index) => h('path', { key: index, d })),
    )
  }

  function BrandMark(props) {
    const size = props.size === undefined ? 38 : props.size
    return h(
      'div',
      {
        className: 'sa-brandmark',
        style: { width: size, height: size, borderRadius: Math.max(10, Math.round(size * 0.3)) },
        'aria-hidden': true,
      },
      h(Icon, { name: 'logo', size: Math.round(size * 0.62), color: 'currentColor' }),
    )
  }

  // -- atoms ------------------------------------------------------------------

  function Button(props) {
    const classes = ['sa-btn']
    if (props.variant === 'primary') classes.push('sa-btn--primary')
    if (props.variant === 'ghost') classes.push('sa-btn--ghost')
    if (props.variant === 'danger') classes.push('sa-btn--danger')
    if (props.size === 'sm') classes.push('sa-btn--sm')
    if (props.block) classes.push('sa-btn--block')
    if (props.className) classes.push(props.className)
    return h(
      'button',
      {
        type: props.type || 'button',
        className: classes.join(' '),
        disabled: props.disabled === true,
        onClick: props.disabled ? undefined : props.onClick,
        title: props.title,
        'aria-label': props['aria-label'] || props.title,
      },
      props.icon ? h(Icon, { name: props.icon, size: 14 }) : null,
      props.children,
    )
  }

  function Pill(props) {
    const tone = props.tone === undefined ? 'plain' : props.tone
    return h(
      'span',
      { className: `sa-pill sa-pill--${tone}` },
      props.dot ? h('span', { className: `sa-dot sa-dot--${dotTone(props.dot)}` }) : null,
      props.icon ? h(Icon, { name: props.icon, size: 12 }) : null,
      props.children,
    )
  }

  function Dot(props) {
    const tone = dotTone(props.tone)
    return h('span', {
      className: `sa-dot sa-dot--${tone}${props.pulse ? ' sa-dot--pulse' : ''}`,
      'aria-hidden': true,
    })
  }

  function dotTone(tone) {
    if (tone === 'ok' || tone === 'ready' || tone === 'success') return 'ok'
    if (tone === 'warn' || tone === 'starting' || tone === 'waiting' || tone === 'blocked') return 'warn'
    if (tone === 'error' || tone === 'failed' || tone === 'degraded') return 'error'
    return 'idle'
  }

  function Card(props) {
    const classes = ['sa-card']
    if (props.variant) classes.push(`sa-card--${props.variant}`)
    if (props.className) classes.push(props.className)
    return h('section', { className: classes.join(' '), style: props.style }, props.children)
  }

  function CardHead(props) {
    return h(
      'div',
      { className: 'sa-cardhead' },
      props.icon ? h(Icon, { name: props.icon, size: 15, color: 'var(--dsw-alias-label-secondary)' }) : null,
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'h2',
          { className: 'sa-cardtitle' },
          props.title,
          props.count === undefined ? null : h('span', { className: 'sa-cardcount' }, props.count),
        ),
        props.subtitle ? h('p', { className: 'sa-cardsub' }, props.subtitle) : null,
      ),
      props.action ? h('div', { className: 'sa-cardactions' }, props.action) : null,
    )
  }

  function EmptyState(props) {
    return h(
      'div',
      { className: 'sa-empty' },
      h('div', { className: 'sa-empty-icon' }, h(Icon, { name: props.icon || 'spark', size: 19 })),
      h('div', { className: 'sa-empty-title' }, props.title),
      props.hint ? h('div', { className: 'sa-empty-hint' }, props.hint) : null,
      props.action || null,
    )
  }

  function Alert(props) {
    const tone = props.tone || 'warn'
    const iconName = props.icon || (tone === 'error' ? 'alert' : tone === 'ok' ? 'checkCircle' : 'info')
    return h(
      'div',
      { className: `sa-alert sa-alert--${tone}`, role: tone === 'error' ? 'alert' : undefined },
      h('span', { className: 'sa-alert-icon' }, h(Icon, { name: iconName, size: 15 })),
      h(
        'div',
        { style: { minWidth: 0 } },
        props.title ? h('div', { style: { fontWeight: 600, marginBottom: props.children ? 2 : 0 } }, props.title) : null,
        props.children || null,
      ),
      props.action ? h('div', { style: { marginLeft: 'auto', flex: '0 0 auto' } }, props.action) : null,
    )
  }

  function Spinner() {
    return h('span', { className: 'sa-spinner', 'aria-hidden': true })
  }

  function Field(props) {
    const id = props.id
    return h(
      'div',
      { className: 'sa-field' },
      h(
        'label',
        { className: 'sa-label', htmlFor: id },
        props.label,
        props.badge ? h(Pill, { tone: 'plain' }, props.badge) : null,
      ),
      props.children,
      props.hint ? h('div', { className: 'sa-hint' }, props.hint) : null,
      props.error ? h('div', { className: 'sa-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, props.error) : null,
    )
  }

  function TextInput(props) {
    return h('input', {
      id: props.id,
      className: 'sa-input',
      type: props.type || 'text',
      value: props.value,
      placeholder: props.placeholder,
      autoComplete: props.autoComplete || 'off',
      spellCheck: false,
      disabled: props.disabled === true,
      onChange: event => {
        if (props.onChange) props.onChange(event.target.value)
      },
      onKeyDown: events => {
        if (props.onEnter && events.key === 'Enter') props.onEnter()
      },
    })
  }

  function TextArea(props) {
    return h('textarea', {
      id: props.id,
      className: 'sa-textarea',
      value: props.value,
      placeholder: props.placeholder,
      spellCheck: false,
      rows: props.rows || 2,
      disabled: props.disabled === true,
      onChange: event => {
        if (props.onChange) props.onChange(event.target.value)
      },
    })
  }

  function NumberStepper(props) {
    return h(
      'div',
      { className: 'sa-inline', role: 'group', 'aria-label': props.label },
      h(Button, {
        size: 'sm',
        icon: 'x',
        title: '−',
        disabled: props.value <= props.min,
        onClick: () => props.onChange(Math.max(props.min, props.value - 1)),
      }),
      h(
        'span',
        {
          style: {
            minWidth: 34,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 14,
            fontWeight: 600,
          },
        },
        props.value,
      ),
      h(Button, {
        size: 'sm',
        icon: 'check',
        title: '+',
        disabled: props.value >= props.max,
        onClick: () => props.onChange(Math.min(props.max, props.value + 1)),
      }),
    )
  }

  function Stepper(props) {
    const labels = props.labels
    const states = props.states
    const nodes = []
    for (let index = 0; index < labels.length; index += 1) {
      const state = states[index]
      nodes.push(
        h(
          'div',
          { key: `step-${index}`, className: `sa-step sa-step--${state}` },
          h(
            'span',
            { className: 'sa-stepnum' },
            state === 'done' ? h(Icon, { name: 'check', size: 13 }) : String(index + 1),
          ),
          h('span', { className: 'sa-steplabel' }, labels[index]),
        ),
      )
      if (index < labels.length - 1) {
        nodes.push(
          h('span', {
            key: `line-${index}`,
            className: `sa-stepline${index < props.current ? ' sa-stepline--done' : ''}`,
            'aria-hidden': true,
          }),
        )
      }
    }
    return h('div', { className: 'sa-steps', 'aria-label': props.ariaLabel || 'steps' }, nodes)
  }

  function RadioCard(props) {
    return h(
      'div',
      {
        className: 'sa-radio',
        role: 'radio',
        tabIndex: 0,
        'aria-checked': props.checked === true,
        'data-checked': props.checked === true ? 'true' : 'false',
        onClick: props.onSelect,
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onSelect()
          }
        },
      },
      h('span', { className: 'sa-radio-mark', 'aria-hidden': true }),
      h(
        'span',
        { className: 'sa-radio-body' },
        h(
          'span',
          { className: 'sa-radio-title' },
          props.title,
          props.badge ? h(Pill, { tone: 'ok' }, props.badge) : null,
        ),
        props.hint ? h('span', { className: 'sa-radio-hint' }, props.hint) : null,
      ),
    )
  }

  function CheckboxRow(props) {
    return h(
      'label',
      { className: 'sa-checkrow' },
      h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        onChange: event => props.onChange(event.target.checked),
      }),
      h('span', { className: 'sa-checkrow-name', title: props.title }, props.title),
      props.badge ? h(Pill, { tone: 'plain' }, props.badge) : null,
      props.meta ? h('span', { className: 'sa-checkrow-meta' }, props.meta) : null,
    )
  }

  function CodeBlock(props) {
    return h(
      'div',
      null,
      h('pre', { className: 'sa-code' }, props.children),
      props.copyText
        ? h(
            'div',
            { style: { marginTop: 6 } },
            h(CopyButton, { text: props.copyText, label: props.copyLabel }),
          )
        : null,
    )
  }

  function CopyButton(props) {
    const [copied, setCopied] = React.useState(false)
    const copy = () => {
      const done = () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(props.text).then(done, () => setCopied(false))
          return
        }
      } catch {
        // fall through
      }
      setCopied(false)
    }
    return h(
      Button,
      { size: 'sm', variant: 'ghost', icon: 'copy', onClick: copy, title: props.label },
      copied ? '✓' : props.label || 'Copy',
    )
  }

  function SummaryRow(props) {
    return h(
      'div',
      { className: 'sa-summary-row' },
      h('span', { className: 'sa-summary-key' }, props.label),
      h('span', { className: 'sa-summary-val' }, props.children),
    )
  }

  // -- hooks ------------------------------------------------------------------

  function delay(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
  }

  /**
   * Load `load` immediately and then every `intervalMs`, never overlapping.
   * Requests settle before the next tick; unmount stops the chain.
   */
  function usePolling(load, intervalMs) {
    const [snapshot, setSnapshot] = React.useState({ data: undefined, error: '', loading: true, at: '' })
    const loadRef = React.useRef(load)
    loadRef.current = load
    const aliveRef = React.useRef(true)

    const run = React.useCallback(async () => {
      const result = await loadRef.current()
      if (!aliveRef.current) return result
      setSnapshot(previous => {
        if (result && result.ok) {
          return { data: result.data, error: '', loading: false, at: new Date().toISOString() }
        }
        return {
          data: previous.data,
          error: errorText(result),
          loading: false,
          at: previous.at,
        }
      })
      return result
    }, [])

    React.useEffect(() => {
      aliveRef.current = true
      let timer
      const tick = async () => {
        await run()
        if (!aliveRef.current) return
        timer = setTimeout(tick, Math.max(1000, intervalMs || 5000))
      }
      void tick()
      return () => {
        aliveRef.current = false
        if (timer) clearTimeout(timer)
      }
    }, [intervalMs, run])

    return { snapshot, refresh: run }
  }

  function statusLabel(status, t) {
    return t(`status.${status}`) || t('status.stopped')
  }

  function pluginTone(status) {
    if (status === 'ready') return 'ok'
    if (status === 'degraded') return 'error'
    if (status === 'starting') return 'warn'
    return 'idle'
  }

  function StatusOrb(props) {
    const status = props.status
    const tone = pluginTone(status)
    const color =
      tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
    const size = props.size || 54
    return h(
      'svg',
      {
        viewBox: '0 0 54 54',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        className: 'sa-hero-orb',
      },
      h('circle', { cx: 27, cy: 27, r: 25, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1.5 }),
      h('circle', { cx: 27, cy: 27, r: 19, fill: color, opacity: 0.12 }),
      h('circle', {
        cx: 27,
        cy: 27,
        r: 19,
        stroke: color,
        strokeWidth: 1.8,
        strokeDasharray: '118',
        strokeDashoffset: status === 'ready' ? 0 : status === 'starting' ? 42 : 82,
        transform: 'rotate(-90 27 27)',
        strokeLinecap: 'round',
        style: { transition: 'stroke-dashoffset .5s ease' },
      }),
      h('circle', {
        cx: 27,
        cy: 27,
        r: 6.5,
        fill: color,
        className: tone === 'ok' ? 'sa-dot--pulse' : undefined,
      }),
    )
  }

  // -- overview ---------------------------------------------------------------

  function OverviewView(props) {
    const { t, state, setup, busy, note, onAction, onRefresh, onOpenSetup } = props
    const data = state.data || {}
    const setupData = setup.data
    const plugin = data.plugin || (setupData && setupData.plugin) || {}
    const status = plugin.status || (state.loading ? 'starting' : 'stopped')
    const paused = data.paused === true
    const sources = listOf(data.sources)
    const tickets = data.tickets && typeof data.tickets === 'object' ? data.tickets : {}
    const attention = listOf(tickets.attention)
    const active = listOf(tickets.active)
    const health = listOf(data.health)
    const healthy = sources.filter(source => source && source.health === 'ready').length
    const configured = setupData === undefined ? true : isSetupConfigured(setupData)
    const tone = pluginTone(status)

    const kindTone = kind => (kind === 'ready' ? 'ok' : kind === 'failed' ? 'error' : 'warn')

    function sourceRow(source, index) {
      return h(
        'div',
        { className: 'sa-row', key: source.id || index },
        h(Dot, { tone: source.health === 'ready' ? 'ok' : source.health === 'error' ? 'error' : source.health === 'starting' ? 'warn' : 'idle' }),
        h(
          'div',
          { className: 'sa-rowmain' },
          h('div', { className: 'sa-rowtitle' }, source.id || t('common.noValue')),
          source.detail ? h('div', { className: 'sa-rowmeta' }, source.detail) : null,
        ),
        h(Pill, { tone: source.health === 'ready' ? 'ok' : source.health === 'error' ? 'error' : 'plain' },
          t(`status.${source.health === 'ready' ? 'ready' : source.health === 'error' ? 'error' : source.health === 'starting' ? 'starting' : 'off'}`) || source.health),
      )
    }

    function attentionRow(ticket, index) {
      return h(
        'div',
        { className: 'sa-row sa-row--stack', key: ticket.id || index },
        h('span', { style: { marginTop: 5 } }, h(Dot, { tone: kindTone(ticket.kind) })),
        h(
          'div',
          { className: 'sa-rowmain' },
          h('div', { className: 'sa-rowtitle' }, ticket.title || ticket.id),
          ticket.question ? h('div', { className: 'sa-rowmeta sa-rowmeta--wrap', style: { marginTop: 3 } }, ticket.question) : null,
          h(
            'div',
            { className: 'sa-rowmeta', style: { marginTop: 3 } },
            h(Pill, { tone: kindTone(ticket.kind) }, ticket.kind),
            ticket.id ? h('span', { className: 'sa-mono', style: { marginLeft: 6 } }, ticket.id) : null,
            ticket.at ? h('span', { style: { marginLeft: 8 } }, formatTime(ticket.at)) : null,
          ),
        ),
        h(
          'div',
          { className: 'sa-rowactions' },
          h(Button, {
            size: 'sm',
            icon: 'retry',
            disabled: busy !== '',
            onClick: () => onAction('retry', ticket.id),
          }, t('overview.retry')),
          h(Button, {
            size: 'sm',
            variant: 'danger',
            icon: 'stop',
            disabled: busy !== '',
            onClick: () => onAction('stop', ticket.id),
          }, t('overview.stop')),
        ),
      )
    }

    function activeRow(ticket, index) {
      return h(
        'div',
        { className: 'sa-row', key: ticket.id || index },
        h(Dot, { tone: 'ok', pulse: true }),
        h(
          'div',
          { className: 'sa-rowmain' },
          h('div', { className: 'sa-rowtitle' }, ticket.title || ticket.id),
          h(
            'div',
            { className: 'sa-rowmeta' },
            [ticket.stage, ticket.lastReport ? `${t('overview.reportTip')}: ${ticket.lastReport}` : ''].filter(Boolean).join(' · ') ||
              t('overview.active'),
          ),
        ),
        h(
          'div',
          { className: 'sa-rowactions' },
          h(Button, {
            size: 'sm',
            variant: 'danger',
            icon: 'stop',
            disabled: busy !== '',
            onClick: () => onAction('stop', ticket.id),
          }, t('overview.stop')),
        ),
      )
    }

    return h(
      'div',
      { className: 'sa-fade' },
      state.error && !state.data
        ? h(Alert, {
            tone: 'error',
            title: t('overview.offlineTitle'),
            action: h(Button, { size: 'sm', onClick: onRefresh }, t('common.tryAgain')),
          }, h('div', null, t('overview.offlineBody'), h('div', { className: 'sa-mono', style: { marginTop: 3 } }, t('overview.apiHint'))))
        : null,

      h(
        Card,
        { variant: 'hero' },
        h(StatusOrb, { status }),
        h(
          'div',
          { className: 'sa-hero-text' },
          h(
            'h2',
            { className: 'sa-hero-title' },
            paused ? t('status.paused') : statusLabel(status, t),
            paused ? h(Pill, { tone: 'warn' }, t('overview.resume')) : null,
            plugin.version ? h(Pill, { tone: 'plain' }, `v${plugin.version}`) : null,
          ),
          h(
            'p',
            { className: 'sa-hero-detail' },
            plugin.detail || t('app.subtitle'),
          ),
          h(
            'div',
            { className: 'sa-rowmeta', style: { marginTop: 5 } },
            `${t('common.updated')} ${state.at ? formatTime(state.at) : t('common.noValue')}`,
          ),
        ),
        h(
          'div',
          { className: 'sa-hero-actions' },
          h(Button, {
            variant: paused ? 'primary' : undefined,
            icon: paused ? 'play' : 'pause',
            disabled: busy !== '',
            onClick: () => onAction(paused ? 'resume' : 'pause'),
          }, paused ? t('overview.resume') : t('overview.pause')),
          h(Button, { icon: 'refresh', onClick: onRefresh }, t('common.refresh')),
        ),
      ),

      !configured
        ? h(
            Card,
            { variant: 'banner' },
            h('div', { className: 'sa-stat-icon sa-stat-icon--ok' }, h(Icon, { name: 'spark', size: 20 })),
            h(
              'div',
              { style: { minWidth: 0, flex: '1 1 240px' } },
              h('div', { style: { fontSize: 14, fontWeight: 650 } }, t('overview.setupBannerTitle')),
              h('div', { className: 'sa-note', style: { marginTop: 2 } }, t('overview.setupBannerBody')),
            ),
            h(Button, { variant: 'primary', icon: 'arrowRight', onClick: onOpenSetup }, t('overview.openSetup')),
          )
        : null,

      h(
        'div',
        { className: 'sa-grid sa-grid--stats' },
        h(
          Card,
          { style: { padding: '15px 17px' } },
          h(
            'div',
            { className: 'sa-stat' },
            h('div', { className: `sa-stat-icon ${attention.length > 0 ? 'sa-stat-icon--warn' : 'sa-stat-icon--ok'}` },
              h(Icon, { name: attention.length > 0 ? 'alert' : 'checkCircle', size: 19 })),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'sa-stat-value' }, attention.length),
              h('div', { className: 'sa-stat-label' }, t('overview.attention')),
            ),
          ),
        ),
        h(
          Card,
          { style: { padding: '15px 17px' } },
          h(
            'div',
            { className: 'sa-stat' },
            h('div', { className: 'sa-stat-icon' }, h(Icon, { name: 'activity', size: 19 })),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'sa-stat-value' }, active.length),
              h('div', { className: 'sa-stat-label' }, t('overview.active')),
            ),
          ),
        ),
        h(
          Card,
          { style: { padding: '15px 17px' } },
          h(
            'div',
            { className: 'sa-stat' },
            h('div', { className: `sa-stat-icon ${sources.length > 0 && healthy === sources.length ? 'sa-stat-icon--ok' : ''}` },
              h(Icon, { name: 'globe', size: 19 })),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'sa-stat-value' }, `${healthy}/${sources.length}`),
              h('div', { className: 'sa-stat-label' }, t('overview.sourcesHealthy')),
            ),
          ),
        ),
      ),

      h(
        'div',
        { className: 'sa-grid sa-grid--two' },
        h(
          Card,
          null,
          h(CardHead, { icon: 'globe', title: t('overview.sources'), count: sources.length ? `(${sources.length})` : undefined }),
          sources.length === 0
            ? h(EmptyState, { icon: 'globe', title: t('overview.noSources'), hint: t('overview.noSourcesHint') })
            : h('div', { className: 'sa-list' }, sources.map(sourceRow)),
        ),
        h(
          Card,
          null,
          h(CardHead, { icon: 'alert', title: t('overview.attention'), count: attention.length ? `(${attention.length})` : undefined }),
          attention.length === 0
            ? h(EmptyState, { icon: 'checkCircle', title: t('overview.noAttention'), hint: t('overview.noAttentionHint') })
            : h('div', { className: 'sa-list' }, attention.map(attentionRow)),
        ),
      ),

      h(
        Card,
        null,
        h(CardHead, { icon: 'activity', title: t('overview.active'), count: active.length ? `(${active.length})` : undefined }),
        active.length === 0
          ? h(EmptyState, { icon: 'spark', title: t('overview.noActive'), hint: t('overview.noActiveHint') })
          : h('div', { className: 'sa-list' }, active.map(activeRow)),
      ),

      health.length > 0
        ? h(
            Card,
            null,
            h(CardHead, { icon: 'cpu', title: t('overview.health') }),
            h(
              'div',
              { className: 'sa-list' },
              health.map((entry, index) =>
                h(
                  'div',
                  { className: 'sa-row', key: entry.name || index },
                  h(Dot, { tone: entry.state === 'ready' ? 'ok' : entry.state === 'error' ? 'error' : 'warn' }),
                  h('div', { className: 'sa-rowmain' }, h('div', { className: 'sa-rowtitle' }, entry.name || t('common.noValue')),
                    entry.detail ? h('div', { className: 'sa-rowmeta' }, entry.detail) : null),
                ),
              ),
            ),
          )
        : null,

      note
        ? h(
            'div',
            { className: 'sa-toast', role: 'status' },
            h(Icon, { name: note.ok ? 'checkCircle' : 'alert', size: 14 }),
            h('span', null, note.text),
          )
        : null,
    )
  }

  // -- setup wizard -----------------------------------------------------------

  function SetupView(props) {
    const { t, wizard, setup, busy, saving, onSetWizard, onValidateTelegram, onValidateGithub, onSave, onSkipTelegram, onSkipGithub } = props
    const [revealed, setRevealed] = React.useState(false)
    const [repoQuery, setRepoQuery] = React.useState('')
    const step = wizard.step
    const labels = stepLabels(t)
    const states = stepStates(wizard)
    const configured = setup.data !== undefined && isSetupConfigured(setup.data)
    const telegram = wizard.telegram
    const github = wizard.github
    const behavior = wizard.behavior
    const finish = wizard.finish

    const setStep = next => onSetWizard(current => ({ ...current, step: next }))

    function patchTelegram(patch) {
      onSetWizard(current => ({ ...current, telegram: { ...current.telegram, ...patch } }))
    }

    function patchGithub(patch) {
      onSetWizard(current => ({ ...current, github: { ...current.github, ...patch } }))
    }

    function patchBehavior(patch) {
      onSetWizard(current => ({ ...current, behavior: { ...current.behavior, ...patch } }))
    }

    // -- step 1: Telegram ----------------------------------------------------

    function telegramStep() {
      const validated = telegram.status === 'validated'
      const validating = telegram.status === 'validating'
      return h(
        'div',
        { className: 'sa-fade' },
        h(
          Card,
          { variant: 'flat' },
          h(CardHead, {
            icon: 'telegram',
            title: t('telegram.title'),
            subtitle: t('telegram.desc'),
            action: h(Pill, { tone: validated ? 'ok' : 'plain' }, validated ? t('common.configured') : t('common.required')),
          }),
          validated
            ? h(
                'div',
                null,
                h(
                  Alert,
                  { tone: 'ok', title: t('telegram.success') },
                  h(
                    'div',
                    { className: 'sa-inline' },
                    h(Icon, { name: 'bot', size: 14 }),
                    h('span', { className: 'sa-mono' }, `@${telegram.botUsername || 'bot'}`),
                    h('a', {
                      className: 'sa-btn sa-btn--primary sa-btn--sm',
                      href: telegram.botUsername ? `https://t.me/${telegram.botUsername.replace(/^@/, '')}` : 'https://t.me/BotFather',
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    }, h(Icon, { name: 'external', size: 13 }), t('telegram.start')),
                  ),
                ),
                h('div', { className: 'sa-note', style: { marginTop: 8 } }, t('telegram.startHint')),
                telegram.tokenFile
                  ? h('div', { className: 'sa-rowmeta sa-mono', style: { marginTop: 6, wordBreak: 'break-all' } }, telegram.tokenFile)
                  : null,
              )
            : h(
                'div',
                { className: 'sa-grid sa-grid--two', style: { alignItems: 'start' } },
                h(
                  'div',
                  null,
                  h(
                    'ol',
                    { className: 'sa-note', style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 7 } },
                    h('li', null, t('telegram.howto1')),
                    h('li', null, t('telegram.howto2')),
                    h('li', null, t('telegram.howto3')),
                  ),
                  h('div', { className: 'sa-inline', style: { marginTop: 12 } },
                    h('a', {
                      className: 'sa-btn sa-btn--sm',
                      href: 'https://t.me/BotFather',
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    }, h(Icon, { name: 'external', size: 13 }), t('telegram.botfather'))),
                  h('div', { className: 'sa-note', style: { marginTop: 10 } }, t('telegram.noOauth')),
                ),
                h(
                  'div',
                  null,
                  h(
                    Field,
                    {
                      id: 'sa-telegram-token',
                      label: t('telegram.tokenLabel'),
                      hint: t('telegram.tokenHint'),
                    },
                    h(
                      'div',
                      { className: 'sa-inputrow' },
                      h(TextInput, {
                        id: 'sa-telegram-token',
                        type: revealed ? 'text' : 'password',
                        value: telegram.token,
                        placeholder: t('telegram.tokenPlaceholder'),
                        disabled: validating,
                        onChange: value => patchTelegram({ token: value, error: '' }),
                        onEnter: () => {
                          if (telegram.token.trim().length > 0 && !validating) onValidateTelegram(telegram.token.trim())
                        },
                      }),
                      h(Button, {
                        size: 'sm',
                        variant: 'ghost',
                        title: revealed ? t('common.hide') : t('common.show'),
                        disabled: validating,
                        onClick: () => setRevealed(value => !value),
                      }, revealed ? t('common.hide') : t('common.show')),
                    ),
                  ),
                  telegram.error ? h(Alert, { tone: 'error', title: t('telegram.error') }, telegram.error) : null,
                  h(
                    'div',
                    { className: 'sa-inline', style: { marginTop: 12 } },
                    h(Button, {
                      variant: 'primary',
                      icon: validating ? undefined : 'key',
                      disabled: validating || telegram.token.trim().length === 0,
                      onClick: () => onValidateTelegram(telegram.token.trim()),
                    }, validating ? h(Spinner, null) : null, validating ? t('telegram.validating') : t('telegram.validate')),
                  ),
                ),
              ),
        ),
      )
    }

    // -- step 2: GitHub ------------------------------------------------------

    function githubStep() {
      const validated = github.status === 'validated'
      const validating = github.status === 'validating'
      const repositories = listOf(github.repositories)
      const selected = listOf(github.selected)
      const selectedSet = new Set(selected)
      const query = repoQuery.trim().toLowerCase()
      const filtered = query.length === 0
        ? repositories
        : repositories.filter(repo => repo.fullName.toLowerCase().includes(query))
      const toggle = (fullName, on) => {
        const next = new Set(selectedSet)
        if (on) next.add(fullName)
        else next.delete(fullName)
        patchGithub({ selected: Array.from(next) })
      }
      const permissions = [
        t('github.permContents'),
        t('github.permIssues'),
        t('github.permPulls'),
        t('github.permChecks'),
        t('github.permActions'),
      ]
      return h(
        'div',
        { className: 'sa-fade' },
        h(
          Card,
          { variant: 'flat' },
          h(CardHead, {
            icon: 'github',
            title: t('github.title'),
            subtitle: t('github.desc'),
            action: h(Pill, { tone: validated ? 'ok' : 'plain' }, validated ? t('common.configured') : t('common.required')),
          }),
          h('div', { className: 'sa-section-title' }, t('github.permsTitle')),
          h('div', { className: 'sa-chips', style: { marginBottom: 14 } },
            permissions.map((text, index) => h('span', { className: 'sa-chip', key: index }, h(Icon, { name: 'check', size: 11 }), text))),
          validated
            ? h(
                'div',
                null,
                h(
                  Alert,
                  { tone: 'ok', title: t('github.success') },
                  h('div', { className: 'sa-inline' },
                    h(Icon, { name: 'github', size: 14 }),
                    h('span', { className: 'sa-mono' }, github.login || t('github.fineGrained')),
                    h(Pill, { tone: 'plain' }, t('github.selected', { count: selected.length })),
                    github.allowSelf === true ? h(Pill, { tone: 'ok' }, 'allowSelf') : null),
                ),
                repositories.length === 0
                  ? h('div', { className: 'sa-note', style: { marginTop: 8 } }, t('github.emptyRepos'))
                  : h(
                      'div',
                      null,
                      h('div', { className: 'sa-section-title', style: { marginTop: 14 } }, t('github.repos')),
                      h(
                        'div',
                        { className: 'sa-inline' },
                        h(
                          'div',
                          { style: { flex: '1 1 220px' } },
                          h(TextInput, {
                            value: repoQuery,
                            placeholder: t('github.searchRepos'),
                            onChange: value => setRepoQuery(value),
                          }),
                        ),
                        h(Button, {
                          size: 'sm',
                          onClick: () => patchGithub({ selected: filtered.map(repo => repo.fullName) }),
                        }, t('github.selectAll')),
                        h(Button, {
                          size: 'sm',
                          variant: 'ghost',
                          onClick: () => patchGithub({ selected: [] }),
                        }, t('github.selectNone')),
                      ),
                      h(
                        'div',
                        { className: 'sa-repolist' },
                        filtered.length === 0
                          ? h('div', { className: 'sa-note', style: { padding: 10 } }, t('github.emptyRepos'))
                          : filtered.map(repo =>
                              h(CheckboxRow, {
                                key: repo.fullName,
                                title: repo.fullName,
                                checked: selectedSet.has(repo.fullName),
                                badge: repo.private ? t('github.private') : undefined,
                                meta: repo.pushedAt ? `${t('github.pushed')} ${formatTime(repo.pushedAt)}` : undefined,
                                onChange: on => toggle(repo.fullName, on),
                              }),
                            ),
                      ),
                      selected.length === 0
                        ? h('div', { className: 'sa-hint', style: { marginTop: 6, color: 'var(--dsw-alias-state-warn-label)' } }, t('github.selectAtLeastOne'))
                        : null,
                    ),
                h('div', { className: 'sa-divider' }),
                h(
                  'label',
                  { className: 'sa-checkrow', style: { alignItems: 'flex-start', padding: '9px 8px' } },
                  h('input', {
                    type: 'checkbox',
                    checked: github.allowSelf === true,
                    onChange: event => patchGithub({ allowSelf: event.target.checked }),
                  }),
                  h(
                    'span',
                    { style: { minWidth: 0 } },
                    h('span', { className: 'sa-checkrow-name', style: { whiteSpace: 'normal', lineHeight: 1.4 } }, t('github.allowSelf')),
                    h('span', { className: 'sa-hint', style: { display: 'block', marginTop: 2 } }, t('github.allowSelfHint')),
                  ),
                ),
              )
            : h(
                'div',
                null,
                h(
                  Field,
                  {
                    id: 'sa-github-token',
                    label: t('github.tokenLabel'),
                    hint: t('github.tokenHint'),
                  },
                  h(
                    'div',
                    { className: 'sa-inputrow' },
                    h(TextInput, {
                      id: 'sa-github-token',
                      type: revealed ? 'text' : 'password',
                      value: github.token,
                      placeholder: t('github.tokenPlaceholder'),
                      disabled: validating,
                      onChange: value => patchGithub({ token: value, error: '' }),
                      onEnter: () => {
                        if (github.token.trim().length > 0 && !validating) onValidateGithub(github.token.trim())
                      },
                    }),
                    h(Button, {
                      size: 'sm',
                      variant: 'ghost',
                      title: revealed ? t('common.hide') : t('common.show'),
                      disabled: validating,
                      onClick: () => setRevealed(value => !value),
                    }, revealed ? t('common.hide') : t('common.show')),
                  ),
                ),
                github.error ? h(Alert, { tone: 'error', title: t('github.error') }, github.error) : null,
                h(
                  'div',
                  { className: 'sa-inline', style: { marginTop: 12 } },
                  h(Button, {
                    variant: 'primary',
                    icon: validating ? undefined : 'key',
                    disabled: validating || github.token.trim().length === 0,
                    onClick: () => onValidateGithub(github.token.trim()),
                  }, validating ? h(Spinner, null) : null, validating ? t('github.validating') : t('github.validate')),
                ),
              ),
        ),
      )
    }

    // -- step 3: behavior ----------------------------------------------------

    function behaviorStep() {
      const error = behaviorError(wizard, t)
      const workers = asNumber(behavior.maxWorkers, 2)
      return h(
        'div',
        { className: 'sa-fade' },
        h(
          Card,
          { variant: 'flat' },
          h(CardHead, { icon: 'settings', title: t('behavior.title'), subtitle: t('behavior.desc') }),
          h(
            Field,
            {
              id: 'sa-allowed-users',
              label: t('behavior.allowedUsers'),
              hint: telegram.status === 'validated' ? t('behavior.allowedUsersHint') : t('behavior.telegramSkipped'),
            },
            h(TextInput, {
              id: 'sa-allowed-users',
              value: behavior.allowedUserIds,
              placeholder: '123456789, 987654321',
              disabled: telegram.status !== 'validated',
              onChange: value => patchBehavior({ allowedUserIds: value }),
            }),
          ),
          h('div', { className: 'sa-divider' }),
          h('div', { className: 'sa-section-title' }, t('behavior.mode')),
          h(
            'div',
            { role: 'radiogroup', 'aria-label': t('behavior.mode') },
            h(RadioCard, {
              checked: behavior.mode === 'observe',
              title: t('behavior.modeObserve'),
              hint: t('behavior.modeObserveHint'),
              badge: t('common.recommended'),
              onSelect: () => patchBehavior({ mode: 'observe' }),
            }),
            h(RadioCard, {
              checked: behavior.mode === 'auto',
              title: t('behavior.modeAuto'),
              hint: t('behavior.modeAutoHint'),
              onSelect: () => patchBehavior({ mode: 'auto' }),
            }),
            h(RadioCard, {
              checked: behavior.mode === 'off',
              title: t('behavior.modeOff'),
              hint: t('behavior.modeOffHint'),
              onSelect: () => patchBehavior({ mode: 'off' }),
            }),
          ),
          h('div', { className: 'sa-divider' }),
          h(
            Field,
            { label: t('behavior.workers'), hint: t('behavior.workersHint') },
            h(NumberStepper, {
              label: t('behavior.workers'),
              value: Math.min(MAX_WORKERS, Math.max(1, workers)),
              min: 1,
              max: MAX_WORKERS,
              onChange: value => patchBehavior({ maxWorkers: value }),
            }),
          ),
          error ? h(Alert, { tone: 'warn' }, error) : null,
        ),
      )
    }

    // -- step 4: finish ------------------------------------------------------

    function finishStep() {
      const status = finish.status
      const elapsed = asNumber(finish.elapsed, 0)
      const percent = Math.min(100, Math.round((elapsed / (RESTART_WAIT_MS / 1000)) * 100))
      const summary = h(
        'div',
        { className: 'sa-summary' },
        h(SummaryRow, { label: t('finish.telegram') },
          telegram.status === 'validated'
            ? h('span', { className: 'sa-inline' }, h(Icon, { name: 'bot', size: 13 }), `@${telegram.botUsername || 'bot'}`)
            : t('finish.noTelegram')),
        h(SummaryRow, { label: t('finish.github') },
          github.status === 'validated'
            ? h('span', { className: 'sa-inline' }, h(Icon, { name: 'github', size: 13 }), github.login || t('github.fineGrained'),
                h(Pill, { tone: 'plain' }, t('github.selected', { count: listOf(github.selected).length })),
                github.allowSelf === true ? h(Pill, { tone: 'ok' }, 'allowSelf') : null)
            : t('finish.noGithub')),
        h(SummaryRow, { label: t('finish.mode') }, behavior.mode),
        h(SummaryRow, { label: t('finish.workers') }, String(asNumber(behavior.maxWorkers, 2))),
      )

      let stateBlock = null
      if (status === 'saving') {
        stateBlock = h('div', { className: 'sa-inline', style: { marginTop: 14 } }, h(Spinner, null), h('span', { className: 'sa-note' }, t('finish.saving')))
      } else if (status === 'restarting') {
        stateBlock = h(
          'div',
          { style: { marginTop: 14 } },
          h('div', { className: 'sa-inline' }, h(Spinner, null), h('span', { className: 'sa-note' }, t('finish.restarting'))),
          h('div', { className: 'sa-progress' }, h('div', { className: 'sa-progress-fill', style: { width: `${percent}%` } })),
          h('div', { className: 'sa-note', style: { marginTop: 5 } }, `${elapsed}s / ${RESTART_WAIT_MS / 1000}s · ${t('finish.restartWait')}`),
        )
      } else if (status === 'done') {
        stateBlock = h(
          'div',
          { style: { marginTop: 14 } },
          h(Alert, { tone: 'ok', title: t('finish.done') }, t('finish.doneHint')),
          h('div', { className: 'sa-inline', style: { marginTop: 10 } },
            h(Button, { variant: 'primary', icon: 'arrowRight', onClick: props.onOpenDashboard }, t('finish.openDashboard')),
            h(Button, { variant: 'ghost', onClick: props.onReconfigure }, t('finish.reconfigure'))),
        )
      } else if (status === 'timeout') {
        stateBlock = h(
          'div',
          { style: { marginTop: 14 } },
          h(Alert, { tone: 'warn', title: t('finish.timeout') }, t('finish.timeoutHint')),
          h('div', { className: 'sa-inline', style: { marginTop: 10 } },
            h(Button, { variant: 'primary', icon: 'retry', onClick: onSave }, t('common.retry')),
            h(Button, { variant: 'ghost', onClick: props.onOpenDashboard }, t('finish.openDashboard'))),
        )
      } else if (status === 'error') {
        stateBlock = h(
          'div',
          { style: { marginTop: 14 } },
          h(Alert, { tone: 'error', title: t('finish.error') }, finish.error || t('common.error')),
          h('div', { className: 'sa-inline', style: { marginTop: 10 } },
            h(Button, { variant: 'primary', icon: 'retry', onClick: onSave }, t('common.tryAgain')),
            h(Button, { variant: 'ghost', onClick: () => setStep(2) }, t('common.back'))),
        )
      }

      return h(
        'div',
        { className: 'sa-fade' },
        h(
          Card,
          { variant: 'flat' },
          h(CardHead, { icon: 'checkCircle', title: t('finish.title'), subtitle: t('finish.desc') }),
          h('div', { className: 'sa-section-title' }, t('finish.summary')),
          summary,
          h('div', { className: 'sa-note', style: { marginTop: 12 } }, t('finish.restartNote')),
          stateBlock,
          status === 'idle' || status === 'error'
            ? h('div', { className: 'sa-inline', style: { marginTop: 14 } },
                h(Button, { variant: 'primary', icon: 'check', disabled: saving, onClick: onSave }, t('finish.save')))
            : null,
        ),
      )
    }

    // -- footer --------------------------------------------------------------

    const stepContent =
      step === 0 ? telegramStep() : step === 1 ? githubStep() : step === 2 ? behaviorStep() : finishStep()

    const canContinue = step < 3 && canAdvance(step, wizard)
    const showSkip =
      (step === 0 && telegram.status !== 'validated' && telegram.skipped !== true) ||
      (step === 1 && github.status !== 'validated' && github.skipped !== true)

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
      h(
        'div',
        { className: 'sa-pagehead' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { className: 'sa-pagetitle' }, t('setup.title')),
          h('p', { className: 'sa-pagedesc' }, t('setup.subtitle')),
        ),
        h('div', { style: { marginLeft: 'auto' } },
          h(Pill, { tone: 'plain' }, t('setup.progress', { done: states.filter(state => state === 'done').length, total: WIZARD_STEPS.length }))),
      ),
      setup.error && !setup.data ? h(Alert, { tone: 'warn' }, t('setup.apiOffline')) : null,
      configured
        ? h(Alert, { tone: 'warn' }, t('setup.configuredNotice'))
        : null,
      h(Stepper, { labels, states, current: step, ariaLabel: t('setup.title') }),
      stepContent,
      h(
        'div',
        { className: 'sa-footerbar' },
        step > 0 && finish.status !== 'done'
          ? h(Button, { variant: 'ghost', onClick: () => setStep(step - 1) }, `← ${t('common.back')}`)
          : null,
        h('span', { className: 'sa-spacer' }),
        showSkip && step === 0 ? h(Button, { variant: 'ghost', onClick: onSkipTelegram }, t('telegram.skip')) : null,
        showSkip && step === 1 ? h(Button, { variant: 'ghost', onClick: onSkipGithub }, t('github.skip')) : null,
        step < 3
          ? h(Button, {
              variant: 'primary',
              icon: 'arrowRight',
              disabled: !canContinue,
              onClick: () => setStep(step + 1),
            }, t('common.next'))
          : null,
        step === 3 && finish.status === 'idle'
          ? h(Button, { variant: 'primary', icon: 'check', disabled: saving, onClick: onSave }, t('finish.save'))
          : null,
      ),
    )
  }

  // -- permissions ------------------------------------------------------------

  function PermissionsView(props) {
    const { t, permissions, onRefresh } = props
    const payload = permissions.data
    const runtimeEntries =
      payload && Array.isArray(payload.permissions)
        ? payload.permissions
        : Array.isArray(payload)
          ? payload
          : []

    const staticItems = [
      { id: 'network', icon: 'globe', title: t('permissions.network'), detail: t('permissions.networkDetail'), state: 'required' },
      { id: 'shell', icon: 'cpu', title: t('permissions.shell'), detail: t('permissions.shellDetail'), state: 'required' },
      { id: 'screen', icon: 'eye', title: t('permissions.screen'), detail: t('permissions.screenDetail'), state: 'not-required' },
      { id: 'accessibility', icon: 'users', title: t('permissions.accessibility'), detail: t('permissions.accessibilityDetail'), state: 'not-required' },
      { id: 'disk', icon: 'lock', title: t('permissions.disk'), detail: t('permissions.diskDetail'), state: 'not-required' },
      { id: 'watchdog', icon: 'clock', title: t('permissions.watchdog'), detail: t('permissions.watchdogDetail'), state: 'optional' },
    ]

    function stateLabel(state) {
      if (state === 'required') return t('permissions.required')
      if (state === 'optional') return t('permissions.optional')
      return t('permissions.notRequired')
    }

    function stateTone(state) {
      if (state === 'required') return 'warn'
      if (state === 'optional') return 'plain'
      return 'ok'
    }

    function itemCard(item, index) {
      return h(
        Card,
        { key: item.id || index, style: { padding: '15px 17px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
          h('div', { className: `sa-stat-icon ${item.state === 'not-required' ? 'sa-stat-icon--ok' : ''}` },
            h(Icon, { name: item.icon || 'shield', size: 18 })),
          h(
            'div',
            { style: { minWidth: 0, flex: '1 1 auto' } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 13.5, fontWeight: 620 } }, item.title || item.id),
              h(Pill, { tone: stateTone(item.state) }, stateLabel(item.state)),
              item.restartRequired ? h(Pill, { tone: 'warn' }, t('common.restartRequired')) : null,
            ),
            h('div', { className: 'sa-hint', style: { marginTop: 4 } }, item.detail || ''),
          ),
        ),
      )
    }

    return h(
      'div',
      { className: 'sa-fade', style: { display: 'flex', flexDirection: 'column', gap: 16 } },
      h(
        'div',
        { className: 'sa-pagehead' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { className: 'sa-pagetitle' }, t('permissions.title')),
          h('p', { className: 'sa-pagedesc' }, t('permissions.subtitle')),
        ),
        h('div', { style: { marginLeft: 'auto' } },
          h(Button, { size: 'sm', icon: 'refresh', onClick: onRefresh }, t('common.refresh'))),
      ),
      h('div', { className: 'sa-grid sa-grid--two' }, staticItems.map(itemCard)),
      h(
        Card,
        { variant: 'flat' },
        h(CardHead, {
          icon: 'clock',
          title: t('permissions.watchdog'),
          action: h(Pill, { tone: 'plain' }, t('permissions.watchdogOff')),
        }),
        h('div', { className: 'sa-note' }, t('permissions.watchdogDetail')),
        h('div', { className: 'sa-section-title', style: { marginTop: 14 } }, t('permissions.watchdogCommands')),
        h(CodeBlock, {
          copyText: 'node scripts/watchdog.mjs --state-dir ~/.dsh/state/superagent --dry-run',
          copyLabel: t('common.copy'),
        }, 'node scripts/watchdog.mjs --state-dir ~/.dsh/state/superagent --dry-run'),
        h(CodeBlock, {
          copyText: './scripts/install-launchd.sh --state-dir ~/.dsh/state/superagent',
          copyLabel: t('common.copy'),
        }, './scripts/install-launchd.sh --state-dir ~/.dsh/state/superagent'),
        h(CodeBlock, {
          copyText: './scripts/uninstall.sh',
          copyLabel: t('common.copy'),
        }, './scripts/uninstall.sh'),
      ),
      h(
        Card,
        null,
        h(CardHead, { icon: 'shield', title: t('permissions.api') }),
        runtimeEntries.length === 0
          ? h(EmptyState, { icon: 'info', title: t('permissions.apiEmpty') })
          : h('div', { className: 'sa-grid', style: { gap: 8 } },
              runtimeEntries.map((entry, index) =>
                h(
                  'div',
                  { className: 'sa-row', key: entry.id || index },
                  h(Dot, { tone: entry.state === 'required' ? 'warn' : entry.state === 'not-required' ? 'ok' : 'idle' }),
                  h(
                    'div',
                    { className: 'sa-rowmain' },
                    h('div', { className: 'sa-rowtitle' }, entry.title || entry.id || t('common.noValue')),
                    entry.detail ? h('div', { className: 'sa-rowmeta sa-rowmeta--wrap' }, entry.detail) : null,
                  ),
                  h(Pill, { tone: stateTone(entry.state) }, stateLabel(entry.state)),
                  entry.restartRequired ? h(Pill, { tone: 'warn' }, t('common.restartRequired')) : null,
                ),
              ),
            ),
      ),
      h(
        Card,
        { variant: 'flat' },
        h(CardHead, { icon: 'info', title: t('permissions.restart') }),
        h('div', { className: 'sa-note' }, t('permissions.restartDetail')),
      ),
    )
  }

  // -- page -------------------------------------------------------------------

  function SuperagentPage() {
    const t = React.useMemo(() => makeTranslator(ctxLocale), [])
    const api = React.useMemo(() => createApi(), [])
    const [view, setView] = React.useState('overview')
    const [wizard, setWizard] = React.useState(defaultWizard)
    const [busy, setBusy] = React.useState('')
    const [note, setNote] = React.useState(null)
    const aliveRef = React.useRef(true)
    const wizardRef = React.useRef(wizard)
    wizardRef.current = wizard

    React.useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    const dashboard = usePolling(() => api.get(API_PATHS.state), STATE_POLL_MS)
    const setup = usePolling(() => api.get(API_PATHS.setupState), SETUP_POLL_MS)
    const permissions = usePolling(() => api.get(API_PATHS.setupPermissions), 30000)

    const hydrated = React.useRef(false)
    React.useEffect(() => {
      const data = setup.snapshot.data
      if (hydrated.current || data === undefined) return
      hydrated.current = true
      if (!isSetupConfigured(data)) {
        setWizard(wizardFromSetup(data))
        setView('setup')
      }
    }, [setup.snapshot.data])

    React.useEffect(() => {
      if (!note) return undefined
      const timer = setTimeout(() => setNote(null), 5000)
      return () => clearTimeout(timer)
    }, [note])

    function refreshAll() {
      void dashboard.refresh()
      void setup.refresh()
      void permissions.refresh()
    }

    function actionText(action) {
      if (action === 'pause') return t('action.paused')
      if (action === 'resume') return t('action.resumed')
      if (action === 'retry') return t('action.retried')
      if (action === 'stop') return t('action.stopped')
      return t('action.unknown')
    }

    async function runAction(action, ticketId) {
      if (busy !== '') return
      setBusy(action)
      const body = ticketId === undefined ? { action } : { action, ticketId }
      const result = await api.post(API_PATHS.action, body)
      if (!aliveRef.current) return
      setBusy('')
      setNote(result.ok ? { ok: true, text: actionText(action) } : { ok: false, text: `${t('action.failed')}: ${result.error}` })
      void dashboard.refresh()
    }

    function openSetup() {
      const data = setup.snapshot.data
      setWizard(wizardFromSetup(data && typeof data === 'object' ? data : {}))
      setView('setup')
    }

    function openDashboard() {
      setView('overview')
      void dashboard.refresh()
      void setup.refresh()
    }

    async function validateTelegram(token) {
      setWizard(current => ({ ...current, telegram: { ...current.telegram, status: 'validating', error: '' } }))
      const result = await api.post(API_PATHS.setupTelegram, { token })
      if (!aliveRef.current) return
      if (!result.ok) {
        setWizard(current => ({ ...current, telegram: { ...current.telegram, status: 'error', error: result.error } }))
        return
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      setWizard(current => ({
        ...current,
        telegram: {
          ...current.telegram,
          status: 'validated',
          token: '',
          botUsername: asText(data.botUsername),
          tokenFile: asText(data.tokenFile),
          error: '',
          skipped: false,
        },
      }))
      void setup.refresh()
    }

    async function validateGithub(token) {
      setWizard(current => ({ ...current, github: { ...current.github, status: 'validating', error: '' } }))
      const result = await api.post(API_PATHS.setupGithub, { token })
      if (!aliveRef.current) return
      if (!result.ok) {
        setWizard(current => ({ ...current, github: { ...current.github, status: 'error', error: result.error } }))
        return
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const repositories = listOf(data.repositories).map(repoEntry).filter(Boolean)
      setWizard(current => {
        const existing = new Set(current.github.selected)
        const selected = repositories.map(repo => repo.fullName).filter(name => existing.has(name))
        return {
          ...current,
          github: {
            ...current.github,
            status: 'validated',
            token: '',
            login: asText(data.login),
            tokenFile: asText(data.tokenFile),
            repositories,
            selected,
            error: '',
            skipped: false,
          },
        }
      })
      void setup.refresh()
    }

    function skipTelegram() {
      setWizard(current => ({ ...current, telegram: { ...current.telegram, skipped: true, error: '' }, step: Math.min(3, current.step + 1) }))
    }

    function skipGithub() {
      setWizard(current => ({ ...current, github: { ...current.github, skipped: true, error: '' }, step: Math.min(3, current.step + 1) }))
    }

    async function saveAndWait() {
      const current = wizardRef.current
      if (current.finish.status === 'saving' || current.finish.status === 'restarting') return
      setWizard(wizardState => ({ ...wizardState, finish: { status: 'saving', error: '', elapsed: 0 } }))
      const result = await api.put(API_PATHS.setupConfig, { config: buildConfig(current) })
      if (!aliveRef.current) return
      if (!result.ok) {
        setWizard(wizardState => ({ ...wizardState, finish: { status: 'error', error: result.error, elapsed: 0 } }))
        return
      }
      setWizard(wizardState => ({ ...wizardState, finish: { status: 'restarting', error: '', elapsed: 0 } }))
      const expected = expectedAccounts(current)
      const startedAt = Date.now()
      // The PUT is answered before the configEditor edit and restart, so the
      // first GET can still describe the OLD ready plugin and the already
      // written token files. A short grace period avoids accepting that stale
      // state as "setup complete"; afterwards, ready + matching accounts + no
      // pending restart is the completion condition.
      await delay(RESTART_POLL_MS)
      while (Date.now() - startedAt < RESTART_WAIT_MS) {
        if (!aliveRef.current) return
        const poll = await api.get(API_PATHS.setupState)
        if (!aliveRef.current) return
        const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        const ready = poll.ok && poll.data && poll.data.plugin && poll.data.plugin.status === 'ready'
        const pending = poll.ok && poll.data && poll.data.restartRequired === true
        if (ready && !pending && accountsMatch(poll.data, expected)) {
          setWizard(wizardState => ({ ...wizardState, finish: { status: 'done', error: '', elapsed } }))
          void setup.refresh()
          void dashboard.refresh()
          return
        }
        setWizard(wizardState => ({ ...wizardState, finish: { status: 'restarting', error: '', elapsed } }))
        await delay(RESTART_POLL_MS)
      }
      if (!aliveRef.current) return
      setWizard(wizardState => ({
        ...wizardState,
        finish: { status: 'timeout', error: '', elapsed: Math.round((Date.now() - startedAt) / 1000) },
      }))
    }

    function reconfigure() {
      setWizard(wizardFromSetup(setup.snapshot.data || {}))
    }

    const plugin = (setup.snapshot.data && setup.snapshot.data.plugin) || (dashboard.snapshot.data && dashboard.snapshot.data.plugin) || {}
    const pluginStatus = plugin.status || (dashboard.snapshot.loading || setup.snapshot.loading ? 'starting' : 'stopped')
    const paused = dashboard.snapshot.data !== undefined && dashboard.snapshot.data.paused === true

    const tabs = [
      { id: 'overview', label: t('nav.overview'), icon: 'activity' },
      { id: 'setup', label: t('nav.setup'), icon: 'settings' },
      { id: 'permissions', label: t('nav.permissions'), icon: 'shield' },
    ]

    const saving = wizard.finish.status === 'saving' || wizard.finish.status === 'restarting'

    let content
    if (view === 'setup') {
      content = h(SetupView, {
        t,
        wizard,
        setup: setup.snapshot,
        busy,
        saving,
        onSetWizard: setWizard,
        onValidateTelegram: token => void validateTelegram(token),
        onValidateGithub: token => void validateGithub(token),
        onSave: () => void saveAndWait(),
        onSkipTelegram: skipTelegram,
        onSkipGithub: skipGithub,
        onOpenDashboard: openDashboard,
        onReconfigure: reconfigure,
      })
    } else if (view === 'permissions') {
      content = h(PermissionsView, { t, permissions: permissions.snapshot, onRefresh: () => void permissions.refresh() })
    } else {
      content = h(OverviewView, {
        t,
        state: dashboard.snapshot,
        setup: setup.snapshot,
        busy,
        note,
        onAction: (action, ticketId) => void runAction(action, ticketId),
        onRefresh: refreshAll,
        onOpenSetup: openSetup,
      })
    }

    return h(
      'div',
      { className: 'sa-root' },
      h('style', null, CSS),
      h(
        'header',
        { className: 'sa-header' },
        h(
          'div',
          { className: 'sa-header-inner' },
          h(
            'div',
            { className: 'sa-headrow' },
            h(
              'div',
              { className: 'sa-brand' },
              h(BrandMark, null),
              h(
                'div',
                { className: 'sa-brandtext' },
                h('h1', { className: 'sa-brandtitle' }, t('app.title')),
                h('p', { className: 'sa-brandsub' }, t('app.subtitle')),
              ),
            ),
            h('span', { className: 'sa-headspacer' }),
            h(Pill, { tone: pluginTone(pluginStatus), dot: pluginTone(pluginStatus) }, statusLabel(pluginStatus, t)),
            paused ? h(Pill, { tone: 'warn' }, t('status.paused')) : null,
            h(Button, { size: 'sm', variant: 'ghost', icon: 'refresh', title: t('common.refresh'), onClick: refreshAll }, t('common.refresh')),
          ),
          h(
            'div',
            { role: 'tablist', 'aria-label': t('app.title'), className: 'sa-tabs' },
            tabs.map(tab =>
              h(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  role: 'tab',
                  className: 'sa-tab',
                  'aria-selected': view === tab.id ? 'true' : 'false',
                  onClick: () => setView(tab.id),
                },
                tab.label,
              ),
            ),
          ),
        ),
      ),
      h('main', { className: 'sa-main' }, content),
    )
  }

  // -- registration -----------------------------------------------------------

  function SuperagentIcon(props) {
    const size = props.size === undefined ? 16 : props.size
    const active = props.active === true
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.78, color: 'currentColor' },
      },
      h('circle', { cx: 12, cy: 12, r: 3.1, fill: 'currentColor' }),
      h('ellipse', {
        cx: 12,
        cy: 12,
        rx: 9.2,
        ry: 4.6,
        stroke: 'currentColor',
        strokeWidth: 1.8,
        transform: 'rotate(-32 12 12)',
      }),
      h('circle', { cx: 19.4, cy: 8.1, r: 1.9, fill: 'currentColor' }),
    )
  }

  const inject = ['slots', 'locale']

  // `ctx.locale` is needed by the page; the wrapper records the live service
  // before registration and falls back to the static English dictionary when
  // the locale service is unavailable.
  let ctxLocale = { bind: () => key => EN[key] || key }

  function apply(ctx) {
    try {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'superagent: client dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SuperagentPage),
          ),
        'superagent: main page',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') },
              SuperagentIcon,
            ),
          ),
        'superagent: sidebar entry',
      )
    } catch (error) {
      console.warn('[superagent] panel failed to register:', error)
    }
  }

  function safeApply(ctx) {
    if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') ctxLocale = ctx.locale
    apply(ctx)
  }

  return {
    inject,
    apply: safeApply,
    internals: {
      // Views are exposed for the offline render smoke test; the loader only
      // reads `inject` and `apply`.
      views: { OverviewView, SetupView, PermissionsView },
      API_PATHS,
      WIZARD_STEPS,
      MAX_WORKERS,
      RESTART_WAIT_MS,
      defaultWizard,
      wizardFromSetup,
      stepLabels,
      stepStates,
      canAdvance,
      behaviorError,
      buildConfig,
      parseUserIds,
      repoEntry,
      repositoryChoices,
      isSetupConfigured,
      expectedAccounts,
      accountsMatch,
      errorText,
      formatTime,
    },
  }
}
