/**
 * Regenerate the plugin's built-in notification tones as 16-bit mono WAV.
 *
 * The clips are committed, so this runs only when a tone is added or retuned:
 *
 * ```
 * pnpm run sounds
 * ```
 *
 * Each event gets a distinct pitch contour, because the whole point is telling
 * three outcomes apart without looking at the screen:
 *
 * | tone | contour | used for |
 * |---|---|---|
 * | `task-complete` | rising major arpeggio | a finished turn |
 * | `task-interrupted` | falling minor third | a cancelled or failed turn |
 * | `needs-input` | two rising pings | a pending approval or question |
 *
 * The remaining entries are alternatives a user can assign to any event.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const OUT = fileURLToPath(new URL('../assets/sounds/', import.meta.url))
mkdirSync(OUT, { recursive: true })

/** One partial: frequency, relative amplitude, decay multiplier. */
const partials = spec => spec

function render(seconds, voices) {
  const n = Math.floor(SR * seconds)
  const buf = Float32Array.from({ length: n }, () => 0)
  for (const v of voices) {
    const start = Math.floor((v.start ?? 0) * SR)
    const len = Math.floor((v.dur ?? seconds) * SR)
    for (let i = 0; i < len && start + i < n; i += 1) {
      const t = i / SR
      // Attack avoids a click; decay shapes the tail.
      const attack = Math.min(1, t / (v.attack ?? 0.004))
      const decay = Math.exp(-(v.decay ?? 5) * t)
      let sample = 0
      for (const p of v.partials) {
        sample += Math.sin(2 * Math.PI * p.f * t + (p.phase ?? 0)) * p.a
      }
      buf[start + i] += sample * attack * decay * (v.gain ?? 1)
    }
  }
  // Normalize with headroom, then apply a short fade-out so the file never ends on a click.
  let peak = 0
  for (const s of buf) peak = Math.max(peak, Math.abs(s))
  const norm = peak > 0 ? 0.82 / peak : 1
  const fade = Math.floor(0.012 * SR)
  for (let i = 0; i < n; i += 1) {
    const tail = n - i < fade ? (n - i) / fade : 1
    buf[i] *= norm * tail
  }
  return buf
}

function wav(samples, path) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24)
  h.writeUInt32LE(SR * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

/** Equal-tempered frequency of a MIDI note. */
const note = m => 440 * 2 ** ((m - 69) / 12)

/** Marimba-like voice: a fundamental plus a few inharmonic-integer partials. */
function mallet(f, gain = 1) {
  return partials([
    { f, a: 1 },
    { f: f * 2, a: 0.35 },
    { f: f * 3.01, a: 0.12 },
    { f: f * 4.02, a: 0.05 },
  ])
}

const TONES = [
  // Task completed — a warm, rising major arpeggio that reads as "done, all good".
  ['task-complete', 1.5, [
    { start: 0, dur: 0.9, decay: 4.2, partials: mallet(note(72)), gain: 0.9 },
    { start: 0.1, dur: 0.9, decay: 4.2, partials: mallet(note(76)), gain: 0.8 },
    { start: 0.2, dur: 1.2, decay: 3.4, partials: mallet(note(79)), gain: 0.95 },
    { start: 0.2, dur: 1.2, decay: 3.0, partials: mallet(note(84)), gain: 0.3 },
  ]],
  // Task interrupted — a soft falling minor third: attention, not alarm.
  ['task-interrupted', 1.2, [
    { start: 0, dur: 0.7, decay: 5.5, partials: mallet(note(69)), gain: 0.85 },
    { start: 0.16, dur: 1.0, decay: 4.2, partials: mallet(note(65)), gain: 0.85 },
    { start: 0.16, dur: 1.0, decay: 4.2, partials: mallet(note(60)), gain: 0.35 },
  ]],
  // Needs your input — two bright pings: clearly a question, not an ending.
  ['needs-input', 1.4, [
    { start: 0, dur: 0.35, decay: 9, partials: mallet(note(83)), gain: 0.85 },
    { start: 0.19, dur: 0.35, decay: 9, partials: mallet(note(88)), gain: 0.8 },
    { start: 0.38, dur: 0.9, decay: 6, partials: mallet(note(90)), gain: 0.7 },
  ]],
  // Single reference ping (the "click"/preview tone).
  ['ping', 0.55, [
    { start: 0, dur: 0.5, decay: 12, partials: mallet(note(88)), gain: 0.9 },
    { start: 0, dur: 0.5, decay: 14, partials: mallet(note(95)), gain: 0.25 },
  ]],
  // Chime — bell-like, longer tail, useful as an alternative completion tone.
  ['chime', 1.8, [
    { start: 0, dur: 1.6, decay: 3.2, partials: mallet(note(79)), gain: 0.85 },
    { start: 0, dur: 1.6, decay: 3.0, partials: mallet(note(86)), gain: 0.4 },
    { start: 0.001, dur: 1.6, decay: 2.2, partials: mallet(note(91)), gain: 0.18 },
  ]],
  // Pulse — a short double blip for a low-key interruption cue.
  ['pulse', 0.7, [
    { start: 0, dur: 0.18, decay: 16, partials: mallet(note(74)), gain: 0.8 },
    { start: 0.22, dur: 0.3, decay: 12, partials: mallet(note(74)), gain: 0.8 },
  ]],
  // Alarm — deliberately more insistent for interruption alerts.
  ['alarm', 1.3, [
    { start: 0, dur: 0.16, decay: 8, partials: mallet(note(81)), gain: 0.9 },
    { start: 0.2, dur: 0.16, decay: 8, partials: mallet(note(76)), gain: 0.9 },
    { start: 0.4, dur: 0.16, decay: 8, partials: mallet(note(81)), gain: 0.9 },
    { start: 0.6, dur: 0.5, decay: 5, partials: mallet(note(76)), gain: 0.9 },
  ]],
  // Soft tick — unobtrusive, for people who want a quiet cue.
  ['soft-tick', 0.4, [
    { start: 0, dur: 0.35, decay: 18, partials: mallet(note(84)), gain: 0.7 },
  ]],
]

for (const [name, seconds, voices] of TONES) {
  wav(render(seconds, voices), join(OUT, `${name}.wav`))
  console.log('wrote', name)
}
