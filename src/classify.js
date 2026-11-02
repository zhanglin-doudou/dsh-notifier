/**
 * Turn-end classification: which notification a recorded `turn/end` reason
 * deserves.
 *
 * The Host half listens to `session/event` and routes every appended event
 * through {@link classifyTurnEnd}. Keeping the decision here (rather than in the
 * listener) makes the rules reviewable and unit-testable without a Cordis
 * composition.
 *
 * @module dsh-notifier/src/classify
 */

/**
 * The notification categories this plugin can sound.
 *
 * @typedef {'complete' | 'interrupted' | 'needs-input'} NotificationKind
 */

/**
 * Explain one turn ending.
 *
 * `completed` is the only reason that means the agent finished what it was
 * asked to do. Everything else either stopped short (`aborted`, `blocked`,
 * `max-tokens`, `interrupted`, `forked`) or failed (`error`), and all of those
 * are reported as `interrupted` so a user hears the difference between "done"
 * and "stopped".
 *
 * A plugin may extend `TurnEndReasonMap`, so this reads `reason.kind` as an open
 * string and falls back to `interrupted` for anything it does not recognize:
 * ringing the "something happened" tone is a safer default than staying silent.
 *
 * @param {{ kind?: unknown } | undefined} reason recorded `turn/end` reason
 * @returns {{ kind: NotificationKind, reason: string, detail?: string } | undefined} the notification category, or undefined to stay silent
 */
export function classifyTurnEnd(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : ''
  switch (kind) {
    case 'completed':
      return { kind: 'complete', reason: kind }
    case 'aborted': {
      // A user's own Cancel reports its cause; keep it so the UI can say why.
      const cause = typeof reason.reason?.kind === 'string' ? reason.reason.kind : undefined
      return { kind: 'interrupted', reason: kind, ...cause === undefined ? {} : { detail: cause } }
    }
    case 'error': {
      const code = typeof reason.error?.code === 'string' ? reason.error.code : undefined
      const message = typeof reason.error?.message === 'string' ? reason.error.message : undefined
      return {
        kind: 'interrupted',
        reason: kind,
        ...(code === undefined ? {} : { detail: code }),
        ...(message === undefined ? {} : { message }),
      }
    }
    case 'max-tokens':
      return { kind: 'interrupted', reason: kind }
    case 'blocked':
      return { kind: 'interrupted', reason: kind }
    case 'interrupted':
      // Written when a crash-orphaned turn is closed after the fact.
      return { kind: 'interrupted', reason: kind }
    case 'forked':
      // A fork boundary closed an open turn; nothing the user should be told about.
      return undefined
    default:
      return kind === '' ? undefined : { kind: 'interrupted', reason: kind }
  }
}

/**
 * Whether a Session is a subagent child whose turns should not ring the user's
 * speaker.
 *
 * Delegated children run many short turns; sounding each one would drown the
 * notifications the user actually cares about. The header records both a coarse
 * `origin` and a `delegationDepth`, and either is enough.
 *
 * @param {{ origin?: unknown, delegationDepth?: unknown } | undefined} header Session header
 * @returns {boolean} true for a delegated child Session
 */
export function isSubagentSession(header) {
  if (header?.origin === 'subagent') return true
  return typeof header?.delegationDepth === 'number' && header.delegationDepth > 0
}
