/**
 * The type-level half of the plugin system. A plugin declares EXTRA args per operation
 * (`operationArgs`), can mutate an operation before it compiles (`transform`), observe it (`hooks`),
 * and graft methods onto the client (`extendClient`) or every delegate (`extendModel`).
 *
 * `definePlugin` preserves the concrete spec, so `Client<S, C, P>` can fold a plugin tuple's
 * `operationArgs` into each delegate method's args and its extension return types into the surface.
 */
import type { ClientRuntime } from "../client";
import type { SchemaIndex } from "../meta";
import type { Hooks, OperationKind } from "./hooks";

/** A plugin's per-delegate state — a flat bag shared by every plugin on a delegate. */
export type PluginState = Record<string, unknown>;

/** Extra args a plugin contributes to an operation (`{ findMany: { deleted: "with" } }`). */
export interface OperationArgsMap {
  readonly [operation: string]: Record<string, unknown> | undefined;
}

/**
 * The mutable view of an operation handed to `transform`. Mutating `where`/`data`/`args` changes what
 * compiles; setting `kind` re-dispatches the operation (e.g. soft-delete turns `delete` into
 * `update`). `where`/`data` are lazily created, so `op.where[col] ??= …` always works.
 */
export interface Operation {
  kind: OperationKind;
  readonly table: string;
  readonly args: Record<string, unknown>;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
  readonly state: PluginState;
}

/** The `this` a plugin's methods run with: its resolved config and the delegate's state. */
export interface PluginContext<Cfg = unknown> {
  readonly config: Cfg;
  readonly state: PluginState;
}

/** What `setup` receives (once, at bootstrap). */
export interface PluginSetupContext {
  readonly index: SchemaIndex;
}

/** What `extendClient` receives. */
export interface PluginClientContext {
  readonly index: SchemaIndex;
  readonly client: ClientRuntime;
}

/** What `extendModel` receives (`model` is the delegate). */
export interface PluginModelContext {
  readonly index: SchemaIndex;
  readonly model: unknown;
}

/** The author-facing plugin spec accepted by `definePlugin`. */
export interface PluginSpec<Cfg = unknown> {
  /** Stable, unique id (a duplicate fails fast at bootstrap). */
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  /** Plugin configuration (available as `this.config`). */
  readonly config?: Cfg;
  /** Extra args per operation (typed onto the delegate). */
  readonly operationArgs?: OperationArgsMap;
  /** Runs once at bootstrap (validate config here; a throw fails fast with `PluginError`). */
  setup?(
    this: PluginContext<Cfg>,
    ctx: PluginSetupContext,
  ): void | Promise<void>;
  /**
   * Mutates an operation before it compiles (runs in plugin order). Return `false` to SKIP the
   * operation entirely (it resolves `undefined` without touching the database).
   */
  transform?(
    this: PluginContext<Cfg>,
    operation: Operation,
  ): void | false | Promise<void | false>;
  /** Observation hooks contributed by the plugin. */
  readonly hooks?: Hooks;
  /** Methods grafted onto the client. */
  extendClient?(this: PluginContext<Cfg>, ctx: PluginClientContext): object;
  /** Methods grafted onto every delegate. */
  extendModel?(this: PluginContext<Cfg>, ctx: PluginModelContext): object;
}

/** The runtime brand key distinguishing a `definePlugin` artifact (a plain literal — nameable in
 * `.d.ts` output, unlike a `unique symbol`). */
export const PLUGIN_BRAND = "__betterSchemicPlugin" as const;

/** A ready plugin (what `definePlugin` returns and `plugins: [...]` accepts). */
export type Plugin<Cfg = unknown> = PluginSpec<Cfg> & {
  readonly [PLUGIN_BRAND]: true;
};

// --- type-level extraction -----------------------------------------------------------------------

type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never;

/** The extra args ONE plugin contributes to `K` (distributes over unions). Plugin args are always
 * OPTIONAL — the plugin applies its own defaults when they are omitted. */
type ArgsOf<T, K extends string> = T extends { operationArgs?: infer M }
  ? K extends keyof M
    ? M[K] extends object
      ? Partial<M[K]>
      : Record<never, never>
    : Record<never, never>
  : Record<never, never>;

/** The merged extra args every plugin contributes to operation `K`. */
export type PluginArgs<
  P extends readonly Plugin[],
  K extends string,
> = P extends readonly []
  ? Record<never, never>
  : UnionToIntersection<ArgsOf<P[number], K>>;

/** The methods every plugin's `extendClient` contributes. */
export type PluginClientExtras<P extends readonly Plugin[]> =
  UnionToIntersection<
    P[number] extends { extendClient?: (...args: never[]) => infer C }
      ? C
      : Record<never, never>
  >;

/** The methods every plugin's `extendModel` contributes. */
export type PluginModelExtras<P extends readonly Plugin[]> =
  UnionToIntersection<
    P[number] extends { extendModel?: (...args: never[]) => infer M }
      ? M
      : Record<never, never>
  >;

/** A plugin tuple or none (the default for clients without plugins). */
export type PluginList = readonly Plugin[];
