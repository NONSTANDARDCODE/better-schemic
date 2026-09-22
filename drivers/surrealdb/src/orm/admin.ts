/**
 * The admin/introspection runtime — `info`/`version`/`ping`/`export`/`import`.
 *
 * `info` compiles `INFO FOR ROOT|NS|DB|TABLE <t>` (context-aware, one round-trip); `ping` is a
 * `RETURN true` round-trip because the SDK's `health()` is unavailable over WebSocket
 * (live-probed: "Method not found"); `version` uses the SDK (connection-level); `export` is
 * session-bound; `import` replays the dump through `query()` (context-aware, and the only form that
 * works over WS).
 */
import { escapeIdent } from "surrealdb";
import { compileError } from "./compiler/shared";
import { assertSessionBound, contextOption } from "./context";
import type { DelegateContext } from "./delegate";
import { BetterSchemicError, normalizeError } from "./errors";
import { execute, runScript, terminate } from "./execute";
import { statementResult } from "./results";
import type {
  AdminOperations,
  ExportOptions,
  ServerVersion,
} from "./types/admin";

/** Build the admin surface over one client context. */
export function createAdminOperations(ctx: DelegateContext): AdminOperations {
  const info = async (
    level: "root" | "ns" | "db" | "table",
    table?: string,
  ): Promise<unknown> => {
    const operation = "info";
    const clause =
      level === "table" ? `TABLE ${tableClause(table)}` : level.toUpperCase();
    const out = await execute(ctx.conn, {
      statements: [{ sql: `INFO FOR ${clause}` }],
      operation,
      debug: ctx.debug,
      ...(ctx.inTransaction === true ? { inTransaction: true } : {}),
      ...contextOption(ctx),
    });
    return out.rows[0];
  };

  const version = async (): Promise<ServerVersion> => {
    const sdk = ctx.conn as unknown as {
      version?: () => Promise<ServerVersion>;
    };
    if (typeof sdk.version !== "function")
      throw new BetterSchemicError(
        "UnsupportedCapability",
        "version() needs the SurrealDB SDK connection — this client wraps an object without `version()`.",
        { operation: "version" },
      );
    try {
      return await sdk.version();
    } catch (e) {
      throw normalizeError(e, { operation: "version" });
    }
  };

  const ping = async (): Promise<boolean> => {
    await execute(ctx.conn, {
      statements: [{ sql: "RETURN true" }],
      operation: "ping",
      debug: ctx.debug,
      ...(ctx.inTransaction === true ? { inTransaction: true } : {}),
      ...contextOption(ctx),
    });
    return true;
  };

  const exportDatabase = async (options?: ExportOptions): Promise<string> => {
    assertSessionBound(ctx.context, "export");
    const sdk = ctx.conn as unknown as {
      export?: (options?: ExportOptions) => Promise<unknown>;
    };
    if (typeof sdk.export !== "function")
      throw new BetterSchemicError(
        "UnsupportedCapability",
        "export() needs the SurrealDB SDK connection — this client wraps an object without `export()`.",
        { operation: "export" },
      );
    try {
      const dump = await sdk.export(options);
      if (typeof dump !== "string")
        throw new BetterSchemicError(
          "UnsupportedCapability",
          "export(): the connection returned a non-text dump (`.raw()`); use `$sdk.export().raw()` for streaming.",
          { operation: "export" },
        );
      return dump;
    } catch (e) {
      throw normalizeError(e, { operation: "export" });
    }
  };

  const importDatabase = async (dump: string): Promise<void> => {
    if (typeof dump !== "string" || dump.trim().length === 0)
      throw compileError(
        "ValidationError",
        "import() needs the SurrealQL dump string produced by export().",
        { operation: "import" },
      );
    const responses = await runScript(ctx.conn, terminate(dump), {
      ...contextOption(ctx),
      operation: "import",
      debug: ctx.debug,
    });
    // A dump may hold many statements; surface the FIRST failure instead of "importing" silently.
    const failure = responses
      .map((response, index) =>
        statementResult(response, {
          operation: "import",
          statementIndex: index,
        }),
      )
      .find((result) => result.status === "ERR");
    if (failure?.error) throw failure.error;
  };

  return {
    info,
    version,
    ping,
    export: exportDatabase,
    import: importDatabase,
  } as unknown as AdminOperations;
}

/** Validate + escape the table named by `INFO FOR TABLE`. */
function tableClause(table: string | undefined): string {
  if (typeof table !== "string" || table.length === 0)
    throw compileError(
      "ValidationError",
      'info("table", table): pass the table name as the second argument.',
      { operation: "info" },
    );
  return escapeIdent(table);
}
