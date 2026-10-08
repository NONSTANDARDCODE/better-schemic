// M4.1 — TYPE assertions for `client.transaction`: the callback receives a `TransactionClient`
// (delegates preserved, lifecycle/realtime stripped, `rollback` typed `never`), the options accept
// retries/timeout/isolation, `mode` is "sdk"-only and the root client keeps the after* scope hooks.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import type { SurrealTransaction } from "surrealdb";
import { defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import { defineSchema } from "../../src/orm/schema";
import type {
  RetryOptions,
  TransactionClient,
  TransactionOptions,
} from "../../src/orm/types/transaction";


const User = defineTable("user", { name: s.string(), age: s.int() });
const schema = defineSchema({ users: User });
type C = Client<typeof schema>;
type Tx = TransactionClient<typeof schema>;

/** The call shapes (instantiation expressions don't survive esbuild/tsx). */
const openRoot = (client: C) => client.transaction(async () => 1);
const openNested = (tx: Tx) => tx.transaction(async () => "inner");

describe("client.transaction — typing", () => {
  it("the callback receives the transaction client and the call resolves the callback value", () => {
    assertType<Promise<number>, ReturnType<typeof openRoot>>();
    const tx = {} as Tx;
    assertType<Delegate<typeof User, typeof schema>, Tx["users"]>();
    assertType<SurrealTransaction, Tx["$sdk"]>();
    assertType<(reason?: unknown) => never, Tx["rollback"]>();
    assertType<void, ReturnType<Tx["afterCommit"]>>();
    assertType<void, ReturnType<Tx["afterRollback"]>>();
    // Transactions nest as a value on the tx client too.
    assertType<Promise<string>, ReturnType<typeof openNested>>();
    void tx;
  });

  it("lifecycle, realtime and session-bound admin surfaces are NOT on the tx client", () => {
    assertType<false, "close" extends keyof Tx ? true : false>();
    assertType<false, "forkSession" extends keyof Tx ? true : false>();
    assertType<false, "$withContext" extends keyof Tx ? true : false>();
    assertType<false, "live" extends keyof Tx ? true : false>();
    assertType<false, "liveOf" extends keyof Tx ? true : false>();
    assertType<false, "kill" extends keyof Tx ? true : false>();
    assertType<false, "changes" extends keyof Tx ? true : false>();
    assertType<false, "export" extends keyof Tx ? true : false>();
    assertType<false, "import" extends keyof Tx ? true : false>();
    assertType<false, "version" extends keyof Tx ? true : false>();
    // The compiler-driven surfaces DO work in-transaction.
    assertType<true, "$raw" extends keyof Tx ? true : false>();
    assertType<true, "fn" extends keyof Tx ? true : false>();
    assertType<true, "info" extends keyof Tx ? true : false>();
  });

  it("the root client exposes the transaction scope hooks", () => {
    assertType<void, ReturnType<C["afterCommit"]>>();
    assertType<void, ReturnType<C["afterRollback"]>>();
    assertType<Promise<void>, ReturnType<C["close"]>>();
  });

  it("options: retries/timeout/isolation are typed; mode accepts only 'sdk'", () => {
    assertType<
      false,
      "sql" extends NonNullable<TransactionOptions["mode"]> ? true : false
    >();
    assertType<
      true,
      "sdk" extends NonNullable<TransactionOptions["mode"]> ? true : false
    >();
    assertType<
      true,
      "writeConflict" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    assertType<
      true,
      "serializationFailure" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    assertType<
      true,
      "connectionError" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    assertType<
      true,
      "snapshot" extends NonNullable<TransactionOptions["isolation"]>
        ? true
        : false
    >();
  });
});
