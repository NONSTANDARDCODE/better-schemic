/**
 * `plugins/policy` — a small, declarative authorization layer ON TOP of the ORM.
 *
 * The database remains the ultimate authority (DEFINE ACCESS / PERMISSIONS); this plugin is for the
 * privileged/agent paths where those checks don't apply, and for fail-fast DX. Three effects:
 *
 * - `deny` — reject a matching operation before it compiles (`PolicyDenied`, 403). With `fields`,
 * writes that touch one of those fields deni them.
 * - `scope` — inject a filter through `Operation.scope`, ANDed into every compiler (reads AND
 * writes), so row-level authorization cannot forgotts it at a call site.
 * - `require` — fail closed (`PolicyRequired`, 403) when a required `meta` key (e.g. an actor) is
 * missing. Callers pass it via `meta: { ... }` on the operation or `$withContext({ meta })`.
 *
 * `$withoutPlugins()` is the explicit admin escape; DB permissions are the real boundary.
 */

import { OrmError } from "../orm/errors"
import { operationFamily } from "../orm/hooks"
import { resolveModel, type SchemaIndex } from "../orm/meta"
import { definePlugin } from "../orm/plugins"
import type { OperationKind } from "../orm/types/hooks"
import type { Operation, Plugin } from "../orm/types/plugins"
import type { SchemaInput } from "../orm/types/schema"

/** Operation kinds, families, or `*` (all operations). */
export type PolicyOperation =
  "*" | "create" | "delete" | "query" | "relate" | "update" | OperationKind

/** The FILTER operators accepted directly in a `scope` rule's value. Anything else is `equals`. */
const FILTER_KEYS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is",
  "isNot",
])

/** One authorization rule. */
export type PolicyRule<Table extends string = string> = {
  readonly effect: "deny" | "require" | "scope"
  /** When set, a `deny` rule fires if a WRITE payload touches one of these fields. */
  readonly fields?: readonly string[]
  /** For `scope`: `{ field: value | { equals|in|…: value } }`. */
  readonly filter?: Readonly<Record<string, unknown>>
  /** Teaching message override. */
  readonly message?: string
  /** Operations to match (kinds or families). Omitted = all. */
  readonly operations?: readonly PolicyOperation[]
  /** For `require`: the `meta` key that must be present (e.g. `"actor"`). */
  readonly require?: string
  /** Schema keys or physical table names. `"*"` matches every table. */
  readonly tables: "*" | readonly Table[]
}

export type PolicyOptions<Table extends string = string> = {
  readonly name?: string
  readonly rules: readonly PolicyRule<Table>[]
}

type CompiledRule = {
  /** Physical table names resolved at bootstrap (empty = all tables). */
  readonly targets: ReadonlySet<string> | undefined
} & PolicyRule

/**
 * Build the rule table once per (SchemaIndex, options) pair. Keying on the index alone would be
 * wrong: clients with DIFFERENT policies can share the same cached index.
 */
const cache = new WeakMap<SchemaIndex, WeakMap<PolicyOptions, readonly CompiledRule[]>>()

