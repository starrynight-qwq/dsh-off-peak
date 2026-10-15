#!/usr/bin/env node
/**
 * Headless smoke test for the client half (lib/client.js).
 *
 * No browser runs in this repo, so the 错峰模式 Settings page is executed here
 * against a hand-written module loader, a miniature React (createElement +
 * useState + useEffect) and a recording `ctx`. It proves the three things the
 * host-side suites cannot: the bundle registers itself under the right slot,
 * the page renders from the real Remote payload shapes, and every control sends
 * the request object the Host service expects.
 *
 *   node tools/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let checks = 0
const failures = []
const ok = (label) => { checks += 1; console.log(`ok   ${label}`) }
const bad = (label, detail) => {
  checks += 1
  failures.push(label)
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (label, actual, expected) => {
  if (actual === expected) ok(label)
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const truthy = (label, actual) => { if (actual) ok(label); else bad(label, 'falsy') }
const textOf = (values, needle) => values.some(value => value.includes(needle))
/** Find the host element of the latest render whose children carry this text. */
const findButton = (label) => elements.find(node => node.type === 'button' && node.children.flat(3).includes(label)) ?? null

/* ── miniature React ─────────────────────────────────────────────────────── */

const frames = new Map()
const elements = []
const stack = []
let dirty = false
const cleanups = []

const react = {
  createElement (type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState (init) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) throw new Error('useState called outside a component')
    const index = frame.index++
    if (frame.values.length <= index) frame.values[index] = typeof init === 'function' ? init() : init
    const set = (next) => {
      const value = typeof next === 'function' ? next(frame.values[index]) : next
      if (Object.is(value, frame.values[index]) === false) {
        frame.values[index] = value
        dirty = true
      }
    }
    return [frame.values[index], set]
  },
  useEffect (fn) {
    const frame = stack[stack.length - 1]
    if (frame !== undefined) frame.effects.push(fn)
  },
}

const frameFor = (path) => {
  let frame = frames.get(path)
  if (frame === undefined) {
    frame = { index: 0, values: [], effects: [], ran: false }
    frames.set(path, frame)
  }
  return frame
}

/** Render one element tree the way a real renderer would: call components. */
const walk = (node, path, out) => {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  if (typeof node.type === 'function') {
    const frame = frameFor(path)
    frame.index = 0
    stack.push(frame)
    let child
    try {
      child = node.type({ ...node.props, children: node.children.length > 1 ? node.children : node.children[0] })
    } finally {
      stack.pop()
    }
    walk(child, `${path}/c`, out)
    return
  }
  node.children.forEach((child, index) => walk(child, `${path}/${index}`, out))
  if (node.props.children !== undefined) walk(node.props.children, `${path}/p`, out)
  elements.push(node)
}

