/**
 * The browser half, exercised through the real ModuleLoader protocol.
 *
 * The bundle must stay honest about three things a hand-written client plugin
 * gets wrong easily: it may only `require` platform modules, its `dsh.client`
 * declaration must match what it registers, and every locale dictionary must
 * translate every key. The page is also rendered through React's real renderer
 * so a Rules-of-Hooks mistake fails here rather than in the shell.
 *
 * React is resolved from the repository this test runs in; when it is absent
 * (a bare checkout with no `node_modules`) the render checks are skipped and the
 * structural checks still run.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(ROOT, 'lib', 'client.js')
const requireFromRoot = createRequire(join(ROOT, 'package.json'))

/** A DOM good enough for the stylesheet effect and base-URI resolution. */
function stubDocument(lang = 'en') {
  /** Nodes appended to `head`, in order. */
  const installed = []
  return {
    installed,
    head: { appendChild: (node) => { installed.push(node) } },
    baseURI: 'http://127.0.0.1:3000/',
    documentElement: { lang },
    createElement: () => {
      const node = {
        attrs: {}, textContent: '',
        setAttribute(key, value) { this.attrs[key] = value },
        remove() {
          const index = installed.indexOf(node)
          if (index !== -1) installed.splice(index, 1)
        },
      }
      return node
    },
  }
}

/**
 * Load the bundle through `__ModuleLoader__` and materialize its factory.
 *
 * @param {object} [options] loader options
 * @param {object} [options.document] stub document
 * @param {Record<string, unknown>} [options.modules] module table the factory may require
 * @returns {{ entry: object, exports: object, requested: string[], document: object }}
 */
