/**
 * Browser half: the dsh-auto-continue card on its own page in the Plugins page.
 *
 * DSH renders no generic config form for a third-party plugin entry, so the two
 * retry knobs get a card of their own, registered into `plugins.bundle.config` under
 * this package's name — the slot the Plugins page renders on the bundle's own page
 * (the Settings nav is left untouched). The values are the loader entry's volatile
 * fields (`maxRetries`, `retryIntervalMs`), written through the host's own settings
 * form model — the same path the built-in cards use, so saves are revision-checked
 * and persisted by the host rather than by this plugin.
 *
 * This file is the body of the host's module-loader factory: it is plain CJS, it may
 * `require` only platform-seeded packages (React and the client UI primitives), and
 * it ends by assigning `module.exports`. `scripts/build-client.mjs` wraps it.
 *
 * @module dsh-auto-continue/client
 */

const React = require('react')
// Platform seed, like React — but required softly: a host whose module table lacks it
// still gets the status card, just without the editable retry form. A plain require
// would take the whole browser half down with it.
let primitives
try {
  primitives = require('@deepseek-ai/dsh-client-ui-primitives')
} catch (error) {
  console.error('[dsh-auto-continue] client UI primitives unavailable:', error)
}
const h = React.createElement

/** Stable browser-plugin name. */
const name = 'dsh-auto-continue-client'

/**
 * Client services required by this card.
 *
 * Only services present on every host line may be named here: cordis' gate is hard,
 * and an inject entry the running line does not provide keeps `apply` from ever
 * running. The config-form service is reached through `ctx.get()` inside `apply`.
 */
const inject = ['slots', 'locale']

/** Settings namespace; the loader entry id, shared with the host half. */
const SETTINGS_NS = 'auto-continue'

/** Host plugin entry id, used to find this plugin's config form. */
const ENTRY_ID = 'auto-continue'

/**
 * This card's key in the Plugins page's `plugins.bundle.config` slot.
 *
 * That page keys the slot by the bundle's package name — the name the profile lists
 * in `dsh.profile.bundles` — and renders the occupant on the bundle's own page.
 */
const BUNDLE_KEY = 'dsh-auto-continue'

/** Plugin-owned status route. Mirrored from lib/index.js. */
const STATUS_PATH = '/_auto-continue/status'

/** How often the card re-reads the status document while it is open. */
const POLL_INTERVAL_MS = 5000

/** Style tag id, and the class every rule is scoped under. */
const STYLE_ID = 'dsh-auto-continue-client-css'
const ROOT_CLASS = 'dsm-ac-card'

const zh = {
  'row.summary': '异常中断后自动补一句「继续」；用户自己点的终止一律不动。',
  'retry.title': '重试参数',
  'retry.hint': '写入本插件的设置，优先级高于 loader 里的 rules。重试次数按 30 分钟窗口累计；间隔是第 2 次起的退避起点（×2 递增、±30% 抖动、上限 30 秒），第 1 次投递总是立即进行。',
  'retry.maxRetries': '重试次数',
  'retry.maxRetriesHint': '同一会话在窗口内最多自动续几次（0 = 一次都不续）。',
  'retry.interval': '重试间隔（毫秒）',
  'retry.intervalHint': '第 2 次起的退避起点；0 = 不等待，立刻重试。',
  'retry.save': '保存',
  'retry.saving': '保存中…',
  'retry.overridden': '已覆盖默认值',
  'retry.reset': '恢复默认',
  'retry.invalid': '请填 0 或正整数',
  'form.unavailable': '宿主没有为这个插件提供配置表单，这里只显示运行状态。',
  'form.readOnly': '当前配置只读。',
  'form.saveFailed': '保存失败。',
  'status.title': '运行状态',
  'status.hint': '读自 /_auto-continue/status（该路由只服务回环地址）。',
  'status.seen': '见过轮次',
  'status.continued': '已续',
  'status.pending': '排队中',
  'status.lastSkip': '最近跳过',
  'status.watchdog': '看门狗',
  'status.watchdogOff': '关',
  'status.none': '—',
  'status.unreachable': '状态路由不可达',
}

const en = {
  'row.summary': 'Appends a "continue" turn after an abnormal interruption; a stop you triggered yourself is never touched.',
  'retry.title': 'Retry settings',
  'retry.hint': 'Stored in this plugin\'s settings, and they outrank the loader\'s rules. The count is per 30-minute window; the interval is the backoff base from the 2nd delivery on (doubles, ±30% jitter, 30s cap). The first delivery is always immediate.',
  'retry.maxRetries': 'Retries',
  'retry.maxRetriesHint': 'How many times one session may auto-continue inside the window (0 = never).',
  'retry.interval': 'Retry interval (ms)',
  'retry.intervalHint': 'Backoff base from the 2nd delivery on; 0 = retry immediately.',
  'retry.save': 'Save',
  'retry.saving': 'Saving…',
  'retry.overridden': 'Overridden',
  'retry.reset': 'Reset',
  'retry.invalid': 'Enter 0 or a positive integer',
  'form.unavailable': 'This host serves no config form for the plugin; only the live status is shown.',
  'form.readOnly': 'The current config is read-only.',
  'form.saveFailed': 'Save failed.',
  'status.title': 'Live status',
  'status.hint': 'Read from /_auto-continue/status (loopback only).',
  'status.seen': 'turns seen',
  'status.continued': 'continued',
  'status.pending': 'pending',
  'status.lastSkip': 'last skip',
  'status.watchdog': 'watchdog',
  'status.watchdogOff': 'off',
  'status.none': '—',
  'status.unreachable': 'status route unreachable',
}

