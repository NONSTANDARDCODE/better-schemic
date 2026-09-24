// M4.1 — `client.transaction`: the managed-transaction runtime over a recording fake. Covers
// commit/cancel, rollback, nested scope, afterCommit/afterRollback, retries, deadline, the
// `inTransaction` threading (batches skip their implicit BEGIN) and option validation.
import { describe, expect, test } from "bun:test";
import type { QueryResponse } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { BetterSchemicError, isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { caught, lines, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

interface TxCall {
  readonly sql: string;
  readonly vars?: Record<string, unknown>;
}

/** A fake managed transaction: records statements, counts commit/cancel. */
function fakeTx() {
  const calls: TxCall[] = [];
  const tx = {
    calls,
    committed: 0,
    cancelled: 0,
    query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return {
        responses: async (): Promise<QueryResponse<unknown>[]> =>
          lines(sql).map(() => ok([])),
      };
    },
    commit() {
      tx.committed++;
      return Promise.resolve();
    },
    cancel() {
      tx.cancelled++;
      return Promise.resolve();
    },
  };
  return tx;
}

/** A fake root connection whose `beginTransaction()` hands back a fresh {@link fakeTx}. */
function fakeRoot(
  onBegin?: (count: number) => void,
  handler?: (
    sql: string,
    vars?: Record<string, unknown>,
  ) => QueryResponse<unknown>[],
) {
  const rootCalls: TxCall[] = [];
  const transactions: ReturnType<typeof fakeTx>[] = [];
  const conn = {
    beginCalls: 0,
    rootCalls,
    transactions,
    query(sql: string, vars?: Record<string, unknown>) {
      rootCalls.push({ sql, vars });
      return {
        responses: async (): Promise<QueryResponse<unknown>[]> =>
          handler ? handler(sql, vars) : lines(sql).map(() => ok([])),
      };
    },
    beginTransaction() {
      conn.beginCalls++;
      onBegin?.(conn.beginCalls);
      const tx = fakeTx();
      transactions.push(tx);
      return Promise.resolve(tx);
    },
  };
  return conn;
}

const clientOver = (
  conn: ReturnType<typeof fakeRoot>,
  transaction?: Parameters<typeof betterSchemic>[1]["transaction"],
) =>
  betterSchemic(conn as never, {
    schema,
    ...(transaction !== undefined ? { transaction } : {}),
  });

const codeOf = (e: unknown): string | undefined =>
  isBetterSchemicError(e) ? e.code : undefined;

describe("client.transaction — commit/cancel/rollback", () => {
  test("success commits once, returns the callback value and runs delegates on the tx", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const value = await client.transaction(async (tx) => {
      await tx.users.findMany({ where: { name: "A" } });
      return 42;
    });
    expect(value).toBe(42);
    expect(conn.beginCalls).toBe(1);
    expect(conn.transactions[0]?.committed).toBe(1);
    expect(conn.transactions[0]?.cancelled).toBe(0);
    expect(conn.transactions[0]?.calls[0]?.sql).toBe(
      "SELECT * FROM user WHERE name = $p0;",
    );
    expect(conn.rootCalls).toHaveLength(0);
  });

  test("batches inside the transaction SKIP the implicit BEGIN/COMMIT wrapper", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    await client.transaction(async (tx) => {
      await tx.users.createMany({ data: [{ name: "A" }, { name: "B" }] });
    });
    const sql = conn.transactions[0]?.calls[0]?.sql ?? "";
    expect(sql).toContain("CREATE user CONTENT $p0;");
    expect(sql).not.toContain("BEGIN TRANSACTION");
    expect(sql).not.toContain("COMMIT TRANSACTION");
  });

  test("an exception cancels, propagates and does NOT commit", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(async () => {
        throw new BetterSchemicError("AssertionFailed", "nope");
      }),
    );
    expect(codeOf(err)).toBe("AssertionFailed");
    expect(conn.transactions[0]?.committed).toBe(0);
    expect(conn.transactions[0]?.cancelled).toBe(1);
  });

  test("tx.rollback(reason) cancels and rejects with TransactionRollback + details.reason", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(async (tx) => {
        tx.rollback("saldo insuficiente");
        return "unreachable";
      }),
    );
    expect(codeOf(err)).toBe("TransactionRollback");
    expect((err as BetterSchemicError).details).toMatchObject({
      reason: "saldo insuficiente",
    });
    expect(conn.transactions[0]?.cancelled).toBe(1);
    expect(conn.transactions[0]?.committed).toBe(0);
  });

  test("a swallowed rollback signal still aborts (state is the source of truth)", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(async (tx) => {
        try {
          tx.rollback("swallowed");
        } catch {
          // user code ignores the unwind
        }
        return "kept going";
      }),
    );
    expect(codeOf(err)).toBe("TransactionRollback");
    expect(conn.transactions[0]?.committed).toBe(0);
  });

  test("nested tx.transaction runs in the SAME transaction (no second begin)", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const out = await client.transaction(async (tx) => {
      const inner = await tx.transaction(async (inner) => {
        await inner.users.findMany();
        return "inner";
      });
      return inner;
    });
    expect(out).toBe("inner");
    expect(conn.beginCalls).toBe(1);
    expect(conn.transactions[0]?.committed).toBe(1);
    expect(conn.transactions[0]?.calls).toHaveLength(1);
  });

  test("root re-entry while a transaction is active throws TransactionAlreadyActive", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(async () => {
        await client.transaction(async () => "again");
      }),
    );
    expect(codeOf(err)).toBe("TransactionAlreadyActive");
    expect(conn.beginCalls).toBe(1);
  });

  test("afterCommit runs after the commit; afterRollback on failure", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const events: string[] = [];
    await client.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push("commit");
      });
      tx.afterRollback(() => {
        events.push("rollback");
      });
      events.push("body");
    });
    expect(events).toEqual(["body", "commit"]);
    const conn2 = fakeRoot();
    const client2 = clientOver(conn2);
    await caught(() =>
      client2.transaction(async (tx) => {
        tx.afterCommit(() => {
          events.push("commit2");
        });
        tx.afterRollback((reason) => {
          events.push(`rollback2:${reason}`);
        });
        throw new Error("boom");
      }),
    );
    expect(events).toEqual(["body", "commit", "rollback2:Error: boom"]);
  });

  test("client.afterCommit reaches the CURRENT scope; outside a transaction it fails fast", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const events: string[] = [];
    await client.transaction(async () => {
      client.afterCommit(() => {
        events.push("root-scope");
      });
    });
    expect(events).toEqual(["root-scope"]);
    const err = (() => {
      try {
        client.afterCommit(() => {});
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(codeOf(err)).toBe("ValidationError");
    expect((err as Error).message).toContain("active transaction");
  });

  test("afterCommit/afterRollback fail once the transaction settled", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    let tx: { afterCommit(cb: () => void): void } | undefined;
    await client.transaction(async (handle) => {
      tx = handle as unknown as { afterCommit(cb: () => void): void };
    });
    const err = (() => {
      try {
        tx?.afterCommit(() => {});
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(codeOf(err)).toBe("ValidationError");
  });
});

describe("client.transaction — retries and deadline", () => {
  test("no retry by default: a WriteConflict propagates on the first attempt", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    let attempts = 0;
    const err = await caught(() =>
      client.transaction(async () => {
        attempts++;
        throw new BetterSchemicError("WriteConflict", "conflict");
      }),
    );
    expect(codeOf(err)).toBe("WriteConflict");
    expect(attempts).toBe(1);
    expect(conn.beginCalls).toBe(1);
  });

  test("retries on writeConflict and re-runs the callback from scratch", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn, {
      retries: { attempts: 3, delayMs: (attempt) => attempt },
    });
    let attempts = 0;
    const value = await client.transaction(async () => {
      attempts++;
      if (attempts < 3) throw new BetterSchemicError("WriteConflict", "again");
      return "ok";
    });
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(conn.beginCalls).toBe(3);
    // Every failed attempt was cancelled; only the last one committed.
    expect(conn.transactions.map((t) => t.cancelled)).toEqual([1, 1, 0]);
    expect(conn.transactions.map((t) => t.committed)).toEqual([0, 0, 1]);
  });

  test("a non-retryable failure is not retried even with attempts > 1", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn, { retries: { attempts: 5 } });
    let attempts = 0;
    await caught(() =>
      client.transaction(async () => {
        attempts++;
        throw new BetterSchemicError("AssertionFailed", "no retry");
      }),
    );
    expect(attempts).toBe(1);
  });

  test("connectionError retry maps socket-style failures", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn, {
      retries: { attempts: 2, on: ["connectionError"] },
    });
    let attempts = 0;
    const value = await client.transaction(async () => {
      attempts++;
      if (attempts === 1)
        throw new BetterSchemicError(
          "DatabaseError",
          "connection reset by peer",
        );
      return "recovered";
    });
    expect(value).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("timeout cancels the transaction and fails with DatabaseError details.timedOut", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return "late";
        },
        { timeout: 20 },
      ),
    );
    expect(codeOf(err)).toBe("DatabaseError");
    expect((err as BetterSchemicError).details).toMatchObject({
      timedOut: true,
      timeoutMs: 20,
    });
    expect(conn.transactions[0]?.cancelled).toBe(1);
  });

  test("a timed-out transaction whose late commit fails still surfaces the timeout error", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const started = client.transaction(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "late";
      },
      { timeout: 10 },
    );
    // The managed tx is created synchronously inside the call; a cancelled transaction can't
    // commit, so the late settle throws — exercising the `if (timedOut)` catch arm. The final
    // wait lets that background settle land inside this test (not after the process exits).
    conn.transactions[0]!.commit = () => Promise.reject(new Error("cancelled"));
    const err = await caught(() => started);
    expect(codeOf(err)).toBe("DatabaseError");
    expect((err as BetterSchemicError).details).toMatchObject({
      timedOut: true,
    });
    expect(conn.transactions[0]?.cancelled).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  test("duration strings are accepted for timeout", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const value = await client.transaction(async () => "fast", {
      timeout: "1s",
    });
    expect(value).toBe("fast");
  });
});

