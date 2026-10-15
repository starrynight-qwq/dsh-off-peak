/**
 * 错峰模式 (Off-Peak Mode) — Client half.
 *
 * Registers one whole Settings page. DeepSeek charges half price during the
 * off-peak window, so this page is where the user decides which workspaces may
 * run inside that window and which must stop the moment peak begins.
 *
 * The page talks to the Host half over the Host's own HTTP route,
 * `POST /plugins/offPeak/rpc` — see `call` below for the envelope. The
 * Typert Remote namespace `ctx.remote.offPeak` is deliberately NOT used: a
 * runtime-installed client bundle has no build-time Remote mount table in the
 * shipped Web bundle, so that namespace stays undefined no matter how healthy
 * the Host half is. The service behind the route owns everything the page shows
 * or changes: the four global switches (merged from the profile row, the
 * plugin's durable store and the schema defaults) and the per-workspace opt-in
 * list. No Harness Client package is imported: the switch and the list are
 * hand-written, per the plugin authoring rules.
 *
 * Visual language: the project list below deliberately copies DSH's own
 * left-hand workspace list — a 34px row, 8px radius, 6px gaps, a 16px glyph
 * slot, a 14px/20px ellipsised title with a 12px/17px tertiary subtitle, and a
 * hover fill of `--dsw-alias-interactive-bg-hover` whose row actions only appear
 * while hovered or focused. Discovery is automatic: the page asks the Host to
 * scan the roots that can plausibly hold the user's projects the moment it
 * mounts, so no directory has to be typed in; the manual walker stays available
 * as a collapsed fallback.
 */