/** Render, then flush the effects each mounted component requested. */
const render = (tree) => {
  let out = []
  for (let pass = 0; pass < 6; pass += 1) {
    dirty = false
    out = []
    elements.length = 0
    walk(tree, 'root', out)
    for (const frame of frames.values()) {
      if (frame.ran) continue
      frame.ran = true
      for (const fn of frame.effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    }
    if (dirty === false) break
  }
  return out
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/* ── the module loader facade the web shell injects ──────────────────────── */

let captured = null
const fakeWindow = { __ModuleLoader__: { load (definition) { captured = definition } } }
const intervals = new Map()
const cleared = []
let nextInterval = 1
const fakeSetInterval = (fn, ms) => { const id = nextInterval++; intervals.set(id, { fn, ms }); return id }
const fakeClearInterval = (id) => { cleared.push(id); intervals.delete(id) }

// A minimal document, exactly enough for the module-scope CSS injection DSH
// expects every client plugin to perform: create a <style>, tag it, append it.
const styleTags = []
const fakeDocument = {
  createElement (type) {
    const tag = { type, dataset: {}, textContent: '' }
    if (type === 'style') styleTags.push(tag)
    return tag
  },
  querySelector (selector) {
    const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
    if (match === null) return null
    return styleTags.find(tag => tag.dataset.pluginCss === match[1]) ?? null
  },
  head: { appendChild (tag) { tag.attached = true } },
}
globalThis.document = fakeDocument

new Function('window', 'setInterval', 'clearInterval', source)(fakeWindow, fakeSetInterval, fakeClearInterval)
delete globalThis.document

truthy('the bundle calls window.__ModuleLoader__.load', captured !== null)
eq('the bundle declares id "dsh-off-peak"', captured?.id, 'dsh-off-peak')
truthy('the bundle ships a factory', typeof captured?.factory === 'function')

let plugin = null
try {
  plugin = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  ok('the factory runs with only "react" required')
} catch (error) {
  bad('the factory runs with only "react" required', error?.message)
}
eq('the plugin injects exactly slots + locale', JSON.stringify(plugin?.inject), JSON.stringify(['slots', 'locale']))
truthy('the plugin exposes apply', typeof plugin?.apply === 'function')

/* ── a recording client context with the real Remote payload shapes ──────── */

const rows = [
  { workspaceId: 'ws-1', title: 'sample-project', path: 'E:\\demo-root\\sample-project', sessionCount: 3, enabled: true, prompt: '', updatedAt: 0, running: true, parked: 2, state: 'running' },
  { workspaceId: 'ws-2', title: 'scratch-notes', path: 'E:\\demo-root\\scratch-notes', sessionCount: 1, enabled: false, prompt: '', updatedAt: 0, running: false, parked: 0, state: 'off' },
]
const status = {
  ok: true,
  now: '2026-10-17 10:00:00 (周六)',
  phase: 'idle',
  enabled: true,
  autoResume: true,
  autoStart: true,
  tickSeconds: 15,
  nextBoundaryInMs: 7200000,
  nextPhase: 'peak',
  nextBoundaryAt: '2026-10-19 09:00:00 (周一)',
  lastAction: '',
  lastError: null,
  running: 1,
  parked: 2,
  stops: 1,
  resumed: 2,
  started: 1,
  storePath: 'C:\\Users\\tester\\.dsh\\storages\\offPeak\\projects.json',
}
const config = {
  ok: true,
  values: { enabled: true, autoResume: true, autoStart: false, tickSeconds: 30 },
  source: { enabled: 'profile', autoResume: 'page', autoStart: 'default', tickSeconds: 'page' },
  configPath: 'C:\\Users\\tester\\.dsh\\storages\\offPeak\\config.json',
}

const calls = []
const dictionaries = {}
const injected = []
const effects = []
const record = (method, reply) => (request) => { calls.push({ method, request }); return reply }
let discoverReply = {
  ok: true,
  roots: ['E:\\demo-root', 'C:\\Users\\tester'],
  candidates: [
    { path: 'E:\\demo-root\\gamma', title: 'gamma', markers: ['Go'], depth: 1, root: 'E:\\demo-root', workspaceId: null, known: false, enabled: false },
    { path: 'E:\\demo-root\\sample-project', title: 'sample-project', markers: ['Node'], depth: 1, root: 'E:\\demo-root', workspaceId: 'ws-1', known: true, enabled: true },
  ],
  errors: [],
  scanned: 12,
  truncated: false,
  truncatedReason: '',
  cached: false,
}
const remote = {
  ping: record('ping', { ok: true }),
  status: record('status', status),
  projects: record('projects', { ok: true, projects: rows }),
  getConfig: record('getConfig', config),
  setConfig: record('setConfig', { ok: true, ...config }),
  setProject: record('setProject', { ok: true, projects: rows }),
  setAll: record('setAll', { ok: true, projects: rows }),
  forgetProject: record('forgetProject', { ok: true, projects: rows }),
  force: record('force', { ok: true }),
  browse: record('browse', {
    ok: true,
    path: 'E:\\demo-root',
    name: 'demo-root',
    parent: 'E:\\',
    directories: [{ name: 'gamma', path: 'E:\\demo-root\\gamma' }],
    files: 4,
    truncated: false,
  }),
  scanProjects: record('scanProjects', {
    ok: true,
    root: 'E:\\demo-root',
    parent: 'E:\\',
    directories: [{ name: 'gamma', path: 'E:\\demo-root\\gamma' }],
    candidates: [{ path: 'E:\\demo-root\\gamma', title: 'gamma', markers: ['Go'], depth: 1, workspaceId: null, known: false }],
    errors: [],
    scanned: 2,
    truncated: false,
  }),
  discover: (request) => { calls.push({ method: 'discover', request }); return discoverReply },
  addProjects: record('addProjects', {
    ok: true,
    added: [{ workspaceId: 'ws-3', path: 'E:\\demo-root\\gamma', title: 'gamma' }],
    errors: [],
    projects: rows,
  }),
}
/* ── the HTTP bridge the Host half registers on the Web carrier ──────────── */

// The page talks to the Host over `POST /plugins/offPeak/rpc`, so replace the
// global `fetch` with one that dispatches the same `{ method, request }`
// envelope straight onto the service stub — the exact path a real browser takes,
// minus the socket. A method the stub does not know is a 400, like the real
// route; an unknown URL is a 404, which is what the page reports as "Host half
// exposes no page channel".
const RPC_URL = '/plugins/offPeak/rpc'
let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetchCalls += 1
  if (url !== RPC_URL) return new Response('not found', { status: 404 })
  const envelope = JSON.parse(String(init?.body ?? '{}'))
  const handler = remote[envelope.method]
  if (typeof handler !== 'function') {
    return new Response(JSON.stringify({ ok: false, error: `未知接口：${envelope.method}` }), { status: 400 })
  }
  return new Response(JSON.stringify(handler(envelope.request) ?? null), { status: 200 })
}

let registration = null
// Flipped mid-run to prove the page really reads the active locale instead of
// hard-coding one language's copy into the render.
let locale = 'zh'
const ctx = {
  slots: {
    inject (name, register) { injected.push(name); return register() },
    register (spec, Component) {
      injected.push(spec.id)
      registration = { spec, Component }
      return { spec, Component, dispose () {} }
    },
  },
  locale: {
    bind: (ns) => (key) => dictionaries[ns]?.[locale]?.[key] ?? key,
    register (ns, value) { dictionaries[ns] = value; return () => {} },
  },
  effect (fn, label) { effects.push({ label, dispose: fn() }); return () => {} },
}

let applyError = null
globalThis.document = fakeDocument
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
} finally {
  delete globalThis.document
}
truthy('apply runs without throwing', applyError === null)
if (applyError !== null) bad('apply error detail', applyError?.stack ?? String(applyError))

