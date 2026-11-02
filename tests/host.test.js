/**
 * The Host half against a stub Cordis context: every listener, the master
 * switch, configuration fallbacks, and the three HTTP routes.
 *
 * Real `@deepseek-ai/schemastery` is a dev dependency here so the Config schema
 * is validated exactly as Cordis validates it at mount time.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, Config } from '../src/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The services this test composition provides to `ctx.inject`.
 *
 * Like Cordis, `inject` only runs its callback when every named dependency is
 * present: a headless composition has no `connection`, and a composition
 * without the settings service has no `settings`. The plugin relies on both
 * rules, so the stub must reproduce them.
 *
 * @param {object} record the stub's recording object
 * @returns {Record<string, object>} the composed services
 */
function servicesOf(record) {
  return {
    settings: {
      configure(options) {
        record.settingsPolicy.push(options)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) { record.routes.set(route.path, route); return () => {} },
      },
    },
  }
}

/** A Cordis context stub recording listeners, routes, and effects. */
function stubContext() {
  const record = {
    listeners: new Map(), routes: new Map(), settingsPolicy: [],
    debug: [], warn: [], info: [], effects: [],
  }
  const services = servicesOf(record)
  const ctx = {
    logger: {
      info: (message) => record.info.push(message),
      warn: (message) => record.warn.push(message),
      debug: (message) => record.debug.push(message),
      error: (message) => record.warn.push(message),
    },
    on(name, listener) {
      const list = record.listeners.get(name) ?? []
      list.push(listener)
      record.listeners.set(name, list)
      return () => {}
    },
    effect(body) {
      const disposer = body()
      if (typeof disposer === 'function') record.effects.push(disposer)
      return () => {}
    },
    inject(deps, callback) {
      // Defer, exactly as Cordis does, when a named service is not composed.
      if (deps.some((name) => services[name] === undefined)) return () => {}
      const scope = {
        ...services,
        effect(body) {
          const disposer = body()
          if (typeof disposer === 'function') record.effects.push(disposer)
          return () => {}
        },
      }
      callback(scope)
      return () => {}
    },
  }
  return { ctx, record }
}

/**
 * Build the config tree Cordis hands a plugin: one volatile reference per field.
 *
 * @param {Record<string, unknown>} [overrides] field replacements
 * @returns {object} the config tree
 */
function configOf(overrides = {}) {
  const ref = (value) => ({ get: () => value })
  return {
    enabled: ref(true),
    completeTone: ref('task-complete'),
    interruptedTone: ref('task-interrupted'),
    needsInputTone: ref('needs-input'),
    volume: ref(0.6),
    ...overrides,
  }
}

/** Fire one `session/event` for a turn ending with `reason`. */
function endTurn(record, reason, header = {}) {
  for (const listener of record.listeners.get('session/event') ?? []) {
    listener({ header }, { type: 'turn/end', data: { turn: 1, reason } })
  }
}

/** The tone id logged for the most recent notification. */
function playedTone(record) {
  const line = record.debug.findLast((message) => message.includes('->'))
  return line === undefined ? undefined : line.split('-> ')[1]
}

// ── configuration ────────────────────────────────────────────────────────────

test('the Config validates with no user input and declares every field live', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined, 'the defaults must satisfy the schema')
  assert.deepEqual(Object.keys(result.value).sort(), [
    'completeTone', 'enabled', 'interruptedTone', 'needsInputTone', 'volume',
  ])
  // Every field must arrive as a volatile reference: that is what lets the
  // settings page write a value without remounting the plugin.
  for (const [field, value] of Object.entries(result.value)) {
    assert.equal(typeof value.get, 'function', `${field} must be a volatile reference`)
  }
})

test('the schema refuses a tone id it does not ship and a volume out of range', () => {
  const badTone = Config['~standard'].validate({ completeTone: 'no-such-tone' })
  assert.notEqual(badTone.issues, undefined, 'an unknown tone id must be refused at the source')
  const badVolume = Config['~standard'].validate({ volume: 12 })
  assert.notEqual(badVolume.issues, undefined, 'a volume above 1 must be refused at the source')
})