function loadBundle(options = {}) {
  const document = options.document ?? stubDocument()
  let entry
  const sandbox = {
    window: { __ModuleLoader__: { load: (registered) => { entry = registered } } },
    document,
    console,
    fetch: (...args) => globalThis.fetch(...args),
    AbortController,
    Response,
    URL,
    JSON,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(readFileSync(BUNDLE, 'utf8'), sandbox)
  assert.ok(entry !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  const requested = []
  // React is optional here: the structural checks must run in a bare checkout,
  // where the shell's shared modules are not installed.
  const table = options.modules ?? { react: optionalReact() }
  const exports = entry.factory((specifier) => {
    requested.push(specifier)
    if (specifier in table) return table[specifier]
    throw new Error(`undeclared module request: ${specifier}`)
  })
  return { entry, exports, requested, document }
}

/**
 * Resolve the shell's shared `react`, or a placeholder when it is not installed.
 *
 * The bundle only *calls* `require('react')`; a structural test needs the module
 * table entry to exist, not to behave.
 *
 * @returns {unknown} the real React module, or a callable stub
 */
function optionalReact() {
  try {
    return requireFromRoot('react')
  } catch {
    return { createElement: () => null, useSyncExternalStore: () => undefined }
  }
}

/** A Cordis context stub recording the registrations the plugin makes. */
function stubContext(lang = 'en') {
  const record = { sections: [], dictionaries: {}, styles: [] }
  const ctx = {
    effect(fn) { const disposer = fn(); record.effects ??= []; record.effects.push(disposer); return () => {} },
    locale: {
      register(ns, all) { record.dictionaries[ns] = all; return () => {} },
      // Faithful to the real service: `bind` resolves the active locale per call.
      bind(ns) {
        const active = lang.startsWith('zh') ? 'zh' : 'en'
        return (key) => record.dictionaries[ns]?.[active]?.[key]
          ?? record.dictionaries[ns]?.en?.[key] ?? key
      },
    },
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(options, component) { record.sections.push({ options, component }); return () => {} },
    },
    configForms: { get: () => undefined },
  }
  return { ctx, record }
}

test('the bundle registers under its package name and declares no extra modules', () => {
  const { entry, exports, requested } = loadBundle()
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(entry.id, manifest.name, 'the bundle id must be the package name the host pairs with the row')
  assert.equal(exports.name, manifest.name)
  assert.equal(typeof exports.apply, 'function')
  // Only platform-seeded modules may be required; anything else needs a
  // `dsh.client.external` declaration.
  assert.deepEqual(requested, ['react'])
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('the client half ships the built bundle it declares', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.ok(manifest.files.includes('lib'), 'the built bundle must be published')
  // A missing artifact fails the host's client-module scan loudly at boot.
  assert.doesNotThrow(() => readFileSync(BUNDLE))
})

test('it registers one settings section with a localized navigation label', () => {
  const { exports } = loadBundle()
  const { ctx, record } = stubContext('en')
  exports.apply(ctx)
  assert.equal(record.sections.length, 1)
  const [section] = record.sections
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.id, 'notifier')
  assert.equal(section.options.locale, 'settings.notifier')
  assert.equal(section.options.label(), 'Notification sounds')
  assert.equal(typeof section.options.inject, 'function')
  assert.ok(section.options.inject().store !== undefined, 'the page receives its store through the inject face')
})

test('the navigation label follows the active language', () => {
  const { exports } = loadBundle()
  const { ctx, record } = stubContext('zh-CN')
  exports.apply(ctx)
  assert.equal(record.sections[0].options.label(), '提示音')
})

test('it installs its stylesheet under a plugin-scoped attribute', () => {
  const { exports, document } = loadBundle()
  const { ctx } = stubContext()
  exports.apply(ctx)
  const style = document.installed.find((node) => node.attrs['data-plugin'] === 'dsh-notifier')
  assert.ok(style !== undefined, 'stylesheet must be installed')
  assert.ok(style.textContent.includes('dsn_page'), 'stylesheet carries the page rules')
  // Class names are namespaced so nothing can collide with shell styles.
  for (const match of style.textContent.matchAll(/\.([a-z][\w-]*)/gu)) {
    assert.ok(match[1].startsWith('dsn_'), `class ${match[1]} must carry the dsn_ prefix`)
  }
})

test('every locale dictionary translates every key', () => {
  const { exports } = loadBundle()
  const { ctx, record } = stubContext()
  exports.apply(ctx)
  const dicts = record.dictionaries['settings.notifier']
  assert.ok(dicts.en !== undefined && dicts.zh !== undefined, 'English and Chinese dictionaries register together')
  const en = Object.keys(dicts.en).sort()
  for (const [locale, dict] of Object.entries(dicts)) {
    assert.deepEqual(Object.keys(dict).sort(), en, `${locale} must cover every key`)
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
      assert.notEqual(value.trim(), '', `${locale}.${key} must not be empty`)
    }
  }
  // Every catalogued tone needs a label a picker can show.
  for (const id of exports.__test.FALLBACK_CATALOG) {
    assert.ok(dicts.en[`tone.${id}`] !== undefined, `missing English label for tone ${id}`)
    assert.ok(dicts.zh[`tone.${id}`] !== undefined, `missing Chinese label for tone ${id}`)
  }
})

test('the fallback catalogue matches the Host tone catalogue', async () => {
  // The picker shows this list before the Host answers, so it must not drift.
  const { exports } = loadBundle()
  const { TONE_IDS } = await import('../src/tones.js')
  assert.deepEqual([...exports.__test.FALLBACK_CATALOG].sort(), [...TONE_IDS].sort())
})

/** Render the page when React is available; skip otherwise. */
async function withReact(run) {
  let React
  try {
    React = requireFromRoot('react')
    requireFromRoot('react-dom/server')
  } catch {
    return false
  }
  await run(React)
  return true
}