window.__ModuleLoader__.load({
  id: 'dsh-off-peak',
  factory (require) {
    const React = require('react')
    const h = React.createElement

    /** Settings namespace; equals the profile entry id in cordis.patch.yml. */
    const NS = 'offPeak'

    /**
     * The Host's dispatch route, relative to whichever origin served this
     * bundle. Literal rather than derived from any injected URL so a deployment
     * behind a path prefix keeps working unchanged.
     */
    const RPC_URL = `/plugins/${NS}/rpc`

    /** Text for both languages, keyed exactly like the Host locale files. */
    const zh = {
      title: '错峰模式',
      subtitle: '错峰半价时段自动开始，高峰时段自动停止。',
      master: '错峰模式总开关',
      masterHint: '关闭后不再自动停止或自动继续任何项目，已有的停止记录会保留。',
      autoResume: '空闲时段自动继续',
      autoResumeHint: '进入空闲时段后，自动继续此前被高峰停止的执行（会补上暂停期间排队的消息）。',
      autoStart: '空闲时段自动开始',
      autoStartHint: '项目内没有任何会话运行时，空闲时段自动唤醒该项目最近使用的会话。',
      tickSeconds: '检查周期（秒）',
      tickSecondsHint: '哨兵在窗口交替时精确触发，该周期只用于兜底检查与状态刷新。',
      peak: '高峰时段',
      idle: '空闲时段',
      peakRule: '高峰：北京时间周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00；其余时间（含周末与法定节假日全天）为空闲时段。',
      nextBoundary: '下一个切换点',
      notSet: '—',
      projects: '项目列表',
      projectsHint: '勾选后，该项目会在空闲时段自主运行，并在高峰时段自动停止。',
      allOn: '全部开启',
      allOff: '全部关闭',
      sessions: '会话',
      running: '运行中',
      stopping: '正在停止',
      paused: '已暂停',
      waiting: '待运行',
      off: '未开启',
      parked: '条消息已暂存',
      stopNow: '立即停止全部',
      resumeNow: '立即继续全部',
      refresh: '刷新',
      loading: '加载中…',
      empty: '还没有任何工作区。在 DSH 中打开一个项目目录后，它会出现在这里。',
      emptyAllOff: '错峰模式总开关已关闭。打开上面的总开关后，这些项目才会在空闲时段自主运行。',
      loadFailed: '无法连接错峰模式服务',
      bridgeDown: 'Host 端未提供页面通道：请在「设置 → 插件」中确认 dsh-off-peak 已启用，重启 DSH 后刷新本页',
      retry: '重试',
      lastAction: '最近动作',
      lastError: '最近错误',
      storePath: '配置存储',
      sourceProfile: '配置文件',
      sourcePage: '本页保存',
      sourceDefault: '默认值',
      sourceFrom: '生效来源',
      saving: '保存中…',
      saveFailed: '保存失败',
      discover: '自动扫描到的项目',
      discoverHint: '进入本页时自动扫描 DSH 已知项目的所在目录，无需手动填写路径。勾选后点「加入并开启错峰模式」，项目就进入上面的项目列表。',
      root: '扫描目录（留空 = 默认目录）',
      scanNow: '扫描项目',
      up: '上一级',
      scanning: '扫描中…',
      found: '发现项目',
      foundNone: '这个目录下没有发现项目。换个目录，或者点「上一级」。',
      foundTruncated: '结果太多，只显示了前 200 个。',
      selectAll: '全选',
      selectNone: '清空',
      addSelected: '加入并开启错峰模式',
      alreadyAdded: '已在列表',
      addedCount: '已添加',
      addFailed: '添加失败',
      subdirs: '子目录',
      walkHint: '点目录名进入下一层，或点「上一级」返回。',
      discoverNone: '没有发现新项目。DSH 已知项目的所在目录都扫过了，也可以在下面手动选择目录。',
      discoverScanning: '正在扫描 DSH 已知项目的所在目录…',
      discoverRoots: '扫描范围',
      discoverRootCount: '个目录',
      discoverScanned: '已检查',
      discoverTruncatedLimit: '项目太多，本次只列出一部分。',
      discoverTruncatedTime: '扫描时间到，本次只列出一部分结果。',
      discoverFailed: '扫描失败',
      discoverRetry: '重新扫描',
      rescan: '重新扫描',
      manual: '手动选择目录',
      hide: '收起',
      show: '展开',
      // Punctuation lives in the dictionary: `：` is correct in Chinese prose but
      // wrong in an English line, and every label/value join goes through it.
      sep: '：',
      unitHours: '小时',
      unitMinutes: '分钟',
      unitSeconds: '秒',
    }

    /** English mirror of {@link zh}. */
    const en = {
      title: 'Off-Peak Mode',
      subtitle: 'Start automatically in the half-price window, stop automatically at peak.',
      master: 'Spare-time master switch',
      masterHint: 'When off, nothing is stopped or resumed automatically. Existing stops are kept.',
      autoResume: 'Auto-resume in idle windows',
      autoResumeHint: 'Continue work stopped by a peak window, replaying anything queued while it was stopped.',
      autoStart: 'Auto-start in idle windows',
      autoStartHint: 'Wake the most recent session of a project that has nothing running.',
      tickSeconds: 'Check interval (seconds)',
      tickSecondsHint: 'The sentinel fires exactly at each window boundary; this interval is only a fallback and for status refresh.',
      peak: 'Peak hours',
      idle: 'Idle hours',
      peakRule: 'Peak: Beijing time Mon–Fri (excluding Chinese statutory holidays) 09:00–12:00 and 14:00–18:00. Everything else, including all weekends and holidays, is idle.',
      nextBoundary: 'Next boundary',
      notSet: '—',
      projects: 'Projects',
      projectsHint: 'Tick a project to let it run on its own during idle windows and stop automatically at peak.',
      allOn: 'Enable all',
      allOff: 'Disable all',
      sessions: 'sessions',
      running: 'Running',
      stopping: 'Stopping',
      paused: 'Paused',
      waiting: 'Waiting',
      off: 'Off',
      parked: 'message(s) parked',
      stopNow: 'Stop all now',
      resumeNow: 'Resume all now',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No workspaces yet. Open a project directory in DSH and it will appear here.',
      emptyAllOff: 'The spare-time master switch is off. Turn it on above and these projects will run on their own during idle windows.',
      loadFailed: 'Cannot reach the spare-time service',
      bridgeDown: 'The Host half exposes no page channel: make sure dsh-off-peak is enabled under Settings → Plugins, restart DSH, then reload this page',
      retry: 'Retry',
      lastAction: 'Last action',
      lastError: 'Last error',
      storePath: 'Settings store',
      sourceProfile: 'Profile config',
      sourcePage: 'Saved here',
      sourceDefault: 'Default',
      sourceFrom: 'Effective from',
      saving: 'Saving…',
      saveFailed: 'Save failed',
      discover: 'Automatically discovered projects',
      discoverHint: 'This page scans the directories DSH already knows about as soon as it opens — no path to type. Tick what you want, press “Add and enable off-peak mode”, and the project joins the list above.',
      root: 'Directory (empty = default)',
      scanNow: 'Scan',
      up: 'Up',
      scanning: 'Scanning…',
      found: 'Projects found',
      foundNone: 'No project found below this directory. Try another one, or go up.',
      foundTruncated: 'Too many results; only the first 200 are shown.',
      selectAll: 'Select all',
      selectNone: 'Clear',
      addSelected: 'Add and enable off-peak mode',
      alreadyAdded: 'Already listed',
      addedCount: 'Added',
      addFailed: 'Add failed',
      subdirs: 'Subdirectories',
      walkHint: 'Click a directory name to descend, or Up to go back.',
      discoverNone: 'Nothing new found. Every directory DSH knows about was scanned; you can still pick one by hand below.',
      discoverScanning: 'Scanning the directories DSH knows about…',
      discoverRoots: 'Scanned',
      discoverRootCount: 'directories',
      discoverScanned: 'checked',
      discoverTruncatedLimit: 'Too many projects; only part of the result is listed.',
      discoverTruncatedTime: 'The scan hit its time budget; only part of the result is listed.',
      discoverFailed: 'Scan failed',
      discoverRetry: 'Scan again',
      rescan: 'Scan again',
      manual: 'Pick a directory by hand',
      hide: 'Hide',
      show: 'Show',
      sep: ': ',
      unitHours: 'h',
      unitMinutes: 'm',
      unitSeconds: 's',
    }

    /**
     * Stylesheet, keyed by this plugin so unmount can remove exactly its own.
     *
     * Metrics follow DSH's sidebar: 34px project rows, `--dsw-radius-md` (8px)
     * corners, 16px glyph slots, 14px/20px titles, 12px/17px meta lines and the
     * standard `--dsw-alias-interactive-bg-hover` hover fill. Every colour is a
     * `--dsw-alias-*` token so light and dark both come from the Harness theme.
     */
    const CSS = `
/* ── page scaffold ─────────────────────────────────────────────────────── */
.offpeak-page{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}
.offpeak-page *{box-sizing:border-box}
.offpeak-card{display:flex;flex-direction:column;gap:12px;min-width:0}
.offpeak-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.offpeak-section-title strong{font-size:14px;font-weight:600;line-height:20px}
.offpeak-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.offpeak-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.offpeak-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.offpeak-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.offpeak-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.offpeak-info{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}

/* ── three-state pill used for the current window and per-project state ── */
.offpeak-phase{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-full,999px);font-size:12px;line-height:20px;font-weight:500;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.offpeak-phase.is-peak{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.offpeak-phase.is-idle{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.offpeak-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ── buttons, aligned with DSH's 28–32px controls ──────────────────────── */
.offpeak-btn{font:inherit;font-size:13px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.offpeak-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.offpeak-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.offpeak-btn:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default;opacity:.7}
.offpeak-btn.is-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}
.offpeak-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);opacity:.9}
.offpeak-btn.is-text{border-color:transparent;background:transparent;color:var(--dsw-alias-link);padding:0 2px}
.offpeak-btn.is-text:hover:not(:disabled){background:transparent;text-decoration:underline}
.offpeak-input{font:inherit;font-size:13px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-elevated-fill,transparent);color:inherit;flex:1;min-width:200px}
.offpeak-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.offpeak-input::placeholder{color:var(--dsw-alias-label-tertiary)}

/* ── the workspace list, shaped like DSH's own sidebar rows ────────────── */
.offpeak-list{display:flex;flex-direction:column;gap:2px;padding:0 4px}
.offpeak-row{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:transparent;border:none;font:inherit;text-align:left;width:100%;cursor:default}
.offpeak-row.is-toggle{cursor:pointer;transition:background .12s var(--ds-ease-in-out,ease)}
.offpeak-row.is-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.offpeak-row.is-toggle:disabled{cursor:default;opacity:.6}
.offpeak-row.is-muted{cursor:pointer}
.offpeak-row.is-muted:hover{background:var(--dsw-alias-interactive-bg-hover)}
.offpeak-row.is-muted:focus-visible,.offpeak-row.is-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.offpeak-glyph{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.offpeak-row.is-picked .offpeak-glyph,.offpeak-row.is-running .offpeak-glyph{color:var(--dsw-alias-state-business-primary)}
.offpeak-row-text{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.offpeak-row-title{display:flex;align-items:center;gap:6px;min-width:0}
.offpeak-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.offpeak-sub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.offpeak-row-actions{display:flex;align-items:center;gap:6px;flex:none}
.offpeak-row-state{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.offpeak-row.is-running .offpeak-row-state{color:var(--dsw-alias-state-success-primary)}
.offpeak-row.is-stopping .offpeak-row-state{color:var(--dsw-alias-state-error-primary)}
.offpeak-row.is-paused .offpeak-row-state{color:var(--dsw-alias-state-warn-primary)}
.offpeak-row.is-waiting .offpeak-row-state{color:var(--dsw-alias-state-business-primary)}
.offpeak-row-state.is-parked{color:var(--dsw-alias-state-idle-primary)}
.offpeak-row-hint{font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.offpeak-tag{font-size:11px;line-height:16px;height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}

/* ── switch ───────────────────────────────────────────────────────────── */
.offpeak-switch{position:relative;display:inline-block;flex:none;width:32px;height:18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;transition:background .16s var(--ds-ease-in-out,ease),border-color .16s var(--ds-ease-in-out,ease)}
.offpeak-row .offpeak-switch{cursor:inherit}
.offpeak-switch[aria-checked=true],.offpeak-switch[data-on=true]{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.offpeak-switch:disabled{opacity:.5;cursor:default}
.offpeak-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.offpeak-switch i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-primary-inverted);transition:transform .16s var(--ds-ease-in-out,ease);display:block}
.offpeak-switch[aria-checked=true] i,.offpeak-switch[data-on=true] i{transform:translateX(14px)}

/* ── settings block: one row per switch, hint on the second line ───────── */
.offpeak-group{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden}
.offpeak-setting{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.offpeak-setting+.offpeak-setting{border-top:1px solid var(--dsw-alias-border-l1)}
.offpeak-setting-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.offpeak-setting-label{font-size:14px;line-height:20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.offpeak-setting-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.offpeak-foot{display:flex;flex-direction:column;gap:6px;padding-top:4px}

/* ── discovery ────────────────────────────────────────────────────────── */
.offpeak-discover{display:flex;flex-direction:column;gap:12px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.offpeak-discover-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.offpeak-discover-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.offpeak-roots{word-break:break-all;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.offpeak-skeleton{display:flex;flex-direction:column;gap:2px}
.offpeak-skeleton-row{display:flex;align-items:center;gap:8px;height:34px;padding:0 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}

/* ── manual walker ────────────────────────────────────────────────────── */
.offpeak-walk{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}

@media (prefers-reduced-motion:reduce){.offpeak-switch,.offpeak-switch i{transition:none}}
`

    /** The `<style>` tag id, also what the module loader keys its cleanup on. */
    const STYLE_ID = `${NS}/client.css`

    /**
     * Put the stylesheet in the document, once.
     *
     * The tag carries `data-plugin`, which is how `dsh-client-modules` finds and
     * removes everything a plugin added when that plugin unloads — without it the
     * rules would outlive the page and pile up on every reload. The guard makes
     * the call idempotent, so a re-applied plugin reuses the tag it already owns.
     */
    function injectStyles () {
      if (typeof document === 'undefined' || document === null) return
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
      if (document.querySelector(selector) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Human label for one project state.
     * @param t - the bound translator.
     * @param state - `'running' | 'stopping' | 'paused' | 'waiting' | 'off'`.
     * @returns the localized label.
     */
    function stateLabel (t, state) {
      if (state === 'running') return t('running')
      if (state === 'stopping') return t('stopping')
      if (state === 'paused') return t('paused')
      if (state === 'waiting') return t('waiting')
      return t('off')
    }

    /** @param state - a project state. @returns true when work is live there. */
    function isLive (state) {
      return state === 'running' || state === 'waiting' || state === 'paused' || state === 'stopping'
    }

    /**
     * The folder glyph DSH puts in front of a workspace row, drawn inline so the
     * bundle needs no icon package.
     * @returns the glyph element.
     */
    function FolderGlyph () {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M1.75 3.5c0-.55.45-1 1-1h3.1c.27 0 .52.11.7.3l.9.95h5.8c.55 0 1 .45 1 1v7.75c0 .55-.45 1-1 1h-10.5c-.55 0-1-.45-1-1v-10z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }))
    }

    /** @returns the check glyph marking a ticked discovery candidate. */
    function CheckGlyph () {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 8.5l3 3 6-6.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /**
     * One switch, rendered as a real button so it is keyboard reachable.
     * @param props - `{ checked, disabled, label, onChange }`.
     * @returns the switch element.
     */
    function Switch (props) {
      return h('button', {
        type: 'button',
        className: 'offpeak-switch',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: () => { if (props.disabled !== true) props.onChange(!props.checked) },
      }, h('i'))
    }

    /**
     * One labelled row wrapping a switch and its hint.
     * @param props - `{ label, hint, checked, disabled, onChange }`.
     * @returns the setting row element.
     */
    function SwitchRow (props) {
      return h('div', { className: 'offpeak-setting' },
        h('div', { className: 'offpeak-setting-text' },
          h('div', { className: 'offpeak-setting-label' }, h('span', null, props.label)),
          h('div', { className: 'offpeak-setting-hint' }, props.hint)),
        h(Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange,
        }))
    }

    /**
     * The switch's track and knob, with no interactivity of its own.
     *
     * A project row is itself the control, so nesting a second focusable switch
     * inside it would give the row two tab stops for one decision. This draws the
     * same shape and lets the row own the ARIA.
     * @param props - `{ checked }`.
     * @returns the decorative switch element.
     */
    function SwitchVisual (props) {
      return h('span', { className: 'offpeak-switch', 'aria-hidden': 'true', 'data-on': props.checked ? 'true' : 'false' }, h('i'))
    }

    /**
     * One 错峰模式 project row, in DSH's left-hand workspace-list shape: a glyph
     * slot, a title line carrying the live state, a single-line subtitle, and the
     * opt-in switch on the trailing edge.
     *
     * The row is the switch: one tab stop, one decision, and the name the user is
     * already reading is what activates it.
     * @param props - `{ row, busy, t, onToggle }`.
     * @returns the row element.
     */
    function ProjectRow (props) {
      const row = props.row
      const live = isLive(row.state)
      const meta = [`${row.sessionCount} ${props.t('sessions')}`, row.path]
      const classes = ['offpeak-row', 'is-toggle']
      if (live) classes.push(`is-${row.state}`)
      const activate = () => {
        if (props.busy !== '') return
        props.onToggle(row.workspaceId, row.enabled !== true)
      }
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        role: 'switch',
        'aria-checked': row.enabled === true ? 'true' : 'false',
        'aria-label': `${row.title} · ${stateLabel(props.t, row.state)}`,
        disabled: props.busy !== '',
        onClick: activate,
      },
        h('span', { className: 'offpeak-glyph' }, h(FolderGlyph)),
        h('div', { className: 'offpeak-row-text' },
          h('div', { className: 'offpeak-row-title' },
            h('span', { className: 'offpeak-title', title: row.title }, row.title),
            row.parked > 0 ? h('span', { className: 'offpeak-row-state is-parked' }, `${row.parked} ${props.t('parked')}`) : null),
          h('div', { className: 'offpeak-sub', title: meta.join(' · ') }, meta.join(' · '))),
        h('div', { className: 'offpeak-row-actions' },
          h('span', { className: 'offpeak-row-state' }, stateLabel(props.t, row.state)),
          h(SwitchVisual, { checked: row.enabled === true })))
    }

    /**
     * One tickable discovery candidate, rendered as the same sidebar row so the
     * found list and the enrolled list read as one control.
     * @param props - `{ candidate, picked, disabled, t, onToggle }`.
     * @returns the row element.
     */
    function CandidateRow (props) {
      const candidate = props.candidate
      if (candidate.known === true) {
        return h('div', { className: 'offpeak-row' },
          h('span', { className: 'offpeak-glyph' }, h(FolderGlyph)),
          h('div', { className: 'offpeak-row-text' },
            h('div', { className: 'offpeak-row-title' },
              h('span', { className: 'offpeak-title', title: candidate.title }, candidate.title),
              (candidate.markers ?? []).map(label => h('span', { key: label, className: 'offpeak-tag' }, label))),
            h('div', { className: 'offpeak-sub', title: candidate.path }, candidate.path)),
          h('div', { className: 'offpeak-row-actions' },
            h('span', { className: 'offpeak-row-hint' }, props.t('alreadyAdded'))))
      }
      return h('button', {
        type: 'button',
        className: `offpeak-row is-muted${props.picked ? ' is-picked' : ''}`,
        'aria-pressed': props.picked ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onToggle(candidate.path, props.picked !== true),
      },
        h('span', { className: 'offpeak-glyph' }, props.picked ? h(CheckGlyph) : h(FolderGlyph)),
        h('div', { className: 'offpeak-row-text' },
          h('div', { className: 'offpeak-row-title' },
            h('span', { className: 'offpeak-title', title: candidate.title }, candidate.title),
            (candidate.markers ?? []).map(label => h('span', { key: label, className: 'offpeak-tag' }, label))),
          h('div', { className: 'offpeak-sub', title: candidate.path }, candidate.path)))
    }

    /**
     * The automatic scan result: every project directory the Host found under the
     * roots DSH already knows about, ticked ones joined and switched on in one go.
     * @param props - the slot's own props; the transport arrives via inject.
     * @returns the discovery card element.
     */
    function DiscoverPanel (props) {
      const t = props.useT()
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [picked, setPicked] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')

      /**
       * Run one transport call with the busy guard and a surfaced failure.
       * @param tag - busy tag.
       * @param action - the call.
       * @returns the response, or null when it failed.
       */
      const guard = async (tag, action) => {
        if (busy !== '') return null
        setBusy(tag)
        setError('')
        try {
          return await action()
        } catch (failure) {
          setError(`${t('discoverFailed')}${t('sep')}${failure?.message ?? failure}`)
          return null
        } finally {
          setBusy('')
        }
      }

      /** Ask the Host what it can find without any path from the user. */
      const run = async () => {
        const answer = await guard('discover', () => props.discover())
        if (answer === null) return null
        if (answer.ok === false) { setError(answer.error ?? t('discoverFailed')); return null }
        setResult(answer)
        setPicked((answer.candidates ?? []).filter(candidate => candidate.known !== true).map(candidate => candidate.path))
        return answer
      }

      /** Add every ticked candidate as a Workspace with 错峰模式 already on. */
      const add = async () => {
        const answer = await guard('add', () => props.add(picked))
        if (answer === null) return
        if (answer.ok === false) { setError(answer.error ?? t('addFailed')); return }
        const added = answer.added ?? []
        const failed = answer.errors ?? []
        const suffix = failed.length > 0 ? ` · ${failed.length} ${t('addFailed')}${t('sep')}${failed[0]?.reason ?? ''}` : ''
        setNote(`${t('addedCount')} ${added.length}${suffix}`)
        setPicked([])
        setResult(previous => previous === null ? previous : {
          ...previous,
          candidates: (previous.candidates ?? []).map(candidate => added.some(entry => entry.path === candidate.path)
            ? { ...candidate, known: true, enabled: true }
            : candidate),
        })
        await props.refresh().catch(() => {})
      }

      // Mount = scan. Nothing is typed and nothing is clicked: the Host walks its
      // own roots asynchronously, so the card paints its "scanning" line first and
      // fills in when the answer lands.
      React.useEffect(() => {
        void run()
      }, [])

      const candidates = result?.candidates ?? []
      const fresh = candidates.filter(candidate => candidate.known !== true)
      const known = candidates.length - fresh.length
      const toggle = (key, on) => {
        if (busy !== '') return
        setPicked(previous => on === true ? [...previous, key] : previous.filter(entry => entry !== key))
      }

      return h('div', { className: 'offpeak-discover' },
        h('div', { className: 'offpeak-discover-head' },
          h('strong', null, t('discover')),
          h('div', { className: 'offpeak-actions' },
            h('button', {
              type: 'button',
              className: 'offpeak-btn',
              disabled: busy !== '',
              onClick: () => { void run() },
            }, busy === 'discover' ? t('scanning') : (result === null ? t('scanNow') : t('rescan'))),
            h('button', {
              type: 'button',
              className: 'offpeak-btn',
              disabled: busy !== '' || fresh.length === 0,
              onClick: () => setPicked(fresh.map(candidate => candidate.path)),
            }, t('selectAll')),
            h('button', {
              type: 'button',
              className: 'offpeak-btn',
              disabled: busy !== '' || picked.length === 0,
              onClick: () => setPicked([]),
            }, t('selectNone')),
            h('button', {
              type: 'button',
              className: 'offpeak-btn is-primary',
              disabled: busy !== '' || picked.length === 0,
              onClick: () => { void add() },
            }, `${t('addSelected')} (${picked.length})`))),
        h('div', { className: 'offpeak-note' }, t('discoverHint')),

        result === null && error === ''
          ? h('div', null,
              h('div', { className: 'offpeak-note' }, t('discoverScanning')),
              h('div', { className: 'offpeak-skeleton' },
                [0, 1, 2].map(index => h('div', { key: index, className: 'offpeak-skeleton-row' },
                  h('span', { className: 'offpeak-glyph' }, h(FolderGlyph)),
                  h('span', { className: 'offpeak-note' }, t('loading'))))))
          : null,

        result !== null
          ? h('div', null,
              h('div', { className: 'offpeak-discover-count' },
                `${t('found')} · ${fresh.length}${known > 0 ? ` · ${known} ${t('alreadyAdded')}` : ''}`
                + ` · ${t('discoverScanned')} ${result.scanned ?? 0}`
                + ` · ${t('discoverRoots')} ${(result.roots ?? []).length} ${t('discoverRootCount')}`),
              h('div', { className: 'offpeak-roots', title: (result.roots ?? []).join('\n') }, (result.roots ?? []).join(' · ')),

              // Nothing to add: say so in one line. Every candidate here is a
              // directory the list below already carries, so repeating its row —
              // and the marker tag that goes with it — would only add height to
              // the page a returning user sees.
              fresh.length === 0
                ? h('div', { className: 'offpeak-note' }, t('discoverNone'))
                : h('div', { className: 'offpeak-list' }, candidates.map(candidate => h(CandidateRow, {
                    key: candidate.path,
                    candidate,
                    picked: picked.includes(candidate.path),
                    disabled: busy !== '',
                    t,
                    onToggle: toggle,
                  }))),
              result.truncated === true
                ? h('div', { className: 'offpeak-note' }, result.truncatedReason === 'time' ? t('discoverTruncatedTime') : t('discoverTruncatedLimit'))
                : null,
              (result.errors ?? []).length > 0
                ? h('div', { className: 'offpeak-error' }, `${(result.errors ?? []).length} · ${(result.errors ?? [])[0]?.path ?? ''}：${(result.errors ?? [])[0]?.reason ?? ''}`)
                : null)
          : null,

        error !== '' ? h('div', { className: 'offpeak-error' }, error) : null,
        note !== '' ? h('div', { className: 'offpeak-note' }, note) : null)
    }

    /**
     * The manual walker, kept for the directory the automatic scan cannot know
     * about: walk one level at a time, or scan the current root for markers.
     * @param props - `{ t, initial, browse, scan, add, onAdded }`, already bound.
     * @returns the walker element.
     */
    function DirectoryPicker (props) {
      const t = props.t
      const [root, setRoot] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')

      /**
       * Run one transport call with the busy guard and error note.
       * @param tag - busy tag.
       * @param action - the call.
       * @returns the response, or null when it failed.
       */
      const guard = async (tag, action) => {
        if (busy !== '') return null
        setBusy(tag)
        setNote('')
        try {
          return await action()
        } catch (error) {
          setNote(`${t('addFailed')}: ${error?.message ?? error}`)
          return null
        } finally {
          setBusy('')
        }
      }

      /** Show one directory level. */
      const open = async (path) => {
        const answer = await guard('browse', () => props.browse(path))
        if (answer === null) return
        if (answer.ok === false) { setNote(answer.error ?? t('addFailed')); return }
        setRoot(answer.root ?? answer.path ?? '')
        setListing(answer)
        setPicked([])
      }

      /** Scan the current root for project markers. */
      const scan = async () => {
        const answer = await guard('scan', () => props.scan(root))
        if (answer === null) return
        if (answer.ok === false) { setNote(answer.error ?? t('addFailed')); return }
        setRoot(answer.root ?? root)
        setPicked([])
        props.onFound(answer)
      }

      // Open the walker at the root the Host is already using, so the field is
      // never empty and the first click always means something. Runs once per
      // mount; the title line and the Up button re-open it whenever needed.
      React.useEffect(() => {
        void open('')
      }, [])

      const candidates = props.found?.candidates ?? []
      const selectable = candidates.filter(candidate => candidate.known !== true)
      const directories = listing?.directories ?? []

      return h('div', { className: 'offpeak-walk' },
        h('div', { className: 'offpeak-section-title' },
          h('strong', null, t('manual')),
          h('div', { className: 'offpeak-actions' },
            h('button', { type: 'button', className: 'offpeak-btn', disabled: busy !== '', onClick: () => { void open(listing?.parent ?? '') } }, t('up')),
            h('button', { type: 'button', className: 'offpeak-btn', disabled: busy !== '', onClick: () => { void scan() } }, busy === 'scan' ? t('scanning') : t('scanNow')),
            h('button', {
              type: 'button',
              className: 'offpeak-btn is-primary',
              disabled: busy !== '' || picked.length === 0,
              onClick: async () => {
                const answer = await guard('add', () => props.add(picked))
                if (answer === null) return
                if (answer.ok === false) { setNote(answer.error ?? t('addFailed')); return }
                const failed = answer.errors ?? []
                setNote(`${t('addedCount')} ${(answer.added ?? []).length}${failed.length > 0 ? ` · ${t('addFailed')}${t('sep')}${failed[0]?.reason ?? ''}` : ''}`)
                setPicked([])
                await props.onAdded()
              },
            }, `${t('addSelected')} (${picked.length})`))),
        h('div', { className: 'offpeak-actions' },
          h('input', {
            className: 'offpeak-input',
            value: root,
            placeholder: t('root'),
            onChange: event => setRoot(event.target.value),
          })),
        directories.length === 0
          ? h('div', { className: 'offpeak-note' }, t('walkHint'))
          : h('div', null,
              h('div', { className: 'offpeak-actions' },
                h('span', { className: 'offpeak-meta' }, `${t('subdirs')}${t('sep')}`),
                directories.slice(0, 40).map(directory => h('button', {
                  key: directory.path,
                  type: 'button',
                  className: 'offpeak-btn',
                  disabled: busy !== '',
                  onClick: () => { void open(directory.path) },
                }, directory.name))),
              h('div', { className: 'offpeak-note' }, t('walkHint'))),
        selectable.length === 0
          ? (props.found === null ? null : h('div', { className: 'offpeak-note' }, t('foundNone')))
          : h('div', { className: 'offpeak-list' }, selectable.map(candidate => h(CandidateRow, {
              key: candidate.path,
              candidate,
              picked: picked.includes(candidate.path),
              disabled: busy !== '',
              t,
              onToggle: (path, on) => setPicked(previous => on === true ? [...previous, path] : previous.filter(entry => entry !== path)),
            }))),
        (props.found?.candidates ?? []).length > 0
          ? h('div', { className: 'offpeak-note' }, `${t('found')} · ${candidates.length}`)
          : null,
        props.found?.truncated === true ? h('div', { className: 'offpeak-note' }, t('foundTruncated')) : null,
        note !== '' ? h('div', { className: 'offpeak-note' }, note) : null)
    }

    /**
     * The 错峰模式 Settings page.
     * @param props - the slot's own props; the transport arrives via inject.
     * @returns the page element.
     */
    function OffPeakPage (props) {
      const status = props.useStatus(value => value)
      const projects = props.useProjects(value => value)
      const config = props.useConfig(value => value)
      const t = props.useT()
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [beat, setBeat] = React.useState(0)
      const [found, setFound] = React.useState(null)
      const [walker, setWalker] = React.useState(false)

      // Keep the countdown and window badge live without touching the Host.
      React.useEffect(() => {
        const timer = setInterval(() => setBeat(value => value + 1), 1000)
        return () => clearInterval(timer)
      }, [])

      const view = status ?? {}
      const rows = (projects?.projects ?? []).filter(row => row.hidden !== true)
      const duplicates = (projects?.projects ?? []).filter(row => row.hidden === true).length
      const enabled = config?.enabled !== false
      const autoResume = config?.autoResume !== false
      const autoStart = config?.autoStart !== false
      const tickSeconds = typeof config?.tickSeconds === 'number' ? config.tickSeconds : 15
      const phase = view.phase === 'peak' ? 'peak' : 'idle'

      /**
       * Human label for the configuration layer a switch value came from.
       * @param source - `'profile'`, `'page'` or `'default'`.
       * @returns the localized label.
       */
      const sourceLabel = (source) => {
        if (source === 'profile') return t('sourceProfile')
        if (source === 'page') return t('sourcePage')
        return t('sourceDefault')
      }

      /**
       * Run one Host call, surfacing its failure instead of throwing it away.
       * @param tag - busy marker for the buttons.
       * @param action - the async call.
       */
      const run = async (tag, action) => {
        if (busy !== '') return
        setBusy(tag)
        setFailure('')
        try {
          const result = await action()
          if (result !== undefined && result !== null && result.ok === false) setFailure(result.error ?? t('saveFailed'))
          await props.refresh()
        } catch (error) {
          setFailure(`${t('saveFailed')}: ${error?.message ?? error}`)
        } finally {
          setBusy('')
        }
      }

      /**
       * Countdown to the next window boundary, recomputed each second.
       * @returns a short label such as `2 小时 13 分钟`.
       */
      const countdown = () => {
        void beat
        const age = view.fetchedAt === undefined ? 0 : Date.now() - view.fetchedAt
        const total = Math.max(Math.round(((view.nextBoundaryInMs ?? 0) - age) / 1000), 0)
        const hours = Math.floor(total / 3600)
        const minutes = Math.floor((total % 3600) / 60)
        const seconds = total % 60
        if (hours > 0) return `${hours}${t('unitHours')} ${minutes}${t('unitMinutes')}`
        if (minutes > 0) return `${minutes}${t('unitMinutes')} ${seconds}${t('unitSeconds')}`
        return `${seconds}${t('unitSeconds')}`
      }

      return h('div', { className: 'offpeak-page' },
        // Window banner: the one line that answers "is it half price right now".
        h('div', { className: 'offpeak-card' },
          h('div', { className: 'offpeak-head' },
            h('span', { className: `offpeak-phase is-${phase}` },
              h('span', { className: 'offpeak-dot' }),
              t(phase === 'peak' ? 'peak' : 'idle')),
            h('span', { className: 'offpeak-meta' },
              `${t('nextBoundary')}${t('sep')}${view.nextPhase === 'peak' ? t('peak') : t('idle')} · ${countdown()} · ${view.nextBoundaryAt ?? t('notSet')}`)),
          h('div', { className: 'offpeak-info' },
            h('div', { className: 'offpeak-note' }, t('peakRule')),
            h('div', { className: 'offpeak-meta' },
              `${t('sourceFrom')}${t('sep')}${sourceLabel(config?.source?.enabled)} · ${t('storePath')}${t('sep')}${config?.configPath ?? t('notSet')}`)),
          failure !== '' ? h('div', { className: 'offpeak-error' }, failure) : null,
          status === null && failure === ''
            ? h('div', { className: 'offpeak-note' }, t('loading'))
            : null),

        // Global switches.
        h('div', { className: 'offpeak-group' },
          h(SwitchRow, {
            label: t('master'),
            hint: t('masterHint'),
            checked: enabled,
            onChange: value => { void run('master', () => props.setConfig('enabled', value)) },
          }),
          h(SwitchRow, {
            label: t('autoResume'),
            hint: t('autoResumeHint'),
            checked: autoResume,
            disabled: !enabled,
            onChange: value => { void run('auto-resume', () => props.setConfig('autoResume', value)) },
          }),
          h(SwitchRow, {
            label: t('autoStart'),
            hint: t('autoStartHint'),
            checked: autoStart,
            disabled: !enabled,
            onChange: value => { void run('auto-start', () => props.setConfig('autoStart', value)) },
          }),
          h(SwitchRow, {
            label: `${t('tickSeconds')} · ${tickSeconds}s`,
            hint: t('tickSecondsHint'),
            checked: tickSeconds > 15,
            disabled: !enabled,
            onChange: value => { void run('tick', () => props.setConfig('tickSeconds', value ? 30 : 15)) },
          })),

        // Automatic discovery: no directory to type in.
        h(DiscoverPanel, { ...props }),

        // The enrolled projects, in DSH's own workspace-list shape.
        h('div', { className: 'offpeak-card' },
          h('div', { className: 'offpeak-section-title' },
            h('div', { className: 'offpeak-heading' },
              h('strong', null, `${t('projects')} · ${rows.length}`),
              h('div', { className: 'offpeak-note' }, t('projectsHint'))),
            h('div', { className: 'offpeak-actions' },
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                disabled: busy !== '',
                onClick: () => { void run('all-on', () => props.setAll(true)) },
              }, t('allOn')),
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                disabled: busy !== '',
                onClick: () => { void run('all-off', () => props.setAll(false)) },
              }, t('allOff')),
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                disabled: busy !== '',
                onClick: () => { void run('stop', () => props.force('stop')) },
              }, t('stopNow')),
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                disabled: busy !== '',
                onClick: () => { void run('resume', () => props.force('resume')) },
              }, t('resumeNow')),
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                disabled: busy !== '',
                onClick: () => { void run('refresh', () => props.refresh()) },
              }, busy === 'refresh' ? t('saving') : t('refresh')))),
          !enabled ? h('div', { className: 'offpeak-info' }, h('div', { className: 'offpeak-note' }, t('emptyAllOff'))) : null,
          rows.length === 0
            ? h('div', { className: 'offpeak-note' }, t('empty'))
            : h('div', { className: 'offpeak-list' }, rows.map(row => h(ProjectRow, {
                key: row.workspaceId,
                row,
                busy,
                t,
                onToggle: (workspaceId, value) => { void run(`project:${workspaceId}`, () => props.setProject(workspaceId, value)) },
              })))),

        // The fallback for a directory nothing knows about yet.
        h('div', { className: 'offpeak-card' },
          h('div', { className: 'offpeak-section-title' },
            h('strong', null, t('manual')),
            h('div', { className: 'offpeak-actions' },
              h('button', {
                type: 'button',
                className: 'offpeak-btn',
                'aria-expanded': walker ? 'true' : 'false',
                onClick: () => setWalker(value => !value),
              }, walker ? t('hide') : t('show')))),
          walker
            ? h(DirectoryPicker, {
                t,
                found,
                browse: props.browse,
                scan: props.scan,
                add: props.add,
                onFound: setFound,
                onAdded: async () => { await props.refresh().catch(() => {}) },
              })
            : null),

        h('div', { className: 'offpeak-foot' },
          h('div', { className: 'offpeak-meta' },
            `${t('lastAction')}${t('sep')}${view.lastAction === '' || view.lastAction === undefined ? t('notSet') : view.lastAction}`
            + ` · ${t('storePath')}${t('sep')}${view.storePath ?? t('notSet')}`
            + (duplicates > 0 ? ` · ${duplicates} × ${t('alreadyAdded')}` : '')),
          view.lastError !== null && view.lastError !== undefined
            ? h('div', { className: 'offpeak-error' }, `${t('lastError')}${t('sep')}${view.lastError}`)
            : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        const t = ctx.locale.bind(NS)
        injectStyles()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'offPeak: dictionaries')

        // One shared poller: the page is the only consumer, but a single timer
        // keeps a re-mounted slot from stacking intervals.
        const box = { status: null, projects: null, config: null, listeners: new Set(), timer: null }
        const wake = () => { for (const listener of [...box.listeners]) listener() }

        // The Host registers this route on the Web carrier that serves this very
        // page, so a relative URL always hits the right server — there is no
        // origin to configure. Only `POST` is answered, so a stray `GET` can
        // never mutate anything.
        const call = async (method, request) => {
          let response
          try {
            response = await fetch(RPC_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method, request }),
            })
          } catch (error) {
            throw new Error(`${t('loadFailed')} — ${t('bridgeDown')}（${error instanceof Error ? error.message : String(error)}）`)
          }
          if (response.status === 404) throw new Error(`${t('loadFailed')} — ${t('bridgeDown')}`)
          let document
          try {
            document = await response.json()
          } catch {
            throw new Error(`${t('loadFailed')} — HTTP ${response.status}`)
          }
          if (document !== null && typeof document === 'object') return document
          throw new Error(`${t('loadFailed')} — HTTP ${response.status}`)
        }

        const refresh = async () => {
          const [status, projects, config] = await Promise.all([call('status'), call('projects'), call('getConfig')])
          if (status?.ok === false) throw new Error(status.error)
          box.status = { ...status, fetchedAt: Date.now() }
          box.projects = projects
          if (config?.ok !== false) box.config = config
          wake()
        }

        const startPolling = () => {
          if (box.timer !== null) return
          box.timer = setInterval(() => { refresh().catch(() => {}) }, 5000)
        }
        const stopPolling = () => {
          if (box.timer === null) return
          clearInterval(box.timer)
          box.timer = null
        }

        ctx.effect(() => {
          refresh().catch(() => {})
          startPolling()
          return () => { stopPolling() }
        }, 'offPeak: status polling')

        /**
         * Subscribe one component to the shared poller.
         * @param pick - reads the current snapshot value.
         * @returns a hook: `useX()` yields the value, `useX(selector)` projects it.
         */
        const bind = (pick) => (selector) => {
          const read = () => (selector === undefined ? pick() : selector(pick()))
          const [value, setValue] = React.useState(read)
          React.useEffect(() => {
            const listener = () => setValue(read())
            box.listeners.add(listener)
            listener()
            return () => { box.listeners.delete(listener) }
          }, [])
          return value
        }

        // The Host service is the single source of truth for these four
        // switches: it merges the profile row, the plugin's own durable store and
        // the schema defaults, and reports which layer each value came from.
        const readConfig = () => {
          const values = box.config?.values ?? {}
          const fromStatus = box.status ?? {}
          return {
            enabled: typeof values.enabled === 'boolean' ? values.enabled : fromStatus.enabled,
            autoResume: typeof values.autoResume === 'boolean' ? values.autoResume : fromStatus.autoResume,
            autoStart: typeof values.autoStart === 'boolean' ? values.autoStart : fromStatus.autoStart,
            tickSeconds: typeof values.tickSeconds === 'number' ? values.tickSeconds : fromStatus.tickSeconds,
            source: box.config?.source ?? {},
          }
        }

        /**
         * Write one switch through the `offPeak` service.
         * @param field - switch name.
         * @param value - new value.
         * @returns the Host's response.
         */
        const setConfig = async (field, value) => {
          const response = await call('setConfig', { field, value })
          if (response?.ok === false) throw new Error(response.error ?? '错峰模式设置写入失败')
          await refresh().catch(() => {})
          return response
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 40,
          label: () => t('title'),
          locale: NS,
          inject: () => ({
            useStatus: bind(() => box.status),
            useProjects: bind(() => box.projects),
            useConfig: bind(() => readConfig()),
            useT: bind(() => t),
            refresh,
            setConfig,
            setProject: (workspaceId, value) => call('setProject', { workspaceId, enabled: value }),
            setAll: value => call('setAll', { enabled: value }),
            force: action => call('force', { action }),
            browse: path => call('browse', { path }),
            scan: root => call('scanProjects', { root }),
            add: paths => call('addProjects', { paths }),
            discover: () => call('discover'),
            open: path => call('browse', { path }),
          }),
        }, OffPeakPage))
      },
    }
  },
})