/* ── the stylesheet really reaches the document ──────────────────────────── */

eq('apply() injects the stylesheet exactly once', styleTags.length, 1)
truthy('the <style> tag is tagged so the loader removes it on unload', styleTags[0]?.dataset.plugin === 'offPeak' && typeof styleTags[0]?.dataset.pluginCss === 'string')
truthy('the tag is actually attached to <head>', styleTags[0]?.attached === true)
truthy('the stylesheet carries the real page rules', String(styleTags[0]?.textContent).includes('.offpeak-row{') && String(styleTags[0]?.textContent).includes('--dsw-alias-label-primary'))
truthy('the injected rules are the sidebar metrics DSH uses', String(styleTags[0]?.textContent).includes('height:34px') && String(styleTags[0]?.textContent).includes('var(--dsw-radius-md)'))

eq('the page is injected into settings.section', injected[0], 'settings.section')
eq('the registration id is the plugin namespace', injected[1], 'offPeak')
eq('the dictionaries are registered for zh and en', Object.keys(dictionaries).join(','), 'offPeak')
eq('the dictionary carries both languages', Object.keys(dictionaries.offPeak ?? {}).join(','), 'zh,en')

/* ── render the page the slot will render ────────────────────────────────── */

const component = registration?.Component
const props = registration?.spec?.inject?.()
truthy('the registration supplies a component', typeof component === 'function')
truthy('the registration supplies the slot payload', typeof props === 'object' && props !== null)
eq('the slot payload exposes every control', Object.keys(props ?? {}).join(','), 'useStatus,useProjects,useConfig,useT,refresh,setConfig,setProject,setAll,force,browse,scan,add,discover,open')

