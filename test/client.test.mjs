/**
 * Browser-half self-check: loads `lib/client.js` exactly the way the host does — a
 * classic script that registers a CommonJS factory — and drives the factory against
 * stubbed React and client-UI primitives.
 *
 * What this pins down (each one has a way of failing silently in production):
 *   · the bundle is a classic script with the right factory id, not an ESM module;
 *   · the browser half requires nothing but platform-seeded packages;
 *   · the card registers into the Plugins page's `plugins.bundle.config` slot under
 *     this package's name, and the one-liner it offers for `view: 'summary'` goes
 *     through the locale;
 *   · the config form is built for the entry with the two volatile fields the host
 *     half reads (`maxRetries`, `retryIntervalMs`) and its actions reach the card;
 *   · the card still renders when the host serves no config form;
 *   · every CSS rule is scoped under the card's own root class — the
 *     `data-plugin-css` attribute only dedupes injection, it is no one's ancestor, so
 *     a rule prefixed with it would never apply.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    const message = String(error && error.message ? error.message : error)
    console.log('  FAIL ' + label + '\n' + '       ' + message.split('\n').join('\n' + '       '))
  }
}

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

check('bundle is a classic script, not an ESM module', () => {
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/^\s*export\s/m.test(source), false)
  assert.ok(source.includes('window.__ModuleLoader__.load({'))
})

let handle
const styleSink = []
const fakeWindow = { __ModuleLoader__: { load: entry => { handle = entry } } }
const fakeDocument = {
  getElementById: id => styleSink.find(node => node.id === id) || null,
  createElement: () => ({ id: '', textContent: '', setAttribute(key, value) { this[key] = value }, style: {} }),
  head: { appendChild: node => { styleSink.push(node) } },
}
new Function('window', 'document', 'console', source)(fakeWindow, fakeDocument, console)

check('factory registers under the package name', () => {
  assert.equal(handle.id, 'dsh-auto-continue')
  assert.equal(typeof handle.factory, 'function')
})

// --- React + primitives stubs -----------------------------------------------------
const reactStub = {
  createElement(type, props, ...children) {
    const name = typeof type === 'string' ? type : (type && type.displayName) || (type && type.name) || 'Component'
    return { type, typeName: name, props: props || {}, children }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
}

const formModels = []
let builtFields = null
class SettingsFormModelStub {
  constructor(scope, fields) {
    this.scope = scope
    this.fields = fields
    formModels.push(this)
    builtFields = fields.map(field => field.field)
  }
  shell() { return { writable: true } }
  field(name) { return { name, text: '', invalid: false } }
  bind(projection) { this.projection = projection; return { subscribe: () => () => {}, getSnapshot: () => projection() } }
  actions() { return { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} } }
  dispose() { this.disposed = true }
}
const primitivesStub = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  SettingsFormModel: SettingsFormModelStub,
  settingsNumberField: field => ({ field }),
}

const required = []
const requireStub = id => {
  required.push(id)
  if (id === 'react') return reactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + id)
}
for (const name of required.splice(0)) void name
const client = handle.factory(requireStub)

check('requires only platform-seeded packages', () => {
  assert.deepEqual(required.slice().sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'].sort())
})

check('exports the browser-plugin shape', () => {
  assert.equal(client.name, 'dsh-auto-continue-client')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(typeof client.apply, 'function')
})

check('locale dictionaries cover the same keys', () => {
  const { zh, en } = client.__test
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

// --- a host-like context ----------------------------------------------------------
const makeCtx = (options = {}) => {
  const registrations = []
  const state = { registered: null, slot: null, effects: [] }
  const ctx = {
    locale: {
      register(namespace, dictionaries) { state.registered = { namespace, dictionaries }; return () => {} },
      bind() {
        return key => {
          const dict = state.registered ? state.registered.dictionaries : { zh: {}, en: {} }
          return dict.zh[key] !== undefined && dict.en[key] !== undefined ? 'T:' + key : 'MISSING:' + key
        }
      },
    },
    effect(fn, label) { state.effects.push(label); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get(name) {
      if (name !== 'configForms') return undefined
      if (options.formService === false) return { get: () => undefined }
      return { get: id => (id === 'auto-continue' ? { entry: id } : undefined) }
    },
    slots: {
      inject(slot, callback) { state.slot = slot; callback() },
      register(descriptor, component) { registrations.push({ descriptor, component }); return () => {} },
    },
  }
  return { ctx, registrations, state }
}

const textOf = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  // Render function components (RetryForm, StatusCard) down to their elements.
  const props = node.props || {}
  const out = []
  for (const key of Object.keys(props)) {
    if (key === 'children') continue
    if (typeof props[key] === 'string') out.push(props[key])
  }
  // Render function components (RetryForm, StatusCard, the primitives stubs) down to
  // their elements — but keep the string props of the element itself, which is where
  // the field labels live.
  if (typeof node.type === 'function') out.push(...textOf(node.type(props)))
  if (props.children !== undefined) out.push(...textOf(props.children))
  if (node.children !== undefined) out.push(...textOf(node.children))
  return out
}

const withForm = makeCtx()
check('apply() registers the card without throwing', () => { client.apply(withForm.ctx) })
check("injects into the Plugins page's bundle-config slot", () => assert.equal(withForm.state.slot, 'plugins.bundle.config'))
check('registers exactly one config entry', () => assert.equal(withForm.registrations.length, 1))
check('entry is keyed by the package name the profile installs', () => {
  const { descriptor } = withForm.registrations[0]
  assert.equal(descriptor.name, 'plugins.bundle.config')
  assert.equal(descriptor.key, 'dsh-auto-continue')
  assert.equal(descriptor.id, undefined)
  assert.equal(withForm.state.registered.namespace, 'settings.auto-continue')
})
check('config form built for the entry with both volatile fields', () => {
  assert.deepEqual(builtFields, ['maxRetries', 'retryIntervalMs'])
  assert.equal(formModels.length, 1)
  assert.deepEqual(formModels[0].scope, { entry: 'auto-continue' })
})
check('descriptor injects the form hook and the save actions', () => {
  const props = withForm.registrations[0].descriptor.inject()
  assert.equal(props.useRetryForm, undefined)
  assert.equal(typeof props.hooks.retryForm, 'object')
  for (const key of ['save', 'discard', 'edit', 'resetField']) assert.equal(typeof props[key], 'function', 'missing action ' + key)
})

const snapshot = { writable: true, maxRetries: { name: 'maxRetries', text: '3' }, retryIntervalMs: { name: 'retryIntervalMs', text: '2000' } }
const render = (registration, useRetryForm, view = 'page') => {
  const props = { ...registration.descriptor.inject(), t: key => 'T:' + key, locale: 'zh', useRetryForm, view }
  // The descriptor may hand back a wrapper component (the one that subscribes to the
  // form); call through function components until the tree is real elements.
  let node = registration.component(props)
  while (node !== null && node !== undefined && typeof node.type === 'function') node = node.type(node.props)
  return node
}

check('with a form: the card renders the retry fields and the live status', () => {
  const tree = render(withForm.registrations[0], selector => selector(snapshot))
  assert.equal(tree.props.className, 'dsm-ac-card')
  const text = textOf(tree)
  for (const key of ['retry.title', 'retry.maxRetries', 'retry.interval', 'status.title']) {
    assert.ok(text.includes('T:' + key), 'missing ' + key)
  }
  assert.equal(text.includes('T:row.summary'), false, 'the one-liner belongs to the summary view only')
})

check('the summary view is one locale-driven line, not the card', () => {
  const summary = render(withForm.registrations[0], selector => selector(snapshot), 'summary')
  assert.equal(summary, 'T:row.summary')
})

const withoutForm = makeCtx({ formService: false })
check('a host without a config form: no form, still one card', () => {
  client.apply(withoutForm.ctx)
  assert.equal(withoutForm.registrations.length, 1)
  assert.equal(formModels.length, 1)
  const props = withoutForm.registrations[0].descriptor.inject()
  assert.equal(props.hooks, undefined)
  const tree = render(withoutForm.registrations[0], undefined)
  const text = textOf(tree)
  assert.ok(text.includes('T:form.unavailable'))
  assert.equal(text.includes('T:retry.title'), false)
  assert.ok(text.includes('T:status.title'))
})

check('the stylesheet is injected once, and every rule is scoped under the card root class', () => {
  // Two applies ran above; the second must reuse the tag from the first.
  assert.equal(styleSink.length, 1)
  const style = styleSink[0]
  assert.equal(style.id, 'dsh-auto-continue-client-css')
  assert.equal(style['data-plugin-css'], 'dsh-auto-continue-client')
  const rules = style.textContent.split('\n').filter(line => line.trim() !== '')
  assert.ok(rules.length >= 5, 'expected a handful of rules, got ' + rules.length)
  for (const rule of rules) assert.ok(rule.startsWith('.dsm-ac-card'), 'unscoped rule: ' + rule)
})

if (failed > 0) {
  console.log('auto-continue client test: ' + failed + ' assertion(s) failed')
  process.exitCode = 1
} else {
  console.log('auto-continue client test: all assertions passed')
}
