/**
 * Playing one bundled tone on the machine that runs the Harness.
 *
 * The player is deliberately tiny and injectable: {@link createPlayer} takes the
 * spawn function it needs so tests can assert launch arguments without opening a
 * speaker, and nothing here ever throws into a session-event listener.
 *
 * @module dsh-notifier/src/player
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding this plugin's bundled WAV clips. */
const SOUND_DIR = fileURLToPath(new URL('../assets/sounds/', import.meta.url))

/**
 * Resolve one tone's absolute file path.
 *
 * @param {string} file file name inside `assets/sounds`
 * @returns {string} absolute path
 */
export function soundPath(file) {
  return join(SOUND_DIR, file)
}

/**
 * Build the command line that plays one audio file at a volume.
 *
 * Each platform gets its own first-choice player and one ordered fallback list,
 * because a Linux desktop may carry any subset of PulseAudio, ALSA, or SDL. A
 * platform with no known player answers `undefined`, and the caller stays silent
 * instead of failing.
 *
 * @param {string} file absolute audio path
 * @param {number} volume playback volume in `[0, 1]`
 * @param {{ platform?: NodeJS.Platform, has?: (command: string) => boolean }} [facts] platform facts for tests
 * @returns {{ command: string, args: string[] } | undefined} the launch, or undefined when no player exists
 */
export function playerCommand(file, volume, facts = {}) {
  const platform = facts.platform ?? process.platform
  const has = facts.has ?? commandOnPath
  if (platform === 'darwin') {
    if (!has('afplay')) return undefined
    // afplay's -v takes 0..4 as a linear gain; this plugin's own range is 0..1.
    return { command: 'afplay', args: ['-v', String(round2(volume)), file] }
  }
  if (platform === 'win32') {
    // SoundPlayer plays the WAV this plugin ships and needs no extra package.
    const escaped = file.replace(/'/gu, "''")
    return {
      command: 'powershell',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
      ],
    }
  }
  // Linux and the BSDs: PulseAudio, then ALSA, then ffmpeg's player, then sox.
  const candidates = [
    { command: 'paplay', args: ['--volume', String(Math.round(volume * 65536)), file] },
    { command: 'aplay', args: ['-q', file] },
    { command: 'ffplay', args: ['-nodisp', '-autoexit', '-volume', String(Math.round(volume * 100)), '-loglevel', 'quiet', file] },
    { command: 'play', args: ['-q', '-v', String(round2(volume)), file] },
  ]
  return candidates.find((candidate) => has(candidate.command))
}

/** Two decimals is enough precision for every player's volume flag. */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Whether a command resolves through `PATH`.
 *
 * @param {string} command executable name
 * @returns {boolean} true when it is runnable
 */
function commandOnPath(command) {
  const path = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const directory of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (directory === '') continue
    for (const extension of extensions) {
      if (existsSync(join(directory, command + extension))) return true
    }
  }
  return false
}

/**
 * Create a player bound to one logger and lifetime.
 *
 * Three behaviours matter more than the launch itself:
 *
 * - **Never throw.** This runs from a `session/event` listener, where a throw
 *   would surface as a plugin failure. Every failure path becomes a warning.
 * - **Answer immediately.** `play()` reports whether the tone *started*, not
 *   whether it finished. A caller that awaited the clip would hold an HTTP
 *   request open for its whole length.
 * - **Never pile up.** Notifications can arrive in bursts (several queued turns
 *   finishing together). One tone plays at a time; the newest request replaces
 *   anything still waiting, so the user hears each event instead of a backlog.
 *
 * @param {object} [options] player options
 * @param {{ warn?: (message: string) => void, debug?: (message: string) => void }} [options.logger] host logger
 * @param {Function} [options.spawn] child_process.spawn, injectable for tests
 * @returns {{ play: (file: string, volume: number) => Promise<'started' | 'skipped' | 'failed'>, stop: () => void }} the player
 */
export function createPlayer(options = {}) {
  const logger = options.logger ?? {}
  const launch = options.spawn ?? spawn
  /** The clip whose sound is coming out of the speaker right now. */
  let playing
  /** One request waiting for the current clip to finish; a newer request replaces it. */
  let queued
  let disposed = false

  /** Release the playing slot and start whatever was queued behind it. */
  const settle = () => {
    playing = undefined
    if (disposed) {
      queued = undefined
      return
    }
    const next = queued
    queued = undefined
    if (next !== undefined) void start(next.file, next.volume)
  }

  const start = (file, volume) => new Promise((resolve) => {
    let child
    try {
      const command = playerCommand(file, volume)
      if (command === undefined) {
        logger.warn?.(`dsh-notifier: no audio player on this platform, cannot play ${file}`)
        resolve('skipped')
        return
      }
      child = launch(command.command, command.args, { stdio: 'ignore' })
    } catch (error) {
      logger.warn?.(`dsh-notifier: could not start an audio player: ${messageOf(error)}`)
      resolve('failed')
      return
    }
    playing = child
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (playing === child) settle()
    }
    // 'error' means the player never ran; 'close' means the sound finished.
    child.once?.('error', (error) => {
      logger.warn?.(`dsh-notifier: audio playback failed: ${messageOf(error)}`)
      release()
    })
    child.once?.('close', (code) => {
      if (code !== 0 && code !== null) logger.debug?.(`dsh-notifier: player exited with code ${String(code)}`)
      release()
    })
    // A tone must never hold the host process open during shutdown.
    child.unref?.()
    // Spawn succeeded: the sound is starting now, so answer without waiting.
    resolve('started')
  })

  return {
    /**
     * Sound one tone, replacing any tone still waiting in the queue.
     *
     * @param {string} file absolute path of the clip
     * @param {number} volume playback volume in `[0, 1]`
     * @returns {Promise<'started' | 'skipped' | 'failed'>} what happened, never a rejection
     */
    async play(file, volume) {
      if (disposed) return 'skipped'
      if (playing !== undefined) {
        // The speaker is busy: keep only the most recent request.
        queued = { file, volume }
        return 'skipped'
      }
      return await start(file, volume)
    },
    /** Release the current clip and drop anything queued. */
    stop() {
      disposed = true
      queued = undefined
      try {
        playing?.kill?.()
      } catch {
        // A player that already exited cannot be killed; nothing to release.
      }
      playing = undefined
    },
  }
}

/** Readable text for any thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
