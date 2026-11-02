/**
 * dsh-notifier — Host half.
 *
 * Sounds a different tone when a task finishes, when it stops short, and when
 * the agent needs a human decision, and serves the settings page its data and
 * its preview audio.
 *
 * The three signals come from three independent sources, because the Harness
 * records them independently:
 *
 * - **Turn endings** arrive as durable `session/event` appends. `turn/end` is
 *   the authoritative "this turn is over" record, and its `reason` says whether
 *   the agent finished (`completed`) or stopped for another cause (aborted,
 *   blocked, error, max-tokens, interrupted).
 * - **Approvals** arrive as the `approval/request` waterfall: a tool needs the
 *   user to allow or reject one call.
 * - **Questions** arrive as the `user-questions/request` waterfall: the agent
 *   asked the user something and is waiting.
 *
 * Both waterfalls are transparent observers here — the listener sounds a tone
 * and returns `next()` so the real answerer (the Web UI) still owns the answer.
 *
 * Every knob lives in a `volatile()` Config field, so the settings page writes
 * it into the profile patch and the running plugin picks the value up without a
 * reload.
 *
 * @module dsh-notifier
 */

import { existsSync, readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { clampVolume, DEFAULT_TONE, EVENTS, TONE_IDS, toneOf } from './tones.js'
import { classifyTurnEnd, isSubagentSession } from './classify.js'
import { createPlayer, soundPath } from './player.js'

/** Prefix of the plugin's own same-origin HTTP routes. */
export const ROUTE_PREFIX = '/api/notifier'

/** The settings field holding each event's tone id. */
const TONE_FIELD = Object.freeze({
  complete: 'completeTone',
  interrupted: 'interruptedTone',
  'needs-input': 'needsInputTone',
})

/**
 * Live-editable configuration. Every field is `volatile()`, so a settings write
 * is committed into the running instance's references instead of remounting the
 * plugin (which would drop the live session listeners).
 */
export const Config = z.object({
  /** Master switch for every notification. */
  enabled: z.boolean().default(true).volatile(),
  /** Tone played when a turn ends because the agent finished its work. */
  completeTone: z.union([...TONE_IDS]).default(DEFAULT_TONE.complete).volatile(),
  /** Tone played when a turn ends without finishing: cancelled, failed, blocked, or truncated. */
  interruptedTone: z.union([...TONE_IDS]).default(DEFAULT_TONE.interrupted).volatile(),
  /** Tone played when the agent is waiting for an approval or a question answer. */
  needsInputTone: z.union([...TONE_IDS]).default(DEFAULT_TONE['needs-input']).volatile(),
  /** Playback volume between 0.05 and 1. */
  volume: z.number().min(0.05).max(1).default(0.6).volatile(),
})

/**
 * Read one value from the Config tree.
 *
 * A Cordis plugin receives its Config as a tree of volatile references, but a
 * unit test (or a host that mounted the plugin without the Loader) passes plain
 * values. Both shapes read the same way here.
 *
 * @param {unknown} field volatile reference or plain value
 * @param {unknown} fallback value when the field cannot be read
 * @returns {unknown} the current value
 */
function valueOf(field, fallback) {
  try {
    if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
      const value = field.get()
      return value === undefined ? fallback : value
    }
    return field === undefined ? fallback : field
  } catch {
    return fallback
  }
}