test('the page renders its controls through real React hooks', async (t) => {
  const { exports } = loadBundle()
  const { ctx, record } = stubContext()
  exports.apply(ctx)
  const Page = record.sections[0].component
  const en = record.dictionaries['settings.notifier'].en
  const translate = (key) => en[key] ?? key
  const settings = {
    enabled: true,
    volume: 0.6,
    catalog: [...exports.__test.FALLBACK_CATALOG],
    completeTone: 'task-complete',
    interruptedTone: 'pulse',
    needsInputTone: 'needs-input',
  }
  const store = {
    available: true, snapshot: () => settings, subscribe: () => () => {}, set: async () => true,
  }

  const rendered = await withReact(async (React) => {
    const { renderToStaticMarkup } = requireFromRoot('react-dom/server')
    const html = renderToStaticMarkup(React.createElement(Page, { store, t: translate, close: () => {} }))
    assert.ok(html.includes('role="switch"'), 'master switch renders')
    assert.ok(html.includes('aria-checked="true"'), 'switch reflects the enabled state')
    assert.equal((html.match(/<select/gu) ?? []).length, 3, 'one picker per event')
    assert.ok(html.includes('Task finished') && html.includes('Task stopped') && html.includes('Needs your input'))
    assert.ok(html.includes('Rising arpeggio'), 'tone labels are localized')
    assert.ok(html.includes('60%'), 'volume percentage renders')

    const off = renderToStaticMarkup(React.createElement(Page, {
      store: { ...store, snapshot: () => ({ ...settings, enabled: false }) }, t: translate, close: () => {},
    }))
    assert.equal((off.match(/disabled=""/gu) ?? []).length >= 4, true, 'the switch disables its controls')

    const zhHtml = renderToStaticMarkup(React.createElement(Page, {
      store, t: (key) => record.dictionaries['settings.notifier'].zh[key] ?? key, close: () => {},
    }))
    assert.ok(zhHtml.includes('任务完成') && zhHtml.includes('需要你介入'))

    const missing = renderToStaticMarkup(React.createElement(Page, {
      store: { ...store, available: false }, t: translate, close: () => {},
    }))
    assert.ok(missing.includes(en.unavailable), 'says so when the Host half is absent')
  })
  if (!rendered) t.diagnostic('React is not installed here; skipped the render checks')
})

test('a picker writes its own Config field and preview reaches the Host', async (t) => {
  const { exports } = loadBundle()
  const { ctx, record } = stubContext()
  exports.apply(ctx)
  const Page = record.sections[0].component
  const en = record.dictionaries['settings.notifier'].en
  const translate = (key) => en[key] ?? key
  const settings = {
    enabled: true,
    volume: 0.6,
    catalog: [...exports.__test.FALLBACK_CATALOG],
    completeTone: 'task-complete',
    interruptedTone: 'pulse',
    needsInputTone: 'needs-input',
  }
  const writes = []
  const store = {
    available: true,
    snapshot: () => settings,
    subscribe: () => () => {},
    set: async (field, value) => { writes.push([field, value]); return true },
  }

  const ran = await withReact(async (React) => {
    // Calling the page inside a component body gives its hooks this render's
    // dispatcher, so the captured tree is exactly what the page returned.
    let captured
    function Wrapper() {
      captured = Page({ store, t: translate, close: () => {} })
      return null
    }
    requireFromRoot('react-dom/server').renderToStaticMarkup(React.createElement(Wrapper))

    const selects = []
    const buttons = []
    let toggle
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      const props = node.props ?? {}
      if (node.type === 'select') selects.push(props)
      if (node.type === 'button' && props.role === 'switch') toggle = props.onClick
      else if (node.type === 'button' && typeof props.onClick === 'function') buttons.push(props)
      walk(props.children)
    }
    walk(captured)
    assert.equal(selects.length, 3)
    assert.equal(buttons.length, 3)

    selects[0].onChange({ target: { value: 'chime' } })
    selects[1].onChange({ target: { value: 'alarm' } })
    selects[2].onChange({ target: { value: 'ping' } })
    assert.deepEqual(writes.slice(0, 3), [
      ['completeTone', 'chime'],
      ['interruptedTone', 'alarm'],
      ['needsInputTone', 'ping'],
    ])
    toggle()
    assert.deepEqual(writes.at(-1), ['enabled', false])

    // Preview must ask the Host: the local speaker is not the browser's.
    const fetched = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      fetched.push({ url: String(url), init })
      return new Response(JSON.stringify({ outcome: 'started' }), { status: 200 })
    }
    try {
      await buttons[0].onClick()
      assert.equal(fetched.length, 1)
      assert.equal(fetched[0].url, '/api/notifier/test')
      assert.equal(fetched[0].init.method, 'POST')
      assert.deepEqual(JSON.parse(fetched[0].init.body), { tone: 'task-complete' })

      // A refused preview is reported in the page rather than thrown.
      globalThis.fetch = async () => new Response('bad', { status: 400 })
      await buttons[1].onClick()
      globalThis.fetch = async () => { throw new Error('offline') }
      await buttons[2].onClick()
    } finally {
      globalThis.fetch = realFetch
    }
  })
  if (!ran) t.diagnostic('React is not installed here; skipped the interaction checks')
})
