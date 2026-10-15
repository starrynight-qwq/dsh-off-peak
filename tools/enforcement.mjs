/**
 * End-to-end enforcement test for the host half.
 *
 * `tools/selftest.mjs` proves the calendar arithmetic and `tools/harness.mjs`
 * proves the service wire. This file proves the promise the plugin is sold on:
 * a project with 错峰模式 enabled is stopped inside a peak window and started
 * again in an idle window, with no user interaction at all.
 *
 * The clock is stubbed before the plugin is imported, so the test does not care
 * what time it is when it runs: peak is a Tuesday 10:00 Beijing and idle is the
 * following Saturday 10:00 Beijing. Everything else is real (a Cordis root from
 * the installed runtime, the plugin's own timers, its own enforcement pass).
 *
 * Run: `node tools/enforcement.mjs` from the plugin directory.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = dirname(here)

const RUNTIME_ROOTS = [
  join(pluginRoot, '_dsh_src', 'node_modules'),
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules'),
]

const runtimeRoot = RUNTIME_ROOTS.find(root => existsSync(join(root, '@deepseek-ai', 'cordis', 'lib', 'index.js')))
if (runtimeRoot === undefined) {
  console.error('enforcement: no Cordis runtime found. Looked in:')
  for (const root of RUNTIME_ROOTS) console.error(`  - ${root}`)
  process.exit(2)
}

//#region the stubbed Beijing clock

/** 2026-10-13 is a Tuesday: 10:00 Beijing is inside 09:00-12:00 → peak. */
const PEAK_STAMP = Date.UTC(2026, 9, 13, 2, 0, 0)
/** 2026-10-17 is a Saturday: any hour is idle. */
const IDLE_STAMP = Date.UTC(2026, 9, 17, 2, 0, 0)

const realNow = Date.now
let fakeNow = PEAK_STAMP
Date.now = () => fakeNow

//#endregion

const load = specifier => import(pathToFileURL(join(runtimeRoot, ...specifier.split('/'))).href)
const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const TimerService = (await load('@deepseek-ai/cordis-plugin-timer/lib/index.js')).default

process.env.DSH_HOME = join(pluginRoot, '_enforcement_home')

