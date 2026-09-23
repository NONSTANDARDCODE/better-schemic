/**
 * The plugin runtime — `definePlugin` plus the pipeline every client builds from `plugins: [...]`.
 *
 * A plugin can:
 * - declare extra per-operation args (`operationArgs`) — typed, passed through untouched;
 * - MUTATE an operation before it compiles (`transform`, synchronous and ordered; setting `kind`
 *   re-dispatches, returning `false` skips the operation);
 * - observe every operation (`hooks`, merged with the client's own);
 * - graft methods onto the client (`extendClient`) or each delegate (`extendModel`);
 * - validate itself once at bootstrap (`setup`).
 *
 * `transform` is deliberately SYNCHRONOUS so compilation stays eager (a bad arg still throws at the
 * call site); async work belongs in a hook. Plugins are resolved once per client; each delegate
 * carries its own `state` (mutated via `$withState`, disabled via `$withoutPlugins`).
 */
import { BetterSchemicError } from "./errors";
import type { SchemaIndex } from "./meta";
import type { Hooks, OperationKind } from "./types/hooks";
import {
  type Operation,
  PLUGIN_BRAND,
  type Plugin,
  type PluginClientContext,
  type PluginModelContext,
  type PluginSpec,
  type PluginState,
} from "./types/plugins";

/**
 * Define a plugin. The concrete spec is preserved, so a client built with `plugins: [p]` folds `p`'s
 * `operationArgs` into the delegate methods' args and its `extendClient`/`extendModel` return types
 * into the surface.
 *
 * ```ts
 * export const timestamps = definePlugin({
 *   id: "@acme/timestamps",
 *   config: { createdAt: "createdAt", updatedAt: "updatedAt" },
 *   transform(op) {
 *     if (op.kind === "create") op.data[this.config.createdAt] ??= surql`time::now()`;
 *     if (op.kind === "update") op.data[this.config.updatedAt] = surql`time::now()`;
 *   },
 * });
 * ```
 */
export function definePlugin<Cfg, const Spec extends PluginSpec<Cfg>>(
  spec: Spec & { readonly config?: Cfg },
): Spec & { readonly [PLUGIN_BRAND]: true } {
  return { ...spec, [PLUGIN_BRAND]: true } as Spec & {
    readonly [PLUGIN_BRAND]: true;
  };
}

/** The `this` a plugin method runs with. */
function pluginContext<Cfg>(
  plugin: Plugin<Cfg>,
  state: PluginState,
): { config: Cfg; state: PluginState } {
  return { config: plugin.config as Cfg, state };
}

/** Wrap a plugin failure with its id so the source is obvious. */
function pluginFailure(
  plugin: Plugin,
  phase: string,
  cause: unknown,
): BetterSchemicError {
  if (cause instanceof BetterSchemicError) return cause;
  return new BetterSchemicError(
    "PluginError",
    `plugin "${plugin.id}": ${phase} failed${cause instanceof Error ? ` — ${cause.message}` : ""}.`,
    { operation: phase, cause },
  );
}

/** The resolved plugin pipeline of one client (absent when no plugin is registered). */
export interface PluginPipeline {
  readonly plugins: readonly Plugin[];
  /** Hooks contributed by every plugin, in registration order (merged into the dispatcher). */
  readonly hooks: readonly Hooks[];
  /** True when at least one plugin mutates operations (skips the dispatch wrapper otherwise). */
  readonly hasTransforms: boolean;
  /** Run every plugin's `setup` once (throws `PluginError` on failure). */
  setup(index: SchemaIndex, client: unknown): void;
  /** Run transforms for one operation; returns true when a plugin asked to skip it. */
  transform(operation: Operation): boolean;
  /** The methods every plugin's `extendClient` contributes. */
  extendClient(ctx: PluginClientContext): Record<string, unknown>;
  /** The methods every plugin's `extendModel` contributes (for one delegate's state). */
  extendModel(
    ctx: PluginModelContext,
    state: PluginState,
  ): Record<string, unknown>;
}

/** Validate the plugin list (unique, non-empty ids). */
function validatePlugins(plugins: readonly Plugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (typeof plugin.id !== "string" || plugin.id.length === 0)
      throw new BetterSchemicError(
        "PluginError",
        "every plugin needs a non-empty `id`.",
      );
    if (seen.has(plugin.id))
      throw new BetterSchemicError(
        "PluginError",
        `duplicate plugin id "${plugin.id}" — plugin ids must be unique.`,
      );
    seen.add(plugin.id);
  }
}

/** Build the pipeline for a client, or `undefined` when there is no plugin. */
export function createPluginPipeline(
  plugins: readonly Plugin[] | undefined,
): PluginPipeline | undefined {
  if (!plugins || plugins.length === 0) return undefined;
  validatePlugins(plugins);
  const hooks = plugins
    .map((plugin) => plugin.hooks)
    .filter((value): value is Hooks => value !== undefined);
  const hasTransforms = plugins.some(
    (plugin) => typeof plugin.transform === "function",
  );

  return {
    plugins,
    hooks,
    hasTransforms,
    setup(index, client) {
      for (const plugin of plugins) {
        if (typeof plugin.setup !== "function") continue;
        try {
          plugin.setup.call(pluginContext(plugin, {}), { index });
        } catch (e) {
          throw pluginFailure(plugin, "setup", e);
        }
        void client;
      }
    },
    transform(operation) {
      let skipped = false;
      for (const plugin of plugins) {
        if (typeof plugin.transform !== "function") continue;
        const result = plugin.transform.call(
          pluginContext(plugin, operation.state),
          operation,
        );
        if (result === false) skipped = true;
      }
      return skipped;
    },
    extendClient(ctx) {
      const out: Record<string, unknown> = {};
      for (const plugin of plugins) {
        if (typeof plugin.extendClient !== "function") continue;
        try {
          Object.assign(
            out,
            plugin.extendClient.call(pluginContext(plugin, {}), ctx),
          );
        } catch (e) {
          throw pluginFailure(plugin, "extendClient", e);
        }
      }
      return out;
    },
    extendModel(ctx, state) {
      const out: Record<string, unknown> = {};
      for (const plugin of plugins) {
        if (typeof plugin.extendModel !== "function") continue;
        try {
          Object.assign(
            out,
            plugin.extendModel.call(pluginContext(plugin, state), ctx),
          );
        } catch (e) {
          throw pluginFailure(plugin, "extendModel", e);
        }
      }
      return out;
    },
  };
}

/** The mutable operation view handed to `transform` (where/data proxy into `args`). */
export class RuntimeOperation implements Operation {
  kind: OperationKind;
  readonly table: string;
  readonly args: Record<string, unknown>;
  readonly state: PluginState;
  meta?: Record<string, unknown>;

  constructor(
    kind: OperationKind,
    table: string,
    args: Record<string, unknown>,
    state: PluginState,
    meta?: Record<string, unknown>,
  ) {
    this.kind = kind;
    this.table = table;
    this.args = args;
    this.state = state;
    if (meta !== undefined) this.meta = meta;
  }

  get where(): Record<string, unknown> {
    if (this.args.where === undefined) this.args.where = {};
    return this.args.where as Record<string, unknown>;
  }

  set where(value: Record<string, unknown>) {
    this.args.where = value;
  }

  get data(): Record<string, unknown> {
    if (this.args.data === undefined) this.args.data = {};
    return this.args.data as Record<string, unknown>;
  }

  set data(value: Record<string, unknown>) {
    this.args.data = value;
  }
}

/** True when `value` is a `definePlugin` artifact. */
export function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[PLUGIN_BRAND] === true
  );
}
