import { orm } from "../../../src/surreal/orm/client"
import type { ModelMeta, TableMeta } from "../../../src/surreal/orm/meta"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { KEEP_ORDER } from "../../order-barrier"
import { fakeConn, ok } from "../orm-fixtures"

/**
 * The shared harness for the combine compiler's decision tables.
 *
 * Every one of those tests asks the same question in a different shape — "compile this `select` and
 * tell me the SQL, or the teaching error" — so the client plumbing lives here once instead of being
 * re-derived inside each `describe`. The point is legibility: a reader of a decision table should see
 * the DECISION, not the connection mock.
 */

/** A table with a self-referencing `owner` link — the shape the operand walk has to reason about. */
export const deepShape = {
  at: s.datetime(),
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  anything: s.any(),
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  owner: s.recordId("deep"),
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  meta: s.object({ deep: s.boolean() }),
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  seats: s.array(s.string()),
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  total: s.decimal(),
}

/** `deep` — a datetime, an `any`, a bare link, a flexible object, an array and a decimal. */
export const Deep = table("deep", deepShape)

/** A cart whose `items` is a LIST of links — what `combine({ split })` unfolds. */

/** The schema index for a `{ key: TableDef }` object, typed to the table meta. */
export function tableMeta(
  schema: Record<string, ReturnType<typeof table>>,
  key: string,
): TableMeta {
  const meta = buildSchemaIndex(schema).tables.get(key)
  if (meta === undefined) throw new Error(`no table "${key}" in the test schema`)
  return meta
}

/**
 * Compile one `combine` call and report what the caller asked for.
 *
 * `sql` is the statement when it compiled; `error` is the teaching message when it did not. An empty
 * `sql`  means "no error AND nothing compiled", which no test should assert on.
 */
export async function probeAggregate(
  schema: Record<string, unknown>,
  key: string,
  args: Record<string, unknown>,
  rows: unknown[] = [],
): Promise<{ error: string; meta: ModelMeta; sql: string }> {
  const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok(rows)))
  const client = orm(conn, { schema: schema as never }) as unknown as Record<
    string,
    { aggregate: (a: unknown) => Promise<unknown> }
  >
  let error = ""
  try {
    await client[key].aggregate(args)
  } catch (error_) {
    error = error_ instanceof Error ? error_.message : String(error_)
  }
  return {
    sql: calls[0]?.sql ?? "",
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    error,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    meta: tableMeta(schema as never, key),
  }
}

/**
 * The teaching message an `combine` call refuses with — the shape most of the operand tests assert
 * (they care about the WORDS: which alternative works), so it's a named helper rather than a
 * try/catch at every call site.
 */
export async function refusal(
  schema: Record<string, unknown>,
  key: string,
  args: Record<string, unknown>,
): Promise<string> {
  const probed = await probeAggregate(schema, key, args)
  return probed.error
}
