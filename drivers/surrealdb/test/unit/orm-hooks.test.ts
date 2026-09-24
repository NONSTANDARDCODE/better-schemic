// M6.1 — the observation-hook dispatcher: routing by operation family, payloads (surql/vars/data/
// result/durationMs/count), meta merging, error routing, raw/transaction hooks and the no-hook fast
// path. Offline (recording fake connection).
import { describe, expect, test } from "bun:test";
import { AlreadyExistsError, RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { createHookDispatcher, resultCount } from "../../src/orm/hooks";
import { defineSchema } from "../../src/orm/schema";
import type {
  AfterHookPayload,
  ErrorHookPayload,
  HookPayload,
} from "../../src/orm/types/hooks";
import { defineRelation, defineTable, s } from "../../src/pure";
import { fail, fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string(), age: s.int() });
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(User);
const schema = defineSchema({ users: User, likes: Likes });

const dup = () =>
  new AlreadyExistsError({
    kind: "AlreadyExists",
    message: "Database record `user:dup` already exists",
  });

function clientWith() {
  return fakeConn((sql) => {
    if (sql.includes("dup")) return lines(sql).map(() => fail(dup()));
    return lines(sql).map(() =>
      ok([{ id: new RecordId("user", 1), name: "A", age: 1 }]),
    );
  });
}

describe("hooks — read operations", () => {
  test("beforeQuery/afterQuery carry table/operation/surql/vars/count/durationMs", async () => {
    const seen: { before?: HookPayload; after?: AfterHookPayload } = {};
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeQuery: (info) => {
          seen.before = info;
        },
        afterQuery: (info) => {
          seen.after = info;
        },
      },
    });
    const rows = await client.users.findMany({
      where: { name: "A" },
      meta: { requestId: "r1" },
    });
    expect(rows).toHaveLength(1);
    expect(seen.before?.table).toBe("user");
    expect(seen.before?.operation).toBe("findMany");
    expect(seen.before?.surql).toBe("SELECT * FROM user WHERE name = $p0");
    expect(seen.before?.vars).toEqual({ p0: "A" });
    expect(seen.before?.meta).toEqual({ requestId: "r1" });
    expect(seen.after?.count).toBe(1);
    expect(typeof seen.after?.durationMs).toBe("number");
    expect(seen.after?.result).toHaveLength(1);
  });

  test("count/exists/aggregate route to beforeQuery too", async () => {
    const ops: string[] = [];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeQuery: ({ operation }) => {
          ops.push(operation);
        },
      },
    });
    await client.users.count({});
    await client.users.exists({});
    await client.users.aggregate({ select: { _count: true }, groupAll: true });
    expect(ops).toEqual(["count", "exists", "aggregate"]);
  });

  test("meta merges $withContext scope then the per-call value (call wins)", async () => {
    let meta: Record<string, unknown> | undefined;
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeQuery: (info) => {
          meta = info.meta;
        },
      },
    });
    const scoped = client.$withContext({ meta: { scope: 1, shared: "scope" } });
    await scoped.users.findMany({ meta: { call: 2, shared: "call" } });
    expect(meta).toEqual({ scope: 1, call: 2, shared: "call" });
  });

  test("explain: true does NOT fire hooks", async () => {
    let fired = 0;
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeQuery: () => {
          fired++;
        },
        afterQuery: () => {
          fired++;
        },
      },
    });
    await client.users.findMany({ explain: true });
    await client.users.findMany({}).explain();
    expect(fired).toBe(0);
  });
});

describe("hooks — write operations", () => {
  test("beforeCreate/afterCreate carry data and result", async () => {
    const seen: { before?: HookPayload; after?: AfterHookPayload } = {};
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeCreate: (info) => {
          seen.before = info;
        },
        afterCreate: (info) => {
          seen.after = info;
        },
      },
    });
    await client.users.create({ data: { name: "A", age: 1 } });
    expect(seen.before?.operation).toBe("create");
    expect(seen.before?.data).toEqual({ name: "A", age: 1 });
    expect(seen.after?.result).toMatchObject({ name: "A", age: 1 });
  });

  test("update/delete route to beforeUpdate/beforeDelete with where", async () => {
    const ops: string[] = [];
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeUpdate: ({ operation }) => {
          ops.push(operation);
        },
        beforeDelete: ({ operation }) => {
          ops.push(operation);
        },
      },
    });
    await client.users.update({
      where: { id: "user:1" },
      mode: "set",
      data: { age: 2 },
    });
    await client.users.delete({ where: { id: "user:1" } });
    expect(ops).toEqual(["update", "delete"]);
  });

  test("relate/unrelate route to beforeRelate", async () => {
    const ops: string[] = [];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeRelate: ({ operation }) => {
          ops.push(operation);
        },
      },
    });
    await client.likes.relate({ from: "user:1", to: "user:2" });
    await client.likes.unrelate({ from: "user:1", to: "user:2" });
    expect(ops).toEqual(["relate", "unrelate"]);
  });
});

