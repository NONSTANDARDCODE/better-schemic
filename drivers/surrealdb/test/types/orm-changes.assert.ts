// M4.3 — TYPE assertions for changefeeds: the row follows the table key, the entry union carries
// the exact per-action shape and `since` accepts versionstamp/Date/ISO.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { RecordId } from "surrealdb";
import { type App, defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import type {
  ChangeDefined,
  ChangeDeleted,
  ChangeEntry,
  ChangeSet,
  ChangesArgs,
  ChangeWritten,
} from "../../src/orm/types/changes";
import type { OperationContext } from "../../src/orm/types/context";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });
type C = Client<typeof schema>;
type Row = App<typeof User>;

/** Call shapes (instantiation expressions don't survive esbuild/tsx). */
const byKey = (client: C) => client.changes({ table: "users", since: 0 });
const byDatabase = (client: C) => client.changes({ limit: 10 });

describe("changes — typing", () => {
  it("the decoded row follows the table key (database-level rows are unknown)", () => {
    attest<Promise<ChangeSet<Row>[]>, ReturnType<typeof byKey>>();
    attest<
      Promise<ChangeSet<Record<string, unknown>>[]>,
      ReturnType<typeof byDatabase>
    >();
  });

  it("the entry union exposes the per-action shape", () => {
    attest<"UPDATE", ChangeWritten<Row>["action"]>();
    attest<Row, ChangeWritten<Row>["value"]>();
    attest<RecordId, ChangeWritten<Row>["recordId"]>();
    attest<"DELETE", ChangeDeleted<Row>["action"]>();
    attest<Row | undefined, ChangeDeleted<Row>["before"]>();
    attest<"DEFINE", ChangeDefined["action"]>();
    attest<unknown, ChangeDefined["definition"]>();
    // The union's discriminant (membership assertions trip attest's constraint check).
    attest<"UPDATE" | "DELETE" | "DEFINE", ChangeEntry<Row>["action"]>();
  });

  it("since accepts versionstamps, Date and ISO strings", () => {
    attest<number | bigint | Date | string | undefined, ChangesArgs["since"]>();
    attest<number | undefined, ChangesArgs["limit"]>();
    attest<OperationContext | undefined, ChangesArgs["context"]>();
  });

  it("a versionstamp is a bigint", () => {
    attest<bigint, ChangeSet<Row>["versionstamp"]>();
  });
});
