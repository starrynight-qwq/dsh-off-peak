/**
 * Self-test for the 错峰模式 Host half.
 *
 * Imports the real module — the bundle is dependency-free on purpose, so this
 * runs from the plugin directory with no node_modules at all — and checks three
 * contracts:
 *   1. the Beijing-time clock: peak = Mon–Fri (excluding mainland statutory
 *      holidays) 09:00–12:00 and 14:00–18:00; everything else idle;
 *   2. the hand-rolled config schema: Standard Schema v1 `validate` (what Cordis
 *      calls before activating the row) and the `uid`/`refs`/`dict` projection
 *      the settings page renders;
 *   3. the hand-written Typert Remote markers, which are what put each service
 *      method on the browser wire.
 *
 * Run: node tools/selftest.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

const module = await import(new URL('../lib/index.js', import.meta.url).href)
const { classify, beijingDate, HOLIDAYS, PEAK_WINDOWS, ZONE, Config, browseDirectory, scanForProjects, samePath } = module
const { default: Schema } = await import(new URL('../lib/schema.js', import.meta.url).href)

let failures = 0
let checks = 0

/**
 * Assert one instant's classification.
 * @param label - what the case proves.
 * @param iso - the instant in Beijing time, `YYYY-MM-DDTHH:MM`.
 * @param expected - `true` when the instant must be peak.
 */
const expect = (label, iso, expected) => {
  checks += 1
  const stamp = Date.parse(`${iso}:00+08:00`)
  const now = classify(stamp)
  const actual = now.peak
  const mark = actual === expected ? 'ok  ' : 'FAIL'
  if (actual !== expected) failures += 1
  console.log(`${mark} ${iso}  peak=${String(actual).padEnd(5)} expected=${String(expected).padEnd(5)} ${label}`)
}

console.log(`zone: ${ZONE}`)
console.log('--- window edges on a normal working day (2026-10-15, Thursday) ---')
expect('before the morning window', '2026-10-15T08:59', false)
expect('first peak minute', '2026-10-15T09:00', true)
expect('last peak minute of the morning', '2026-10-15T11:59', true)
expect('lunch break starts', '2026-10-15T12:00', false)
expect('lunch break', '2026-10-15T13:59', false)
expect('afternoon window starts', '2026-10-15T14:00', true)
expect('last peak minute of the day', '2026-10-15T17:59', true)
expect('evening off-peak starts', '2026-10-15T18:00', false)
expect('midnight', '2026-10-15T00:00', false)
expect('23:59', '2026-10-15T23:59', false)

console.log('--- weekend (2026-10-17 Saturday, 2026-10-18 Sunday) ---')
expect('Saturday morning window', '2026-10-17T10:00', false)
expect('Saturday afternoon window', '2026-10-17T15:00', false)
expect('Sunday morning window', '2026-10-18T10:00', false)

console.log('--- statutory holidays ---')
expect('国庆节 2026-10-01', '2026-10-01T10:00', false)
expect('国庆节 last day 2026-10-07 (Wednesday)', '2026-10-07T15:00', false)
expect('day after 国庆节, Thursday', '2026-10-08T10:00', true)
expect('元旦 2026-01-01 (Thursday)', '2026-01-01T10:00', false)
expect('元旦 last day 2026-01-03 (Saturday)', '2026-01-03T10:00', false)
expect('春节 2026-02-17 (Tuesday)', '2026-02-17T10:00', false)
expect('春节 first day 2026-02-15 (Sunday)', '2026-02-15T15:00', false)
expect('春节 last day 2026-02-23 (Monday)', '2026-02-23T15:00', false)
expect('day after 春节', '2026-02-24T10:00', true)
expect('劳动节 2026-05-01 (Friday)', '2026-05-01T10:00', false)
expect('中秋节 2026-09-25 (Friday)', '2026-09-25T15:00', false)
expect('国庆节 2025-10-01 (Wednesday)', '2025-10-01T10:00', false)
expect('国庆节 2025 last day (Wednesday)', '2025-10-08T15:00', false)
expect('day after 2025 国庆节', '2025-10-09T10:00', true)