await props.refresh().then(() => ok('refresh() resolves through the bridge')).catch(error => bad('refresh() resolves through the bridge', error?.message))
eq('refresh() posts three envelopes over /plugins/offPeak/rpc', fetchCalls >= 3 ? 'posted' : `only ${fetchCalls}`, 'posted')
eq('refresh() reads status, projects and getConfig', calls.slice(0, 3).map(call => call.method).join(','), 'status,projects,getConfig')

const values = render(react.createElement(component, { ...props }))
const zh = dictionaries.offPeak.zh
const en = dictionaries.offPeak.en
// `(?<![\w$])` keeps method names out of the scan: `document.createElement('style')`
// ends in a `t(` and would otherwise be read as a translation key.
const keys = [...new Set([...source.matchAll(/(?<![\w$])t\('([A-Za-z]+)'\)/g)].map(match => match[1]))]
const missing = keys.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string')
eq('every t(key) the page uses exists in zh and en', missing.join(','), '')
truthy(`the page translates ${keys.length} distinct labels`, keys.length >= 10)
truthy('the rendered page names every workspace', textOf(values, 'sample-project') && textOf(values, 'scratch-notes'))

// The project rows mirror DSH's sidebar list, and each row is ONE keyboard
// reachable switch rather than a div with a click handler.
const rowSwitches = elements.filter(node => node.type === 'button' && node.props?.role === 'switch')
truthy('every project row and setting is a real switch button', rowSwitches.length >= 6)
truthy('a switch carries its state and its name for assistive tech', rowSwitches.every(node => typeof node.props['aria-checked'] === 'string' && typeof node.props['aria-label'] === 'string'))
truthy('the rendered page shows live parked work', textOf(values, `2 ${zh.parked}`))
truthy('the rendered page shows the configured tick', textOf(values, '30s'))
truthy('the rendered page labels the current window', textOf(values, zh.idle) || textOf(values, zh.peak))
truthy('idle polling is scheduled every 5s', [...intervals.values()].some(entry => entry.ms === 5000) || cleared.length > 0)

/* ── the copy follows the active locale, punctuation included ────────────── */

locale = 'en'
const english = render(react.createElement(component, { ...props }))
locale = 'zh'
truthy('the countdown counts in the locale’s own units', textOf(english, '2h 0m') && textOf(english, '小时') === false)
truthy('label/value joins use the locale’s own punctuation', textOf(english, 'Next boundary: ') && textOf(english, '：') === false)
eq('the separator is localized', `${zh.sep}|${en.sep}`, '：|: ')

/* ── the wire shapes of every control ────────────────────────────────────── */

await props.setProject('ws-1', true)
eq('setProject sends { workspaceId, enabled }', JSON.stringify(calls.filter(call => call.method === 'setProject').at(-1)?.request), JSON.stringify({ workspaceId: 'ws-1', enabled: true }))
await props.setAll(false)
eq('setAll sends { enabled }', JSON.stringify(calls.filter(call => call.method === 'setAll').at(-1)?.request), JSON.stringify({ enabled: false }))
await props.force('stop')
eq('force sends { action }', JSON.stringify(calls.filter(call => call.method === 'force').at(-1)?.request), JSON.stringify({ action: 'stop' }))
await props.setConfig('autoStart', true)
eq('setConfig sends { field, value }', JSON.stringify(calls.filter(call => call.method === 'setConfig').at(-1)?.request), JSON.stringify({ field: 'autoStart', value: true }))

