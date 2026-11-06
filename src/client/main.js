/**
 * Superagent panel — the optional observation surface of dsh-superagent-personal.
 *
 * This is a plain-JavaScript dynamic Client module (the `window.__ModuleLoader__`
 * format DSH loads for a bundle's `dsh.client` entry). It registers
 *  - one entry in the left sidebar's panel list, and
 *  - the page that entry opens in the layout's keyed `main` slot.
 *
 * The page only reads `GET /superagent/api/state` and posts the four actions of
 * `POST /superagent/api/action` (pause, resume, retry, stop); it never changes
 * configuration. Every failure is rendered inside the page — the host is never
 * affected: the factory catches its own errors, the request has a timeout, and
 * no React state update happens after unmount.
 *
 * Requirements from the host: the `slots` and `locale` Client services (the
 * registrations are effect-scoped), and the panel API served by
 * `src/app/api.ts` on the same origin.
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
  const REQUEST_HEADERS = { 'x-superagent-request': '1' }
  const POLL_MS = 5000
  const REQUEST_TIMEOUT_MS = 4000

  const DICTS = {
    zh: {
      panel: 'Superagent',
      title: 'Superagent',
      refresh: '刷新',
      pause: '暂停',
      resume: '恢复',
      retry: '重试',
      stop: '停止',
      status: '状态',
      sources: '来源',
      attention: '待你处理',
      active: '进行中',
      health: '组件健康',
      loading: '正在读取状态…',
      unreachable: '无法连接 Superagent（插件可能已降级或未运行）',
      noAttention: '没有需要你处理的事项',
      noActive: '没有进行中的 Ticket',
      noSources: '没有配置来源',
      noHealth: '没有组件报告',
      question: '问题',
      paused: '已暂停',
      running: '运行中',
      plugin: '插件',
      actionFailed: '操作失败',
      actionOk: '操作已接受',
      hint: '这里只做观察与暂停/重试/停止；完整操作请在 Telegram 完成。',
      updatedAt: '更新于',
      healthError: '异常',
      healthReady: '正常',
      tickets: 'Ticket',
      stage: '阶段',
      report: '最近报告',
    },
    en: {
      panel: 'Superagent',
      title: 'Superagent',
      refresh: 'Refresh',
      pause: 'Pause',
      resume: 'Resume',
      retry: 'Retry',
      stop: 'Stop',
      status: 'Status',
      sources: 'Sources',
      attention: 'Waiting for you',
      active: 'Active',
      health: 'Components',
      loading: 'Reading state…',
      unreachable: 'Superagent is not answering (the plugin may be degraded or stopped).',
      noAttention: 'Nothing needs your attention.',
      noActive: 'No active tickets.',
      noSources: 'No sources configured.',
      noHealth: 'No component reports yet.',
      question: 'Question',
      paused: 'Paused',
      running: 'Running',
      plugin: 'Plugin',
      actionFailed: 'Action failed',
      actionOk: 'Action accepted',
      hint: 'This page only observes and pauses/retries/stops; use Telegram for everything else.',
      updatedAt: 'Updated',
      healthError: 'error',
      healthReady: 'ready',
      tickets: 'Ticket',
      stage: 'stage',
      report: 'last report',
    },
  }

  // -- data -----------------------------------------------------------------

  function readJson(response) {
    return response.json().catch(() => undefined)
  }

  async function request(path, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(path, {
        ...init,
        signal: controller.signal,
        headers: { ...REQUEST_HEADERS, ...(init && init.headers ? init.headers : {}) },
      })
      const body = await readJson(response)
      if (!response.ok) {
        const message = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  function fetchState() {
    return request(`${API}/state`, { method: 'GET', cache: 'no-store' })
  }

  function postAction(action, ticketId) {
    const body = { action }
    if (ticketId !== undefined) body.ticketId = ticketId
    return request(`${API}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * Poll the plugin state while the page is mounted. Requests never overlap:
   * the next poll starts only after the previous round settled, and an
   * in-flight request is aborted when the page unmounts.
   */
  function usePanelState() {
    const [snapshot, setSnapshot] = React.useState({
      phase: 'loading',
      data: undefined,
      error: undefined,
      at: undefined,
    })
    const [busy, setBusy] = React.useState(undefined)
    const [note, setNote] = React.useState(undefined)

    const load = React.useCallback(async () => {
      try {
        const data = await fetchState()
        setSnapshot({ phase: 'ready', data, error: undefined, at: new Date().toISOString() })
      } catch (error) {
        setSnapshot(previous => ({
          phase: previous.data === undefined ? 'error' : 'stale',
          data: previous.data,
          error: error instanceof Error ? error.message : String(error),
          at: previous.at,
        }))
      }
    }, [])

    React.useEffect(() => {
      let active = true
      let timer
      const tick = async () => {
        await load()
        if (!active) return
        timer = setTimeout(tick, POLL_MS)
      }
      void tick()
      return () => {
        active = false
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [load])

    const act = React.useCallback(
      async (action, ticketId) => {
        if (busy !== undefined) return
        setBusy(action)
        setNote(undefined)
        try {
          const result = await postAction(action, ticketId)
          if (result && result.ok === false) throw new Error(result.error || 'refused')
          setNote({ ok: true, text: result && result.result ? String(result.result) : undefined })
          await load()
        } catch (error) {
          setNote({ ok: false, text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(undefined)
        }
      },
      [busy, load],
    )

    return { snapshot, busy, note, act, reload: load }
  }

  // -- presentation ---------------------------------------------------------

  const COLORS = {
    text: 'var(--dsw-alias-label-primary)',
    secondary: 'var(--dsw-alias-label-secondary)',
    tertiary: 'var(--dsw-alias-label-tertiary)',
    border: 'var(--dsw-alias-border-l2)',
    surface: 'var(--dsw-alias-bg-layer-1)',
    base: 'var(--dsw-alias-bg-base)',
    hover: 'var(--dsw-alias-interactive-bg-hover)',
    ok: 'var(--dsw-alias-state-business-primary)',
    error: 'var(--dsw-alias-state-error-primary)',
    warn: 'var(--dsw-alias-state-warn-label)',
  }

  const styles = {
    page: {
      height: '100%',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '24px 28px 40px',
      color: COLORS.text,
      background: COLORS.base,
      font: 'inherit',
    },
    inner: { maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
    header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
    title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.3 },
    pill: {
      borderRadius: 999,
      padding: '2px 10px',
      fontSize: 12,
      border: `1px solid ${COLORS.border}`,
      color: COLORS.secondary,
      whiteSpace: 'nowrap',
    },
    spacer: { flex: '1 1 auto' },
    section: {
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      background: COLORS.surface,
      padding: '14px 16px',
    },
    sectionTitle: { margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: COLORS.secondary },
    row: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
      padding: '6px 0',
      borderTop: `1px solid ${COLORS.border}`,
      minWidth: 0,
    },
    rowFirst: { padding: '6px 0', display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 },
    name: { fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    detail: { color: COLORS.secondary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' },
    dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
    empty: { color: COLORS.tertiary, fontSize: 13, padding: '4px 0' },
    actions: { display: 'flex', gap: 8, marginLeft: 'auto', flex: '0 0 auto' },
    button: {
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      padding: '3px 10px',
      borderRadius: 6,
      border: `1px solid ${COLORS.border}`,
      background: 'transparent',
      color: COLORS.text,
      cursor: 'pointer',
    },
    buttonPrimary: {
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      padding: '3px 10px',
      borderRadius: 6,
      border: `1px solid ${COLORS.border}`,
      background: 'transparent',
      color: COLORS.text,
      cursor: 'pointer',
      fontWeight: 600,
    },
    note: { fontSize: 12, minHeight: 18 },
    footer: { color: COLORS.tertiary, fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' },
  }

  function tone(state) {
    if (state === 'ready' || state === 'ok') return COLORS.ok
    if (state === 'error' || state === 'failed') return COLORS.error
    if (state === 'starting' || state === 'warn' || state === 'waiting') return COLORS.warn
    return COLORS.tertiary
  }

  function statusTone(status) {
    if (status === 'ready') return COLORS.ok
    if (status === 'degraded') return COLORS.error
    if (status === 'starting') return COLORS.warn
    return COLORS.tertiary
  }

  function Row(props) {
    const style = props.first ? styles.rowFirst : styles.row
    return h(
      'div',
      { style },
      props.dot ? h('span', { style: { ...styles.dot, background: props.dot } }) : null,
      h('span', { style: styles.name }, props.name),
      props.detail ? h('span', { style: styles.detail }, props.detail) : null,
      props.children,
    )
  }

  function Button(props) {
    const style = props.primary ? styles.buttonPrimary : styles.button
    return h(
      'button',
      {
        type: 'button',
        style: { ...style, opacity: props.disabled ? 0.5 : 1, cursor: props.disabled ? 'default' : 'pointer' },
        disabled: props.disabled === true,
        onClick: props.disabled ? undefined : props.onClick,
        title: props.title,
      },
      props.label,
    )
  }

  function StatusPill(props) {
    return h(
      'span',
      { style: { ...styles.pill, color: props.tone, borderColor: props.tone } },
      props.label,
    )
  }

  function SourcesSection(props) {
    const sources = props.sources || []
    return h(
      'section',
      { style: styles.section },
      h('h2', { style: styles.sectionTitle }, props.t.sources),
      sources.length === 0
        ? h('div', { style: styles.empty }, props.t.noSources)
        : sources.map((source, index) =>
            h(Row, {
              key: source.id || index,
              first: index === 0,
              dot: tone(source.health),
              name: source.id || '?',
              detail: source.health + (source.detail ? ` · ${source.detail}` : ''),
            }),
          ),
    )
  }

  function AttentionSection(props) {
    const tickets = props.tickets || []
    return h(
      'section',
      { style: styles.section },
      h('h2', { style: styles.sectionTitle }, `${props.t.attention} (${tickets.length})`),
      tickets.length === 0
        ? h('div', { style: styles.empty }, props.t.noAttention)
        : tickets.map((ticket, index) =>
            h(
              'div',
              { key: ticket.id || index, style: index === 0 ? styles.rowFirst : styles.row },
              h('span', { style: { ...styles.dot, background: tone(ticket.kind) } }),
              h(
                'span',
                { style: { minWidth: 0 } },
                h('span', { style: styles.name }, ticket.title || ticket.id),
                ticket.question ? h('span', { style: { ...styles.detail, display: 'block' } }, `${props.t.question}: ${ticket.question}`) : null,
                h('span', { style: { ...styles.detail, display: 'block' } }, `${ticket.kind || ''}${ticket.id ? ` · ${ticket.id}` : ''}`),
              ),
              h(
                'div',
                { style: styles.actions },
                h(Button, {
                  label: props.t.retry,
                  disabled: props.busy !== undefined,
                  onClick: () => props.act('retry', ticket.id),
                }),
                h(Button, {
                  label: props.t.stop,
                  disabled: props.busy !== undefined,
                  onClick: () => props.act('stop', ticket.id),
                }),
              ),
            ),
          ),
    )
  }

  function ActiveSection(props) {
    const tickets = props.tickets || []
    return h(
      'section',
      { style: styles.section },
      h('h2', { style: styles.sectionTitle }, `${props.t.active} (${tickets.length})`),
      tickets.length === 0
        ? h('div', { style: styles.empty }, props.t.noActive)
        : tickets.map((ticket, index) =>
            h(Row, {
              key: ticket.id || index,
              first: index === 0,
              dot: COLORS.ok,
              name: ticket.title || ticket.id,
              detail: [ticket.stage, ticket.lastReport].filter(Boolean).join(' · '),
              children: h(
                'div',
                { style: styles.actions },
                h(Button, {
                  label: props.t.stop,
                  disabled: props.busy !== undefined,
                  onClick: () => props.act('stop', ticket.id),
                }),
              ),
            }),
          ),
    )
  }

  function HealthSection(props) {
    const entries = props.health || []
    if (entries.length === 0) {
      return h(
        'section',
        { style: styles.section },
        h('h2', { style: styles.sectionTitle }, props.t.health),
        h('div', { style: styles.empty }, props.t.noHealth),
      )
    }
    return h(
      'section',
      { style: styles.section },
      h('h2', { style: styles.sectionTitle }, props.t.health),
      entries.map((entry, index) =>
        h(Row, {
          key: entry.name || index,
          first: index === 0,
          dot: tone(entry.state),
          name: entry.name || '?',
          detail: entry.state + (entry.detail ? ` · ${entry.detail}` : ''),
        }),
      ),
    )
  }

  function SuperagentPage() {
    const t = React.useMemo(() => {
      try {
        return ctxLocale.bind(NS)
      } catch {
        return key => DICTS.en[key] || key
      }
    }, [])
    const state = usePanelState()
    const snapshot = state.snapshot
    const data = snapshot.data || {}
    const plugin = data.plugin || {}
    const paused = data.paused === true
    const tickets = data.tickets || {}
    const pluginStatus = snapshot.phase === 'error' ? 'stopped' : plugin.status || 'starting'

    return h(
      'div',
      { style: styles.page },
      h(
        'div',
        { style: styles.inner },
        h(
          'div',
          { style: styles.header },
          h('h1', { style: styles.title }, t('title')),
          h(StatusPill, { label: `${t('plugin')}: ${pluginStatus}`, tone: statusTone(pluginStatus) }),
          h(StatusPill, { label: paused ? t('paused') : t('running'), tone: paused ? COLORS.warn : COLORS.ok }),
          h('span', { style: styles.spacer }),
          h(Button, {
            label: paused ? t('resume') : t('pause'),
            primary: true,
            disabled: state.busy !== undefined || snapshot.phase === 'error',
            onClick: () => state.act(paused ? 'resume' : 'pause'),
          }),
          h(Button, {
            label: t('refresh'),
            disabled: state.busy !== undefined,
            onClick: () => void state.reload(),
          }),
        ),
        plugin.detail ? h('div', { style: { color: COLORS.error, fontSize: 13 } }, String(plugin.detail)) : null,
        snapshot.phase === 'loading' ? h('div', { style: styles.empty }, t('loading')) : null,
        snapshot.phase === 'error'
          ? h('div', { style: { ...styles.section, borderColor: COLORS.error, color: COLORS.error } }, `${t('unreachable')} (${snapshot.error || ''})`)
          : null,
        snapshot.phase === 'stale'
          ? h('div', { style: { ...styles.section, borderColor: COLORS.warn, color: COLORS.warn } }, `${t('unreachable')} — ${snapshot.error || ''}`)
          : null,
        h(SourcesSection, { t, sources: data.sources }),
        h(AttentionSection, { t, tickets: tickets.attention, act: state.act, busy: state.busy }),
        h(ActiveSection, { t, tickets: tickets.active, act: state.act, busy: state.busy }),
        h(HealthSection, { t, health: data.health }),
        state.note
          ? h(
              'div',
              { style: { ...styles.note, color: state.note.ok ? COLORS.ok : COLORS.error } },
              `${state.note.ok ? t('actionOk') : t('actionFailed')}${state.note.text ? `: ${state.note.text}` : ''}`,
            )
          : null,
        h(
          'div',
          { style: styles.footer },
          h('span', null, t('hint')),
          snapshot.at ? h('span', null, `${t('updatedAt')} ${snapshot.at}`) : null,
        ),
      ),
    )
  }

  function SuperagentIcon(props) {
    const size = props.size === undefined ? 16 : props.size
    const active = props.active === true
    return h(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.75 },
      },
      // An orbit: a small agent core with one satellite, drawn in currentColor
      // so the host's sidebar colors apply.
      h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'currentColor' }),
      h('ellipse', {
        cx: 8,
        cy: 8,
        rx: 6.1,
        ry: 3.1,
        stroke: 'currentColor',
        strokeWidth: 1.2,
        transform: 'rotate(-35 8 8)',
      }),
      h('circle', { cx: 13.1, cy: 5.6, r: 1.35, fill: 'currentColor' }),
    )
  }

  const inject = ['slots', 'locale']

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

  // `ctx.locale` is needed by the page, which ignores slot props; the wrapper
  // records the live service before the registrations run, and falls back to a
  // static English dictionary when the locale service is unavailable.
  let ctxLocale = { bind: () => key => DICTS.en[key] || key }

  return {
    inject,
    apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') ctxLocale = ctx.locale
      apply(ctx)
    },
  }
}