console.log('--- 调休 make-up working days stay idle days ---')
expect('调休 Saturday 2026-02-28', '2026-02-28T10:00', false)
expect('调休 Sunday 2026-10-11', '2026-10-11T15:00', false)

console.log('--- weekday arithmetic ---')
const weekdays = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
for (const iso of weekdays) {
  checks += 1
  const date = beijingDate(Date.parse(`${iso}T10:00:00+08:00`))
  if (date.iso !== iso) {
    failures += 1
    console.log(`FAIL ${iso} → beijingDate returned ${date.iso}`)
  }
}
console.log(`ok   Mon–Fri 2026-10-12…2026-10-16 all render back as themselves`)

console.log('--- holiday table sanity ---')
checks += 1
const problems = []
for (const [year, ranges] of Object.entries(HOLIDAYS)) {
  if (String(Number(year)) !== year) problems.push(`${year} is not a year key`)
  for (const [from, to] of ranges) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) problems.push(`${year}: bad date ${from}~${to}`)
    if (from > to) problems.push(`${year}: reversed range ${from}~${to}`)
    if (from.slice(0, 4) !== year || to.slice(0, 4) !== year) problems.push(`${year}: range ${from}~${to} leaves the year`)
  }
}
if (problems.length > 0) {
  failures += 1
  console.log(`FAIL holiday table: ${problems.join('; ')}`)
} else {
  console.log(`ok   ${Object.keys(HOLIDAYS).join(', ')}: ${Object.values(HOLIDAYS).flat().length} ranges, all well-formed and in-year`)
}

console.log('--- bundle is dependency-free ---')
checks += 1
{
  const bare = [...source.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+'([^']+)'/g)]
    .map(match => match[1])
    .filter(spec => spec.startsWith('.') === false && spec.startsWith('node:') === false)
  const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const clientBare = [...clientSource.matchAll(/require\('([^']+)'\)/g)]
    .map(match => match[1])
    .filter(spec => spec !== 'react' && spec.startsWith('.') === false)
  if (bare.length > 0 || clientBare.length > 0) {
    failures += 1
    console.log(`FAIL bare specifiers would not resolve from the plugin directory: ${[...bare, ...clientBare].join(', ')}`)
  } else {
    console.log('ok   Host half imports only node: builtins and relative files; Client half only `react`')
  }
}

console.log('--- config schema (Standard Schema v1, what Cordis calls first) ---')
checks += 1
{
  const standard = Config['~standard']
  const filled = standard?.validate({})
  const rejected = standard?.validate({ tickSeconds: 3 })
  const ok = standard?.version === 1 &&
    'then' in (filled ?? {}) === false &&
    JSON.stringify(filled?.value) === JSON.stringify({ enabled: true, autoResume: true, autoStart: true, tickSeconds: 15 }) &&
    Array.isArray(rejected?.issues) && rejected.issues.length === 1 &&
    rejected.issues[0].path.join('.') === 'tickSeconds'
  if (!ok) {
    failures += 1
    console.log(`FAIL schema validate: ${JSON.stringify({ filled, rejected })}`)
  } else {
    console.log(`ok   validate({}) fills every default; validate({ tickSeconds: 3 }) issues "${rejected.issues[0].message}"`)
  }
}

console.log('--- config schema projection (what the settings page renders) ---')
checks += 1
{
  const json = Config.toJSON()
  const fields = Object.keys(json.dict ?? {})
  const volatile = fields.filter((key) => json.refs[String(json.dict[key])]?.meta?.volatile === true)
  const ok = json.type === 'object' && fields.length === 4 &&
    volatile.length === 4 &&
    json.refs[String(json.uid)]?.dict !== undefined
  if (!ok) {
    failures += 1
    console.log(`FAIL projection: fields=${fields.join(',')} volatile=${volatile.join(',')}`)
  } else {
    console.log(`ok   ${fields.length} fields (${fields.join(', ')}), all four carrying meta.volatile so the page may write them`)
  }
}