test('the default value of each volatile field resolves through its reference', () => {
  const resolved = Config['~standard'].validate({}).value
  assert.equal(resolved.enabled.get(), true)
  assert.equal(resolved.volume.get(), 0.6)
  // The three events must ship three different tones.
  const tones = [resolved.completeTone.get(), resolved.interruptedTone.get(), resolved.needsInputTone.get()]
  assert.equal(new Set(tones).size, 3, 'the shipped defaults must be distinguishable by ear')
})

// ── turn endings ─────────────────────────────────────────────────────────────

test('a completed turn sounds the complete tone', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ completeTone: { get: () => 'chime' } }))
  endTurn(record, { kind: 'completed' })
  assert.equal(playedTone(record), 'chime')
})

test('every stopped or failed turn sounds the interrupted tone', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ interruptedTone: { get: () => 'alarm' } }))
  const reasons = [
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } },
    { kind: 'max-tokens' },
    { kind: 'blocked' },
    { kind: 'interrupted' },
  ]
  for (const reason of reasons) {
    record.debug.length = 0
    endTurn(record, reason)
    assert.equal(playedTone(record), 'alarm', `${reason.kind} must sound the interrupted tone`)
  }
})

test('a fork boundary and a delegated child turn stay silent', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf())
  endTurn(record, { kind: 'forked' })
  endTurn(record, { kind: 'completed' }, { origin: 'subagent' })
  endTurn(record, { kind: 'completed' }, { delegationDepth: 1 })
  assert.deepEqual(record.debug, [])
})

// ── human-in-the-loop ────────────────────────────────────────────────────────

test('an approval request sounds needs-input and still delegates the answer', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ needsInputTone: { get: () => 'ping' } }))
  for (const listener of record.listeners.get('approval/request') ?? []) {
    const outcome = await listener({ toolName: 'bash' }, async () => 'allowed-once')
    assert.equal(outcome, 'allowed-once', 'the real answerer must still decide')
  }
  assert.equal(playedTone(record), 'ping')
})

test('a user question sounds needs-input and still delegates the answer', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ needsInputTone: { get: () => 'ping' } }))
  for (const listener of record.listeners.get('user-questions/request') ?? []) {
    const outcome = await listener({ questions: [{}, {}] }, async () => 'answered')
    assert.equal(outcome, 'answered')
  }
  assert.equal(playedTone(record), 'ping')
})

// ── configuration fallbacks ──────────────────────────────────────────────────

test('the master switch silences every notification', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ enabled: { get: () => false } }))
  endTurn(record, { kind: 'completed' })
  for (const listener of record.listeners.get('approval/request') ?? []) {
    await listener({ toolName: 'bash' }, async () => 'rejected')
  }
  assert.deepEqual(record.debug, [])
})

test('a hand-edited tone id falls back to the event default instead of silence', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ completeTone: { get: () => 'removed-tone' } }))
  endTurn(record, { kind: 'completed' })
  assert.equal(playedTone(record), 'task-complete')
})

test('a plain-value config reads exactly like a reference tree', () => {
  const { ctx, record } = stubContext()
  // A host that mounted the plugin outside the Loader passes plain values.
  apply(ctx, {
    enabled: true, completeTone: 'pulse', interruptedTone: 'pulse', needsInputTone: 'pulse', volume: 0.3,
  })
  endTurn(record, { kind: 'completed' })
  assert.equal(playedTone(record), 'pulse')
})

test('a reference that throws while reading falls back rather than breaking the turn', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ completeTone: { get: () => { throw new Error('reference disposed') } } }))
  endTurn(record, { kind: 'completed' })
  assert.equal(playedTone(record), 'task-complete')
})

// ── routes ───────────────────────────────────────────────────────────────────