let passed = 0
const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Poll a predicate until it holds, so the check states a fact, not a race. */
const until = async (predicate, timeoutMs) => {
  const deadline = realNow() + timeoutMs
  while (realNow() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

//#region a composition with two projects and two live sessions

const root = new Context()
root.plugin(TimerService)

const cancelled = []
const sent = []
const agents = new Map()
const makeAgent = (id, status, queued = []) => ({
  id,
  status,
  inbox: {
    queue: [...queued],
    take () {
      return this.queue.shift()
    },
  },
  cancel () {
    cancelled.push(id)
    this.status = 'idle'
    return true
  },
  send (message, mode, wake) {
    sent.push({ id, mode, wake, text: message?.content?.[0]?.text ?? '' })
    this.status = 'running'
    return true
  },
})
// ws-1: running with two messages the user typed before peak closed in.
agents.set('s-1', makeAgent('s-1', 'running', [
  { id: 'm1', content: [{ type: 'text', text: '请继续实现登录页' }] },
  { id: 'm2', content: [{ type: 'text', text: '顺手补一个单元测试' }] },
]))
// ws-2: running, but its project is never opted in.
agents.set('s-2', makeAgent('s-2', 'running'))
// ws-3: idle, opted in, so the idle window has to start it from cold.
agents.set('s-3', makeAgent('s-3', 'idle'))

const workspace = (id, sessionIds) => ({
  id,
  path: join(pluginRoot, `sample-${id}`),
  title: `sample-${id}`,
  createdAt: PEAK_STAMP,
  updatedAt: PEAK_STAMP,
  sessionIds,
  status: () => ({ kind: 'idle' }),
})

const workspaces = [workspace('ws-1', ['s-1']), workspace('ws-2', ['s-2']), workspace('ws-3', ['s-3'])]

const provide = (name, value) => root.plugin({ name: `stub-${name}`, apply (ctx) { ctx.provide(name, value) } })

provide('tools', { register: () => () => {} })
provide('agents', { list: () => [...agents.values()], get: id => agents.get(`${id}`) })
provide('workspaceRegistry', {
  list: () => workspaces,
  get: id => workspaces.find(entry => `${entry.id}` === `${id}`),
})
provide('sessions', {
  list: () => [...agents.keys()].map(id => ({ id })),
  get: id => (agents.has(`${id}`) ? { id: `${id}` } : undefined),
  create: async () => undefined,
  flush: async () => {},
})
provide('sessionProjections', { stop: async () => {} })

//#endregion

const plugin = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
const fiber = root.plugin(plugin, { tickSeconds: 15 })

await sleep(300)
check('the fiber is ACTIVE under a stubbed peak clock', fiber.state === 2, fiber._error?.message)
const service = root.get('offPeak')
check('the service is reachable', service !== undefined && service !== null)

//#region peak: the enabled project is stopped on its own

const optedIn = service.setProject({ workspaceId: 'ws-1', enabled: true })
service.setProject({ workspaceId: 'ws-3', enabled: true })
check('错峰模式 is enabled per project, not globally', optedIn.ok === true && optedIn.projects.find(row => row.workspaceId === 'ws-1').enabled === true && optedIn.projects.find(row => row.workspaceId === 'ws-2').enabled === false)

const stoppedInPeak = await until(() => cancelled.includes('s-1'), 20000)
check('peak auto-stops the running session of the enabled project', stoppedInPeak && agents.get('s-1').status === 'idle')
check('peak leaves the project that is switched off alone', cancelled.includes('s-2') === false && agents.get('s-2').status === 'running')

const peakStatus = service.status()
const peakRow = service.projects().projects.find(row => row.workspaceId === 'ws-1')
check('status() reports peak and parks both queued messages', peakStatus.phase === 'peak' && peakStatus.counters.stops >= 1 && peakRow.parked === 2, { counters: peakStatus.counters, parked: peakRow.parked })
check('status() keeps the project rows off the wire', peakStatus.projects === undefined)

check('peak refuses a model step for the enabled project', (await root.waterfall('agent/pre-step', { agent: { id: 's-1' }, signal: { aborted: false } }, () => ({ kind: 'continue' }))).kind === 'reject')
check('peak allows a model step for the project that is switched off', (await root.waterfall('agent/pre-step', { agent: { id: 's-2' }, signal: { aborted: false } }, () => ({ kind: 'continue' }))).kind === 'continue')

//#endregion

//#region idle: the same project is started again, with its message replayed

fakeNow = IDLE_STAMP

const resumedInIdle = await until(() => sent.some(entry => entry.id === 's-1' && entry.wake === true), 20000)
check('idle auto-starts the stopped session again', resumedInIdle && agents.get('s-1').status === 'running', sent)
const replay = sent.find(entry => entry.id === 's-1' && entry.text.includes('<offpeak-resume>'))
check('idle replays the two messages queued during peak', replay !== undefined && replay.text.includes('请继续实现登录页') && replay.text.includes('顺手补一个单元测试'), replay?.text?.slice(0, 200))

const startedCold = sent.find(entry => entry.id === 's-3' && entry.wake === true)
check('idle starts a project that had nothing running', startedCold !== undefined && startedCold.text.includes('请从上次中断处继续未完成的工作'), startedCold?.text?.slice(0, 160))

const idleStatus = service.status()
check('status() counts the replay as a resume and the cold project as a start', idleStatus.phase === 'idle' && idleStatus.counters.resumed >= 1 && idleStatus.counters.started >= 1, idleStatus.counters)
check('no message stays parked once the idle window opened', service.projects().projects.every(row => row.parked === 0), service.projects().projects)
check('idle allows a model step for the enabled project', (await root.waterfall('agent/pre-step', { agent: { id: 's-1' }, signal: { aborted: false } }, () => ({ kind: 'continue' }))).kind === 'continue')
check('the switched-off project is never sent a wake message', sent.some(entry => entry.id === 's-2') === false)

//#endregion

//#region teardown

await fiber.dispose()
await sleep(100)
check('disposing the fiber stops the enforcement timers', root.get('offPeak') === undefined)

//#endregion

Date.now = realNow

console.log(`\n${passed}/${passed + failures.length} enforcement checks passed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
process.exit(0)