/**
 * Mount the notifier.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {ReturnType<typeof Config.parse>} config live configuration
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? {}
  const player = createPlayer({ logger })

  // This plugin ships its own settings page, so it opts out of the automatic
  // page the settings service would otherwise generate from this Config. The
  // policy belongs to this plugin's fiber, and it registers only while a
  // settings service is composed — a headless run has no forms at all.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  /**
   * Resolve the tone configured for one event.
   *
   * An unknown id (a tone that a future release removed, or a hand-edited patch)
   * falls back to that event's default rather than going silent.
   *
   * @param {'complete' | 'interrupted' | 'needs-input'} event notification category
   * @returns {{ id: string, file: string } | undefined} the catalogue entry
   */
  const toneFor = (event) => toneOf(valueOf(config[TONE_FIELD[event]], DEFAULT_TONE[event]))
    ?? toneOf(DEFAULT_TONE[event])

  /** Whether the master switch is on. */
  const isEnabled = () => valueOf(config.enabled, true) === true

  /** The configured playback volume, clamped into range. */
  const currentVolume = () => clampVolume(valueOf(config.volume, 0.6))

  /**
   * Sound one notification, if the plugin is enabled.
   *
   * @param {'complete' | 'interrupted' | 'needs-input'} event notification category
   * @param {string} [origin] short reason written to the debug log
   * @returns {void}
   */
  const notify = (event, origin) => {
    if (!isEnabled()) return
    const tone = toneFor(event)
    if (tone === undefined) return
    const file = soundPath(tone.file)
    if (!existsSync(file)) {
      logger.warn?.(`dsh-notifier: bundled tone is missing: ${file}`)
      return
    }
    logger.debug?.(`dsh-notifier: ${event} (${origin ?? 'event'}) -> ${tone.id}`)
    void player.play(file, currentVolume())
  }

  // ── turn endings ────────────────────────────────────────────────────────────
  // `session/event` is the post-commit append feed: every durable Session event,
  // including the `turn/end` record that closes a turn with its reason.
  // `ctx.on` owns the listener on this fiber, so unloading removes it.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    // Delegated children run many short turns; only top-level turns ring.
    if (isSubagentSession(session?.header)) return
    const outcome = classifyTurnEnd(event.data?.reason)
    if (outcome === undefined) return
    notify(outcome.kind, outcome.detail === undefined ? outcome.reason : `${outcome.reason}/${outcome.detail}`)
  })

  // ── human-in-the-loop ───────────────────────────────────────────────────────
  // Both are waterfalls whose answer belongs to the Web UI. Observing means
  // sounding a tone and then delegating with `next()`, never answering.
  ctx.on('approval/request', (request, next) => {
    const tool = typeof request?.toolName === 'string' ? request.toolName : 'tool'
    notify('needs-input', `approval:${tool}`)
    return next()
  })

  ctx.on('user-questions/request', (request, next) => {
    const count = Array.isArray(request?.questions) ? request.questions.length : 0
    notify('needs-input', `question:${String(count)}`)
    return next()
  })

  // ── the settings page's own routes ──────────────────────────────────────────
  // Served over the connection's authenticated Fetch channel, which exists in
  // both the Web and desktop compositions. A headless run composes no
  // connection: notifications still work, the page has nothing to read.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => jsonResponse(statePayload()),
    }), 'dsh-notifier: state route')

    scope.effect(() => scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/preview`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => previewResponse(request),
    }), 'dsh-notifier: preview route')

    scope.effect(() => scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/test`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => testResponse(request),
    }), 'dsh-notifier: test route')
  })

  /**
   * The live configuration, as the settings page reads it.
   *
   * The page polls this after each write so it shows what the Host actually
   * committed, not what the page hoped it committed.
   */
  function statePayload() {
    return {
      enabled: isEnabled(),
      volume: currentVolume(),
      tones: {
        complete: toneFor('complete')?.id,
        interrupted: toneFor('interrupted')?.id,
        'needs-input': toneFor('needs-input')?.id,
      },
      catalog: TONE_IDS,
      events: EVENTS,
    }
  }

  /**
   * Answer one preview request with a tone's bytes.
   *
   * `?tone=<id>` names a catalogue entry directly; `?event=<category>` resolves
   * the tone currently configured for that category.
   */
  function previewResponse(request) {
    const url = new URL(request.url)
    const requested = toneOf(url.searchParams.get('tone'))
    const event = url.searchParams.get('event')
    const tone = requested ?? (EVENTS.includes(event) ? toneFor(event) : undefined)
    if (tone === undefined) return textResponse(400, 'unknown tone')
    const file = soundPath(tone.file)
    if (!existsSync(file)) return textResponse(404, 'tone file missing')
    let body
    try {
      body = readFileSync(file)
    } catch {
      return textResponse(500, 'tone file unreadable')
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(body.byteLength),
        // Clips never change once shipped, but they are tiny and a plugin update
        // should not leave a stale tone in the cache.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  /**
   * Sound a tone through the local speaker, for the settings page's Preview and
   * per-event Test buttons.
   *
   * The page cannot play the clip itself: the point of this plugin is the sound
   * coming out of the machine that runs the Harness, and only the Host half can
   * reach that speaker.
   */
  async function testResponse(request) {
    let body
    try {
      const text = await request.text()
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      return textResponse(400, 'invalid JSON body')
    }
    const tone = toneOf(body?.tone)
    if (tone === undefined) return textResponse(400, 'unknown tone')
    const volume = clampVolume(body?.volume, currentVolume())
    const outcome = await player.play(soundPath(tone.file), volume)
    return jsonResponse({ tone: tone.id, volume, outcome })
  }

  ctx.effect(() => () => { player.stop() }, 'dsh-notifier: player lifetime')

  logger.info?.('dsh-notifier: notification tones armed')
}

/** Answer with a JSON body. */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Answer with a plain-text status. */
function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
