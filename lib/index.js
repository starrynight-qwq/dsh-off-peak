/**
 * 错峰模式 (Off-Peak Mode) — Host half.
 *
 * DeepSeek's off-peak discount applies to Beijing-time 00:00–09:00, 12:00–14:00
 * and 18:00–24:00 on working days, plus the whole of weekends and Chinese
 * statutory holidays. The mirror image of that discount window is the PEAK
 * window this plugin enforces: Beijing time Mon–Fri (excluding statutory
 * holidays) 09:00–12:00 and 14:00–18:00.
 *
 * Behaviour:
 *   - a 15 s tick classifies the wall clock in `Asia/Shanghai`;
 *   - every Workspace the user opted in is the unit of enforcement: sessions of
 *     an enabled, running Workspace are stopped when peak begins (queued user
 *     messages are parked, never dropped) and resumed when the idle window
 *     begins;
 *   - the `错峰模式` Settings page reads and writes the opt-in list and the
 *     global switches through the `offPeak` service below.
 *
 * Naming: the package (and the profile entry's `name`) is `dsh-off-peak`, while
 * the Settings namespace (the profile entry's `id`) is `offPeak`, which is also
 * the service key, the route prefix and the on-disk store directory. The two are
 * deliberately different spellings, so `cordis.patch.yml`, `lib/client.js` and
 * this file must be renamed together.
 *
 * The plugin-owned service is named `ctx.offPeak` (`publishRemote` below keeps
 * declaring the Typert Remote namespace for hosts that mount it). The page does
 * NOT travel the Typert Remote wire: the client half of a runtime-installed
 * plugin has no build-time Remote mount table in the shipped Web bundle, so
 * `ctx.remote.offPeak` is always undefined there. The page therefore calls the
 * `POST /plugins/offPeak/rpc` route this file registers on the Web carrier
 * (`webServer`), a same-origin JSON dispatch onto the very same service — see
 * `handleRpc` for the envelope and the exact methods exposed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Schema from './schema.js'

//#region clock

/** IANA zone the pricing windows are defined in. */
const ZONE = 'Asia/Shanghai'

/** Peak windows, as [startMinutes, endMinutes) in minutes past local midnight. */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60], // 09:00–12:00
  [14 * 60, 18 * 60], // 14:00–18:00
]

/** Sub-24h time, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Statutory holidays for the People's Republic of China (mainland), inclusive
 * date ranges in Beijing time.
 *
 * The State Council publishes these late in the preceding year; the ranges below
 * follow 国办发明电〔2024〕12号 (2025) and 国办发明电〔2025〕7号 (2026) verbatim.
 * Dates landing on a Saturday or Sunday are harmless here — a weekend is idle
 * either way.
 *
 * NOTE: 中国法定节假日 also includes 调休 make-up working days, where a Saturday or
 * Sunday becomes a working day. Per the specification such a day is NOT peak
 * (the rule is 周一至周五，不含中国法定节假日), so make-up days are deliberately
 * absent from this table.
 */
const HOLIDAYS = Object.freeze({
  2025: [
    ['2025-01-01', '2025-01-01'], // 元旦
    ['2025-01-28', '2025-02-04'], // 春节
    ['2025-04-04', '2025-04-06'], // 清明节
    ['2025-05-01', '2025-05-05'], // 劳动节
    ['2025-05-31', '2025-06-02'], // 端午节
    ['2025-10-01', '2025-10-08'], // 国庆节、中秋节
  ],
  2026: [
    ['2026-01-01', '2026-01-03'], // 元旦
    ['2026-02-15', '2026-02-23'], // 春节
    ['2026-04-04', '2026-04-06'], // 清明节
    ['2026-05-01', '2026-05-05'], // 劳动节
    ['2026-06-19', '2026-06-21'], // 端午节
    ['2026-09-25', '2026-09-27'], // 中秋节
    ['2026-10-01', '2026-10-07'], // 国庆节
  ],
})

/** Cached `Intl.DateTimeFormat` per component set. */
const FORMATTERS = new Map()

/**
 * Build (and memoise) one `Intl.DateTimeFormat` for the pricing zone.
 * @param kind - which component set to request.
 * @returns the formatter.
 */
function formatterFor (kind) {
  let found = FORMATTERS.get(kind)
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', kind === 'date'
      ? { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }
      : { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    FORMATTERS.set(kind, found)
  }
  return found
}

/**
 * Read the calendar date in Beijing time.
 * @param stamp - epoch milliseconds.
 * @returns `{ year, iso, weekday }` where weekday is 0=Sunday…6=Saturday.
 */