/**
 * Install the card's stylesheet.
 *
 * Every rule is scoped under `ROOT_CLASS`, the class on this card's own root node —
 * the `data-plugin-css` attribute only dedupes injection, it is not an ancestor of
 * anything, so a rule prefixed with it would silently never apply.
 */
function installStyles() {
  try {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.setAttribute('data-plugin-css', name)
    style.textContent = [
      '.' + ROOT_CLASS + ' { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px; }',
      '.' + ROOT_CLASS + ' .dsm-ac-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.' + ROOT_CLASS + ' .dsm-ac-block { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid rgba(127, 127, 127, 0.24); border-radius: var(--dsw-radius-sm); }',
      '.' + ROOT_CLASS + ' .dsm-ac-blocktitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.' + ROOT_CLASS + ' .dsm-ac-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.' + ROOT_CLASS + ' .dsm-ac-metrics { display: flex; flex-wrap: wrap; gap: 8px 18px; }',
      '.' + ROOT_CLASS + ' .dsm-ac-metric { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }',
      '.' + ROOT_CLASS + ' .dsm-ac-k { color: var(--dsw-alias-label-secondary); }',
      '.' + ROOT_CLASS + ' .dsm-ac-v { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; word-break: break-all; }',
    ].join('\n')
    document.head.appendChild(style)
  } catch (error) {
    console.error('[dsh-auto-continue] styles unavailable:', error)
  }
}

/**
 * The retry card.
 *
 * Purely presentational: the model, the subscribed snapshot and the actions all
 * arrive as props (built once in `apply`), so this component subscribes to nothing
 * itself and the card renders without it when the host serves no config form.
 */
function RetryForm(props) {
  const { t, form, edit, resetField } = props
  const disabled = form.writable !== true
  return h('div', { className: 'dsm-ac-block' },
    h('span', { className: 'dsm-ac-blocktitle' }, t('retry.title')),
    h('p', { className: 'dsm-ac-hint' }, t('retry.hint')),
    h(primitives.SettingsForm, {
      labels: {
        unavailable: t('form.unavailable'),
        readOnly: t('form.readOnly'),
        saveFailed: t('form.saveFailed'),
        save: t('retry.save'),
        saving: t('retry.saving'),
      },
      state: form,
      onSave: props.save,
      onDiscard: props.discard,
    },
      h(primitives.SettingsValueField, {
        id: 'dsm-ac-max-retries',
        label: t('retry.maxRetries'),
        hint: t('retry.maxRetriesHint'),
        overriddenLabel: t('retry.overridden'),
        resetLabel: t('retry.reset'),
        invalidLabel: t('retry.invalid'),
        disabled,
        ...form.maxRetries,
        onEdit: text => edit('maxRetries', text),
        onReset: () => resetField('maxRetries'),
      }),
      h(primitives.SettingsValueField, {
        id: 'dsm-ac-retry-interval',
        label: t('retry.interval'),
        hint: t('retry.intervalHint'),
        overriddenLabel: t('retry.overridden'),
        resetLabel: t('retry.reset'),
        invalidLabel: t('retry.invalid'),
        disabled,
        ...form.retryIntervalMs,
        onEdit: text => edit('retryIntervalMs', text),
        onReset: () => resetField('retryIntervalMs'),
      })))
}

/** The live status strip: what the host half has seen and done since it loaded. */
function StatusCard(props) {
  const { t, status } = props
  const show = value => (value === undefined || value === null || value === '' ? t('status.none') : String(value))
  let rows
  if (status === null) {
    rows = [[t('status.seen'), t('status.none')]]
  } else if (status.unreachable !== undefined) {
    rows = [[t('status.unreachable'), String(status.unreachable)]]
  } else {
    const watchdog = status.watchdog
    const watchdogText = watchdog === undefined
      ? t('status.none')
      : watchdog.minutes > 0
        ? watchdog.minutes + ' min · watching ' + show(watchdog.watching) + ' · fires ' + show(watchdog.fires)
        : t('status.watchdogOff')
    const skip = status.lastSkip
    rows = [
      [t('status.seen'), show(status.seen)],
      [t('status.continued'), show(status.continued)],
      [t('status.pending'), show(status.pending)],
      [t('status.lastSkip'), show(skip && skip.reason !== undefined ? skip.reason : skip)],
      [t('status.watchdog'), watchdogText],
    ]
  }
  return h('div', { className: 'dsm-ac-block' },
    h('span', { className: 'dsm-ac-blocktitle' }, t('status.title')),
    h('p', { className: 'dsm-ac-hint' }, t('status.hint')),
    h('div', { className: 'dsm-ac-metrics' }, rows.map((row, index) => h('div', {
      className: 'dsm-ac-metric',
      key: 'metric-' + index,
    }, h('span', { className: 'dsm-ac-k' }, row[0]), h('span', { className: 'dsm-ac-v' }, row[1])))),
  )
}

