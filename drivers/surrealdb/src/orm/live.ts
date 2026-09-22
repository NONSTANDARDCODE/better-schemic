/**
 * The live-query runtime — `client.users.live(args?, handler?)`, `client.live(table, …)`,
 * `client.liveOf(uuid, …)` and `client.kill(uuid)`.
 *
 * The statement is compiled BY THE ORM (`LIVE SELECT [DIFF] <projeção> FROM <tabela> [WHERE …]
 * [FETCH …]`) so the typed `where` keeps its parameter binds and fragment semantics; notifications
 * come from the SDK's `liveOf(uuid)` stream (WebSocket only) and are decoded through the model
 * codec. `kill()` is idempotent; `reconnect: true` (default) re-runs the LIVE and re-subscribes on
 * the SDK's `connected` event, emitting `RECONNECTED`.
 *
 * Live-probed constraints (`docs/orm-syntax-map.md` §7): `DIFF` cannot combine with a projection,
 * `FROM ONLY`/record targets are errors, a record leaving the `WHERE` filter emits nothing, and HTTP
 * connections answer `LiveQueryNotSupported`.
 */
import { ChannelIterator, type RecordId, Uuid } from "surrealdb";
import { type CompiledLive, compileLive } from "./compiler/live";
import type { ProjectionSpec } from "./compiler/projection";
import { compileError, createBinds, describeValue } from "./compiler/shared";
import { assertSessionBound } from "./context";
import { decodeRow } from "./decode";
import type { DelegateContext } from "./delegate";
import { BetterSchemicError, normalizeError } from "./errors";
import { execute, type Queryable } from "./execute";
import type { ModelMeta, SchemaIndex } from "./meta";
import type {
  LiveChange,
  LiveDefaults,
  LiveHandler,
  LiveId,
  LiveNotification,
  LiveSubscription,
} from "./types/live";
import type { PatchOp } from "./types/write";

/** The structural slice of the SDK live message the runtime reads. */
interface SdkLiveMessage {
  readonly queryId: Uuid;
  readonly action: "CREATE" | "UPDATE" | "DELETE" | "KILLED";
  readonly recordId: RecordId;
  readonly value: unknown;
}

/** The structural slice of the SDK live subscription the runtime drives. */
interface SdkLiveSubscription {
  readonly id: Uuid;
  readonly isAlive: boolean;
  kill(): Promise<void>;
  subscribe(handler: (message: SdkLiveMessage) => void): () => void;
}

/** The connection capabilities live needs (the SDK `Surreal`; HTTP engines throw on `liveOf`). */
interface LiveSource extends Queryable {
  liveOf(id: Uuid): Promise<SdkLiveSubscription> | SdkLiveSubscription;
  subscribe?(event: "connected", listener: () => void): () => void;
}

/** One decoded change, minus the uuid the subscription owns. */
type LiveChangeBody<Row> = Omit<LiveChange<Row>, "uuid">;

/** Turn one SDK message into a change body (no-op passthrough for `liveOf`). */
type LiveDecoder<Row> = (message: SdkLiveMessage) => LiveChangeBody<Row>;

/** The decoded body of a `KILLED` message (the server ended the live query). */
function killedChange<Row>(message: SdkLiveMessage): LiveChangeBody<Row> {
  return {
    action: "KILLED",
    value: null,
    recordId: message.recordId,
    result: message.value,
  };
}

/** Decode a notified row through the model codec. */
function makeDecoder<Row>(
  meta: ModelMeta,
  projection: ProjectionSpec,
  index: SchemaIndex | undefined,
  diff: boolean,
): LiveDecoder<Row> {
  return (message) => {
    if (message.action === "KILLED") return killedChange<Row>(message);
    if (diff)
      return {
        action: message.action,
        value: null,
        recordId: message.recordId,
        diff: (message.value ?? []) as readonly PatchOp[],
        result: message.value,
      };
    const raw = message.value;
    const value =
      raw === undefined || raw === null
        ? null
        : (decodeRow(raw, meta, projection, index) as Row);
    return {
      action: message.action,
      value,
      recordId: message.recordId,
      ...(raw !== undefined ? { result: raw } : {}),
    };
  };
}

