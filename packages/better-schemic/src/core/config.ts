/**
 * Configuration for the `better-schemic` CLI — author it in `better-schemic.config.ts`
 * (`schemic.config.ts` still loads as a legacy alias).
 *
 * A project declares named CONNECTIONS, each built by the `surrealConnection` factory
 * (exported from `better-schemic/connection`). Connection values are EXPLICIT — there is no env-var
 * magic; read env yourself where you want it (`url: process.env.MY_URL`).
 * See `docs/MULTI-CONNECTION.md`.
 *
 * ```ts
 * import { defineConfig } from "better-schemic/config";
 * import { surrealConnection } from "better-schemic/connection";
 *
 * export default defineConfig({
 *   connections: {
 *     default: surrealConnection({
 *       schema: "./database/schema",
 *       url: "ws://localhost:8000",
 *       namespace: "app",
 *       database: "app",
 *     }),
 *   },
 * });
 * ```
 *
 * For more than one database (multi-tenant / heterogeneous / DB-per-user), add named connections;
 * a connection may be a resolver (incl. an array → a collection). See docs/MULTI-CONNECTION.md.
 *
 * NOTE: this file is dialect-NEUTRAL. Driver-specific connection shapes (SurrealDB's
 * url/namespace/authLevel, its check-engine options, …) live in the driver package's
 * `<driver>Connection` factory, not here.
 */
import type {
  AnyConnectionEntry,
  ConnectionConfigBase,
  ConnectionEntry,
  ConnectionInput,
  ResolveContext,
  ResolvedConnectionHandle,
} from "./connection"

/**
 * Module aliases used by the CLI's jiti loader when it imports the app's schema/modules. Values
 * are relative to the project root; both the exact key and a trailing-`/*` wildcard register them,
 * so `{ "@": "./src" }` resolves `@/env` as well as `@`.
 */
export type ResolveConfig = {
  readonly alias?: Record<string, string>
  /** Also honour `compilerOptions.paths` from the project's tsconfig. Default false. */
  readonly tsconfigPaths?: boolean | string
}

/** Settings for the static-getter ORM façade generator (`sc generate --orm`). */
export type OrmGeneratorConfig = {
  /** Expression returning the client. Default `getOrmClient`. */
  readonly client?: string
  /** Output module, relative to the project root. */
  readonly out?: string
  /** Module exporting the client resolver — relative to the generated file. */
  readonly provider?: string
  /** Module exporting the schema artifact — defaults to the connection's `schema` when a file. */
  readonly schema?: string
  /** Export name of the schema artifact. Default `schema`. */
  readonly schemaExport?: string
  /** Name of the generated const. Default `orm`. */
  readonly surface?: string
}

/** Settings for the AOT validator generator (`sc generate --aot`). */
export type AotGeneratorConfig = {
  /** Directory for the synthetic + compiled modules, relative to the project root. */
  readonly dir?: string
  /** Source files where the bootstrap import inserts it (idempotent). */
  readonly importIn?: readonly string[]
  /**
   * How the compiled validators get installed: `orm` imports the bootstrap from the generated ORM
   * façade (default), `bootstrap` emits one documented import, `none` leaves it to the app.
   */
  readonly installVia?: "bootstrap" | "none" | "orm"
  /** Bootstrap module, relative to the project root. */
  readonly out?: string
}

/** Declarative generators run together by `sc generate`. `false` disables one. */
export type GeneratorsConfig = {
  readonly aot?: AotGeneratorConfig | false
  readonly orm?: false | OrmGeneratorConfig
}

/** Directives and tool-ignore conventions applied to every generated artifact. */
export type GeneratedConfig = {
  /** Prepend the ESLint file-level disable directive. Default true. */
  readonly eslintDisable?: boolean
  /** Add generated paths to knip/tsconfig/bunfig ignores. Default `ignore`. */
  readonly knip?: "ignore" | "off"
  /** Actually merge those ignores into the app's config files. Default false. */
  readonly knipAutoWrite?: boolean
  /** Marker used for idempotence. Default `// @ts-nocheck — generated`. */
  readonly marker?: string
  /** Prepend `// @ts-nocheck — generated`. Default true. */
  readonly tsNocheck?: boolean
  /** Specifier used by zod-compiler's generated header. Default `better-schemic/zod`. */
  readonly zodSpecifier?: string
}

export type OrmConfig = {
  /** Named database connections — each produced by a per-driver `<driver>Connection(...)` factory. */
  connections: Record<string, AnyConnectionEntry>
  /**
   * With more than one connection, the connection a bare command targets (must name a single static
   * connection). Absent + ambiguous → a live command errors asking for `--connection`.
   */
  defaultConnection?: string
  /** Directives + tool ignores for the generated artifacts. */
  generated?: GeneratedConfig
  /** Declarative code generators — `sc generate` runs them from this config. */
  generators?: GeneratorsConfig
  /** Table that records applied migrations (per connection). Default `_migrations`. */
  migrationsTable?: string
  /** Aliases the CLI's jiti loader honours when importing schema modules (no symlinks needed). */
  resolve?: ResolveConfig
  /** Optional seed script run by `better-schemic seed`. */
  seed?: string
}

/**
 * Legacy alias — prefer {@link OrmConfig}.
 */
export type SchemicConfig = OrmConfig

