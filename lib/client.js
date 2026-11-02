/**
 * dsh-notifier — browser half.
 *
 * One settings page (`settings.section`, id `notifier`) that switches the
 * notification tones on and off, assigns a tone to each of the three events, and
 * lets the user hear a tone before choosing it.
 *
 * The page is a hand-written ModuleLoader bundle: no build step, no dependency
 * beyond the `react` the shell already provides. It reads and writes its Host
 * configuration through `ctx.configForms`, the shared settings transport, and it
 * asks its own Host half to play a preview through `/api/notifier/test`, because
 * the speaker this plugin exists to drive is not the browser's.
 *
 * @module dsh-notifier/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-notifier',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.notifier'
    /** Profile entry id carrying this plugin's configuration. */
    const ENTRY_ID = 'notifier'
    /**
     * Same-origin base for this plugin's own Host routes, resolved against the
     * document so it works under whatever mount prefix the Host serves.
     */
    const API = (() => {
      try {
        return new URL('api/notifier', document.baseURI).pathname
      } catch {
        return '/api/notifier'
      }
    })()

    // ── copy ────────────────────────────────────────────────────────────────────
    // Flat key → template string, registered with the locale service under NS.
    // Tone names are keys (`tone.<id>`) rather than a nested object, because the
    // locale runtime is a flat dictionary.
    const DICT = {
      en: {
        nav: 'Notification sounds',
        title: 'Notification sounds',
        intro: 'Play a different sound on this machine when a task finishes, when a task stops early, and when the agent needs you.',
        enabled: 'Enable notification sounds',
        enabledHint: 'Applies to every event below. Sounds play on the machine running DeepSeek Harness.',
        volume: 'Volume',
        volumeHint: 'Shared by every notification.',
        events: 'Event sounds',
        'event.complete': 'Task finished',
        'event.complete.hint': 'A turn ended because the agent completed its work.',
        'event.interrupted': 'Task stopped',
        'event.interrupted.hint': 'A turn was cancelled, failed, was blocked, or ran out of tokens.',
        'event.needs-input': 'Needs your input',
        'event.needs-input.hint': 'The agent is waiting for an approval or an answer to a question.',
        preview: 'Preview',
        previewing: 'Playing',
        saved: 'Saved',
        failed: 'Could not save',
        previewFailed: 'Preview failed',
        unavailable: 'The notifier plugin is not running on this Host, so there is nothing to configure.',
        loading: 'Loading settings…',
        'tone.task-complete': 'Rising arpeggio',
        'tone.chime': 'Chime',
        'tone.ping': 'Single ping',
        'tone.soft-tick': 'Soft tick',
        'tone.task-interrupted': 'Falling minor third',
        'tone.pulse': 'Double pulse',
        'tone.alarm': 'Alarm',
        'tone.needs-input': 'Double ping',
      },
      zh: {
        nav: '提示音',
        title: '提示音',
        intro: '任务完成、任务中断、以及需要你介入时，各播放一段不同的提示音。',
        enabled: '开启提示音',
        enabledHint: '对下面所有事件生效。提示音在运行 DeepSeek Harness 的这台机器上播放。',
        volume: '音量',
        volumeHint: '所有提示音共用。',
        events: '事件提示音',
        'event.complete': '任务完成',
        'event.complete.hint': '智能体完成任务，本轮对话正常结束。',
        'event.interrupted': '任务中断',
        'event.interrupted.hint': '本轮被取消、失败、被阻止，或达到 token 上限。',
        'event.needs-input': '需要你介入',
        'event.needs-input.hint': '智能体正在等待你的授权或回答问题。',
        preview: '试听',
        previewing: '播放中',
        saved: '已保存',
        failed: '保存失败',
        previewFailed: '试听失败',
        unavailable: '提示音插件未在此 Host 上运行，没有可配置的内容。',
        loading: '正在读取设置…',
        'tone.task-complete': '上行琶音',
        'tone.chime': '钟声',
        'tone.ping': '单声叮',
        'tone.soft-tick': '轻声嘀嗒',
        'tone.task-interrupted': '下行小三度',
        'tone.pulse': '双脉冲',
        'tone.alarm': '警报',
        'tone.needs-input': '双声叮',
      },
    }

    /** Tone ids in picker order, used until the Host answers with its catalogue. */
    const FALLBACK_CATALOG = [
      'task-complete', 'chime', 'ping', 'soft-tick',
      'task-interrupted', 'pulse', 'alarm', 'needs-input',
    ]

    /** The three events in page order, with the Config field each one writes. */
    const EVENT_ROWS = [
      { event: 'complete', field: 'completeTone' },
      { event: 'interrupted', field: 'interruptedTone' },
      { event: 'needs-input', field: 'needsInputTone' },
    ]

    // ── styles ──────────────────────────────────────────────────────────────────
    // Every colour is a `--dsw-alias-*` theme token, so the page follows light
    // and dark mode without a second palette. Class names carry a `dsn_` prefix
    // so nothing here can collide with shell styles.
    const CSS = `
.dsn_page { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 24px; max-width: 760px; }
.dsn_head { display: flex; flex-direction: column; gap: 6px; }
.dsn_title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsn_intro { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsn_groupTitle { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary); text-transform: uppercase; padding: 4px 2px 0; }
.dsn_card { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsn_row { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsn_row:last-child { border-bottom: none; }
.dsn_rowText { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dsn_label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsn_hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsn_switch { position: relative; flex: none; width: 40px; height: 22px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; transition: background 140ms ease, border-color 140ms ease; }
.dsn_switch[data-on="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsn_knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-static-neutral-00); box-shadow: 0 1px 2px rgb(0 0 0 / 25%); transition: transform 140ms ease; }
.dsn_switch[data-on="true"] .dsn_knob { transform: translateX(18px); }
.dsn_switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsn_switch:disabled { opacity: .5; cursor: default; }
.dsn_select { flex: none; width: 172px; height: 30px; padding: 0 8px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.dsn_select:disabled { opacity: .5; }
.dsn_button { flex: none; min-width: 72px; height: 30px; padding: 0 12px; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; white-space: nowrap; }
.dsn_button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsn_button:disabled { opacity: .5; cursor: default; }
.dsn_button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsn_volumeRow { display: flex; align-items: center; gap: 10px; flex: none; width: 200px; }
.dsn_slider { flex: 1; accent-color: var(--dsw-alias-brand-primary); }
.dsn_volumeValue { flex: none; width: 38px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.dsn_status { font-size: 12px; min-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsn_status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsn_status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsn_notice { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; color: var(--dsw-alias-label-secondary); }
`

    // ── data plumbing ───────────────────────────────────────────────────────────
    /**
     * Call one of this plugin's own Host routes.
     *
     * A short timeout keeps a missing or wedged route from hanging the page: the
     * settings surface must stay usable even when the Host half is not running.
     *
     * @param {string} path path below `api/notifier`
     * @param {object} [options] fetch options
     * @returns {Promise<any>} the parsed JSON body
     */
    async function call(path, options) {
      const { timeout = 8000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, {
          ...rest,
          redirect: 'error',
          signal: controller.signal,
          headers: rest.body === undefined
            ? rest.headers
            : { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        })
        const text = await response.text()
        if (!response.ok) throw new Error(text === '' ? `HTTP ${String(response.status)}` : text.slice(0, 200))
        return text === '' ? {} : JSON.parse(text)
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * The page's read/write face over the Host settings document.
     *
     * `ctx.configForms.get(entryId)` returns the shared form for one Host entry:
     * its accepted value, and `set(field, value)` writes one volatile field into
     * the profile patch, which the running Host plugin picks up in place.
     *
     * @param {object} ctx client plugin context
     * @returns {object} the store
     */
    function createStore(ctx) {
      let form
      try {
        form = ctx.configForms?.get?.(ENTRY_ID)
      } catch {
        form = undefined
      }
      return {
        /** Whether the Host serves this namespace at all. */
        available: form !== undefined,
        /** The accepted section, or undefined before the first Host answer. */
        snapshot() {
          if (form === undefined) return undefined
          const state = form.getSnapshot()
          return state.status === 'ready' ? state.value : undefined
        },
        /** Observe accepted-value changes. */
        subscribe(listener) {
          return form === undefined ? () => {} : form.subscribe(listener)
        },
        /**
         * Write one field.
         *
         * @param {string} field Config field name
         * @param {unknown} value the new value
         * @returns {Promise<boolean>} whether the Host accepted the write
         */
        async set(field, value) {
          if (form === undefined) return false
          return await form.set(field, value)
        },
      }
    }

    /**
     * React hook over the shared config form.
     *
     * @param {object} store the store from {@link createStore}
     * @returns {object | undefined} the accepted section
     */
    function useSettings(store) {
      const subscribe = useCallback((listener) => store.subscribe(listener), [store])
      const getSnapshot = useCallback(() => store.snapshot(), [store])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    // ── the page ────────────────────────────────────────────────────────────────
    /**
     * The settings page.
     *
     * The shell supplies `t` (bound to this plugin's `locale: NS` dictionary) and
     * `close` (owner props); `store` rides the registration's inject face.
     *
     * @param {object} props slot props
     * @returns {object} React element
     */
    function NotifierSettings({ store, t }) {
      const settings = useSettings(store)
      const [pending, setPending] = useState(false)
      const [status, setStatus] = useState({ key: '', tone: '' })
      const [playing, setPlaying] = useState('')
      const [draftVolume, setDraftVolume] = useState(undefined)
      const playTimer = useRef()

      useEffect(() => () => { if (playTimer.current !== undefined) clearTimeout(playTimer.current) }, [])

      const report = useCallback((key, tone) => { setStatus({ key, tone }) }, [])

      /** Write one field and report the outcome beside the controls. */
      const write = useCallback(async (field, value) => {
        setPending(true)
        report('', '')
        try {
          const accepted = await store.set(field, value)
          report(accepted ? 'saved' : 'failed', accepted ? 'ok' : 'error')
        } catch (error) {
          report(`failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          setPending(false)
        }
      }, [store, report])

      /** Ask the Host to sound one tone on the local speaker. */
      const preview = useCallback(async (tone) => {
        if (tone === undefined) return
        setPlaying(tone)
        report('', '')
        try {
          const result = await call('/test', { method: 'POST', body: JSON.stringify({ tone }) })
          // 'skipped' means another tone was still playing; that is not a failure.
          if (result?.outcome === 'failed') report('previewFailed', 'error')
        } catch (error) {
          report(`previewFailed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          playTimer.current = setTimeout(() => { setPlaying('') }, 700)
        }
      }, [report])

      const catalog = useMemo(() => {
        const served = settings?.catalog
        return Array.isArray(served) && served.length > 0 ? served : FALLBACK_CATALOG
      }, [settings?.catalog])

      if (!store.available) {
        return h('div', { className: 'dsn_page' }, h('div', { className: 'dsn_notice' }, t('unavailable')))
      }
      if (settings === undefined) {
        return h('div', { className: 'dsn_page' }, h('div', { className: 'dsn_notice' }, t('loading')))
      }

      const enabled = settings.enabled !== false
      const volume = typeof settings.volume === 'number' ? settings.volume : 0.6
      // The slider keeps a local draft while dragging and commits on release, so
      // one gesture is one settings write rather than dozens.
      const shown = draftVolume ?? volume
      const busy = pending

      const toneRow = ({ event, field }) => {
        const current = settings[field] ?? catalog[0]
        return h('div', { className: 'dsn_row', key: event },
          h('div', { className: 'dsn_rowText' },
            h('div', { className: 'dsn_label' }, t(`event.${event}`)),
            h('div', { className: 'dsn_hint' }, t(`event.${event}.hint`))),
          h('select', {
            className: 'dsn_select',
            value: current,
            disabled: busy || !enabled,
            'aria-label': t(`event.${event}`),
            onChange: (changeEvent) => { void write(field, changeEvent.target.value) },
          }, catalog.map((id) => h('option', { key: id, value: id }, t(`tone.${id}`)))),
          h('button', {
            type: 'button',
            className: 'dsn_button',
            disabled: playing !== '' || !enabled,
            onClick: () => { void preview(current) },
          }, playing === current ? t('previewing') : t('preview')))
      }

      return h('div', { className: 'dsn_page' },
        h('div', { className: 'dsn_head' },
          h('div', { className: 'dsn_title' }, t('title')),
          h('div', { className: 'dsn_intro' }, t('intro'))),

        h('div', { className: 'dsn_card' },
          h('div', { className: 'dsn_row' },
            h('div', { className: 'dsn_rowText' },
              h('div', { className: 'dsn_label' }, t('enabled')),
              h('div', { className: 'dsn_hint' }, t('enabledHint'))),
            h('button', {
              type: 'button',
              className: 'dsn_switch',
              'data-on': String(enabled),
              role: 'switch',
              'aria-checked': enabled,
              'aria-label': t('enabled'),
              disabled: busy,
              onClick: () => { void write('enabled', !enabled) },
            }, h('span', { className: 'dsn_knob' }))),

          h('div', { className: 'dsn_row' },
            h('div', { className: 'dsn_rowText' },
              h('div', { className: 'dsn_label' }, t('volume')),
              h('div', { className: 'dsn_hint' }, t('volumeHint'))),
            h('div', { className: 'dsn_volumeRow' },
              h('input', {
                className: 'dsn_slider',
                type: 'range',
                min: '5',
                max: '100',
                step: '5',
                value: String(Math.round(shown * 100)),
                'aria-label': t('volume'),
                disabled: !enabled,
                onChange: (changeEvent) => {
                  setDraftVolume(Number(changeEvent.target.value) / 100)
                },
                onPointerUp: () => {
                  const next = draftVolume
                  setDraftVolume(undefined)
                  if (next !== undefined && next !== volume) void write('volume', next)
                },
                onKeyUp: () => {
                  const next = draftVolume
                  setDraftVolume(undefined)
                  if (next !== undefined && next !== volume) void write('volume', next)
                },
              }),
              h('span', { className: 'dsn_volumeValue' }, `${String(Math.round(shown * 100))}%`)))),

        h('div', { className: 'dsn_groupTitle' }, t('events')),
        h('div', { className: 'dsn_card' }, EVENT_ROWS.map(toneRow)),

        h('div', { className: 'dsn_status', 'data-tone': status.tone }, status.key === '' ? '' : t(status.key)))
    }

    // ── plugin entry ────────────────────────────────────────────────────────────
    const inject = ['slots', 'configForms', 'locale']

    /**
     * Register the settings page.
     *
     * @param {object} ctx client plugin context
     * @returns {void}
     */
    function apply(ctx) {
      const store = createStore(ctx)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-notifier')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-notifier: styles')

      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-notifier: dictionaries')

      // `slots.inject` waits for the settings shell to declare the section, so
      // this page appears in the Settings navigation without the shell knowing
      // about this plugin. `locale: NS` gives the component its `t` prop and
      // re-registers the navigation label when the language changes.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'notifier',
        order: 60,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => ({ store }),
      }, NotifierSettings))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-notifier'
    exports.__test = { DICT, EVENT_ROWS, FALLBACK_CATALOG, API, CSS }
    return module.exports
  },
})