/** The runtime subscription: channels + handler fan-out, kill and reconnect. */
class OrmLiveSubscription<Row> implements LiveSubscription<Row> {
  #uuid: string;
  #sdk: SdkLiveSubscription;
  #alive = true;
  #resubscribing = false;
  readonly #channels = new Set<ChannelIterator<LiveNotification<Row>>>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #handler?: LiveHandler<Row>;
  readonly #meta?: Record<string, unknown>;
  readonly #decode: LiveDecoder<Row>;
  readonly #reconnect?: () => Promise<{
    uuid: string;
    sdk: SdkLiveSubscription;
  }>;
  #unsubscribeSdk?: () => void;
  #unsubscribeSource?: () => void;

  constructor(spec: {
    readonly uuid: string;
    readonly sdk: SdkLiveSubscription;
    readonly decode: LiveDecoder<Row>;
    readonly handler?: LiveHandler<Row>;
    readonly meta?: Record<string, unknown>;
    readonly reconnect?: () => Promise<{
      uuid: string;
      sdk: SdkLiveSubscription;
    }>;
    readonly source?: LiveSource;
  }) {
    this.#uuid = spec.uuid;
    this.#sdk = spec.sdk;
    this.#decode = spec.decode;
    this.#handler = spec.handler;
    this.#meta = spec.meta;
    this.#reconnect = spec.reconnect;
    this.#bind(spec.sdk);
    if (spec.reconnect && spec.source?.subscribe)
      this.#unsubscribeSource = spec.source.subscribe("connected", () => {
        void this.#reconnectNow();
      });
  }

  get uuid(): string {
    return this.#uuid;
  }

  get isAlive(): boolean {
    return this.#alive;
  }

  get meta(): Record<string, unknown> | undefined {
    return this.#meta;
  }

  onError(handler: (error: Error) => void): void {
    this.#errors.add(handler);
  }

  async kill(): Promise<void> {
    if (!this.#alive) return;
    this.#alive = false;
    for (const channel of this.#channels) channel.cancel();
    this.#channels.clear();
    this.#unsubscribeSource?.();
    this.#unsubscribeSdk?.();
    try {
      await this.#sdk.kill();
    } catch (e) {
      // Already killed server-side (e.g. `client.kill(uuid)` first) — idempotent by contract.
      const normalized = normalizeError(e, { operation: "kill" });
      if (!/Cannot execute KILL statement using id/i.test(normalized.message))
        this.#emitError(normalized);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveNotification<Row>> {
    if (!this.#alive)
      throw new BetterSchemicError(
        "ValidationError",
        "live: this subscription was killed — start a new live query.",
        { operation: "live" },
      );
    const channel = new ChannelIterator<LiveNotification<Row>>(() => {
      this.#channels.delete(channel);
    });
    this.#channels.add(channel);
    return channel;
  }

  /** Wire one SDK subscription into this runtime (initial + every reconnect). */
  #bind(sdk: SdkLiveSubscription): void {
    this.#sdk = sdk;
    this.#unsubscribeSdk = sdk.subscribe((message) => this.#dispatch(message));
  }

  /** Decode one SDK message and fan it out (deserialize failures route to `onError`). */
  #dispatch(message: SdkLiveMessage): void {
    if (!this.#alive) return;
    let notification: LiveNotification<Row>;
    try {
      notification = {
        ...this.#decode(message),
        uuid: this.#uuid,
      } as LiveNotification<Row>;
    } catch (e) {
      this.#emitError(normalizeError(e, { operation: "live" }));
      return;
    }
    this.#emit(notification);
  }

  /** Emit the client-side `RECONNECTED` lifecycle event. */
  #dispatchReconnected(): void {
    this.#emit({
      action: "RECONNECTED",
      value: null,
      uuid: this.#uuid,
    } as LiveNotification<Row>);
  }

  /** Deliver one notification to the handler and every iterator channel. */
  #emit(notification: LiveNotification<Row>): void {
    if (this.#handler) {
      try {
        const result = this.#handler(notification);
        if (result && typeof (result as Promise<void>).catch === "function")
          (result as Promise<void>).catch((e) => {
            this.#emitError(normalizeError(e, { operation: "live" }));
          });
      } catch (e) {
        this.#emitError(normalizeError(e, { operation: "live" }));
      }
    }
    for (const channel of this.#channels) channel.submit(notification);
  }

  /** Re-run + re-subscribe after an SDK reconnection (single-flight). */
  async #reconnectNow(): Promise<void> {
    if (!this.#alive || !this.#reconnect || this.#resubscribing) return;
    this.#resubscribing = true;
    try {
      const next = await this.#reconnect();
      this.#unsubscribeSdk?.();
      this.#uuid = next.uuid;
      this.#bind(next.sdk);
      this.#dispatchReconnected();
    } catch (e) {
      this.#emitError(normalizeError(e, { operation: "live" }));
    } finally {
      this.#resubscribing = false;
    }
  }

  /** Route handler/stream failures to the observers (console when nobody listens). */
  #emitError(error: Error): void {
    if (this.#errors.size === 0) {
      console.error(
        "[better-schemic] live: unhandled notification error",
        error,
      );
      return;
    }
    for (const handler of this.#errors) {
      try {
        handler(error);
      } catch {
        // an error handler that throws must not cascade
      }
    }
  }
}

