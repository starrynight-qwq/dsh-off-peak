/**
 * 错峰模式 — the tiny schema builder this plugin own-rolls.
 *
 * A DSH plugin bundle is imported by Node from its own directory, so a bare
 * specifier such as `@deepseek-ai/schemastery` only resolves when the Harness
 * happens to hoist that package next to the profile. Everything this plugin
 * really needs from a schema is:
 *
 *   - a callable that fills defaults and validates a config section;
 *   - `toJSON()` producing the JSON-Schema-flavoured tree the Harness projects
 *     into a settings form, with each field's `meta` chain — `meta.volatile`
 *     being what makes a field editable from the 错峰模式 page;
 *   - the `uid`/`refs`/`dict` layout that tree uses for nested fields.
 *
 * Reproducing those three things here keeps the bundle dependency-free, which
 * is the difference between a plugin that loads and one that fails with
 * `ERR_MODULE_NOT_FOUND`.
 */

/** Type tags used by the projected JSON Schema. */
const SCHEMA_TYPES = {
  boolean: 'boolean',
  number: 'number',
  string: 'string',
  object: 'object',
}

/** Monotonic node id, matching the referenced-node layout of the projection. */
let nextUid = 0

function describe (value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Validate one atomic value against a node's metadata.
 * @param type - the node's primitive type tag.
 * @param meta - the node's metadata chain.
 * @param key - dotted path used in the error message.
 * @param value - the candidate value.
 * @returns the accepted value.
 */
function assertAtomic (type, meta, key, value) {
  const label = `$.${key}`
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} expected boolean but got ${describe(value)}`)
    return value
  }
  if (type === 'number') {
    if (typeof value !== 'number' || Number.isFinite(value) === false) {
      throw new Error(`${label} expected number but got ${describe(value)}`)
    }
    if (meta.min !== undefined && value < meta.min) throw new Error(`${label} expected number >= ${meta.min} but got ${value}`)
    if (meta.max !== undefined && value > meta.max) throw new Error(`${label} expected number <= ${meta.max} but got ${value}`)
    return value
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${label} expected string but got ${describe(value)}`)
    return value
  }
  return value
}

/**
 * Build one schema node.
 *
 * The returned value is callable — `node(value)` fills defaults and validates —
 * and its chainable helpers attach the metadata the projection publishes.
 * @param type - one of {@link SCHEMA_TYPES}.
 * @param entries - for `object` nodes, the ordered `[key, child]` field list.
 * @param extra - extra keys merged into the projected node.
 * @returns the schema node.
 */
function node (type, entries, extra) {
  const meta = {}
  const self = function schemaNode (value) {
    return self.resolve(value)
  }

  self.meta = meta
  self.type = SCHEMA_TYPES[type]
  self.uid = nextUid++

  /**
   * Attach one metadata entry. `volatile` is the load-bearing one: the Harness
   * only lets the settings page write a field whose schema carries it.
   */
  const withMeta = (key, value) => {
    meta[key] = value
    return self
  }

  self.volatile = () => withMeta('volatile', true)
  self.description = (text) => withMeta('description', text)
  self.default = (value) => withMeta('default', value)
  self.required = () => withMeta('required', true)
  self.min = (value) => withMeta('min', value)
  self.max = (value) => withMeta('max', value)
  self.step = (value) => withMeta('step', value)
  self.role = (value) => withMeta('role', value)

  if (type === 'object') {
    self.dict = Object.fromEntries(entries ?? [])
    meta.default = {}
    self.resolve = (value) => {
      const source = value === undefined || value === null || typeof value !== 'object' ? {} : value
      const out = {}
      for (const [key, child] of entries ?? []) {
        const resolved = child(source[key])
        if (resolved !== undefined) out[key] = resolved
      }
      return out
    }
  } else {
    self.resolve = (value) => {
      const candidate = value === undefined ? meta.default : value
      if (candidate === undefined) return undefined
      return assertAtomic(type, meta, 'value', candidate)
    }
  }

  /**
   * Project this subtree the way the Harness reads it: the root node spread at
   * the top level, every node also filed under `refs` by its own id, and each
   * parent referring to its children by id.
   */
  self.toJSON = () => {
    const refs = {}
    const walk = (target) => {
      const projected = { type: target.type }
      if (target.dict !== undefined) {
        projected.dict = {}
        for (const [key, child] of Object.entries(target.dict)) projected.dict[key] = child.uid
      }
      if (target.list !== undefined) projected.list = target.list.map((item) => item.uid)
      if (extra !== undefined) Object.assign(projected, extra)
      if (Object.keys(target.meta).length > 0) projected.meta = { ...target.meta }
      refs[String(target.uid)] = projected
      if (target.dict !== undefined) for (const child of Object.values(target.dict)) walk(child)
    }
    walk(self)
    return { uid: self.uid, refs, ...refs[String(self.uid)] }
  }

  self.toString = () => JSON.stringify(self.toJSON())

  /**
   * Validate with issue collection instead of throwing.
   *
   * Cordis validates a plugin's config through Standard Schema v1 in
   * `resolveConfig`: `runtime.Config['~standard'].validate(config)` must return
   * `{ value }` or `{ issues }` synchronously. Missing this member is what makes
   * a plugin row fail to activate with `Cannot read properties of undefined
   * (reading 'validate')`.
   * @param value - the raw profile configuration.
   * @returns the Standard Schema result.
   */
  const validate = (value) => {
    const issues = []
    const collect = (target, input, path) => {
      if (target.dict === undefined) {
        const candidate = input === undefined ? target.meta.default : input
        if (candidate === undefined) return undefined
        try {
          return assertAtomic(target.type, target.meta, path.length === 0 ? 'value' : path.join('.'), candidate)
        } catch (error) {
          issues.push({ message: error.message, path })
          return undefined
        }
      }
      const source = input === undefined || input === null || typeof input !== 'object' ? {} : input
      const out = {}
      for (const [key, child] of Object.entries(target.dict)) {
        const resolved = collect(child, source[key], [...path, key])
        if (resolved !== undefined) out[key] = resolved
      }
      return out
    }
    const out = {}
    if (self.dict === undefined) {
      const resolved = collect(self, value, [])
      if (resolved !== undefined) out.value = resolved
    } else {
      const resolved = collect(self, value, [])
      if (resolved !== undefined) Object.assign(out, resolved)
    }
    if (issues.length > 0) return { issues }
    return { value: out }
  }

  Object.defineProperty(self, '~standard', {
    value: Object.freeze({ version: 1, vendor: 'dsh-off-peak', validate }),
  })

  return self
}

/** `Schema.boolean()` */
const boolean = () => node('boolean')

/** `Schema.number()` */
const number = () => node('number')

/** `Schema.string()` */
const string = () => node('string')

/**
 * `Schema.object({ ... })` — the only composite this plugin needs.
 * @param entries - ordered field map.
 */
const object = (entries) => node('object', Object.entries(entries ?? {}))

/**
 * `Schema.union([...])` — projected as its first branch, which is all the
 * settings form needs in order to render a control.
 * @param branches - the candidate schemas.
 */
const union = (branches) => {
  const first = branches[0] ?? string()
  first.list = branches
  return first
}

const Schema = { boolean, number, string, object, union, node }

export { Schema }
export default Schema