describe("hooks — errors, raw and transactions", () => {
  test("onError fires with the normalized failure and rethrows", async () => {
    const seen: ErrorHookPayload[] = [];
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        onError: (info) => {
          seen.push(info);
        },
      },
    });
    const error = await client.users
      .create({ data: { id: "user:dup", name: "dup", age: 1 } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("RecordAlreadyExists");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.operation).toBe("create");
    expect(seen[0]?.table).toBe("user");
  });

  test("beforeRaw/afterRaw fire around $raw; onRawError on a failed script", async () => {
    const events: string[] = [];
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeRaw: ({ operation }) => {
          events.push(`before:${operation}`);
        },
        afterRaw: ({ operation }) => {
          events.push(`after:${operation}`);
        },
        onRawError: ({ operation }) => {
          events.push(`error:${operation}`);
        },
      },
    });
    await client.$raw`SELECT * FROM user`;
    await client.$raw`SELECT * FROM dup`.catch(() => {});
    expect(events).toEqual([
      "before:$raw",
      "after:$raw",
      "before:$raw",
      "error:$raw",
    ]);
  });

  test("beforeTransaction/afterTransactionCommit fire around a commit", async () => {
    const events: string[] = [];
    const tx = {
      query(sql: string) {
        return { responses: async () => lines(sql).map(() => ok([])) };
      },
      commit: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    };
    const root = {
      query: () => ({ responses: async () => [] }),
      beginTransaction: () => Promise.resolve(tx),
    };
    const client = betterSchemic(root as never, {
      schema,
      hooks: {
        beforeTransaction: () => {
          events.push("before");
        },
        afterTransactionCommit: () => {
          events.push("commit");
        },
        afterTransactionRollback: () => {
          events.push("rollback");
        },
      },
    });
    await client.transaction(async (t) => {
      await t.users.findMany({});
    });
    expect(events).toEqual(["before", "commit"]);
  });

  test("afterTransactionRollback + onTransactionError fire on failure", async () => {
    const events: string[] = [];
    const tx = {
      query: () => ({ responses: async () => [] }),
      commit: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    };
    const root = {
      query: () => ({ responses: async () => [] }),
      beginTransaction: () => Promise.resolve(tx),
    };
    const client = betterSchemic(root as never, {
      schema,
      hooks: {
        afterTransactionRollback: () => {
          events.push("rollback");
        },
        onTransactionError: () => {
          events.push("error");
        },
      },
    });
    await client
      .transaction(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    expect(events).toEqual(["error", "rollback"]);
  });
});

describe("hooks — fast path and after-hook failures", () => {
  test("createHookDispatcher returns undefined when no hook is registered", () => {
    expect(createHookDispatcher([])).toBeUndefined();
    expect(createHookDispatcher([undefined])).toBeUndefined();
    expect(createHookDispatcher([{}])).toBeUndefined();
  });

  test("an after-hook failure is routed to onError and never fails the operation", async () => {
    const seen: ErrorHookPayload[] = [];
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        afterQuery: () => {
          throw new Error("metrics down");
        },
        onError: (info) => {
          seen.push(info);
        },
      },
    });
    const rows = await client.users.findMany({});
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const reported = seen[0]?.error as Error | undefined;
    expect(reported?.message).toBe("metrics down");
  });

  test("a before-hook failure aborts the operation", async () => {
    const { conn } = clientWith();
    const client = betterSchemic(conn, {
      schema,
      hooks: {
        beforeQuery: () => {
          throw new Error("blocked");
        },
      },
    });
    const error = await client.users.findMany({}).catch((e: unknown) => e);
    expect((error as Error).message).toBe("blocked");
  });

  test("an after-hook failure with no onError listener logs and leaves the operation standing", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const { conn } = clientWith();
      const client = betterSchemic(conn, {
        schema,
        hooks: {
          afterQuery: () => {
            throw new Error("metrics down");
          },
        },
      });
      expect(await client.users.findMany({})).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  test("an onError hook that throws is swallowed and logged", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const { conn } = clientWith();
      const client = betterSchemic(conn, {
        schema,
        hooks: {
          afterQuery: () => {
            throw new Error("after");
          },
          onError: () => {
            throw new Error("onError boom");
          },
        },
      });
      expect(await client.users.findMany({})).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});

describe("resultCount", () => {
  test("counts numbers/booleans/arrays/objects and treats null/undefined as 0", () => {
    expect(resultCount(5)).toBe(5);
    expect(resultCount(true)).toBe(1);
    expect(resultCount(false)).toBe(0);
    expect(resultCount([1, 2, 3])).toBe(3);
    expect(resultCount({ data: [1, 2] })).toBe(2);
    expect(resultCount({ count: 9 })).toBe(9);
    expect(resultCount({})).toBe(1);
    expect(resultCount(null)).toBe(0);
    expect(resultCount(undefined)).toBe(0);
  });
});
