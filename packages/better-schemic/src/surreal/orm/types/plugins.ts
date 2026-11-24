/**
 * The type-level half of the plugin system. A plugin declares EXTRA args per operation
 * (`operationArgs`), can mutate an operation before it compiles (`transform`), observe it (`hooks`),
 * and graft methods onto the client (`extendClient`) or every delegate (`extendModel`).
 *
 * `definePlugin` preserves the concrete spec, so `Client<S, C, P>` can fold a plugin tuple's
 * `operationArgs` into each delegate method's args and its extension return types into the surface.
 */
import type { ClientRuntime } from "../client"
import type { SchemaIndex } from "../meta"

import type { Hooks, OperationKind } from "./hooks"

/** A plugin's per-delegate state — a flat bag shared by every plugin on a delegate. */
export type PluginState = Record<string, unknown>

/** Extra args a plugin contributes to an operation (`{ findMany: { deleted: "with" } }`). */
export type OperationArgsMap = Readonly<Record<string, Record<string, unknown> | undefined>>

/**
 * The mutable view of an operation handed to `transform`. Mutating `where`/`data`/`args` changes what
 * compiles; setting `kind` re-dispatches the operation (e.g. soft-delete turns `delete` into
 * `update`). `where`/`data` exist, so `op.where[col] ??= …` always works.
 */
export type Operation = {
  readonly args: Record<string, unknown>
  data: Record<string, unknown>
  /** The validated schema index — the canonical source for field/relation introspection. */
  readonly index: SchemaIndex
  kind: OperationKind
  meta?: Record<string, unknown>
  /**
   * A plugin-written filter AND-combined by EVERY compiler into the statement it compiles —
   * reads (`findMany`/`findUnique`/`count`/`exists`/`combine`/`paginate`/`cursor`) and writes.
   * Unlike `where`, it NEVER participates in the singular target resolution (`uniqueTarget`), so a
   * plugin can scope `update`/`delete`/`patch`/`upsert` by id/unique field (`UPDATE  t:id …
   * WHERE <scope>`) and `findUnique`'s targets.  created like `where`. INTERNAL channel: user
   * args never expose it; not part of the typed surface.
   */
  scope: Record<string, unknown>
  readonly state: PluginState
  readonly table: string
  where: Record<string, unknown>
}

/** The `this` a plugin's methods run with: its resolved config and the delegate's state. */
export type PluginContext<Cfg = unknown> = {
  readonly config: Cfg
  readonly state: PluginState
}

/** What `setup` receives (once, at bootstrap). */
export type PluginSetupContext = {
  readonly index: SchemaIndex
}

/** What `extendClient` receives. */
export type PluginClientContext = {
  readonly client: ClientRuntime
  readonly index: SchemaIndex
}

/** What `extendModel` receives (`model` is the delegate). */
export type PluginModelContext = {
  readonly index: SchemaIndex
  readonly model: unknown
}

/** The author-facing plugin spec accepted by `definePlugin`. */
export type PluginSpec<Cfg = unknown> = {
  /** Plugin configuration (available as `this.config`). */
  readonly config?: Cfg
  readonly description?: string
  /** Methods grafted onto the client. */

  extendClient?(this: PluginContext<Cfg>, ctx: PluginClientContext): Record<string, unknown>
  /** Methods grafted onto every delegate. */

  extendModel?(this: PluginContext<Cfg>, ctx: PluginModelContext): Record<string, unknown>
  /** Observation hooks contributed by the plugin. */
  readonly hooks?: Hooks
  /** Stable, unique id (a duplicate fails fast at bootstrap). */
  readonly id: string
  readonly name?: string
  /** Extra args per operation (typed onto the delegate). */
  readonly operationArgs?: OperationArgsMap
  /**
   * Runs once at bootstrap (check config here; a throw fails fast with `PluginError`).
   * SYNCHRONOUS: the client builts it synchronously, so an async `setup` cannot awaits it.
   */
  setup?(this: PluginContext<Cfg>, ctx: PluginSetupContext): void
  /**
   * Mutates an operation before it compiles (runs in plugin order). Return `false` to SKIP the
   * operation entirely (it resolves `undefined` without touching the database).
   * SYNCHRONOUS: compilation is eager, so async work belongs in a hook.
   */

  transform?(this: PluginContext<Cfg>, operation: Operation): false | undefined
  readonly version?: string
}

/** The runtime brand key distinguishing a `definePlugin` artifact (a plain literal — nameable in
 * `.d.ts` output, unlike a `unique symbol`). */
export const PLUGIN_BRAND = "__ormPlugin" as const

/** A ready plugin (what `definePlugin` returns and `plugins: [...]` accepts). */
export type Plugin<Cfg = unknown> = PluginSpec<Cfg> & {
  readonly [PLUGIN_BRAND]: true
}

// --- type-level extraction -----------------------------------------------------------------------

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- default neutro sem index signature
type EmptyArgs = Record<never, never>

/** The extra args ONE plugin contributes to `K` (distributes over unions). Plugin args are always
 * OPTIONAL — the plugin applies its own defaults when they omitt them. */
type ArgsOf<T, K extends string> = T extends { operationArgs?: infer M }
  ? K extends keyof M
    ? M[K] extends Record<string, unknown>
      ? Partial<M[K]>
      : EmptyArgs
    : EmptyArgs
  : EmptyArgs

/** The merged extra args every plugin contributes to operation `K`. */
export type PluginArgs<P extends readonly Plugin[], K extends string> = P extends readonly []
  ? EmptyArgs
  : UnionToIntersection<ArgsOf<P[number], K>>

/** The methods every plugin's `extendClient` contributes. */
export type PluginClientExtras<P extends readonly Plugin[]> = UnionToIntersection<
  P[number] extends { extendClient?: (...args: never[]) => infer C } ? C : EmptyArgs
>

/** The methods every plugin's `extendModel` contributes. */
export type PluginModelExtras<P extends readonly Plugin[]> = UnionToIntersection<
  P[number] extends { extendModel?: (...args: never[]) => infer M } ? M : EmptyArgs
>

/** A plugin tuple or none (the default for clients without plugins). */
export type PluginList = readonly Plugin[]