/** `liveOf` with a teaching error when the transport can't do live queries (HTTP). */
async function liveOf(
  source: LiveSource,
  id: Uuid,
  operation: string,
): Promise<SdkLiveSubscription> {
  if (typeof source.liveOf !== "function")
    throw new BetterSchemicError(
      "LiveQueryUnsupported",
      `${operation}: this connection cannot do live queries — live needs the SurrealDB SDK over WebSocket (HTTP engines do not support them).`,
      { operation },
    );
  try {
    return await source.liveOf(id);
  } catch (e) {
    if (e instanceof Error && /does not support the feature/i.test(e.message))
      throw new BetterSchemicError(
        "LiveQueryUnsupported",
        `${operation}: the connection does not support live queries (${e.message}).`,
        { operation, cause: e },
      );
    throw normalizeError(e, { operation });
  }
}

/** Run the LIVE statement and return the server uuid. */
async function startServerLive(
  ctx: DelegateContext,
  meta: ModelMeta,
  compiled: CompiledLive,
  binds: ReturnType<typeof createBinds>,
): Promise<Uuid> {
  const out = await execute(ctx.conn, {
    statements: [{ sql: compiled.sql, vars: binds.vars }],
    operation: "live",
    table: meta.name,
    debug: ctx.debug,
  });
  const id = out.rows[0];
  if (!(id instanceof Uuid))
    throw new BetterSchemicError(
      "DatabaseError",
      `live: the server did not return a live query id (got ${describeValue(id)}).`,
      { operation: "live", table: meta.name },
    );
  return id;
}

/** The reconnect replay for a delegate live: re-run the SAME compiled statement (same binds). */
function replay(
  ctx: DelegateContext,
  meta: ModelMeta,
  compiled: CompiledLive,
  binds: ReturnType<typeof createBinds>,
): () => Promise<{ uuid: string; sdk: SdkLiveSubscription }> {
  const source = ctx.conn as LiveSource;
  return async () => {
    const id = await startServerLive(ctx, meta, compiled, binds);
    const sdk = await liveOf(source, id, "live");
    return { uuid: id.toString(), sdk };
  };
}

