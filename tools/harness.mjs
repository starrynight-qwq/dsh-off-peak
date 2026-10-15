/**
 * Integration harness for the host half.
 *
 * `tools/selftest.mjs` checks pure logic by importing the module directly. This
 * harness goes one level further: it boots a real Cordis root from the runtime
 * that is installed for the desktop profile, hands the plugin the same five
 * services the Harness hands it, and then exercises the registered service, the
 * status tool, and the enforcement tick.
 *
 * Run: `node tools/harness.mjs` from the plugin directory.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = dirname(here)

/** Where a Cordis runtime can be found: the extracted one first, the profile second. */
const RUNTIME_ROOTS = [
  join(pluginRoot, '_dsh_src', 'node_modules'),
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules'),
]

const runtimeRoot = RUNTIME_ROOTS.find(root => existsSync(join(root, '@deepseek-ai', 'cordis', 'lib', 'index.js')))
if (runtimeRoot === undefined) {
  console.error('harness: no Cordis runtime found. Looked in:')
  for (const root of RUNTIME_ROOTS) console.error(`  - ${root}`)
  process.exit(2)
}

const load = specifier => import(pathToFileURL(join(runtimeRoot, ...specifier.split('/'))).href)

const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const TimerService = (await load('@deepseek-ai/cordis-plugin-timer/lib/index.js')).default

process.env.DSH_HOME = join(pluginRoot, '_harness_home')

// ---- pre-rename data (rename migration check) -------------------------------
//
// This plugin was published as `dsh-sparetime` and stored its state under
// `storages/sparetime/`. Boot with that directory as the ONLY source of state so
// the checks below can prove the new code adopts it instead of starting empty.
const harnessHome = process.env.DSH_HOME
rmSync(harnessHome, { recursive: true, force: true })
mkdirSync(join(harnessHome, 'storages', 'sparetime'), { recursive: true })
writeFileSync(join(harnessHome, 'storages', 'sparetime', 'config.json'), JSON.stringify({
  version: 1,
  values: { autoStart: true },
}), 'utf8')
writeFileSync(join(harnessHome, 'storages', 'sparetime', 'projects.json'), JSON.stringify({
  version: 1,
  projects: { 'ws-legacy': { enabled: true, updatedAt: 1 } },
}), 'utf8')

let passed = 0
const failures = []
const check = (label, condition) => {
  if (condition) {
    passed += 1
    console.log(`ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}`)
  }
}

//#region a composition with the five injected services

const root = new Context()
root.plugin(TimerService)

const registeredTools = []
const stoppedSessions = []
const fakeWorkspace = {
  id: 'ws-1',
  path: join(pluginRoot, 'sample-project'),
  title: 'sample-project',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sessionIds: ['s-1'],
  status: () => ({ kind: 'idle' }),
}

const provide = (name, value) => root.plugin({ name: `stub-${name}`, apply (ctx) { ctx.provide(name, value) } })

provide('tools', {
  // Mirrors the real @deepseek-ai/dsh-tools register() contract: a definition
  // without `output.render` is rejected. The live host caught the original
  // definition this way, so the stub fails just as loudly.
  register (definition) {
    if (definition?.output === undefined || typeof definition.output?.render !== 'function') {
      throw new TypeError(`tool "${definition?.name}" must declare output { schema, render, presentationMeta? }`)
    }
    // Mirror the supported JSON-Schema subset from @deepseek-ai/dsh-tools:
    // `required` is an array of names on an object node, never a leaf flag.
    const schema = definition.output.schema
    if (schema?.type !== 'object') throw new TypeError(`tool "${definition?.name}" output.schema.type must be "object"`)
    if (!Array.isArray(schema.required)) throw new TypeError(`tool "${definition?.name}" output.schema.required must be an array of property names`)
    for (const [key, node] of Object.entries(schema.properties ?? {})) {
      if (node?.required !== undefined) throw new TypeError(`schema.properties.${key}.required is not supported on type "${node.type}"`)
    }
    registeredTools.push(definition)
    return () => {}
  },
})
provide('agents', { list: () => [], get: () => undefined })
// Mirrors the real WorkspaceRegistry contract: `list` plus the two calls the
// 读取项目 flow makes — `resolveByPath` (reuse an existing Workspace) and
// `create` (register a new one).
const createdWorkspaces = []
provide('workspaceRegistry', {
  list: () => [fakeWorkspace, ...createdWorkspaces],
  get: id => (`${id}` === 'ws-1' ? fakeWorkspace : createdWorkspaces.find(workspace => workspace.id === `${id}`)),
  resolveByPath: path => [fakeWorkspace, ...createdWorkspaces].find(workspace => workspace.path === path),
  create: async path => {
    const workspace = {
      id: `ws-${createdWorkspaces.length + 2}`,
      path,
      title: basename(path),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionIds: [],
      status: () => ({ kind: 'idle' }),
    }
    createdWorkspaces.push(workspace)
    return workspace
  },
})
provide('sessions', {
  list: () => [],
  get: () => undefined,
  create: async () => undefined,
  flush: async () => {},
})
provide('sessionProjections', { stop: async id => { stoppedSessions.push(id) } })

