// M4.1 — transactions end-to-end: managed commit/cancel, rollback on error and explicit, batches
// inside the transaction (no nested BEGIN), afterCommit/afterRollback ordering, a REAL write
// conflict (two connections, concurrent transactions) and the retry path. Ephemeral server;
// skipped without a `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  type EphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s, surql } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { isTransactionRollback, isWriteConflict } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught } from "../orm-fixtures";
import { connectRoot, startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-transactions] `surreal` binary unavailable — skipping");

const Account = defineTable("tx_account", {
  name: s.string(),
  balance: s.int(),
});
const schema = defineSchema({ accounts: Account });

live("orm transactions — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  const connect = (): Promise<Surreal> => connectRoot(server, "orm_tx", "live");

  beforeAll(async () => {
    const started = await startLiveServer({
      namespace: "orm_tx",
      database: "live",
      ddl: `
        DEFINE TABLE tx_account SCHEMAFULL;
        DEFINE FIELD name ON tx_account TYPE string;
        DEFINE FIELD balance ON tx_account TYPE int;
        CREATE tx_account:a CONTENT { name: "A", balance: 100 };
        CREATE tx_account:b CONTENT { name: "B", balance: 50 };
      `,
    });
    server = started.server;
    db = started.db;
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("commit persists every operation of the callback (delegates + batch)", async () => {
    const result = await client.transaction(async (tx) => {
      const from = await tx.accounts
        .update({
          where: { id: "tx_account:a" },
          mode: "set",
          data: { balance: surql`balance - ${30}` },
          return: "after",
        })
        .throw();
      await tx.accounts.update({
        where: { id: "tx_account:b" },
        mode: "set",
        data: { balance: surql`balance + ${30}` },
      });
      await tx.accounts.createMany({
        data: [
          { name: "batch1", balance: 0 },
          { name: "batch2", balance: 0 },
        ],
      });
      return from;
    });
    expect(result).toMatchObject({ name: "A", balance: 70 });
    const rows = await client.accounts.findMany({
      select: { name: true, balance: true },
      orderBy: [{ name: "asc" }],
    });
    expect(rows.map((r) => r.balance)).toEqual([70, 80, 0, 0]);
  });

  test("an exception cancels the WHOLE callback (no partial commit)", async () => {
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await tx.accounts.update({
          where: { id: "tx_account:a" },
          mode: "set",
          data: { balance: 1 },
        });
        throw new Error("abort");
      }),
    );
    expect((err as Error).message).toContain("abort");
    const [a] = await client.accounts.findMany({
      where: { id: "tx_account:a" },
      select: { balance: true },
    });
    expect(a?.balance).toBe(70);
  });

  test("tx.rollback(reason) cancels and rejects with TransactionRollback", async () => {
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await tx.accounts.update({
          where: { id: "tx_account:b" },
          mode: "set",
          data: { balance: 999 },
        });
        tx.rollback("regra de negócio");
      }),
    );
    expect(isTransactionRollback(err)).toBe(true);
    const [b] = await client.accounts.findMany({
      where: { id: "tx_account:b" },
      select: { balance: true },
    });
    expect(b?.balance).toBe(80);
  });

  test("afterCommit runs after persistence; afterRollback on failure", async () => {
    const events: string[] = [];
    await client.transaction(async (tx) => {
      // The transaction connection is closed after commit — afterCommit reads the ROOT client.
      tx.afterCommit(async () => {
        const [row] = await client.accounts.findMany({
          where: { id: "tx_account:a" },
          select: { balance: true },
        });
        events.push(`commit:${row?.balance}`);
      });
      await tx.accounts.update({
        where: { id: "tx_account:a" },
        mode: "set",
        data: { balance: 71 },
      });
    });
    expect(events).toEqual(["commit:71"]);
    await caught(() =>
      client.transaction(async (tx) => {
        tx.afterRollback(() => {
          events.push("rollback");
        });
        throw new Error("nope");
      }),
    );
    expect(events).toEqual(["commit:71", "rollback"]);
  });

  test("nested tx.transaction shares the SAME transaction (rollback cancels everything)", async () => {
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await tx.accounts.update({
          where: { id: "tx_account:a" },
          mode: "set",
          data: { balance: 500 },
        });
        await tx.transaction(async (inner) => {
          await inner.accounts.update({
            where: { id: "tx_account:b" },
            mode: "set",
            data: { balance: 500 },
          });
        });
        throw new Error("later failure");
      }),
    );
    expect((err as Error).message).toContain("later failure");
    const rows = await client.accounts.findMany({
      where: { id: { in: ["tx_account:a", "tx_account:b"] } },
      select: { balance: true },
      orderBy: [{ balance: "asc" }],
    });
    expect(rows.map((r) => r.balance)).toEqual([71, 80]);
  });

  test("timeout cancels the transaction (client-side deadline)", async () => {
    const err = await caught(() =>
      client.transaction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
        { timeout: 30 },
      ),
    );
    expect((err as { code?: string }).code).toBe("DatabaseError");
    expect((err as { details?: unknown }).details).toMatchObject({
      timedOut: true,
    });
  });

  test("a REAL write conflict surfaces as WriteConflict (and is retryable)", async () => {
    const other = await connect();
    const otherClient = betterSchemic(other, {
      schema,
      transaction: { retries: { attempts: 3, delayMs: 5 } },
    });
    let updated = () => {};
    const firstUpdated = new Promise<void>((resolve) => {
      updated = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    // T1 holds the transaction open after writing; T2 writes and waits; T1 commits first, so
    // T2's commit hits the optimistic-concurrency check.
    const first = client.transaction(async (tx) => {
      await tx.accounts.update({
        where: { id: "tx_account:a" },
        mode: "set",
        data: { balance: 1000 },
      });
      updated();
      await released;
    });
    const second = otherClient.transaction(async (tx) => {
      await firstUpdated;
      await tx.accounts.update({
        where: { id: "tx_account:a" },
        mode: "set",
        data: { balance: 2000 },
      });
      // let T1 commit first (its callback resolves on `release`)
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    release();
    await first;
    // T2 retried after the conflict: the second attempt re-read and committed 2000.
    await second;
    const [row] = await client.accounts.findMany({
      where: { id: "tx_account:a" },
      select: { balance: true },
    });
    expect(row?.balance).toBe(2000);

    // Without retries the same race fails as WriteConflict.
    const solo = await connect();
    const soloClient = betterSchemic(solo, { schema });
    const [a, b] = [client, soloClient];
    let cUpdated = () => {};
    const cFirst = new Promise<void>((resolve) => {
      cUpdated = resolve;
    });
    let cRelease = () => {};
    const cReleased = new Promise<void>((resolve) => {
      cRelease = resolve;
    });
    const t1 = a.transaction(async (tx) => {
      await tx.accounts.update({
        where: { id: "tx_account:b" },
        mode: "set",
        data: { balance: 1 },
      });
      cUpdated();
      await cReleased;
    });
    const t2 = b.transaction(async (tx) => {
      await cFirst;
      await tx.accounts.update({
        where: { id: "tx_account:b" },
        mode: "set",
        data: { balance: 2 },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    cRelease();
    await t1;
    const conflict = await caught(() => t2);
    expect(isWriteConflict(conflict)).toBe(true);
    await solo.close();
    await other.close();
  });
});