/**
 * Start a delegate live query. The statement is compiled eagerly (bad args throw at the call
 * site); the server uuid is awaited before the subscription resolves, so mutations made after
 * `await live(...)` are always observed.
 */
export async function startLive(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: unknown,
  handler?: LiveHandler<unknown>,
  operation = "live",
): Promise<LiveSubscription<unknown>> {
  if (ctx.inTransaction === true)
    throw new BetterSchemicError(
      "LiveInTransaction",
      `${operation}: live queries cannot run inside a transaction — subscribe outside client.transaction(...).`,
      { operation, table: meta.name },
    );
  const binds = createBinds();
  const compiled = compileLive(meta, args, binds, operation, {
    index: ctx.index,
  });
  const source = ctx.conn as LiveSource;
  const defaults: LiveDefaults = ctx.live ?? {};
  const decode = makeDecoder<unknown>(
    meta,
    compiled.projection,
    ctx.index,
    compiled.diff,
  );
  const connect = replay(ctx, meta, compiled, binds);
  const first = await connect();
  const meta_ = (args as { meta?: Record<string, unknown> } | undefined)?.meta;
  return new OrmLiveSubscription<unknown>({
    uuid: first.uuid,
    sdk: first.sdk,
    decode,
    ...(handler !== undefined ? { handler } : {}),
    ...(meta_ !== undefined ? { meta: meta_ } : {}),
    ...(defaults.reconnect !== false ? { reconnect: connect } : {}),
    source,
  });
}

/** The delegate-facing `live(args?, handler?)` (validates the handler shape eagerly). */
export function createLiveOperation(
  meta: ModelMeta,
  ctx: DelegateContext,
): (args?: unknown, handler?: unknown) => Promise<LiveSubscription<unknown>> {
  return (args?: unknown, handler?: unknown) => {
    assertSessionBound(ctx.context, "live");
    if (handler !== undefined && typeof handler !== "function")
      throw compileError(
        "ValidationError",
        `live: the handler must be a function (got ${describeValue(handler)}).`,
        { operation: "live", table: meta.name },
      );
    return startLive(
      meta,
      ctx,
      args ?? {},
      handler as LiveHandler<unknown> | undefined,
    );
  };
}

/** Validate a live query id (string or SDK `Uuid`). */
function liveIdText(id: LiveId, operation: string): string {
  const text =
    id instanceof Uuid
      ? id.toString()
      : typeof id === "string"
        ? id
        : undefined;
  if (
    !text ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      text,
    )
  )
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: pass the live query uuid (got ${describeValue(id)}).`,
      { operation },
    );
  return text;
}

/** Reattach to an existing live query (`client.liveOf`) — rows are NOT decoded (no table meta). */
export async function reattachLive(
  conn: Queryable,
  id: LiveId,
  handler?: LiveHandler<Record<string, unknown>>,
): Promise<LiveSubscription<Record<string, unknown>>> {
  const text = liveIdText(id, "liveOf");
  const source = conn as LiveSource;
  const sdk = await liveOf(source, new Uuid(text), "liveOf");
  return new OrmLiveSubscription<Record<string, unknown>>({
    uuid: text,
    sdk,
    decode: (message) =>
      message.action === "KILLED"
        ? killedChange<Record<string, unknown>>(message)
        : {
            action: message.action,
            value:
              (message.value as Record<string, unknown> | null | undefined) ??
              null,
            recordId: message.recordId,
            result: message.value,
          },
    ...(handler !== undefined ? { handler } : {}),
  });
}

/** `client.kill(uuid)` — end a live query on the server (the uuid is validated + bound). */
export async function killLive(
  conn: Queryable,
  id: LiveId,
  debug = false,
): Promise<void> {
  const text = liveIdText(id, "kill");
  await execute(conn, {
    statements: [{ sql: "KILL $p0", vars: { p0: text } }],
    operation: "kill",
    debug,
  });
}