describe("client.transaction — options validation and unsupported features", () => {
  test("mode 'sql' fails fast with UnsupportedCapability", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const err = await caught(() =>
      client.transaction(async () => "x", {
        mode: "sql" as never,
      }),
    );
    expect(codeOf(err)).toBe("UnsupportedCapability");
    expect((err as Error).message).toContain("sdk");
  });

  test("isolation honours onUnsupported: throw/warn/ignore", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const thrown = await caught(() =>
      client.transaction(async () => "x", {
        isolation: "snapshot",
        onUnsupported: "throw",
      }),
    );
    expect(codeOf(thrown)).toBe("UnsupportedCapability");
    const ignored = await client.transaction(async () => "x", {
      isolation: "snapshot",
      onUnsupported: "ignore",
    });
    expect(ignored).toBe("x");
  });

  test("invalid retry/timeout options throw ValidationError", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn);
    const cases = [
      { retries: { attempts: 0 } },
      { retries: { on: ["nope" as never] } },
      { retries: { delayMs: -1 } },
      { retries: { delayMs: "soon" as never } },
      { timeout: "30 minutes" },
      { timeout: -5 },
    ];
    for (const options of cases) {
      const err = await caught(() =>
        client.transaction(async () => "x", options as never),
      );
      expect(codeOf(err)).toBe("ValidationError");
    }
  });

  test("a connection without beginTransaction fails with UnsupportedCapability", async () => {
    const conn = fakeRoot();
    // Strip the managed transaction surface (an HTTP engine behaves like this).
    const bare = {
      query: conn.query,
    };
    const client = betterSchemic(bare as never, { schema });
    const err = await caught(() => client.transaction(async () => "x"));
    expect(codeOf(err)).toBe("UnsupportedCapability");
  });

  test("client-level defaults apply (retries/attempts) and are overridable per call", async () => {
    const conn = fakeRoot();
    const client = clientOver(conn, { retries: { attempts: 2 } });
    let attempts = 0;
    const err = await caught(() =>
      client.transaction(
        async () => {
          attempts++;
          throw new BetterSchemicError("WriteConflict", "conflict");
        },
        { retries: { attempts: 1 } },
      ),
    );
    expect(codeOf(err)).toBe("WriteConflict");
    expect(attempts).toBe(1);
  });
});