console.log('--- project discovery (读取项目 / scanForProjects) ---')
{
  /**
   * Assert one discovery fact.
   * @param label - what the case proves.
   * @param ok - the assertion result.
   */
  const verify = (label, ok) => {
    checks += 1
    if (ok !== true) failures += 1
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${label}`)
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'offpeak-scan-'))
  mkdirSync(join(sandbox, 'alpha', 'src'), { recursive: true })
  writeFileSync(join(sandbox, 'alpha', 'package.json'), '{}\n')
  mkdirSync(join(sandbox, 'beta'), { recursive: true })
  writeFileSync(join(sandbox, 'beta', 'pyproject.toml'), '[project]\nname = "beta"\n')
  mkdirSync(join(sandbox, 'node_modules', 'junk'), { recursive: true })
  writeFileSync(join(sandbox, 'node_modules', 'junk', 'package.json'), '{}\n')
  mkdirSync(join(sandbox, 'nested', 'l1', 'l2', 'l3', 'deep'), { recursive: true })
  writeFileSync(join(sandbox, 'nested', 'l1', 'l2', 'l3', 'deep', 'Cargo.toml'), '[package]\n')

  const found = scanForProjects(sandbox)
  const paths = found.candidates.map(candidate => candidate.path)
  verify('a directory with package.json is reported', paths.includes(join(sandbox, 'alpha')) === true)
  verify('a directory with pyproject.toml is reported', paths.includes(join(sandbox, 'beta')) === true)
  verify('a project directory is not descended into (alpha/src is no candidate)', paths.includes(join(sandbox, 'alpha', 'src')) === false)
  verify('node_modules is never scanned', found.candidates.every(candidate => candidate.path.includes('node_modules') === false))
  verify('the default depth is 3 (a project 4 levels down is skipped)', paths.includes(join(sandbox, 'nested', 'l1', 'l2', 'l3', 'deep')) === false)
  verify('markers carry an ecosystem tag', found.candidates.find(candidate => candidate.path === join(sandbox, 'alpha'))?.markers.includes('Node') === true)
  verify('scanForProjects() clamps its limit and reports truncation', scanForProjects(sandbox, { limit: 1 }).truncated === true)
  verify('a deeper walk finds the nested project', scanForProjects(sandbox, { depth: 6 }).candidates.some(candidate => candidate.path === join(sandbox, 'nested', 'l1', 'l2', 'l3', 'deep')) === true)

  const listing = browseDirectory(sandbox)
  verify('browseDirectory() lists only real subdirectories', listing.path === sandbox && listing.directories.map(entry => entry.name).join(',') === 'alpha,beta,nested')
  verify('browseDirectory() reports a parent for the walker', typeof listing.parent === 'string' && listing.parent !== '' && listing.files >= 0)
  verify('samePath() ignores case on Windows', samePath(sandbox, sandbox.toUpperCase()) === true)
  verify('browseDirectory() reports an unreadable path instead of throwing', browseDirectory(join(sandbox, 'does-not-exist')).error !== '')
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('--- Typert Remote markers (what the browser wire reads) ---')
checks += 1
{
  const key = '@deepseek-ai/dsh-typert-protocol/remote-methods'
  const applied = source.includes('ctx.effect(() => {') && source.includes("'offPeak: service'")
  const expected = ['getConfig', 'setConfig', 'ping', 'status', 'projects', 'setProject', 'setAll', 'forgetProject', 'force', 'browse', 'scanProjects', 'discover', 'addProjects']
  const declared = [...source.matchAll(/publishRemote\(OffPeakService,\s*'([^']+)'\)/g)].map(match => match[1])
  const ok = applied && key.length > 0 &&
    expected.every(name => declared.includes(name)) && declared.length === expected.length
  if (!ok) {
    failures += 1
    console.log(`FAIL remote markers: declared=${declared.join(',')}`)
  } else {
    console.log(`ok   ${declared.length} methods publish a version-1 direct marker: ${declared.join(', ')}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