//#endregion

//#region boot the plugin the way the Loader does

const plugin = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
const fiber = root.plugin(plugin, { tickSeconds: 15 })

check('plugin module exports apply/inject/name/Config', typeof plugin.apply === 'function' && Array.isArray(plugin.inject) && plugin.name === 'offPeak' && plugin.Config !== undefined)

await new Promise(resolve => setTimeout(resolve, 300))

check('fiber reaches ACTIVE (was FAILED with "cannot get property config without inject")', fiber.state === 2)
check('fiber carries no error', (fiber._error ?? undefined) === undefined)

const service = root.get('offPeak')
check('ctx.offPeak is provided', service !== undefined && service !== null)

const REMOTE = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const wireNames = (service === undefined || service === null)
  ? []
  : (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), REMOTE)?.value?.methods ?? []).map(marker => marker.exportName ?? marker.method)
check('thirteen Remote methods are wired to the browser', wireNames.length === 13 && wireNames.includes('getConfig') && wireNames.includes('setProject') && wireNames.includes('discover') && wireNames.includes('addProjects'))

//#endregion

//#region the service answers

if (service !== undefined && service !== null) {
  const view = service.getConfig()
  check('getConfig() reports the four switches and their source layer', view.ok === true && view.values.tickSeconds === 15 && view.source.tickSeconds === 'profile' && view.source.enabled === 'default')
  check('the pre-rename switch store is adopted', view.values.autoStart === true && view.source.autoStart === 'page')

  const status = service.status()
  check('status() classifies the current Beijing instant', typeof status.phase === 'string' && typeof status.nextBoundaryAt === 'string' && status.zone === 'Asia/Shanghai')
  check('status() counts the enforcement ticks already run', status.counters.checks >= 1)

  const rows = service.projects()
  check('projects() lists the registry workspace', Array.isArray(rows.projects) && rows.projects.some(row => row.workspaceId === 'ws-1' && row.enabled === false))

  const on = service.setProject({ workspaceId: 'ws-1', enabled: true })
  check('setProject() enables 错峰模式 and persists it', on.ok === true && on.projects.some(row => row.workspaceId === 'ws-1' && row.enabled === true))
  check('setProject() wrote the durable store', existsSync(join(process.env.DSH_HOME, 'storages', 'offPeak', 'projects.json')))
  check('the pre-rename project store is never rewritten', !existsSync(join(harnessHome, 'storages', 'sparetime', 'projects.json.tmp')))

  const all = service.setAll({ enabled: true })
  check('setAll() flips every row', all.ok === true && all.projects.every(row => row.enabled === true))

  const off = service.setProject({ workspaceId: 'ws-1', enabled: false })
  check('setProject() disables again', off.ok === true && off.projects.some(row => row.workspaceId === 'ws-1' && row.enabled === false))

  const config = await service.setConfig({ field: 'autoStart', value: false })
  check('setConfig() writes one switch', config.ok === true && config.values.autoStart === false && config.source.autoStart === 'page')
  const rejected = await service.setConfig({ field: 'nope', value: true })
  check('setConfig() rejects an unknown switch', rejected.ok === false)

  const ping = service.ping()
  check('ping() answers', ping.ok === true)

  const forced = service.force({ action: 'stop' })
  check('force({action:"stop"}) is accepted', forced.ok === true)

  const forgotten = service.forgetProject({ workspaceId: 'ws-1' })
  check('forgetProject() drops the record', forgotten.ok === true && forgotten.projects.some(row => row.workspaceId === 'ws-1' && row.enabled === false))

  // 读取项目: browse → scan → add. The tree is real on disk, so a sandbox with
  // one Go module and one vendored `node_modules` exercises the real scanner.
  const discoverRoot = join(process.env.DSH_HOME, 'discover')
  mkdirSync(join(discoverRoot, 'gamma'), { recursive: true })
  writeFileSync(join(discoverRoot, 'gamma', 'go.mod'), 'module gamma\n')
  mkdirSync(join(discoverRoot, 'node_modules', 'junk'), { recursive: true })
  writeFileSync(join(discoverRoot, 'node_modules', 'junk', 'package.json'), '{}\n')

  const listing = service.browse({ path: discoverRoot })
  check('browse() lists one directory level', listing.ok === true && listing.directories.some(entry => entry.name === 'gamma') && listing.directories.some(entry => entry.name === 'node_modules') === false)

  const scanned = service.scanProjects({ root: discoverRoot })
  const gamma = scanned.candidates?.find(candidate => candidate.path === join(discoverRoot, 'gamma'))
  check('scanProjects() finds the Go module and skips node_modules', scanned.ok === true && gamma !== undefined && gamma.markers.includes('Go') === true && gamma.known === false)

  const added = await service.addProjects({ paths: [join(discoverRoot, 'gamma')] })
  check('addProjects() registers a Workspace and switches 错峰模式 on', added.ok === true && added.added.length === 1 && added.projects.some(row => row.workspaceId === 'ws-2' && row.enabled === true))

  const rescanned = service.scanProjects({ root: discoverRoot })
  check('a rescan marks the added directory as already listed', rescanned.candidates.find(candidate => candidate.path === join(discoverRoot, 'gamma'))?.known === true)

  const duplicate = await service.addProjects({ paths: [join(discoverRoot, 'gamma')] })
  check('adding the same directory twice reuses the Workspace', duplicate.ok === true && duplicate.added[0]?.workspaceId === 'ws-2')

  const empty = await service.addProjects({ paths: [join(discoverRoot, 'missing')] })
  check('addProjects() reports a path that is not a directory', empty.ok === true && empty.added.length === 0 && empty.errors.length === 1)

  // discover(): the automatic scan, pointed at a root of our choosing so the
  // assertions never depend on the machine's real home directory.
  const auto = service.discover({ roots: [discoverRoot], budgetMs: 4000 })
  check('discover() finds the project with no path typed in', auto.ok === true && auto.roots.includes(discoverRoot) === true && auto.candidates.some(candidate => candidate.path === join(discoverRoot, 'gamma')))
  check('discover() marks a directory DSH already lists as known and enabled', auto.candidates.find(candidate => candidate.path === join(discoverRoot, 'gamma'))?.workspaceId === 'ws-2')
  const cached = service.discover({ roots: [discoverRoot] })
  check('a second discover() over the same roots is served from the cache', cached.ok === true && cached.cached === true && cached.scanned === auto.scanned)
  const refreshed = service.discover({ roots: [discoverRoot], force: true })
  check('discover({ force: true }) walks again', refreshed.ok === true && refreshed.cached === false)
  const bounded = service.discover({ roots: [discoverRoot], visitsPerRoot: 1 })
  check('discover() reports why it stopped early', bounded.ok === true && bounded.truncated === true && bounded.truncatedReason === 'visits')
  const nowhere = service.discover({ roots: [join(discoverRoot, 'missing')] })
  check('discover() reports unreadable roots instead of throwing', nowhere.ok === true && nowhere.errors.length >= 1)
}