function compile(index: SchemaIndex, options: PolicyOptions): readonly CompiledRule[] {
  let perIndex = cache.get(index)
  if (!perIndex) {
    perIndex = new WeakMap()
    cache.set(index, perIndex)
  }
  const cached = perIndex.get(options)
  if (cached) return cached

  const compiled = options.rules.map((rule) => {
    if (rule.effect === "scope" && !rule.filter)
      throw new OrmError("PluginError", "policy: a `scope` rule needs a `filter`.")

    if (rule.effect === "require" && !rule.require)
      throw new OrmError("PluginError", "policy: a `require` rule needs a `require` meta key.")

    const targets =
      rule.tables === "*"
        ? undefined
        : new Set(
            rule.tables.map((name) => {
              const model = resolveModel(index, name)
              if (!model) {
                throw new OrmError(
                  "PluginError",
                  `policy: unknown table "${name}" — check the schema key or physical name.`,
                )
              }
              return model.name
            }),
          )
    // Typo protection: a field in a `scope` filter or a field-scoped `deny` must exist on every
    // targeted table — otherwise it would compile into a SQL error at the worst possible moment.
    const referenced = [...Object.keys(rule.filter ?? {}), ...(rule.fields ?? [])]
    if (referenced.length > 0) {
      const models = targets
        ? [...targets].map((name) => index.byName.get(name)).filter((model) => model !== undefined)
        : [...index.tables.values()]
      // schemaless entries have no declared columns
      const offending = models.find(
        (model) => "columns" in model && referenced.some((field) => !model.columns.has(field)),
      )
      if (offending && "columns" in offending) {
        const field = referenced.find((f) => !offending.columns.has(f))
        if (field !== undefined) {
          throw new OrmError(
            "PluginError",
            `policy: field "${field}" is not a column of "${offending.name}" — check the rule's field names.`,
            { field, table: offending.name },
          )
        }
      }
    }

    return { ...rule, targets }
  })
  perIndex.set(options, compiled)
  return compiled
}

const operationMatches = (rule: CompiledRule, op: Operation): boolean => {
  if (!rule.operations) return true

  const family = operationFamily(op.kind)
  return rule.operations.some(
    (candidate) => candidate === "*" || candidate === op.kind || candidate === family,
  )
}

const touchesFields = (rule: CompiledRule, op: Operation): boolean => {
  if (!rule.fields) return true

  const data = op.data
  return rule.fields.some((field) => field in data)
}

/** Normalize a scope value: a known filter object passes through; anything else means `equals`. */
function asFilter(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    FILTER_KEYS.has(Object.keys(value)[0])
  )
    return value

  return { equals: value }
}

/**
 * Declarative authorization: `definePolicy({ users: User }, { rules: [...] })` types table names
 * against the schema; the plain `definePolicy({ rules: [...] })` form accepts any name.
 */
export function definePolicy<const S extends SchemaInput>(
  schema: S,
  options: PolicyOptions<Extract<keyof S, string>>,
): Plugin
export function definePolicy(options: PolicyOptions): Plugin
export function definePolicy(
  schemaOrOptions: PolicyOptions | SchemaInput,
  maybeOptions?: PolicyOptions,
): Plugin {
  const options: PolicyOptions = maybeOptions ?? (schemaOrOptions as PolicyOptions)
  if (!Array.isArray((options as { rules?: unknown }).rules))
    throw new OrmError("PluginError", "policy: `rules` must be an array.")

  return definePlugin({
    config: options,
    id: "better-schemic/policy",
    name: "Policy",
    setup({ index }) {
      compile(index, options)
    },
    transform(op) {
      compile(op.index, options).forEach((rule) => {
        if (rule.targets && !rule.targets.has(op.table)) return

        if (!operationMatches(rule, op)) return

        if (rule.effect === "require") {
          const key = rule.require
          if (key === undefined) return
          if (op.meta?.[key] === undefined || op.meta[key] === null) {
            throw new OrmError(
              "PolicyRequired",
              rule.message ?? `policy: "${key}" is required in meta for ${op.kind} on ${op.table}.`,
              { field: key, operation: op.kind, table: op.table },
            )
          }
          return
        }

        if (rule.effect === "scope") {
          Object.entries(rule.filter ?? {}).forEach(([field, value]) => {
            op.scope[field] = asFilter(value)
          })
          return
        }

        // deny — field-scoped rules apply to write payloads.
        if (!touchesFields(rule, op)) return

        const field = rule.fields?.[0]
        throw new OrmError(
          "PolicyDenied",
          rule.message ??
            `policy: ${op.kind} on ${op.table}${field ? ` (field "${field}")` : ""} is denied. ` +
              `Use $withoutPlugins() only in trusted admin code; the DB permission is the boundary.`,
          { field, operation: op.kind, table: op.table },
        )
      })
    },
  })
}
