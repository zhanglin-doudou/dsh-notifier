/**
 * Unit tests for the pieces that decide *what* to play and *how* to launch a
 * player, with no Cordis composition and no speaker.
 *
 * Run with `node --test tests/`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyTurnEnd, isSubagentSession } from '../src/classify.js'
import {
  clampVolume, DEFAULT_TONE, EVENTS, MAX_VOLUME, MIN_VOLUME, TONE_IDS, TONES, toneIdOf, toneOf,
} from '../src/tones.js'
import { playerCommand, soundPath } from '../src/player.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// ── turn classification ──────────────────────────────────────────────────────

test('a completed turn is the only "complete" outcome', () => {
  assert.deepEqual(classifyTurnEnd({ kind: 'completed' }), { kind: 'complete', reason: 'completed' })
})

test('every non-completing reason is reported as interrupted', () => {
  const cases = [
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'user'],
    [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'disposed'],
    [{ kind: 'aborted', reason: { kind: 'parent' } }, 'parent'],
    [{ kind: 'max-tokens' }, undefined],
    [{ kind: 'blocked' }, undefined],
    [{ kind: 'interrupted' }, undefined],
  ]
  for (const [reason, detail] of cases) {
    const outcome = classifyTurnEnd(reason)
    assert.equal(outcome.kind, 'interrupted', `reason ${reason.kind} must sound the interrupted tone`)
    assert.equal(outcome.reason, reason.kind)
    assert.equal(outcome.detail, detail)
  }
})

test('an error carries its code and message', () => {
  const outcome = classifyTurnEnd({ kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } })
  assert.equal(outcome.kind, 'interrupted')
  assert.equal(outcome.detail, 'UNKNOWN')
  assert.equal(outcome.message, 'boom')
})

test('a fork boundary stays silent', () => {
  assert.equal(classifyTurnEnd({ kind: 'forked' }), undefined)
})

test('an unrecognized plugin-extended reason still rings', () => {
  const outcome = classifyTurnEnd({ kind: 'quota-exhausted' })
  assert.equal(outcome.kind, 'interrupted')
  assert.equal(outcome.reason, 'quota-exhausted')
})

test('a missing or malformed reason stays silent', () => {
  assert.equal(classifyTurnEnd(undefined), undefined)
  assert.equal(classifyTurnEnd({}), undefined)
  assert.equal(classifyTurnEnd({ kind: 42 }), undefined)
})

// ── subagent filtering ───────────────────────────────────────────────────────

test('delegated children are recognized by origin or depth', () => {
  assert.equal(isSubagentSession({ origin: 'subagent' }), true)
  assert.equal(isSubagentSession({ delegationDepth: 1 }), true)
  assert.equal(isSubagentSession({ delegationDepth: 2 }), true)
})

test('a top-level session rings', () => {
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession({ delegationDepth: 0 }), false)
  assert.equal(isSubagentSession(undefined), false)
})

// ── the tone catalogue ───────────────────────────────────────────────────────

test('every tone id is unique and resolvable', () => {
  assert.equal(new Set(TONE_IDS).size, TONE_IDS.length)
  for (const id of TONE_IDS) assert.equal(toneOf(id)?.id, id)
})

test('every bundled WAV exists and is a real RIFF/WAVE file', () => {
  for (const tone of TONES) {
    const bytes = readFileSync(soundPath(tone.file))
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', `${tone.file} is not RIFF`)
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE', `${tone.file} is not WAVE`)
    // 16-bit mono PCM as the generator writes it.
    assert.equal(bytes.readUInt16LE(20), 1)
    assert.equal(bytes.readUInt16LE(22), 1)
    assert.equal(bytes.readUInt16LE(34), 16)
    assert.ok(bytes.length > 44, `${tone.file} has no samples`)
  }
})

test('the three events default to three different tones', () => {
  const ids = EVENTS.map((event) => DEFAULT_TONE[event])
  assert.equal(new Set(ids).size, 3, 'the three events must sound different by default')
  for (const id of ids) assert.ok(TONE_IDS.includes(id), `${id} is not in the catalogue`)
})

test('unknown tone ids are rejected, not guessed', () => {
  assert.equal(toneIdOf('nope'), undefined)
  assert.equal(toneIdOf(undefined), undefined)
  assert.equal(toneIdOf(''), undefined)
  assert.equal(toneIdOf(7), undefined)
  assert.equal(toneIdOf(TONE_IDS[0]), TONE_IDS[0])
})

test('volume is clamped into the accepted range', () => {
  assert.equal(clampVolume(0.5), 0.5)
  assert.equal(clampVolume(0), MIN_VOLUME)
  assert.equal(clampVolume(-3), MIN_VOLUME)
  assert.equal(clampVolume(9), MAX_VOLUME)
  assert.equal(clampVolume(Number.NaN, 0.42), 0.42)
  assert.equal(clampVolume('loud'), 0.6)
})

// ── player launch ────────────────────────────────────────────────────────────

test('macOS launches afplay with a volume flag and the file', () => {
  const command = playerCommand('/tmp/a.wav', 0.6, { platform: 'darwin', has: () => true })
  assert.deepEqual(command, { command: 'afplay', args: ['-v', '0.6', '/tmp/a.wav'] })
})

test('macOS without afplay stays silent instead of failing', () => {
  assert.equal(playerCommand('/tmp/a.wav', 0.6, { platform: 'darwin', has: () => false }), undefined)
})

test('Linux falls through the player list in order', () => {
  const all = playerCommand('/tmp/a.wav', 0.5, { platform: 'linux', has: () => true })
  assert.equal(all.command, 'paplay')
  const alsa = playerCommand('/tmp/a.wav', 0.5, { platform: 'linux', has: (c) => c === 'aplay' })
  assert.equal(alsa.command, 'aplay')
  const none = playerCommand('/tmp/a.wav', 0.5, { platform: 'linux', has: () => false })
  assert.equal(none, undefined)
})

test('Windows plays the WAV through SoundPlayer', () => {
  const command = playerCommand("C:\\a b\\o'ne.wav", 0.7, { platform: 'win32', has: () => true })
  assert.equal(command.command, 'powershell')
  assert.ok(command.args.includes('-NoProfile'))
  const script = command.args.at(-1)
  assert.ok(script.includes('SoundPlayer'))
  // A single quote in the path must be doubled, not left to break the literal.
  assert.ok(script.includes("o''ne.wav"))
})

test('the preview route serves the shipped catalogue from disk', () => {
  // Guards the manifest `files` list: a tone that ships without its asset would
  // break Preview in an installed copy.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(manifest.files.includes('assets'), 'assets must ship')
  for (const tone of TONES) {
    assert.ok(soundPath(tone.file).startsWith(join(ROOT, 'assets', 'sounds')))
  }
})
