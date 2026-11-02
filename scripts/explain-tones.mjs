/**
 * Explain, from a durable Session log, exactly which tones dsh-notifier rang —
 * and which events it deliberately stayed silent for.
 *
 * This works offline because the plugin decides from durable records only: a
 * turn ending arrives as `turn/end` with its `reason`, and an approval rings
 * from the `approval/asked` audit record. Replaying those records through the
 * same `src/classify.js` the plugin uses reproduces every decision without a
 * running Harness — which matters because the plugin's own debug line
 * (`-> <tone-id>`) never reaches a file or the trajectory.
 *
 * This is a development aid; it is not shipped in the bundle.
 *
 * Usage:
 *   node scripts/explain-tones.mjs                     # this workspace, newest session
 *   node scripts/explain-tones.mjs <workspace dir>     # newest session of another workspace
 *   node scripts/explain-tones.mjs <session dir|file>  # one exact session
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { classifyTurnEnd, isSubagentSession } from '../src/classify.js'

/** First four bytes of a zstd frame, little-endian magic `0xFD2FB528`. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v4.jsonl.zstd'
/** `$DSH_HOME/sessions`, so a non-default Harness home still resolves. */
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'sessions')

/**
 * Decode one session log.
 *
 * The persistence layer appends one zstd frame per flush, so a live session is a
 * concatenation of frames. `zstdDecompressSync` reads only the FIRST frame, which
 * for a long session yields just the header record — walk the frames by their
 * magic bytes instead. Plain JSONL is accepted too, for exported logs.
 *
 * @param {string} file absolute session file path
 * @returns {string} decoded JSONL text
 */
function readSession(file) {
  const buffer = readFileSync(file)
  const offsets = []
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) offsets.push(at)
  if (offsets.length === 0) return buffer.toString('utf8')
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8')
    } catch {
      // A torn trailing frame is normal for a session still being written.
    }
  }
  return text
}

/** The folder name this Harness home uses for one workspace directory. */
function labelOf(directory) {
  return `--${directory.replace(/^\/+/, '').replaceAll('/', '-')}--`
}

/** Newest session directory directly under `directory`. */
function newestSession(directory) {
  const names = readdirSync(directory).filter((name) => name.startsWith('session-'))
  if (names.length === 0) throw new Error(`no session under ${directory}`)
  const modified = (name) => statSync(join(directory, name)).mtimeMs
  return join(directory, names.sort((left, right) => modified(right) - modified(left))[0])
}

/** Whether `path` is an existing regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a command-line target to one session file.
 *
 * @param {string} target workspace directory, session directory, or session file
 * @returns {string} absolute session file path
 */
function locate(target) {
  const path = resolve(target)
  if (isFile(path)) return path
  if (isFile(join(path, SESSION_FILE))) return join(path, SESSION_FILE)
  // A workspace directory maps to a labelled folder under the Harness home.
  for (const candidate of [path, join(SESSIONS_ROOT, labelOf(path))]) {
    try {
      return locate(newestSession(candidate))
    } catch {}
  }
  throw new Error(`no session for ${path} (looked under ${SESSIONS_ROOT})`)
}

/** Render one record instant in the machine's local zone. */
function stamp(time) {
  if (typeof time !== 'number') return '—'
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Parse every well-formed JSONL record. */
function recordsOf(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A partially written trailing line is normal; skip it.
    }
  }
  return records
}

/**
 * Explain the notification the plugin would have sounded for one record.
 *
 * @param {object} record one durable session record
 * @param {boolean} silent whether this is a delegated child session
 * @returns {{ event: string, tone: string, why: string } | undefined} one row, or undefined when the record is not a notification trigger
 */
function explain(record, silent) {
  if (record.type === 'turn/end') {
    const reason = record.data?.reason?.kind ?? 'unknown'
    const outcome = classifyTurnEnd(record.data?.reason)
    const tone = silent ? 'silent (subagent)' : outcome === undefined ? 'silent (forked)' : outcome.kind
    const why = outcome === undefined
      ? 'classifyTurnEnd() → undefined'
      : `classifyTurnEnd() → ${outcome.kind}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`
    return { event: `turn ${record.data?.turn} ended (${reason})`, tone, why }
  }
  if (record.type === 'approval/asked') {
    return {
      event: `approval asked (${record.data?.toolName ?? 'tool'})`,
      tone: silent ? 'silent (subagent)' : 'needs-input',
      why: 'approval/request waterfall',
    }
  }
  if (record.type === 'tool/call') {
    const name = record.data?.name ?? record.data?.toolName
    if (name === 'ask_user_question' || name === 'exit_plan_mode') {
      return {
        event: `${name} called`,
        tone: silent ? 'silent (subagent)' : 'needs-input',
        why: 'user-questions/request waterfall',
      }
    }
  }
  return undefined
}

const file = locate(process.argv[2] ?? '.')
const records = recordsOf(readSession(file))
const header = records.find((record) => record.type === 'session')
const silent = isSubagentSession(header)

console.log(`session : ${file}`)
console.log(`header  : origin=${header?.origin ?? '—'} delegationDepth=${header?.delegationDepth ?? 0}`)
if (silent) console.log('NOTE    : delegated child — dsh-notifier stays silent for every event below')

const rows = []
for (const record of records) {
  const row = explain(record, silent)
  if (row !== undefined) rows.push({ time: record.time, ...row })
}

if (rows.length === 0) {
  console.log('\nno turn endings, approvals, or questions recorded — nothing could have rung')
} else {
  console.log('')
  console.log(' time            event                                    tone                    reason')
  console.log(' ──────────────  ───────────────────────────────────────  ──────────────────────  ─────────────────────────')
  for (const row of rows) {
    console.log(` ${stamp(row.time)}  ${row.event.padEnd(39)}  ${row.tone.padEnd(22)}  ${row.why}`)
  }
  const totals = new Map()
  for (const row of rows) totals.set(row.tone, (totals.get(row.tone) ?? 0) + 1)
  console.log(`\ntotals: ${[...totals].map(([tone, count]) => `${tone}=${count}`).join('  ')}`)
  console.log('note  : the waterfalls themselves are not durable, so `approval/asked` and the')
  console.log('        ask_user_question / exit_plan_mode call are the closest durable evidence.')
}