/** The bound ORM client type a {@link ConnectionEntry} opens (inferred from the driver factory). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- wildcards bivariantes: `infer` estreita a inferência de clients/args no config.
export type EntryClient<E> = E extends ConnectionEntry<infer Client, any> ? Client : never
/** The typed resolver `args` a {@link ConnectionEntry} accepts (from its `args` schema). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mesmo wildcard bivariante de `EntryClient`.
export type EntryArgs<E> = E extends ConnectionEntry<any, infer Args> ? Args : never

/**
 * What {@link defineConfig} ADDS to your config: the config IS the app's typed entry point to its
 * databases. `connect(name, args?)` autocompletes your connection names, types `args` per connection
 * (the resolver's declared 2nd param — absent for a static/argless connection), and returns that
 * entry's own client type (a heterogeneous-driver project types per-connection). A PARAMETERIZED
 * connection whose resolver returns an ARRAY is bulk-: `connect` throws a teaching error — pass
 * `args` selecting ONE config. The client is disposable: `await using db = await orm.connect()`.
 */
/** Excludes the chained builder's initial sentinel key from the addressable connection names. */
type ConnectName<Conns> = Exclude<keyof Conns & string, "__better_schemic_empty__">

export type OrmProject<Conns extends Record<string, AnyConnectionEntry>> = {
  connect<N extends ConnectName<Conns>>(
    name?: N,
    args?: EntryArgs<Conns[N]>,
  ): Promise<EntryClient<Conns[N]>>
}

/**
 * Type + enrich a Better-schemic config: returns the config with a typed `connect()` attached — the config
 * itself is the factory. The loader accepts a `default` export OR the NAMED `orm` export
 * (`schemic` still loads as a legacy alias); the scaffolded form is the named one
 * (deterministic auto-import, no file rename needed):
 *
 * ```ts
 * // better-schemic.config.ts (better-schemic.ts, schemic.config.ts, and schemic.ts also load)
 * export const orm = defineConfig({ connections: { ... } });
 * // app code: import { orm } from "./better-schemic.config";  →  await using db = await orm.connect();
 * ```
 */
/**
 * A resolver's `ctx` in the CHAINED form: `connections` types it with the ACCUMULATED prior
 * connections — each handle is thenable to that entry's FULL ORM client (`const main = await
 * ctx.connections.main; main.select(...)`) and keeps a direct `.query`. Order = visibility: a
 * resolver  sees connections declared BEFORE it (structural cycle prevention). Do not stash a
 * sibling client — it's closed when resolution settles.
 */
export type ChainCtx<Conns extends Record<string, AnyConnectionEntry>> = Omit<
  ResolveContext,
  "connections"
> & {
  connections: {
    [K in keyof Conns]: PromiseLike<EntryClient<Conns[K]>> & ResolvedConnectionHandle
  }
}

/** The shape a driver connection factory must have to uss it as the `.connection()` driver marker. */
/* eslint-disable @typescript-eslint/no-explicit-any -- wildcards bivariantes no slot de args do factory (tipo público) */
export type ChainableDriverFactory<C extends ConnectionConfigBase, Client> = (
  input: ConnectionInput<C, any>,
) => ConnectionEntry<Client, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The CHAINED config builder (`defineConfig().connection(...)`): each `.connection(name, factory,
 * input)` uses the driver FACTORY ITSELF as the driver marker and contextually types the resolver's
 * `ctx.connections` with everything declared so far. The literal `defineConfig({ connections })`
 * form remains for static maps.
 */
export type ChainedConfig<Conns extends Record<string, AnyConnectionEntry>> = {
  connection<N extends string, C extends ConnectionConfigBase, Client, Args = undefined>(
    name: N,
    factory: ChainableDriverFactory<C, Client>,
    input: ((ctx: ChainCtx<Conns>, args: Args) => C | C[] | Promise<C | C[]>) | C,
  ): ChainedConfig<Conns & Record<N, ConnectionEntry<Client, Args>>>
  connections: Conns
  defaultConnection?: string
  generated?: GeneratedConfig
  generators?: GeneratorsConfig
  migrationsTable?: string
  resolve?: ResolveConfig
  seed?: string
} & OrmProject<Conns>

/** Start a CHAINED config: `defineConfig().connection("main", surrealConnection, {...})`. */
/** A sentinel key (filtered by {@link ConnectName}) keeps the initial map non-empty without widening `keyof`. */
type EmptyConnections = { readonly __better_schemic_empty__: AnyConnectionEntry }

export function defineConfig(base?: Omit<OrmConfig, "connections">): ChainedConfig<EmptyConnections>
/** Type + enrich a literal config — returns it with the typed `connect()` attached. */
export function defineConfig<const C extends OrmConfig>(config: C): C & OrmProject<C["connections"]>
export function defineConfig(config?: Omit<OrmConfig, "connections"> | OrmConfig): unknown {
  const isLiteral = !!config && "connections" in config
  const base: OrmConfig = isLiteral
    ? config
    : {
        ...config,
        connections: {},
      }

  const withApi = (cfg: OrmConfig): unknown => ({
    ...cfg,
    async connect(name?: string, args?: unknown): Promise<unknown> {
      // Lazy: authoring/loading a config stays light; the client machinery loads when used.
      const { connectFromConfig } = await import("./client")
      return connectFromConfig(cfg, name, args)
    },
    connection(
      name: string,
      factory: (input: unknown) => AnyConnectionEntry,
      input: unknown,
    ): unknown {
      // The factory IS the driver marker: it stamps the driver tag, config type, and client opener.
      // The chain re-types ctx/args itself, so the factory calls it through a variance cast.
      const entry = factory(input)
      return withApi({
        ...cfg,
        connections: { ...cfg.connections, [name]: entry },
      })
    },
  })

  return withApi(base)
}

/**
 * Legacy alias — prefer {@link OrmProject}.
 */
export type SchemicProject<Conns extends Record<string, AnyConnectionEntry>> = OrmProject<Conns>
