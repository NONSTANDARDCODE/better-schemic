// M4.1 — TYPE assertions for `client.transaction`: the callback receives a `TransactionClient`
// (delegates preserved, lifecycle/realtime stripped, `rollback` typed `never`), the options accept
// retries/timeout/isolation, `mode` is "sdk"-only and the root client keeps the after* scope hooks.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest, setup, teardown } from "@ark/attest";
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

let cleanup: (() => void) | undefined;
before(() => {
  cleanup = setup() as unknown as () => void;
});
after(() => {
  cleanup?.();
  teardown();
});

const User = defineTable("user", { name: s.string(), age: s.int() });
const schema = defineSchema({ users: User });
type C = Client<typeof schema>;
type Tx = TransactionClient<typeof schema>;

/** The call shapes (instantiation expressions don't survive esbuild/tsx). */
const openRoot = (client: C) => client.transaction(async () => 1);
const openNested = (tx: Tx) => tx.transaction(async () => "inner");

describe("client.transaction — typing", () => {
  it("the callback receives the transaction client and the call resolves the callback value", () => {
    attest<Promise<number>, ReturnType<typeof openRoot>>();
    const tx = {} as Tx;
    attest<Delegate<typeof User, typeof schema>, Tx["users"]>();
    attest<SurrealTransaction, Tx["$sdk"]>();
    attest<(reason?: unknown) => never, Tx["rollback"]>();
    attest<void, ReturnType<Tx["afterCommit"]>>();
    attest<void, ReturnType<Tx["afterRollback"]>>();
    // Transactions nest as a value on the tx client too.
    attest<Promise<string>, ReturnType<typeof openNested>>();
    void tx;
  });

  it("lifecycle, realtime and session-bound admin surfaces are NOT on the tx client", () => {
    attest<false, "close" extends keyof Tx ? true : false>();
    attest<false, "forkSession" extends keyof Tx ? true : false>();
    attest<false, "$withContext" extends keyof Tx ? true : false>();
    attest<false, "live" extends keyof Tx ? true : false>();
    attest<false, "liveOf" extends keyof Tx ? true : false>();
    attest<false, "kill" extends keyof Tx ? true : false>();
    attest<false, "changes" extends keyof Tx ? true : false>();
    attest<false, "export" extends keyof Tx ? true : false>();
    attest<false, "import" extends keyof Tx ? true : false>();
    attest<false, "version" extends keyof Tx ? true : false>();
    // The compiler-driven surfaces DO work in-transaction.
    attest<true, "$raw" extends keyof Tx ? true : false>();
    attest<true, "fn" extends keyof Tx ? true : false>();
    attest<true, "info" extends keyof Tx ? true : false>();
  });

  it("the root client exposes the transaction scope hooks", () => {
    attest<void, ReturnType<C["afterCommit"]>>();
    attest<void, ReturnType<C["afterRollback"]>>();
    attest<Promise<void>, ReturnType<C["close"]>>();
  });

  it("options: retries/timeout/isolation are typed; mode accepts only 'sdk'", () => {
    attest<
      false,
      "sql" extends NonNullable<TransactionOptions["mode"]> ? true : false
    >();
    attest<
      true,
      "sdk" extends NonNullable<TransactionOptions["mode"]> ? true : false
    >();
    attest<
      true,
      "writeConflict" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    attest<
      true,
      "serializationFailure" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    attest<
      true,
      "connectionError" extends NonNullable<RetryOptions["on"]>[number]
        ? true
        : false
    >();
    attest<
      true,
      "snapshot" extends NonNullable<TransactionOptions["isolation"]>
        ? true
        : false
    >();
  });
});