/**
 * The card: the retry form plus the live status in the `page` view, one locale-driven
 * line in the `summary` view the Plugins page asks for when the bundle has no
 * description of its own. Renders with or without the config form. The hook order is
 * fixed — the summary view is a branch after them, never a second component.
 */
function AutoContinueCard(props) {
  const { t, form } = props
  const summary = props.view === 'summary'
  const [status, setStatus] = React.useState(null)
  // The card is the only reader of the status document, so the interval is owned
  // here and torn down with the component. The summary view never needs it.
  React.useEffect(() => {
    if (summary) return undefined
    let alive = true
    const read = async () => {
      try {
        const response = await fetch(STATUS_PATH, { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const next = await response.json()
        if (alive) setStatus(next)
      } catch (error) {
        if (alive) setStatus({ unreachable: String(error && error.message ? error.message : error) })
      }
    }
    void read()
    const timer = setInterval(read, POLL_INTERVAL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [summary])
  if (summary) return t('row.summary')
  return h('div', { className: ROOT_CLASS },
    form === undefined
      ? h('div', { className: 'dsm-ac-block' }, h('p', { className: 'dsm-ac-hint' }, t('form.unavailable')))
      : h(RetryForm, { ...props, form }),
    h(StatusCard, { t, status }))
}

/**
 * The same card, subscribed to the config form.
 *
 * A separate component on purpose: the subscription hook must not be called
 * conditionally, and the card renders with or without a form depending on whether
 * the host has one to serve.
 */
function AutoContinueCardWithConfig(props) {
  return h(AutoContinueCard, { ...props, form: props.useRetryForm(snapshot => snapshot) })
}

function apply(ctx) {
  try {
    const namespace = 'settings.' + SETTINGS_NS
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-auto-continue: settings copy')
    const t = ctx.locale.bind(namespace)

    installStyles()

    // This plugin's config form (the loader entry's schema) is served by the host,
    // but nothing renders it for a third-party plugin. `configForms` is deliberately
    // absent from `inject`: on a host line that does not provide it, naming it would
    // stop `apply` from ever running and the card would vanish. The model is built
    // once — rebuilding it per render would discard whatever was staged.
    let retryForm
    const resolveRetryForm = () => {
      if (retryForm !== undefined) return retryForm
      try {
        if (primitives === undefined || typeof primitives.SettingsFormModel !== 'function') return undefined
        const scope = ctx.get && ctx.get('configForms') ? ctx.get('configForms').get(ENTRY_ID) : undefined
        if (scope === undefined) return undefined
        const model = new primitives.SettingsFormModel(scope, [
          primitives.settingsNumberField('maxRetries'),
          primitives.settingsNumberField('retryIntervalMs'),
        ])
        const store = model.bind(() => ({
          ...model.shell(),
          maxRetries: model.field('maxRetries'),
          retryIntervalMs: model.field('retryIntervalMs'),
        }))
        ctx.effect(() => () => model.dispose && model.dispose(), 'dsh-auto-continue: retry form')
        retryForm = { store, actions: model.actions() }
      } catch (error) {
        console.error('[dsh-auto-continue] retry config form unavailable:', error)
      }
      return retryForm
    }

    // Two-phase registration: `inject` waits for the Plugins page to declare the
    // slot. That page keys it by the bundle's package name and renders the occupant on
    // the bundle's own page, so the Settings nav stays untouched. The component is
    // chosen here, once, because a subscription hook may not appear or vanish between
    // renders.
    ctx.slots.inject('plugins.bundle.config', () => {
      const form = resolveRetryForm()
      return ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_KEY,
        locale: namespace,
        inject: () => form === undefined
          ? { t }
          : { t, hooks: { retryForm: form.store }, ...form.actions },
      }, form === undefined ? AutoContinueCard : AutoContinueCardWithConfig)
    })
  } catch (error) {
    console.error('[dsh-auto-continue] client card failed to load (host half unaffected):', error)
  }
}

module.exports = { name, inject, apply, __test: { zh, en, ROOT_CLASS, STATUS_PATH, ENTRY_ID, BUNDLE_KEY } }
