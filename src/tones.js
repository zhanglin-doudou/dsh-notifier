/**
 * The built-in tone catalogue shared by the Host half, the browser half, and
 * the settings page.
 *
 * This module is dependency-free on purpose: the Host imports it to resolve a
 * configured tone id and to serve preview bytes, and the browser half inlines
 * the same table so a picker can list tones before any round trip. A tone id is
 * stable user data (it is persisted in the profile patch), so ids must never be
 * renamed — add a new id and keep the old one.
 *
 * @module dsh-notifier/src/tones
 */

/**
 * One selectable notification tone.
 *
 * @typedef {object} Tone
 * @property {string} id stable id persisted in the profile patch
 * @property {string} file WAV file name inside `assets/sounds`
 * @property {string} durationMs nominal length, used to bound preview playback
 */

/** @type {readonly Tone[]} */
export const TONES = Object.freeze([
  Object.freeze({ id: 'task-complete', file: 'task-complete.wav', durationMs: 1500 }),
  Object.freeze({ id: 'chime', file: 'chime.wav', durationMs: 1800 }),
  Object.freeze({ id: 'ping', file: 'ping.wav', durationMs: 550 }),
  Object.freeze({ id: 'soft-tick', file: 'soft-tick.wav', durationMs: 400 }),
  Object.freeze({ id: 'task-interrupted', file: 'task-interrupted.wav', durationMs: 1200 }),
  Object.freeze({ id: 'pulse', file: 'pulse.wav', durationMs: 700 }),
  Object.freeze({ id: 'alarm', file: 'alarm.wav', durationMs: 1300 }),
  Object.freeze({ id: 'needs-input', file: 'needs-input.wav', durationMs: 1400 }),
])

/** Every valid tone id. */
export const TONE_IDS = Object.freeze(TONES.map((tone) => tone.id))

/**
 * The three notification events this plugin can sound, in menu order.
 *
 * `complete` fires on a finished turn, `interrupted` on a turn that ended
 * without finishing (cancelled, failed, blocked, or truncated), and `needs-input`
 * when the agent is waiting for a human decision.
 */
export const EVENTS = Object.freeze(['complete', 'interrupted', 'needs-input'])

/** Defaults chosen so the three events are distinguishable by pitch contour. */
export const DEFAULT_TONE = Object.freeze({
  complete: 'task-complete',
  interrupted: 'task-interrupted',
  'needs-input': 'needs-input',
})

/** Every bundled tone is quieter than this ceiling in dB; clips are normalized at build time. */
export const MAX_VOLUME = 1

/** Lowest volume that still makes an audible sound. */
export const MIN_VOLUME = 0.05

/**
 * Narrow an arbitrary value to a known tone id.
 *
 * @param {unknown} value candidate from configuration or a request
 * @returns {string | undefined} the tone id, or undefined when unknown
 */
export function toneIdOf(value) {
  return typeof value === 'string' && TONE_IDS.includes(value) ? value : undefined
}

/**
 * Look one tone up by id.
 *
 * @param {unknown} id candidate tone id
 * @returns {Tone | undefined} the catalogue entry
 */
export function toneOf(id) {
  return TONES.find((tone) => tone.id === id)
}

/**
 * Clamp a configured volume into the accepted range.
 *
 * `afplay` accepts 0–4; this plugin keeps the ceiling at {@link MAX_VOLUME} so a
 * misconfigured value cannot blast a speaker, and treats a non-number as the
 * neutral default.
 *
 * @param {unknown} value candidate volume
 * @param {number} [fallback] value used when the candidate is not a finite number
 * @returns {number} a volume in `[MIN_VOLUME, MAX_VOLUME]`
 */
export function clampVolume(value, fallback = 0.6) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, number))
}
