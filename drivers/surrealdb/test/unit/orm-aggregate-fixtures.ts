/**
 * The shared harness for the AGGREGATE compiler's decision tables.
 *
 * Every one of those tests asks the same question in a different shape — "compile this `select` and
 * tell me the SQL, or the teaching error" — so the client plumbing lives here once instead of being
 * re-derived inside each `describe`. The point is legibility: a reader of a decision table should see
 * the DECISION, not the connection mock.
 */
import { RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import type { BetterSchemicError } from "../../src/orm/errors";
import { buildSchemaIndex } from "../../src/orm/schema";
import type { ModelMeta, TableMeta } from "../../src/orm/meta";
import { defineTable, s } from "../../src/pure";
import { fakeConn, ok } from "../orm-fixtures";

/** A table with a self-referencing `owner` link — the shape the operand walk has to reason about. */
export const deepShape = {
  at: s.datetime(),
  anything: s.any(),
  owner: s.recordId("deep"),
  meta: s.object({ deep: s.boolean() }),
  seats: s.array(s.string()),
  total: s.decimal(),
};

/** `deep` — a datetime, an `any`, a bare link, a flexible object, an array and a decimal. */
export const Deep = defineTable("deep", deepShape);

/** A cart whose `items` is a LIST of links — what `aggregate({ split })` unfolds. */
export const splitItemShape = {
  name: s.string(),
  qty: s.int(),
  tags: s.array(s.string()),
};
export const SplitItem = defineTable("split_item", splitItemShape);

export const splitHolderShape = {
  name: s.string(),
  items: s.array(s.recordId("split_item")),
  tags: s.array(s.string()),
};
export const SplitHolder = defineTable("split_holder", splitHolderShape);

/** The schema index for a `{ key: TableDef }` object, typed to the table meta. */
export function tableMeta(
  schema: Record<string, ReturnType<typeof defineTable>>,
  key: string,
): TableMeta {
  const meta = buildSchemaIndex(schema).tables.get(key);
  if (meta === undefined) throw new Error(`no table "${key}" in the test schema`);
  return meta as TableMeta;
}

/**
 * Compile one `aggregate` call and report what the caller asked for.
 *
 * `sql` is the statement when it compiled; `error` is the teaching message when it did not. An empty
 * `sql` therefore means "no error AND nothing compiled", which no test should assert on.
 */
export async function probeAggregate(
  schema: Record<string, unknown>,
  key: string,
  args: Record<string, unknown>,
  rows: unknown[] = [],
): Promise<{ sql: string; error: string; meta: ModelMeta }> {
  const { conn, calls } = fakeConn((sql) =>
    sql.split("\n").map(() => ok(rows)),
  );
  const client = betterSchemic(conn, { schema: schema as never }) as unknown as Record<
    string,
    { aggregate: (a: unknown) => Promise<unknown> }
  >;
  let error = "";
  try {
    await client[key]?.aggregate(args);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    sql: (calls[0]?.sql as string) ?? "",
    error,
    meta: tableMeta(schema as never, key),
  };
}

/**
 * The teaching message an `aggregate` call refuses with — the shape most of the operand tests assert
 * (they care about the WORDS: which alternative works), so it is a named helper rather than a
 * try/catch at every call site.
 */
export async function refusal(
  schema: Record<string, unknown>,
  key: string,
  args: Record<string, unknown>,
): Promise<string> {
  return (await probeAggregate(schema, key, args)).error;
}

/** The compiled statement, failing loudly if the call was refused instead. */
export async function compiled(
  schema: Record<string, unknown>,
  key: string,
  args: Record<string, unknown>,
  rows: unknown[] = [],
): Promise<string> {
  const out = await probeAggregate(schema, key, args, rows);
  if (out.error !== "")
    throw new Error(`expected a statement, got the error: ${out.error}`);
  return out.sql;
}

/** A decode-safe row for a table with a `record` column (the Zod decode rejects a bare string). */
export function row(
  table: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { id: new RecordId(table, "1"), ...fields };
}

export { betterSchemic, defineTable, s };