/* ── the 读取项目 card scans by itself, then adds what is ticked ─────────── */

const first = render(react.createElement(component, { ...props }))
truthy('the page renders the 读取项目 card', textOf(first, zh.discover))
truthy('the card explains that nothing has to be typed', textOf(first, zh.discoverHint))

// The scan starts on its own when the page mounts — before any click, and
// without a path from the user.
eq('the card scans as soon as the page mounts, with no path to type', calls.filter(call => call.method === 'discover').length, 1)
eq('the automatic scan asks the Host for nothing but the scan itself', calls.find(call => call.method === 'discover')?.request, undefined)
const secondText = render(react.createElement(component, { ...props }))
truthy('the automatic scan lists the project it found', textOf(secondText, 'gamma'))
truthy('the automatic scan tags the ecosystem marker it detected', textOf(secondText, 'Go'))
truthy('the automatic scan reports how many directories it walked', textOf(secondText, `${zh.discoverScanned} 12`))
truthy('a project DSH already knows is shown as already added', textOf(secondText, zh.alreadyAdded))

const addButton = findButton(`${zh.addSelected} (1)`)
truthy('the found project arrives pre-selected for adding', addButton !== null)
addButton?.props?.onClick?.()
await settle()
await settle()

eq('clicking 加入并开启错峰模式 posts { paths } with the ticked directory', JSON.stringify(calls.filter(call => call.method === 'addProjects').at(-1)?.request), JSON.stringify({ paths: ['E:\\demo-root\\gamma'] }))
truthy('the card reports the added count', textOf(render(react.createElement(component, { ...props })), `${zh.addedCount} 1`))

const scanButton = findButton(zh.rescan)
truthy('the card offers a manual re-scan', scanButton !== null)
scanButton?.props?.onClick?.()
await settle()
await settle()
eq('the re-scan asks the Host again', calls.filter(call => call.method === 'discover').length, 2)

// A returning user: everything the scan finds is already in the list below, so
// the card says so in one line instead of repeating rows that are already there.
discoverReply = {
  ...discoverReply,
  candidates: [discoverReply.candidates[1]],
  scanned: 9,
}
findButton(zh.rescan)?.props?.onClick?.()
await settle()
await settle()
const settled = render(react.createElement(component, { ...props }))
truthy('a scan that finds nothing new says so', textOf(settled, zh.discoverNone))
eq('and does not repeat the already-listed row (its marker tag is gone)', textOf(settled, 'Node'), false)
eq('the card reports the count it did find', textOf(settled, `${zh.found} · 0 · 1 ${zh.alreadyAdded}`), true)
truthy('nothing stays ticked when there is nothing to add', findButton(`${zh.addSelected} (0)`) !== null)

await props.browse('E:\\demo-root')
eq('browse sends { path }', JSON.stringify(calls.filter(call => call.method === 'browse').at(-1)?.request), JSON.stringify({ path: 'E:\\demo-root' }))
await props.scan('E:\\demo-root')
eq('scan sends { root }', JSON.stringify(calls.filter(call => call.method === 'scanProjects').at(-1)?.request), JSON.stringify({ root: 'E:\\demo-root' }))

/* ── teardown ────────────────────────────────────────────────────────────── */

for (const dispose of cleanups) dispose()
for (const effect of effects) if (typeof effect.dispose === 'function') effect.dispose()
globalThis.fetch = realFetch
truthy('the poller is cleared on teardown', cleared.length > 0)

console.log(`\n${checks - failures.length}/${checks} client checks passed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(' | ')}`)
  process.exit(1)
}
process.exit(0)
