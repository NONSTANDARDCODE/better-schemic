// M4.3 — TYPE assertions for changefeeds: the row follows the table key, the entry union carries
// the exact per-action shape and `since` accepts versionstamp/Date/ISO.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import type { RecordId } from "surrealdb";
import { assertType } from "../../../../../scripts/type-assert";
import { type App, s, table } from "../../../src/surreal";
import type { Client } from "../../../src/surreal/orm/client";
import { schema } from "../../../src/surreal/orm/schema";
import type {
  ChangeDefined,
  ChangeDeleted,
  ChangeEntry,
  ChangeSet,
  ChangesArgs,
  ChangeWritten,
} from "../../../src/surreal/orm/types/changes";
import type { OperationContext } from "../../../src/surreal/orm/types/context";

const User = table("user", { name: s.string() });
const schemaDef = schema({ users: User });
type C = Client<typeof schemaDef>;
type Row = App<typeof User>;

/** Call shapes (instantiation expressions don't survive esbuild/tsx). */
const byKey = (client: C) => client.changes({ table: "users", since: 0 });
const byDatabase = (client: C) => client.changes({ limit: 10 });

describe("changes — typing", () => {
  it("the decoded row follows the table key (database-level rows are unknown)", () => {
    assertType<Promise<ChangeSet<Row>[]>, ReturnType<typeof byKey>>();
    assertType<
      Promise<ChangeSet<Record<string, unknown>>[]>,
      ReturnType<typeof byDatabase>
    >();
  });

  it("the entry union exposes the per-action shape", () => {
    assertType<"UPDATE", ChangeWritten<Row>["action"]>();
    assertType<Row, ChangeWritten<Row>["value"]>();
    assertType<RecordId, ChangeWritten<Row>["recordId"]>();
    assertType<"DELETE", ChangeDeleted<Row>["action"]>();
    assertType<Row | undefined, ChangeDeleted<Row>["before"]>();
    assertType<"DEFINE", ChangeDefined["action"]>();
    assertType<unknown, ChangeDefined["definition"]>();
    // The union's discriminant (membership assertions trip the equality constraint).
    assertType<"UPDATE" | "DELETE" | "DEFINE", ChangeEntry<Row>["action"]>();
  });

  it("since accepts versionstamps, Date and ISO strings", () => {
    assertType<
      number | bigint | Date | string | undefined,
      ChangesArgs["since"]
    >();
    assertType<number | undefined, ChangesArgs["limit"]>();
    assertType<OperationContext | undefined, ChangesArgs["context"]>();
  });

  it("a versionstamp is a bigint", () => {
    assertType<bigint, ChangeSet<Row>["versionstamp"]>();
  });
});