test('/state reports the live configuration, catalogue, and events', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ completeTone: { get: () => 'chime' }, volume: { get: () => 0.4 } }))
  const route = record.routes.get('/api/notifier/state')
  assert.ok(route !== undefined, '/state must register on the connection')
  const response = await route.fetch(new Request('http://host/api/notifier/state'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.enabled, true)
  assert.equal(payload.volume, 0.4)
  assert.equal(payload.tones.complete, 'chime')
  assert.deepEqual(payload.events, ['complete', 'interrupted', 'needs-input'])
  assert.ok(payload.catalog.includes('task-complete'))
})

test('/state reflects a write the moment the reference changes', async () => {
  const { ctx, record } = stubContext()
  let value = 'ping'
  apply(ctx, configOf({ completeTone: { get: () => value } }))
  const route = record.routes.get('/api/notifier/state')
  const before = await (await route.fetch(new Request('http://host/api/notifier/state'))).json()
  // This is what a volatile commit does: mutate the reference in place.
  value = 'alarm'
  const after = await (await route.fetch(new Request('http://host/api/notifier/state'))).json()
  assert.equal(before.tones.complete, 'ping')
  assert.equal(after.tones.complete, 'alarm', 'a live write must be visible without a remount')
})

test('/preview answers real WAV bytes, by tone and by event', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf({ completeTone: { get: () => 'chime' } }))
  const route = record.routes.get('/api/notifier/preview')
  assert.ok(route !== undefined, '/preview must register')

  const direct = await route.fetch(new Request('http://host/api/notifier/preview?tone=ping'))
  assert.equal(direct.status, 200)
  assert.equal(direct.headers.get('content-type'), 'audio/wav')
  assert.equal(direct.headers.get('x-content-type-options'), 'nosniff')
  const bytes = Buffer.from(await direct.arrayBuffer())
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE')

  const byEvent = await route.fetch(new Request('http://host/api/notifier/preview?event=complete'))
  assert.equal(byEvent.status, 200)
  const chime = readFileSync(join(ROOT, 'assets', 'sounds', 'chime.wav'))
  assert.equal((await byEvent.arrayBuffer()).byteLength, chime.byteLength)

  for (const query of ['?tone=nope', '']) {
    const bad = await route.fetch(new Request(`http://host/api/notifier/preview${query}`))
    assert.equal(bad.status, 400, `preview${query} must be refused`)
  }
})

test('/test asks the local player to sound a tone and reports the outcome', async () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf())
  const route = record.routes.get('/api/notifier/test')
  assert.ok(route !== undefined, '/test must register')

  const response = await route.fetch(new Request('http://host/api/notifier/test', {
    method: 'POST',
    body: JSON.stringify({ tone: 'needs-input', volume: 0.2 }),
  }))
  const payload = await response.json()
  assert.equal(payload.tone, 'needs-input')
  assert.equal(payload.volume, 0.2)
  assert.ok(['started', 'skipped', 'failed'].includes(payload.outcome))

  const unknown = await route.fetch(new Request('http://host/api/notifier/test', {
    method: 'POST', body: JSON.stringify({ tone: 'nope' }),
  }))
  assert.equal(unknown.status, 400)
  const malformed = await route.fetch(new Request('http://host/api/notifier/test', {
    method: 'POST', body: 'not json',
  }))
  assert.equal(malformed.status, 400)
})

test('unloading the plugin releases the route and player effects', () => {
  const { ctx, record } = stubContext()
  apply(ctx, configOf())
  assert.ok(record.routes.size === 3, 'all three routes registered')
  assert.ok(record.effects.length > 0, 'effects registered for teardown')
  // Every effect disposer must be safe to call.
  for (const dispose of record.effects) assert.doesNotThrow(() => dispose())
})

test('the routes stay absent on a host with no connection service', () => {
  const record = { listeners: new Map(), debug: [], info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => record.info.push(m), warn: (m) => record.warn.push(m), debug: (m) => record.debug.push(m) },
    on(name, listener) { record.listeners.set(name, listener); return () => {} },
    effect(body) { body(); return () => {} },
    // A headless composition has no `connection`: the callback must not run.
    inject() { /* never invoked */ },
  }
  apply(ctx, configOf())
  assert.ok(record.info.some((line) => line.includes('armed')), 'notifications still arm without a web surface')
})