const statusTool = registeredTools.find(tool => tool.name === 'offPeak_status')
check('the offPeak_status tool is registered with the Harness output contract', statusTool !== undefined && typeof statusTool.output?.render === 'function')
// The model request is `input_schema: tool.parameters` verbatim, so the
// property-map shorthand is NOT compiled here: an empty `{}` reaches the
// provider as `type: null` and fails the request with INVALID_REQUEST.
check(
  'the tool declares raw object-rooted JSON-Schema parameters',
  statusTool?.parameters?.type === 'object' && typeof statusTool?.parameters?.properties === 'object',
)
const statusRendered = statusTool === undefined ? [] : statusTool.output.render({}, await statusTool.execute())
check('the status tool renders text', statusRendered?.[0]?.type === 'text' && statusRendered[0].text.includes('空闲') === true)

//#endregion

//#region teardown

await fiber.dispose()
await new Promise(resolve => setTimeout(resolve, 100))
check('disposing the fiber unregisters ctx.offPeak', root.get('offPeak') === undefined)

//#endregion

console.log('')
if (failures.length === 0) {
  console.log(`${passed}/${passed} harness checks passed (runtime: ${runtimeRoot})`)
  process.exit(0)
}
console.log(`${passed}/${passed + failures.length} harness checks passed`)
for (const label of failures) console.log(`  - ${label}`)
process.exit(1)