function beijingDate (stamp) {
  const parts = Object.fromEntries(formatterFor('date').formatToParts(stamp).map(part => [part.type, part.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { year, iso, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() }
}

/**
 * Read the wall clock in Beijing time.
 * @param stamp - epoch milliseconds.
 * @returns `{ hour, minute, second, minutes }` with `minutes` past local midnight.
 */
function beijingClock (stamp) {
  const parts = Object.fromEntries(formatterFor('time').formatToParts(stamp).map(part => [part.type, part.value]))
  // Some ICU builds spell midnight as hour "24" even with `hour12: false`.
  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  return { hour, minute, second: Number(parts.second), minutes: hour * 60 + minute }
}

/**
 * Classify one instant against the pricing calendar.
 * @param stamp - epoch milliseconds to classify; defaults to now.
 * @returns the classification every other helper consumes.
 */
function classify (stamp = Date.now()) {
  const date = beijingDate(stamp)
  const clock = beijingClock(stamp)
  const ranges = HOLIDAYS[date.year] ?? []
  const holiday = ranges.find(([from, to]) => date.iso >= from && date.iso <= to)
  const weekend = date.weekday === 0 || date.weekday === 6
  const window = weekend || holiday !== undefined
    ? undefined
    : PEAK_WINDOWS.find(([from, to]) => clock.minutes >= from && clock.minutes < to)
  return { stamp, date, clock, peak: window !== undefined, holiday, weekend, workday: !weekend && holiday === undefined }
}

/** Weekday names for display. */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * Human-readable Beijing-time label for one instant.
 * @param stamp - epoch milliseconds.
 * @returns e.g. `2026-10-15 10:52 (周四)`.
 */
function stampLabel (stamp = Date.now()) {
  const { date, clock } = classify(stamp)
  const pad = value => String(value).padStart(2, '0')
  return `${date.iso} ${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)} (${WEEKDAY_NAMES[date.weekday]})`
}

/**
 * Describe the current classification in Chinese.
 * @param now - a `classify()` result.
 * @returns a short phrase such as `高峰时段`.
 */
function describeState (now) {
  if (now.holiday !== undefined) return `空闲时段（法定节假日）`
  if (now.weekend) return '空闲时段（周末）'
  return now.peak ? '高峰时段' : '空闲时段（工作日错峰）'
}

/**
 * Every peak⇄idle boundary between now and `horizon` ms ahead.
 * @param stamp - epoch milliseconds to start from.
 * @param horizon - how far ahead to scan, in milliseconds.
 * @returns ascending boundary timestamps with their post-boundary phase.
 */
function boundaries (stamp, horizon) {
  const found = []
  const step = 60 * 1000
  let previous = classify(stamp).peak
  let probe = stamp + (step - (stamp % step))
  const limit = stamp + horizon
  while (probe <= limit) {
    const current = classify(probe).peak
    if (current !== previous) {
      found.push({ stamp: probe, peak: current })
      previous = current
    }
    probe += step
  }
  return found
}

/**
 * Next peak⇄idle boundary within a week.
 * @param stamp - epoch milliseconds to start from.
 * @returns the boundary instant and the phase that begins there.
 */
function nextBoundary (stamp = Date.now()) {
  const [first] = boundaries(stamp, 8 * DAY_MS)
  return first ?? { stamp: stamp + DAY_MS, peak: !classify(stamp).peak }
}

//#endregion

//#region plugin state

/** Marker naming this plugin as the author of a parked or replayed message. */
const PLUGIN_SOURCE = 'dsh-off-peak'
/** Resume prompt used when a session had nothing queued when peak began. */
const GENERIC_RESUME = '【错峰模式】已进入错峰（半价）时段，请继续之前未完成的工作。'

/** Settings namespace and profile entry id (see cordis.patch.yml). */
const NAMESPACE = 'offPeak'
/**
 * Namespace this plugin used before it was renamed from `dsh-sparetime` to
 * `dsh-off-peak`. Only ever read (once, when the new store does not exist yet),
 * so an install that predates the rename keeps its opt-in list and switches.
 */
const LEGACY_NAMESPACE = 'sparetime'

//#region project discovery

/**
 * How long an automatic scan's result is reused.
 *
 * The Settings page scans on every mount, and users flip between panes; without
 * this an open/close/open cycle would re-walk the whole home directory each
 * time. 30s is short enough that a newly created project still appears.
 */
const DISCOVER_TTL_MS = 30_000

/**
 * Default bounds for one automatic scan: depth, candidates, visits per root and
 * the shared wall-clock budget the whole sweep must fit into.
 */
const DISCOVER_LIMITS = Object.freeze({ depth: 3, limit: 200, visitsPerRoot: 500, budgetMs: 2500, maxRoots: 6 })

/**
 * Directory names a project scan never descends into.
 *
 * These are dependency trees, build output and editor state: a project inside
 * one of them is never something the user wants scheduled.
 */
const SCAN_SKIP = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
  'coverage', '.git', '.hg', '.svn', '.next', '.nuxt', '.svelte-kit', '.venv',
  'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.cache',
  '.gradle', '.idea', '.vscode', '.terraform', 'Pods', '$RECYCLE.BIN',
  'System Volume Information',
])

/** Files whose presence marks a directory as a project, with an ecosystem tag. */
const PROJECT_MARKERS = [
  ['package.json', 'Node'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['deno.json', 'Deno'],
  ['tsconfig.json', 'TypeScript'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['setup.py', 'Python'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['pom.xml', 'Maven'],
  ['build.gradle', 'Gradle'],
  ['build.gradle.kts', 'Gradle'],
  ['composer.json', 'PHP'],
  ['Gemfile', 'Ruby'],
  ['CMakeLists.txt', 'CMake'],
  ['Makefile', 'Make'],
  ['mix.exs', 'Elixir'],
  ['pubspec.yaml', 'Dart'],
  ['Package.swift', 'Swift'],
  ['.git', 'Git'],
]

/** Filename suffixes that mark a project too (IDE solution formats). */
const PROJECT_SUFFIXES = [
  ['.sln', 'Visual Studio'],
  ['.csproj', '.NET'],
  ['.xcodeproj', 'Xcode'],
]

/**
 * Ecosystem tags for one directory listing.
 * @param names - file and directory names inside the candidate directory.
 * @returns the tags; `[]` when nothing marks the directory as a project.
 */
function markerLabels (names) {
  const labels = []
  for (const [file, label] of PROJECT_MARKERS) {
    if (names.has(file) === true && labels.includes(label) === false) labels.push(label)
  }
  for (const name of names) {
    for (const [suffix, label] of PROJECT_SUFFIXES) {
      if (`${name}`.endsWith(suffix) && labels.includes(label) === false) labels.push(label)
    }
  }
  return labels
}

/**
 * Compare two paths as the same directory on this platform.
 * @param left - one absolute or relative path.
 * @param right - the other.
 * @returns true when both name the same directory.
 */
function samePath (left, right) {
  const a = resolve(`${left}`).replace(/[\\/]+$/, '')
  const b = resolve(`${right}`).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * @param path - any path.
 * @returns a map key for it, case-folded on Windows.
 */
function pathKey (path) {
  const normalized = resolve(`${path}`).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Read one directory without ever throwing.
 * @param path - absolute directory path.
 * @returns `{ ok, entries, error }`.
 */
function readEntries (path) {
  try {
    return { ok: true, entries: readdirSync(path, { withFileTypes: true }), error: '' }
  } catch (error) {
    return { ok: false, entries: [], error: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}` }
  }
}

/** @param path - any path. @returns its parent, or `''` at a filesystem root. */
function parentOf (path) {
  const parent = dirname(path)
  return parent === path ? '' : parent
}

/**
 * List one directory level, for the page's walker.
 * @param requested - directory path.
 * @param limit - maximum number of subdirectories to return.
 * @returns a JSON document describing that level.
 */
function browseDirectory (requested, limit = 400) {
  const target = resolve(`${requested}`)
  const read = readEntries(target)
  const base = {
    path: target,
    name: basename(target) || target,
    parent: parentOf(target),
    directories: [],
    files: 0,
    truncated: false,
    error: '',
  }
  if (read.ok === false) return { ...base, error: read.error }
  const directories = []
  let files = 0
  for (const entry of read.entries) {
    const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
    if (isDirectory === false) { files += 1; continue }
    if (SCAN_SKIP.has(entry.name)) continue
    if (directories.length >= limit) continue
    directories.push({ name: entry.name, path: join(target, entry.name) })
  }
  directories.sort((left, right) => left.name.localeCompare(right.name))
  return { ...base, directories, files, truncated: directories.length >= limit }
}

/**
 * Walk a tree and collect the directories that look like projects.
 *
 * A directory that already looks like a project is reported and not descended
 * into: its subdirectories are that project's own packages, not separate
 * projects the user would schedule.
 *
 * The walk is bounded three ways — breadth-first order, a hard `maxVisits` cap
 * and a wall-clock `deadlineMs` — so an automatic scan of a home directory
 * cannot stall the Host RPC that serves the page. Whatever limit stopped it is
 * reported as `truncatedReason`, and unreadable directories are collected in
 * `errors` instead of aborting the walk.
 * @param requested - the root to walk.
 * @param options - `{ depth, limit, maxVisits, deadlineMs }`, all clamped.
 * @returns `{ root, candidates, errors, scanned, truncated, truncatedReason }`.
 */
function scanForProjects (requested, options = {}) {
  const root = resolve(`${requested}`)
  const depth = Number.isFinite(options.depth) === true ? Math.min(Math.max(Math.floor(options.depth), 0), 6) : 3
  const limit = Number.isFinite(options.limit) === true ? Math.min(Math.max(Math.floor(options.limit), 1), 1000) : 200
  const maxVisits = Number.isFinite(options.maxVisits) === true ? Math.min(Math.max(Math.floor(options.maxVisits), 1), 5000) : 1000
  const deadline = Number.isFinite(options.deadlineMs) === true && options.deadlineMs > 0 ? Date.now() + options.deadlineMs : 0
  const candidates = []
  const errors = []
  let scanned = 0
  let truncated = false
  let truncatedReason = ''
  const queue = [{ path: root, level: 0 }]
  while (queue.length > 0) {
    if (candidates.length >= limit) { truncated = true; truncatedReason = 'limit'; break }
    if (scanned >= maxVisits) { truncated = true; truncatedReason = 'visits'; break }
    if (deadline !== 0 && scanned % 8 === 0 && Date.now() > deadline) { truncated = true; truncatedReason = 'time'; break }
    const current = queue.shift()
    const read = readEntries(current.path)
    if (read.ok === false) { errors.push({ path: current.path, reason: read.error }); continue }
    scanned += 1
    const markers = markerLabels(new Set(read.entries.map(entry => entry.name)))
    if (markers.length > 0) {
      candidates.push({ path: current.path, title: basename(current.path) || current.path, markers, depth: current.level })
      continue
    }
    if (current.level >= depth) continue
    for (const entry of read.entries) {
      const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
      if (isDirectory === false || SCAN_SKIP.has(entry.name)) continue
      queue.push({ path: join(current.path, entry.name), level: current.level + 1 })
    }
  }
  return { root, candidates, errors: errors.slice(0, 20), scanned, truncated, truncatedReason }
}

/**
 * Durable per-project opt-in store.
 *
 * Deliberately a plugin-owned JSON file rather than a storage domain: it keeps
 * the bundle dependency-free, and a corrupt file degrades to "nothing enabled"
 * instead of blocking activation.
 */
class ProjectStore {
  /**
   * @param path - absolute path of the JSON document.
   * @param logger - the plugin's logger for diagnostics.
   * @param options - `{ legacyPath }`, read once when `path` does not exist yet.
   */
  constructor (path, logger, options = {}) {
    this.path = path
    this.logger = logger
    this.legacyPath = options.legacyPath
    this.document = this.read()
  }

  /** @returns the on-disk document, or a fresh one when unreadable. */
  read () {
    let source = this.path
    try {
      if (!existsSync(source)) {
        // Pre-rename installs kept this file under `storages/sparetime/`. Adopt
        // it once so the first launch after the rename keeps the opt-in list;
        // the file is left in place as a fallback for a downgrade.
        if (this.legacyPath === undefined || !existsSync(this.legacyPath)) return { version: 1, projects: {} }
        source = this.legacyPath
        this.logger?.info?.(`${PLUGIN_SOURCE}: adopting ${source} as ${this.path}`)
      }
      const parsed = JSON.parse(readFileSync(source, 'utf8'))
      return {
        version: 1,
        projects: typeof parsed?.projects === 'object' && parsed.projects !== null ? parsed.projects : {},
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.(`${PLUGIN_SOURCE}: ignoring unreadable ${source} (${error?.message ?? error})`)
      return { version: 1, projects: {} }
    }
  }

  /** Persist the document atomically. */
  write () {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, JSON.stringify(this.document, null, 2), 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      this.logger?.warn?.(`${PLUGIN_SOURCE}: cannot persist ${this.path} (${error?.message ?? error})`)
    }
  }

  /**
   * Read one project's record.
   * @param workspaceId - registry id.
   * @returns the record, or `undefined` when never configured.
   */
  get (workspaceId) {
    return this.document.projects[workspaceId]
  }

  /** @returns every stored record keyed by workspace id. */
  all () {
    return this.document.projects
  }

  /**
   * Merge one project's record.
   * @param workspaceId - registry id.
   * @param patch - fields to merge.
   * @returns the stored record.
   */
  set (workspaceId, patch) {
    const previous = this.document.projects[workspaceId] ?? {}
    this.document.projects[workspaceId] = { ...previous, ...patch, updatedAt: Date.now() }
    this.write()
    return this.document.projects[workspaceId]
  }

  /**
   * Drop one project's record.
   * @param workspaceId - registry id.
   */
  remove (workspaceId) {
    if (this.document.projects[workspaceId] === undefined) return
    delete this.document.projects[workspaceId]
    this.write()
  }
}

/**
 * Durable home of the four global switches.
 *
 * The switches are also declared as `volatile` Config fields, so they can be
 * written from the native configuration editor and survive a profile upgrade
 * through the user's own patch layer. This store is the second, always-writable
 * home: the 错峰模式 page writes here through the `offPeak` service, which
 * keeps the page working even when no profile patch exists yet, and lets the
 * Host answer "what is the switch set to" without depending on a service that
 * may not be composed into every profile.
 *
 * Precedence, highest first: an explicit value in the profile row's `config`,
 * this store, the schema default.
 */
class ConfigStore {
  /**
   * @param path - absolute path of the JSON document.
   * @param logger - the plugin's logger for diagnostics.
   * @param options - `{ legacyPath }`, read once when `path` does not exist yet.
   */
  constructor (path, logger, options = {}) {
    this.path = path
    this.logger = logger
    this.legacyPath = options.legacyPath
    this.document = this.read()
  }

  /** @returns the on-disk document, or a fresh one when unreadable. */
  read () {
    let source = this.path
    try {
      if (!existsSync(source)) {
        if (this.legacyPath === undefined || !existsSync(this.legacyPath)) return { version: 1, values: {} }
        source = this.legacyPath
        this.logger?.info?.(`${PLUGIN_SOURCE}: adopting ${source} as ${this.path}`)
      }
      const parsed = JSON.parse(readFileSync(source, 'utf8'))
      return {
        version: 1,
        values: typeof parsed?.values === 'object' && parsed.values !== null ? parsed.values : {},
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.(`${PLUGIN_SOURCE}: ignoring unreadable ${source} (${error?.message ?? error})`)
      return { version: 1, values: {} }
    }
  }

  /** Persist the document atomically. */
  write () {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, JSON.stringify(this.document, null, 2), 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      this.logger?.warn?.(`${PLUGIN_SOURCE}: cannot persist ${this.path} (${error?.message ?? error})`)
    }
  }

  /**
   * Merge one switch. `undefined` drops the stored value so the schema default
   * applies again.
   * @param field - switch name.
   * @param value - the new value, or `undefined` to unset.
   */
  set (field, value) {
    if (value === undefined) delete this.document.values[field]
    else this.document.values[field] = value
    this.write()
  }

  /** @returns the stored switch values, `{}` when none were ever written. */
  all () {
    return this.document.values
  }
}

/** Every configurable switch, with the schema default and its validator. */
const CONFIG_FIELDS = {
  enabled: { fallback: true, kind: 'boolean' },
  autoResume: { fallback: true, kind: 'boolean' },
  autoStart: { fallback: true, kind: 'boolean' },
  tickSeconds: { fallback: 15, kind: 'seconds' },
}

/**
 * Coerce one incoming switch value to the type its field declares.
 *
 * The values arrive from the browser as JSON, so a switch can realistically be
 * sent as a string; accepting `"false"`/`"true"` and clamping the tick keeps a
 * hand-edited profile patch from wedging the engine.
 * @param field - switch name.
 * @param value - the raw incoming value.
 * @returns the coerced value, or `undefined` when the value cannot be used.
 */
function normalizeField (field, value) {
  const spec = CONFIG_FIELDS[field]
  if (spec === undefined) return undefined
  if (spec.kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    return undefined
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(numeric) === false) return undefined
  return Math.min(Math.max(Math.round(numeric), 15), 300)
}

//#endregion

//#region messages

/**
 * Read the plain text out of a persisted user message.
 * @param message - a session message of any shape.
 * @returns the concatenated text blocks, or `''`.
 */
function messageText (message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const blocks = []
  for (const block of content) {
    if (typeof block === 'string') blocks.push(block)
    else if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') blocks.push(block.text)
  }
  return blocks.join('\n').trim()
}

/**
 * Project one queued inbox message into a JSON-safe parked record.
 * @param message - a message read out of the agent's inbox.
 * @param sessionId - owning session id.
 * @param index - position within the batch.
 * @returns the record to persist in memory.
 */
function parkRecord (message, sessionId, index) {
  const { content, ...rest } = message ?? {}
  return {
    id: message?.id ?? `parked-${sessionId}-${index}`,
    sessionId,
    message: { ...rest, content: structuredClone(content) },
    text: messageText(message),
    parkedAt: Date.now(),
  }
}

/**
 * Build the user message replayed when the idle window opens.
 * @param parked - parked records for one session.
 * @returns a `createUserMessage` shaped object tagged with this plugin's source.
 */
function resumeMessage (parked) {
  const sections = parked.map((entry, index) => {
    const lines = [`【${index + 1}/${parked.length}】`]
    if (entry.text !== '') lines.push(entry.text)
    const extras = (Array.isArray(entry.message?.content) ? entry.message.content : [])
      .filter(block => typeof block === 'object' && block !== null && block.type !== 'text' && block.type !== 'reasoning')
    for (const block of extras) lines.push(JSON.stringify(block, null, 2))
    return lines.join('\n')
  })
  return {
    content: [{
      type: 'text',
      text: [
        '<offpeak-resume>',
        '【错峰模式】已进入空闲（错峰半价）时段，此前因高峰时段暂停的执行现在自动继续。',
        sections.length === 0
          ? '请从上次中断处继续未完成的工作。'
          : `下面是高峰时段暂停期间排队、尚未处理的用户消息，请从中断处继续：\n\n${sections.join('\n\n')}`,
        '</offpeak-resume>',
      ].join('\n'),
    }],
    source: { kind: PLUGIN_SOURCE, form: 'offpeak-resume' },
  }
}

//#endregion

//#region schema

/** Config schema; `volatile` is what makes these fields editable from the UI. */
const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('错峰模式总开关。关闭后不再自动停止或自动继续任何项目。'),
  autoResume: Schema.boolean()
    .default(true)
    .volatile()
    .description('进入空闲时段后自动继续项目里被高峰停止的执行；关闭后只停止、不自动继续。'),
  autoStart: Schema.boolean()
    .default(true)
    .volatile()
    .description('空闲时段自动开始：当项目里没有任何会话在运行时，自动唤醒该项目最近使用的会话。'),
  tickSeconds: Schema.number()
    .default(15)
    .min(15)
    .max(300)
    .step(5)
    .volatile()
    .description('检查周期（秒）。哨兵在每次窗口交替时精确触发，该周期只用于兜底与状态刷新。'),
})

//#endregion

//#region service

/**
 * The prototype key the Typert Gateway reads to find Remote methods.
 *
 * The shipped Harness packages get this marker from the `@Remote` decorator at
 * build time. This plugin ships plain JavaScript the Loader imports directly,
 * with no transform step, and it deliberately imports nothing from the Harness
 * (a bundle is resolved from its own directory, so a bare `@deepseek-ai/...`
 * specifier only works when the package happens to be hoisted — the failure
 * mode is `ERR_MODULE_NOT_FOUND` at plugin load). The marker itself is plain
 * data, so writing it directly keeps the wire contract without the dependency.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Publish one public instance method on the Typert wire.
 *
 * The stored descriptor is exactly the one the decorator writes: version 1
 * with one frozen `{ method, invocation: { kind: 'direct' } }` marker, appended
 * to whatever the prototype already declares.
 * @param owner - the class holding the method.
 * @param method - the public instance method name, also the default wire name.
 * @param exportName - optional distinct wire name.
 */
const publishRemote = (owner, method, exportName) => {
  const prototype = owner.prototype
  const current = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value
  const methods = Array.isArray(current?.methods) ? current.methods : []
  if (methods.some(candidate => candidate.method === method)) return
  const marker = Object.freeze({
    method,
    ...(exportName === undefined || exportName === method ? {} : { exportName }),
    invocation: Object.freeze({ kind: 'direct' }),
  })
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze([...methods, marker]) }),
  })
}

/**
 * The `offPeak` service: the Settings page's whole back end.
 *
 * Every method the browser calls is published with `publishRemote`, which is
 * what makes it reachable as `ctx.remote.offPeak.<method>`; nothing else about
 * this service is visible across the wire. It is a plain class registered with
 * `ctx.provide`, not a Cordis `Service` subclass, so that the bundle needs no
 * Harness import to exist.
 */
class OffPeakService {
  /**
   * @param ctx - the plugin's Cordis context.
   */
  constructor (ctx) {
    this.ctx = ctx
    this.engine = null
  }

  /**
   * Attach the enforcement engine.
   *
   * The engine owns the tick, the stores, and the parked queue, so the service
   * is a thin, JSON-only face over it: every method below returns plain data the
   * RPC carrier can copy.
   * @param engine - the engine handle built by `apply`.
   */
  attach (engine) {
    this.engine = engine
  }

  /**
   * The four global switches plus where their effective value came from.
   * @returns the config document the page renders.
   */
  getConfig () {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    return { ok: true, ...engine.configView() }
  }

  /**
   * Write one global switch.
   *
   * Writes the durable store first, because that always succeeds, then mirrors
   * the value into the plugin's volatile Config so the native configuration
   * editor and the profile patch stay in agreement. A refusal from the settings
   * document is reported but never loses the switch.
   * @param request - `{ field, value }`; any configurable switch name.
   * @returns the fresh config document and the mirror result.
   */
  async setConfig (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const field = typeof request?.field === 'string' ? request.field : ''
    if (Object.hasOwn(CONFIG_FIELDS, field) === false) return { ok: false, error: `未知设置项：${field || '(空)'}` }
    const parsed = normalizeField(field, request?.value)
    if (parsed === undefined) return { ok: false, error: `设置项 ${field} 的取值无效。` }
    engine.storeConfig(field, parsed)
    const mirrored = await engine.mirrorConfig(field, parsed)
    return { ok: true, ...engine.configView(), mirrored }
  }

  /** @returns a short connection probe used to verify the wire from the page. */
  ping () {
    return { ok: true, plugin: NAMESPACE, now: stampLabel(), pid: process.pid }
  }

  /**
   * Current clock classification plus live enforcement counters.
   *
   * `projects` is dropped on purpose: the rows are already served by
   * `projects()`, and re-sending them on every status poll would double the
   * wire payload for no gain. The `offPeak_status` tool still reports them,
   * because it formats `snapshot()` directly.
   * @returns the status document the 错峰模式 page renders.
   */
  status () {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    return { ok: true, ...engine.snapshot(), projects: undefined }
  }

  /**
   * Every known Workspace with its opt-in state and live activity.
   * @returns the project rows the 错峰模式 page lists.
   */
  projects () {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    return { ok: true, projects: engine.projectRows() }
  }

  /**
   * Turn 错峰模式 on or off for one Workspace, or re-point it at a session.
   * @param request - `{ workspaceId, enabled?, prompt?, sessionId? }`.
   * @returns the fresh project list.
   */
  setProject (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : ''
    if (workspaceId === '') return { ok: false, error: '缺少 workspaceId。' }
    if (engine.workspaceOf(workspaceId) === undefined) return { ok: false, error: `未知项目：${workspaceId}` }
    const patch = {}
    if (typeof request.enabled === 'boolean') patch.enabled = request.enabled
    if (typeof request.prompt === 'string') patch.prompt = request.prompt.slice(0, 4000)
    if (typeof request.sessionId === 'string') patch.sessionId = request.sessionId
    if (Object.keys(patch).length === 0) return { ok: false, error: '没有要修改的字段。' }
    engine.store.set(workspaceId, patch)
    engine.tick()
    return { ok: true, projects: engine.projectRows() }
  }

  /**
   * Enable or disable every known Workspace at once.
   * @param request - `{ enabled: boolean }`.
   * @returns the fresh project list.
   */
  setAll (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const enabled = request?.enabled === true
    for (const workspace of engine.workspaces()) engine.store.set(workspace.id, { enabled })
    engine.tick()
    return { ok: true, projects: engine.projectRows() }
  }

  /**
   * Forget one Workspace's opt-in record.
   * @param request - `{ workspaceId }`.
   * @returns the fresh project list.
   */
  forgetProject (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : ''
    engine.store.remove(workspaceId)
    engine.tick()
    return { ok: true, projects: engine.projectRows() }
  }

  /**
   * Stop or resume every enabled project right now, ignoring the clock.
   * @param request - `{ action: 'stop' | 'resume' }`.
   * @returns the fresh status document.
   */
  force (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const action = request?.action === 'stop' ? 'stop' : 'resume'
    engine.force(action)
    return { ok: true, ...engine.snapshot() }
  }

  /**
   * List one directory level so the page can walk to a project root.
   * @param request - `{ path }`; empty falls back to the default scan root.
   * @returns the directory listing, or `{ ok: false, error }`.
   */
  browse (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    try {
      return { ok: true, ...engine.browse(request?.path) }
    } catch (error) {
      return { ok: false, error: `无法读取目录：${error?.message ?? error}` }
    }
  }

  /**
   * Scan a root for project directories the user could add.
   * @param request - `{ root, depth?, limit? }`.
   * @returns `{ ok, root, candidates, directories, errors, scanned, truncated }`.
   */
  scanProjects (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    try {
      return { ok: true, ...engine.scan(request?.root, { depth: request?.depth, limit: request?.limit }) }
    } catch (error) {
      return { ok: false, error: `无法扫描该目录：${error?.message ?? error}` }
    }
  }

  /**
   * Find the user's projects without being told where to look.
   *
   * This is what the Settings page calls on mount, so no directory ever has to
   * be typed in. Roots come from the Workspaces DSH already knows plus the home
   * directory; the walk is bounded by depth, a per-root visit cap and one shared
   * wall-clock budget.
   * @param request - `{ roots?, depth?, limit?, budgetMs?, visitsPerRoot?, force? }`.
   * @returns `{ ok, candidates, scanned, roots, errors, truncated, truncatedReason }`.
   */
  discover (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    try {
      return { ok: true, ...engine.discover({ roots: request?.roots, depth: request?.depth, limit: request?.limit, budgetMs: request?.budgetMs, visitsPerRoot: request?.visitsPerRoot, force: request?.force === true }) }
    } catch (error) {
      return { ok: false, error: `自动扫描失败：${error?.message ?? error}` }
    }
  }

  /**
   * Register the selected directories as Workspaces and switch 错峰模式 on.
   * @param request - `{ paths: string[] }`.
   * @returns the added rows, the failures and the fresh project list.
   */
  async addProjects (request) {
    const engine = this.engine
    if (engine === null) return { ok: false, error: '错峰模式引擎尚未启动。' }
    const paths = Array.isArray(request?.paths) ? request.paths : []
    if (paths.length === 0) return { ok: false, error: '没有选择任何项目。' }
    const result = await engine.addProjects(paths)
    return { ok: true, ...result, projects: engine.projectRows() }
  }
}

publishRemote(OffPeakService, 'getConfig')
publishRemote(OffPeakService, 'setConfig')
publishRemote(OffPeakService, 'ping')
publishRemote(OffPeakService, 'status')
publishRemote(OffPeakService, 'projects')
publishRemote(OffPeakService, 'setProject')
publishRemote(OffPeakService, 'setAll')
publishRemote(OffPeakService, 'forgetProject')
publishRemote(OffPeakService, 'force')
publishRemote(OffPeakService, 'browse')
publishRemote(OffPeakService, 'scanProjects')
publishRemote(OffPeakService, 'discover')
publishRemote(OffPeakService, 'addProjects')

//#endregion

//#region http bridge

/** Path of the page's own JSON endpoint, inside the plugin's reserved route. */
const RPC_PATH = `/plugins/${NAMESPACE}/rpc`

/** Cap on one RPC request body; every payload this page sends is tiny. */
const RPC_BODY_LIMIT_BYTES = 256 * 1024

/**
 * The public service methods the page may call over the bridge.
 *
 * Written out instead of reflecting over the prototype on purpose: an explicit
 * table is the allowlist, so nothing added to the service later becomes
 * reachable from the browser by accident.
 */
const RPC_METHODS = Object.freeze({
  getConfig: true,
  setConfig: true,
  ping: true,
  status: true,
  projects: true,
  setProject: true,
  setAll: true,
  forgetProject: true,
  force: true,
  browse: true,
  scanProjects: true,
  discover: true,
  addProjects: true,
})

/**
 * Collect one request body.
 *
 * `res` owns the request lifecycle, so a body over the cap is answered here and
 * the socket is left alone otherwise; an erroring request rejects instead.
 * @param req - the incoming request.
 * @returns the decoded UTF-8 body.
 */
function readRequestBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > RPC_BODY_LIMIT_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
  })
}

/**
 * Dispatch one browser call onto the service.
 *
 * The envelope is `{ method, request }` and the answer is the method's own
 * return value verbatim — the same JSON documents the Remote wire used to
 * carry, so the page's rendering code is unchanged. Only `POST` is accepted,
 * so the endpoint can never be reached by a cross-site `GET` from a link or an
 * image; the Web carrier's own auth gate covers who may reach it at all.
 * @param service - the `offPeak` service instance.
 * @param req - the incoming request.
 * @param res - the response owning this request.
 * @returns a promise settling once the response is complete.
 */
async function handleRpc (service, req, res) {
  /** Answer one call with a JSON document. */
  const send = (status, payload) => {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
    res.end()
    return
  }

  let envelope
  try {
    envelope = JSON.parse(await readRequestBody(req))
  } catch {
    send(400, { ok: false, error: '无法解析请求内容。' })
    return
  }

  const method = typeof envelope?.method === 'string' ? envelope.method : ''
  if (RPC_METHODS[method] !== true || typeof service[method] !== 'function') {
    send(400, { ok: false, error: `未知接口：${method || '(空)'}` })
    return
  }

  try {
    send(200, await service[method](envelope?.request))
  } catch (error) {
    // The service reports its own failures as `{ ok: false, error }`; anything
    // thrown here is a bug, so it is logged with the host's logger rather than
    // hidden in the page.
    service.ctx?.logger?.warn?.(error)
    send(500, { ok: false, error: `错峰模式服务异常：${error instanceof Error ? error.message : String(error)}` })
  }
}

//#endregion

//#region plugin

/** Cordis plugin name used in diagnostics. */
const name = NAMESPACE

/**
 * Services this plugin wants. `workspaceRegistry` and `agents` are mandatory in
 * practice but left optional here so the plugin still activates (degraded) on a
 * composition without them. `webServer` is deliberately NOT listed: waiting on
 * the Web carrier would park the whole plugin as `pending` on a profile that has
 * none (headless, or a test harness), losing the scheduler and the tool as well
 * as the page. The bridge below injects it on its own instead, so the carrier
 * only gates the page's transport and nothing else.
 */
const inject = ['timer', 'tools', 'agents', 'workspaceRegistry', 'sessions']

/**
 * Install the 错峰模式 scheduler.
 * @param ctx - the plugin's Cordis context.
 * @param config - this plugin's validated settings section.
 * @returns nothing; every registration is owned by `ctx`'s fiber.
 */
function apply (ctx, config) {
  const storageHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const store = new ProjectStore(
    join(storageHome, 'storages', NAMESPACE, 'projects.json'),
    ctx.logger,
    { legacyPath: join(storageHome, 'storages', LEGACY_NAMESPACE, 'projects.json') },
  )
  const configStore = new ConfigStore(
    join(storageHome, 'storages', NAMESPACE, 'config.json'),
    ctx.logger,
    { legacyPath: join(storageHome, 'storages', LEGACY_NAMESPACE, 'config.json') },
  )

  /** Live state shared by the tick, the tool, and the service. */
  const live = {
    parked: [],
    appliedAt: 0,
    lastChecks: 0,
    lastError: '',
    stops: 0,
    resumed: 0,
    started: 0,
    lastAction: '',
    lastDiscover: null,
    lastDiscoverAt: 0,
    lastDiscoverKey: '',
  }

  /**
   * The authored config layer: what the profile patch actually wrote.
   *
   * `ctx.config` is a Harness accessor registered only for entries the Loader
   * could project a native Schemastery schema for; reading it on any other
   * entry throws `cannot get property "config" without inject`, which fails the
   * whole fiber. `ctx.fiber.config` is not a substitute either: Cordis runs the
   * entry config through this plugin's own schema before starting the fiber, so
   * it is always fully defaulted — reading a switch from it would shadow every
   * value the 错峰模式 page writes to its own store and the page would look
   * dead. `fiber._config` is the document the profile authored, and
   * `Fiber.update()` reassigns it whenever the settings editor writes a
   * volatile value, so it is the layer that wins over the store and nothing
   * else does.
   * @returns the authored config object, `{}` when the profile authored none.
   */
  function authoredConfig () {
    const carried = ctx.fiber !== undefined ? ctx.fiber._config : undefined
    if (carried === null || typeof carried !== 'object') return {}
    return carried
  }

  /**
   * Read one field out of a live config object.
   *
   * A volatile field is a `{ get() }` box rather than a plain value, so an
   * unwrap is what makes the switches readable no matter which schema shape
   * declared them.
   * @param source - a live config object.
   * @param field - field name.
   * @returns the plain value, or `undefined` when the field is absent.
   */
  function fieldOf (source, field) {
    const value = source?.[field]
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
    return value
  }

  function settings () {
    const authored = authoredConfig()
    const stored = configStore.all()
    const pick = (field) => {
      const value = fieldOf(authored, field)
      if (value !== undefined) return value
      if (stored[field] !== undefined) return stored[field]
      return CONFIG_FIELDS[field].fallback
    }
    const tick = Number(pick('tickSeconds'))
    return {
      enabled: pick('enabled') !== false,
      autoResume: pick('autoResume') !== false,
      autoStart: pick('autoStart') !== false,
      tickSeconds: Number.isFinite(tick) && tick >= 15 ? tick : 15,
    }
  }

  /**
   * The four switches, with the layer each value came from.
   * @returns a JSON document for the 错峰模式 page.
   */
  function configView () {
    const authored = authoredConfig()
    const stored = configStore.all()
    const source = (field) => (fieldOf(authored, field) !== undefined ? 'profile' : (stored[field] !== undefined ? 'page' : 'default'))
    const conf = settings()
    return {
      values: {
        enabled: conf.enabled,
        autoResume: conf.autoResume,
        autoStart: conf.autoStart,
        tickSeconds: conf.tickSeconds,
      },
      source: {
        enabled: source('enabled'),
        autoResume: source('autoResume'),
        autoStart: source('autoStart'),
        tickSeconds: source('tickSeconds'),
      },
      configPath: configStore.path,
      storePath: store.path,
    }
  }

  /**
   * Write one switch to the durable store the page owns.
   * @param field - switch name.
   * @param value - an already-normalized value.
   */
  function storeConfig (field, value) {
    configStore.set(field, value)
  }

  /**
   * Mirror one switch into this plugin's volatile Config.
   *
   * `settings` is not an injected service, so reading it as a property would
   * throw `cannot get property "settings" without inject` and take the fiber
   * down; it is resolved through the non-throwing `ctx.get` lookup instead.
   * Mapping the field name through the live schema is what satisfies the
   * "is this path volatile" check, so a renamed field can never silently write
   * to the wrong place. Failures are returned, never thrown: the durable store
   * already holds the value by the time this runs.
   * @param field - switch name.
   * @param value - an already-normalized value.
   * @returns `{ ok, reason? }` describing the mirror attempt.
   */
  async function mirrorConfig (field, value) {
    const settingsService = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (settingsService === undefined || settingsService === null || typeof settingsService.update !== 'function') {
      return { ok: false, reason: '当前配置不可写，已保存到插件自己的存储。' }
    }
    try {
      await settingsService.update(NAMESPACE, { [field]: value })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `${error?.message ?? error}` }
    }
  }

  /** @returns every registered Workspace. */
  function workspaces () {
    try {
      return ctx.workspaceRegistry?.list?.() ?? []
    } catch (error) {
      live.lastError = `无法读取工作区列表：${error?.message ?? error}`
      return []
    }
  }

  /**
   * Resolve one Workspace by registry id.
   * @param workspaceId - registry id.
   * @returns the Workspace entity, or `undefined`.
   */
  function workspaceOf (workspaceId) {
    return workspaces().find(workspace => `${workspace.id}` === `${workspaceId}`)
  }

  /**
   * Resolve one Workspace by directory path.
   *
   * The registry's own `resolveByPath` is preferred; the fallback covers
   * compositions (and test stubs) where it is absent.
   * @param path - absolute directory path.
   * @returns the Workspace entity, or `undefined`.
   */
  function workspaceAt (path) {
    try {
      const resolved = typeof ctx.workspaceRegistry?.resolveByPath === 'function' ? ctx.workspaceRegistry.resolveByPath(path) : undefined
      if (resolved !== undefined && resolved !== null) return resolved
    } catch (error) {
      live.lastError = `无法按路径解析工作区：${error?.message ?? error}`
    }
    return workspaces().find(workspace => typeof workspace.path === 'string' && samePath(workspace.path, path))
  }

  /**
   * The directory a scan starts from when the page sends none: the parent of the
   * first workspace, so the list the user already has guides discovery.
   * @param requested - the path the page sent, possibly empty.
   * @returns an absolute path.
   */
  function scanRoot (requested) {
    if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested.trim())
    const first = workspaces()[0]
    if (first !== undefined && typeof first.path === 'string' && first.path !== '') return parentOf(resolve(first.path))
    return homedir()
  }

  /** @returns a Map from path key to workspace id, for every registered Workspace. */
  function knownByPath () {
    const known = new Map()
    for (const workspace of workspaces()) {
      if (typeof workspace.path !== 'string' || workspace.path === '') continue
      known.set(pathKey(workspace.path), `${workspace.id}`)
    }
    return known
  }

  /**
   * One directory level plus the default root the page should show.
   * @param requested - directory path, possibly empty.
   * @returns the listing document.
   */
  function browse (requested) {
    return browseDirectory(scanRoot(requested))
  }

  /**
   * Scan a root for project directories and mark the ones already registered.
   * @param requested - root path, empty for the default.
   * @param options - `{ depth, limit }`.
   * @returns the scan result plus the listing and the per-candidate flags.
   */
  function scan (requested, options) {
    const root = scanRoot(requested)
    const listing = browseDirectory(root)
    const result = scanForProjects(root, options)
    const known = knownByPath()
    const records = store.all()
    return {
      ...result,
      root,
      parent: listing.parent,
      directories: listing.directories,
      candidates: result.candidates.map(candidate => {
        const workspaceId = known.get(pathKey(candidate.path)) ?? null
        return {
          ...candidate,
          workspaceId,
          known: workspaceId !== null,
          enabled: workspaceId !== null && records[workspaceId]?.enabled === true,
        }
      }),
    }
  }

  /**
   * Where the user's projects are, without being told.
   *
   * The walk is milliseconds on a normal machine and a few hundred on a deep
   * home directory, and the Settings page calls this on every mount. Results are
   * therefore memoized for `DISCOVER_TTL_MS`, so re-opening the page costs
   * nothing while a project added in between still shows up.
   * @param options - `{ roots, depth, limit, budgetMs, visitsPerRoot, force }`.
   * @returns `{ candidates, scanned, roots, errors, truncated, truncatedReason, cached }`.
   */
  function discover (options = {}) {
    const roots = discoveryRoots(options?.roots)
    const key = roots.join('|')
    const fresh = options?.force !== true && live.lastDiscover !== null && live.lastDiscoverKey === key && Date.now() - live.lastDiscoverAt < DISCOVER_TTL_MS
    if (fresh) return { ...live.lastDiscover, roots, cached: true }
    const result = discoverProjects({ ...options, roots })
    live.lastDiscover = result
    live.lastDiscoverAt = Date.now()
    live.lastDiscoverKey = key
    return { ...result, cached: false }
  }

  /**
   * The directories an automatic scan should look in, most relevant first.
   *
   * Two sources, no user input: the parent of every Workspace DSH already knows
   * (the user's projects almost always live beside each other), then the home
   * directory itself, whose immediate children are where `dev`/`code`/`Projects`
   * style folders live. Everything is deduplicated, and the list is capped so one
   * scan can never fan out over an unbounded number of roots.
   * @param extra - additional roots to prefer, in order.
   * @returns absolute directory paths.
   */
  function discoveryRoots (extra = []) {
    const found = []
    const seen = new Set()
    const home = homedir()
    const consider = (value) => {
      if (typeof value !== 'string' || value.trim() === '') return
      let resolved
      try {
        resolved = resolve(value.trim())
      } catch (error) {
        return
      }
      const key = pathKey(resolved)
      if (seen.has(key) === true) return
      seen.add(key)
      found.push(resolved)
    }
    for (const value of Array.isArray(extra) ? extra : []) consider(value)
    for (const workspace of workspaces()) {
      if (typeof workspace?.path === 'string' && workspace.path !== '') consider(parentOf(workspace.path))
    }
    consider(home)
    return found.slice(0, 6)
  }

  /**
   * Work out where the user's projects actually are, without asking.
   *
   * This is what makes the Settings page work on first sight: the page calls it
   * with no arguments and gets back every project directory it could find under
   * the roots `discoveryRoots` returns, already marked with the Workspace id and
   * the opt-in flag for the ones DSH knows. All roots share one wall-clock budget
   * and one candidate cap, so a huge home directory degrades into partial results
   * (`truncated` plus a reason) instead of hanging the Host RPC that renders the
   * page.
   * @param options - `{ roots, depth, limit, budgetMs, visitsPerRoot }`.
   * @returns `{ candidates, scanned, roots, errors, truncated, truncatedReason }`.
   */
  function discoverProjects (options = {}) {
    const roots = discoveryRoots(options.roots)
    const budgetMs = Number.isFinite(options.budgetMs) === true ? Math.min(Math.max(Math.floor(options.budgetMs), 100), 10_000) : DISCOVER_LIMITS.budgetMs
    const perRoot = Number.isFinite(options.visitsPerRoot) === true ? Math.min(Math.max(Math.floor(options.visitsPerRoot), 1), 5000) : DISCOVER_LIMITS.visitsPerRoot
    const deadline = Date.now() + budgetMs
    const known = knownByPath()
    const records = store.all()
    const candidates = []
    const seen = new Set()
    const errors = []
    const scannedRoots = []
    let scanned = 0
    let truncated = false
    let truncatedReason = ''
    for (const root of roots) {
      const left = deadline - Date.now()
      if (left <= 0) { truncated = true; truncatedReason = 'time'; break }
      scannedRoots.push(root)
      const result = scanForProjects(root, {
        depth: options.depth,
        limit: options.limit,
        maxVisits: perRoot,
        deadlineMs: left,
      })
      scanned += result.scanned
      for (const entry of result.errors) errors.push(entry)
      for (const candidate of result.candidates) {
        const key = pathKey(candidate.path)
        if (seen.has(key) === true) continue
        seen.add(key)
        const workspaceId = known.get(key) ?? null
        candidates.push({
          ...candidate,
          root,
          workspaceId,
          known: workspaceId !== null,
          enabled: workspaceId !== null && records[workspaceId]?.enabled === true,
        })
      }
      if (result.truncated === true) {
        truncated = true
        if (truncatedReason === '') truncatedReason = result.truncatedReason
      }
    }
    return {
      candidates,
      scanned,
      roots: scannedRoots,
      errors: errors.slice(0, 20),
      truncated,
      truncatedReason,
    }
  }

  /**
   * Register the selected directories as Workspaces and opt them into 错峰模式.
   * @param requested - array of absolute directory paths.
   * @returns `{ added, errors }`.
   */
  async function addProjects (requested) {
    const paths = Array.isArray(requested) ? requested : []
    const added = []
    const errors = []
    for (const raw of paths) {
      if (typeof raw !== 'string' || raw.trim() === '') { errors.push({ path: `${raw}`, reason: '路径为空。' }); continue }
      const target = resolve(raw.trim())
      try {
        if (statSync(target).isDirectory() !== true) { errors.push({ path: target, reason: '不是一个目录。' }); continue }
      } catch (error) {
        errors.push({ path: target, reason: `无法读取该目录：${error?.message ?? error}` })
        continue
      }
      try {
        let workspace = workspaceAt(target)
        if (workspace === undefined) {
          if (typeof ctx.workspaceRegistry?.create !== 'function') { errors.push({ path: target, reason: '当前 DSH 版本不支持从插件创建工作区。' }); continue }
          workspace = await ctx.workspaceRegistry.create(target)
        }
        if (workspace === undefined || workspace === null || workspace.id === undefined) { errors.push({ path: target, reason: '创建后没有返回工作区。' }); continue }
        const workspaceId = `${workspace.id}`
        const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : (basename(target) || target)
        store.set(workspaceId, { enabled: true, path: target, title, addedAt: Date.now() })
        added.push({ workspaceId, path: target, title })
      } catch (error) {
        errors.push({ path: target, reason: `${error?.message ?? error}` })
      }
    }
    if (added.length > 0) {
      live.lastAction = `读取项目：新增并开启 ${added.length} 个项目`
      tick()
    } else if (errors.length > 0) {
      live.lastAction = `读取项目失败：${errors[0].reason}`
    }
    return { added, errors }
  }

  /**
   * Classify one live session against the opt-in list.
   * @param sessionId - session id.
   * @returns `{ workspace, record, enabled }`, each possibly undefined.
   */
  function classifySession (sessionId) {
    for (const workspace of workspaces()) {
      const owned = workspace.sessionIds?.includes?.(sessionId) ?? false
      if (!owned) continue
      const record = store.get(`${workspace.id}`)
      return { workspace, record, enabled: record?.enabled === true }
    }
    return { workspace: undefined, record: undefined, enabled: false }
  }

  /**
   * Live Agent for a session id.
   * @param sessionId - session id.
   * @returns the Agent, or `undefined` when the session has no live fiber.
   */
  function agentOf (sessionId) {
    try {
      return ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Decide whether a parked message may start a turn at this instant.
   * @param sessionId - session id.
   * @returns a refusal reason, or `null` to allow.
   */
  function gate (sessionId) {
    const conf = settings()
    if (!conf.enabled) return null
    const { workspace, enabled } = classifySession(sessionId)
    if (workspace === undefined || !enabled) return null
    const now = classify()
    if (!now.peak) return null
    return `【错峰模式】当前为高峰时段（${stampLabel(now.stamp)}，计费为半价时段的 2 倍），项目「${workspace.title}」已开启错峰模式，本次执行已暂停。`
  }

  /**
   * Append one message to a session's inbox through the live Agent.
   * @param sessionId - target session id.
   * @param message - `createUserMessage` shaped message.
   * @param wake - whether the append should start a turn.
   * @returns `true` when the message was accepted.
   */
  function enqueue (sessionId, message, wake) {
    const agent = agentOf(sessionId)
    if (agent === undefined) return false
    try {
      if (wake && typeof agent.send === 'function') agent.send(message, 'next-turn', true)
      else if (typeof agent.followup === 'function') agent.followup(message)
      else if (typeof agent.send === 'function') agent.send(message, 'next-turn', false)
      else return false
      return true
    } catch (error) {
      live.lastError = `写入会话 ${sessionId} 失败：${error?.message ?? error}`
      return false
    }
  }

  /**
   * Park every queued message of a session that is being stopped.
   * @param sessionId - target session id.
   * @returns the parked records for that session.
   */
  function drainInbox (sessionId) {
    const agent = agentOf(sessionId)
    const box = agent?.inbox
    if (box === undefined) return []
    const records = []
    try {
      if (typeof box.take === 'function') {
        for (;;) {
          const next = box.take()
          if (next === undefined || next === null) break
          records.push(parkRecord(next, sessionId, records.length))
        }
      } else {
        const queued = [...(box.nextTurn ?? []), ...(box.nextStep ?? [])]
        for (const message of queued) records.push(parkRecord(message, sessionId, records.length))
        box.clear?.()
      }
    } catch (error) {
      live.lastError = `读取会话 ${sessionId} 的待处理消息失败：${error?.message ?? error}`
    }
    return records
  }

  /**
   * Stop a running session the way the user's own stop button does, keeping the
   * inbox so nothing the user typed is lost.
   * @param sessionId - target session id.
   * @returns `true` when a cancellation was issued.
   */
  function stopSession (sessionId) {
    const agent = agentOf(sessionId)
    if (agent === undefined || agent.status !== 'running') return false
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return true
    } catch (error) {
      live.lastError = `停止会话 ${sessionId} 失败：${error?.message ?? error}`
      return false
    }
  }

  /**
   * Choose the session to wake for a project that has nothing running.
   *
   * Prefers the project's most recent session; a stored `sessionId` wins only
   * while it still exists in the registry.
   * @param workspace - the Workspace entity.
   * @param record - its opt-in record.
   * @returns a session id, or `undefined` when the project has no history.
   */
  function pickSession (workspace, record) {
    const ids = [...(workspace.sessionIds ?? [])]
    if (ids.length === 0) return undefined
    if (typeof record?.sessionId === 'string' && ids.includes(record.sessionId)) return record.sessionId
    const newest = [...ids].reverse().find(id => ctx.sessions?.get?.(id) !== undefined)
    return newest ?? ids.at(-1)
  }

  /**
   * Resume one stopped session: replay its parked messages, or a generic
   * continuation when nothing was queued.
   * @param sessionId - target session id.
   * @param parked - the records captured when it was stopped.
   * @returns `true` when a wake message was accepted.
   */
  function resumeSession (sessionId, parked) {
    const agent = agentOf(sessionId)
    if (agent === undefined) return false
    if (agent.status === 'running') return false
    const message = resumeMessage(parked)
    if (!enqueue(sessionId, message, true)) return false
    live.resumed += 1
    return true
  }

  /**
   * Stop (or resume) every session belonging to an enabled project.
   * @param mode - `'auto'` follows the clock; `'stop'`/`'resume'` are manual.
   * @returns a summary of what happened.
   */
  function reconcile (mode = 'auto') {
    const conf = settings()
    const now = classify()
    const summary = { stopped: 0, resumed: 0, started: 0, at: stampLabel(now.stamp), phase: now.peak ? 'peak' : 'idle' }

    for (const workspace of workspaces()) {
      const workspaceId = `${workspace.id}`
      const record = store.get(workspaceId)
      // A project the user switched off is left untouched: whatever it does is
      // the user's own business, and anything parked for it stays parked.
      if (record?.enabled !== true || !conf.enabled) continue
      const shouldStop = mode === 'stop' || (mode === 'auto' && now.peak)
      const shouldRun = mode === 'resume' || (mode === 'auto' && !now.peak)
      let running = 0

      for (const sessionId of workspace.sessionIds ?? []) {
        const agent = agentOf(sessionId)
        if (agent === undefined) continue
        if (agent.status === 'running') {
          running += 1
          if (shouldStop) {
            live.parked.push(...drainInbox(sessionId))
            if (stopSession(sessionId)) {
              live.stops += 1
              summary.stopped += 1
              live.lastAction = `已停止「${workspace.title}」在 ${stampLabel()} 的执行`
            }
          }
        } else if (shouldRun) {
          const parked = live.parked.filter(entry => entry.sessionId === sessionId)
          if (parked.length === 0) continue
          live.parked = live.parked.filter(entry => entry.sessionId !== sessionId)
          if (resumeSession(sessionId, parked)) {
            summary.resumed += 1
            live.lastAction = `已继续「${workspace.title}」在 ${stampLabel()} 的执行`
          } else {
            live.parked.push(...parked)
          }
        }
      }

      // 自动开始：idle window, project opted in, nothing running anywhere in it.
      // Only sessions that already exist and already have a live Agent can be
      // woken; reviving a cold session is the Host's own resume path and is left
      // to the Session controller rather than duplicated here.
      if (shouldRun && conf.autoStart && running === 0) {
        const sessionId = pickSession(workspace, record)
        if (sessionId !== undefined && agentOf(sessionId) !== undefined) {
          const parked = live.parked.filter(entry => entry.sessionId === sessionId)
          live.parked = live.parked.filter(entry => entry.sessionId !== sessionId)
          if (resumeSession(sessionId, parked)) {
            summary.started += 1
            live.started += 1
            live.lastAction = `已在空闲时段自动开始「${workspace.title}」`
          } else {
            live.parked.push(...parked)
          }
        }
      }
    }

    live.appliedAt = Date.now()
    return summary
  }

  /** One enforcement pass. */
  function tick () {
    live.lastChecks += 1
    const conf = settings()
    if (!conf.enabled) {
      live.appliedAt = Date.now()
      return { stopped: 0, resumed: 0, started: 0, phase: classify().peak ? 'peak' : 'idle', at: stampLabel() }
    }
    try {
      return reconcile('auto')
    } catch (error) {
      live.lastError = `错峰模式执行出错：${error?.message ?? error}`
      ctx.logger?.warn?.(live.lastError)
      return { stopped: 0, resumed: 0, started: 0, phase: classify().peak ? 'peak' : 'idle', at: stampLabel() }
    }
  }

  /**
   * Project rows for the 错峰模式 page.
   *
   * Shaped for the Settings list, which renders registered and discovered
   * directories with the same row component: `hidden` marks a row the user has
   * opted out of, and `duplicateOf` marks one whose directory is already
   * registered under a second Workspace, so the page can show it as the
   * duplicate it is instead of offering to add it twice.
   * @returns one row per registered Workspace.
   */
  function projectRows () {
    const now = classify()
    const conf = settings()
    const records = store.all()
    const parkedBySession = new Map()
    for (const entry of live.parked) parkedBySession.set(entry.sessionId, (parkedBySession.get(entry.sessionId) ?? 0) + 1)
    const paths = workspaces()
      .filter(workspace => typeof workspace.path === 'string' && workspace.path !== '')
      .map(workspace => [pathKey(workspace.path), `${workspace.id}`])
    const byPath = new Map(paths)
    const rows = []
    for (const workspace of workspaces()) {
      const workspaceId = `${workspace.id}`
      const record = records[workspaceId] ?? store.get(workspaceId)
      const sessions = [...(workspace.sessionIds ?? [])]
      let running = 0
      let parked = 0
      for (const sessionId of sessions) {
        if (agentOf(sessionId)?.status === 'running') running += 1
        parked += parkedBySession.get(sessionId) ?? 0
      }
      const duplicateId = typeof workspace.path === 'string' && workspace.path !== ''
        ? (byPath.get(pathKey(workspace.path)) ?? workspaceId)
        : workspaceId
      rows.push({
        workspaceId,
        title: workspace.title,
        path: workspace.path,
        sessionCount: sessions.length,
        enabled: record?.enabled === true,
        hidden: record?.hidden === true,
        duplicateOf: duplicateId === workspaceId ? null : duplicateId,
        prompt: typeof record?.prompt === 'string' ? record.prompt : '',
        updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : null,
        running,
        parked,
        state: !conf.enabled || record?.enabled !== true
          ? 'off'
          : (now.peak ? (running > 0 ? 'stopping' : 'paused') : (running > 0 ? 'running' : 'waiting')),
      })
    }
    return rows
  }

  /**
   * Everything the 错峰模式 page and the status tool render.
   * @returns the status document.
   */
  function snapshot () {
    const now = classify()
    const conf = settings()
    const boundary = nextBoundary(now.stamp)
    return {
      enabled: conf.enabled,
      autoResume: conf.autoResume,
      autoStart: conf.autoStart,
      tickSeconds: conf.tickSeconds,
      phase: now.peak ? 'peak' : 'idle',
      phaseLabel: describeState(now),
      now: stampLabel(now.stamp),
      zone: ZONE,
      peakRule: '周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00',
      reason: now.holiday !== undefined
        ? `法定节假日 ${now.holiday[0]} ~ ${now.holiday[1]}`
        : (now.weekend ? '周末' : (now.peak ? '处于高峰时段' : '处于空闲时段')),
      nextBoundaryAt: stampLabel(boundary.stamp),
      nextBoundaryInMs: Math.max(boundary.stamp - now.stamp, 0),
      nextPhase: boundary.peak ? 'peak' : 'idle',
      projects: projectRows(),
      counters: { checks: live.lastChecks, stops: live.stops, resumed: live.resumed, started: live.started },
      lastAction: live.lastAction,
      lastError: live.lastError === '' ? null : live.lastError,
      storePath: store.path,
    }
  }

  const service = new OffPeakService(ctx)
  service.attach({
    snapshot,
    projectRows,
    workspaceOf,
    workspaces,
    store,
    tick,
    configView,
    storeConfig,
    mirrorConfig,
    force: mode => reconcile(mode === 'stop' ? 'stop' : 'resume'),
    browse,
    scan,
    discover,
    addProjects,
  })

  // Register `ctx.offPeak` and bind the same key as its Remote namespace. The
  // binding is kept for hosts that mount Typert Remote namespaces at build time;
  // it is NOT what the browser reaches, because a runtime-installed client bundle
  // has no mount table in the shipped Web bundle. See `handleRpc` for the carrier
  // the page actually uses. A plain object service has no Cordis base class to
  // provide itself, so both halves are explicit here; the disposer is what
  // unregisters the service when the fiber unloads.
  service.typertRemote = Object.freeze({
    service,
    serviceKey: NAMESPACE,
    namespace: NAMESPACE,
  })
  ctx.effect(() => {
    const dispose = typeof ctx.provide === 'function'
      ? ctx.provide(NAMESPACE, service)
      : ctx.reflect.provide(NAMESPACE, service)
    return typeof dispose === 'function' ? dispose : () => {}
  }, 'offPeak: service')

  // The Settings page's carrier: one same-origin JSON route on the Web server,
  // under a prefix this plugin already owns (`/plugins/dsh-off-peak/…`, the
  // client-bundle prefix). `ctx.inject` waits for the carrier instead of
  // requiring it, and the returned disposer is what unregisters the route with
  // the fiber this plugin owns, so the route can never outlive the service.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const carrier = webCtx.webServer
      if (carrier === undefined || typeof carrier.register !== 'function') return
      webCtx.effect(() => carrier.register({
        kind: 'exact',
        path: RPC_PATH,
        handler: (req, res) => handleRpc(service, req, res),
      }), 'offPeak: settings rpc route')
    })
  } else {
    ctx.logger?.warn?.('offPeak: ctx.inject is unavailable, the 错峰模式 page has no transport')
  }

  // The native configuration editor (and any profile patch applied at runtime)
  // can change the same four switches the page owns. Re-run the engine when the
  // settings document for this namespace is written, so a switch flipped in the
  // configuration editor takes effect on the next tick instead of at restart.
  ctx.on('settings/document-updated', (ns) => {
    if (ns !== NAMESPACE && `${ns}` !== NAMESPACE) return
    tick()
  })

  // Peak boundary sentinel: re-evaluate every 15 s, and additionally at the
  // exact second the window flips so peak never runs longer than one tick.
  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') return () => {}
    return ctx.interval(() => { tick() }, Math.max(15, settings().tickSeconds) * 1000)
  }, 'offPeak: enforcement tick')

  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') return () => {}
    return ctx.interval(() => {
      const boundary = nextBoundary()
      const wait = boundary.stamp - Date.now()
      if (wait <= 1000) tick()
    }, 1000)
  }, 'offPeak: boundary sentinel')

  // Refuse to start a turn inside a peak window for an enabled project. The
  // rejection also cancels the model call that proposed the step, so a session
  // that was somehow already running stops at the next step boundary.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || signal?.aborted) return decision
    const reason = gate(agent?.id)
    if (reason === null) return decision
    return { kind: 'reject', reason }
  })

  // A user message arriving during peak inside an enabled project is parked
  // rather than executed.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind === PLUGIN_SOURCE) return
    const reason = gate(agent?.id)
    if (reason === null) return
    if (agent?.status !== 'running') return
    drainInbox(agent.id)
    stopSession(agent.id)
    enqueue(agent.id, { content: [{ type: 'text', text: reason }], source: { kind: PLUGIN_SOURCE, form: 'offpeak-notice' } }, false)
  })

  if (ctx.tools?.register !== undefined) {
    ctx.effect(() => ctx.tools.register({
      name: 'offPeak_status',
      description: '错峰模式 (Off-Peak Mode) status: whether the current Beijing-time instant is peak (full price) or idle (half price), when the next window boundary is, which workspaces have 错峰模式 enabled, and which sessions are running, stopped, or parked awaiting an idle window.',
      // `ctx.tools.register()` stores `parameters` verbatim and the model
      // request is assembled as `input_schema: tool.parameters`
      // (dsh-llm-deepseek/lib/index.js:1715), so this must already be raw JSON
      // Schema: the property-map shorthand is only compiled by defineTool().
      // An empty `{}` reaches the provider as `type: null` and the whole
      // request fails with INVALID_REQUEST.
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // The Harness tool contract requires a declared output shape plus the
      // renderer that turns the returned value into content blocks; a bare
      // `{ content }` return is rejected by ctx.tools.register(). The schema
      // must stay inside the supported JSON-Schema subset, where `required`
      // is an ARRAY of names allowed on an object node only.
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: '错峰模式 status report: current window, next boundary, switches and per-workspace state.',
            },
          },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute () {
        const status = snapshot()
        const rows = status.projects.map(row => `- ${row.enabled ? '[错峰模式]' : '[ 关闭 ]'} ${row.title} — ${row.state}${row.parked > 0 ? ` (${row.parked} 条消息已暂存)` : ''}\n  ${row.path}`)
        const text = [
          `当前：${status.phaseLabel}（${status.now}）`,
          `判定：${status.reason}；下一个切换点 ${status.nextBoundaryAt} → ${status.nextPhase === 'peak' ? '高峰' : '空闲'}`,
          `高峰规则：${status.peakRule}`,
          `总开关：${status.enabled ? '开启' : '关闭'}；自动继续：${status.autoResume ? '开启' : '关闭'}；自动开始：${status.autoStart ? '开启' : '关闭'}`,
          `项目（共 ${status.projects.length} 个）：`,
          ...(rows.length > 0 ? rows : ['- （尚无工作区）']),
          status.lastAction === '' ? '最近动作：无' : `最近动作：${status.lastAction}`,
          status.lastError === null ? '最近错误：无' : `最近错误：${status.lastError}`,
        ].join('\n')
        return { text }
      },
    }), 'offPeak: status tool')
  }

  tick()
}

// The clock helpers are exported for `tools/selftest.mjs`; the Loader only ever
// reads `apply`, `inject`, `name` and `Config` from a plugin module.
export {
  Config,
  apply,
  inject,
  name,
  classify,
  beijingDate,
  HOLIDAYS,
  PEAK_WINDOWS,
  ZONE,
  browseDirectory,
  markerLabels,
  samePath,
  scanForProjects,
}

//#endregion
