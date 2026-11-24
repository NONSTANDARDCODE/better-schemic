import { describe, expect, test } from "bun:test"
import { DateTime, Decimal, Duration, RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { type Client, orm } from "../../../src/surreal/orm/client"
import { compileUpsertDelta } from "../../../src/surreal/orm/compiler/mutate"
import { type Binds, createBinds } from "../../../src/surreal/orm/compiler/shared"
import type { WritePlan } from "../../../src/surreal/orm/compiler/write-shared"
import { computeFieldDelta, equalAppValue } from "../../../src/surreal/orm/delta"
import type { OrmError } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { KEEP_ORDER } from "../../order-barrier"
import { required } from "../../required"
import { caught, fakeConn, ok } from "../orm-fixtures"

import { codeOf } from "./orm-writes-fixtures"

const MAGIC_2 = 2
const MAGIC_3 = 3
// `upsertDelta` — the compiler (golden SQL per lowering + the eager guards) and the runtime delta
// decode (create/update/no-op/removal/codecs/strict miss) over a recording fake connection.
// The live contract (round-trips, plugins, concurrency) lives in test/live/orm-writes-delta.test.ts.

const Ledger = table("delta_ledger", {
  name: s.string(),
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
  balance: s.decimal(),
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
  note: s.string().optional(),
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
  at: s.datetime().optional(),
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
  owner: s.recordId("delta_user").optional(),
}).index("uniq_name", ["name"], { unique: true })
const schemaDef = schema({ ledgers: Ledger })

type C = Client<typeof schemaDef>

/** A client over a fake connection whose every statement answers `respond(line)`. */
function clientFor(respond: (line: string) => unknown): {
  calls: { sql: string; vars?: Record<string, unknown> }[]
  client: C
} {
  const { calls, conn } = fakeConn((script) => script.split("\n").map((line) => ok(respond(line))))
  return { calls, client: orm(conn, { schema: schemaDef }) }
}

const client = clientFor(() => null).client
const meta = required(client.$index.tables.get("ledgers"))
const b = (): Binds => createBinds()
const sql = (plan: { statements: readonly string[] }): string => plan.statements.join("\n")

const ROW = {
  id: new RecordId("delta_ledger", "1"),
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
  name: "A",
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
  balance: new Decimal("10.00"),
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
  note: "n",
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
  at: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
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
  owner: new RecordId("delta_user", "u1"),
}

const ENVELOPE = "RETURN VALUE { before: $before, after: $after }"
const guardArgs =
  (value: unknown): (() => WritePlan) =>
  (): WritePlan =>
    compileUpsertDelta(meta, value as never, b())

describe("compileUpsertDelta — lowering", () => {
  test("strict is the DEFAULT: UPDATE ONLY t:id with the envelope (+ timeout)", () => {
    expect(
      sql(compileUpsertDelta(meta, { data: { name: "B" }, where: { id: "delta_ledger:1" } }, b())),
    ).toBe(`UPDATE ONLY delta_ledger:1 MERGE $p0 ${ENVELOPE}`)
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            timeout: 500,
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPDATE ONLY delta_ledger:1 MERGE $p0 ${ENVELOPE} TIMEOUT 500ms`)
  })

  test("onMissing create: UPSERT t:id with the envelope", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            onMissing: "create",
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPSERT delta_ledger:1 MERGE $p0 ${ENVELOPE}`)
  })

  test("data.id infers the id target", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          { data: { id: "delta_ledger:1", name: "B" }, onMissing: "create" },
          b(),
        ),
      ),
    ).toBe(`UPSERT delta_ledger:1 MERGE $p0 ${ENVELOPE}`)
  })

  test("no target: CREATE with the generated id strategy", () => {
    const plan = compileUpsertDelta(meta, { data: { name: "B" } }, b())
    expect(sql(plan)).toBe(
      `CREATE type::record(s"delta_ledger", rand::ulid()) CONTENT $p0 ${ENVELOPE}`,
    )
    expect(plan.result).toBe("delta")
    expect(plan.transactional).toBe(false)
    expect(plan.resultIndexes).toEqual([0])
  })

  test("unique target (id-less payload): resolve-or-create with the envelope", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          { data: { name: "A" }, onMissing: "create", where: { name: "A" } },
          b(),
        ),
      ),
    ).toBe(
      `UPSERT ((SELECT VALUE id FROM delta_ledger WHERE name = $p0 LIMIT 1)[0] ?? type::record(s"delta_ledger", rand::ulid())) MERGE $p1 ${ENVELOPE}`,
    )
  })

  test("unique target (payload id): plain-table UPSERT WHERE unique", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { id: "delta_ledger:9", name: "A" },
            onMissing: "create",
            where: { name: "A" },
          },
          b(),
        ),
      ),
    ).toBe(`UPSERT delta_ledger MERGE $p0 WHERE name = $p1 ${ENVELOPE}`)
  })

  test("timeout rides every lowering", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "A" },
            onMissing: "create",
            timeout: "2s",
            where: { name: "A" },
          },
          b(),
        ),
      ),
    ).toBe(
      `UPSERT ((SELECT VALUE id FROM delta_ledger WHERE name = $p0 LIMIT 1)[0] ?? type::record(s"delta_ledger", rand::ulid())) MERGE $p1 ${ENVELOPE} TIMEOUT 2s`,
    )
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            onMissing: "throw",
            timeout: "2s",
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPDATE ONLY delta_ledger:1 MERGE $p0 ${ENVELOPE} TIMEOUT 2s`)
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            create: { name: "A" },
            onMissing: "create",
            timeout: "2s",
            update: { name: "B" },
            where: { name: "A" },
          },
          b(),
        ),
      ),
    ).toContain(`${ENVELOPE} TIMEOUT 2s ELSE`)
  })

  test("strict (onMissing throw) is UPDATE-only", () => {
    const id = compileUpsertDelta(
      meta,
      {
        data: { name: "B" },
        onMissing: "throw",
        where: { id: "delta_ledger:1" },
      },
      b(),
    )
    expect(sql(id)).toBe(`UPDATE ONLY delta_ledger:1 MERGE $p0 ${ENVELOPE}`)
    expect(id.mayMiss).toBe(true)
    expect(id.result).toBe("delta")

    const unique = compileUpsertDelta(
      meta,
      { data: { name: "A" }, onMissing: "throw", where: { name: "A" } },
      b(),
    )
    expect(sql(unique)).toBe(`UPDATE delta_ledger MERGE $p0 WHERE name = $p1 ${ENVELOPE}`)
    expect(unique.mayMiss).toBe(true)
  })

  test("expressions branch first and envelope EACH branch (+ timeout per branch)", () => {
    const plan = compileUpsertDelta(
      meta,
      {
        data: { balance: surql`balance + 1` },
        onMissing: "create",
        timeout: "5s",
        where: { id: "delta_ledger:1" },
      },
      b(),
    )
    expect(plan.transactional).toBe(true)
    expect(plan.resultIndexes).toEqual([1])
    expect(sql(plan)).toBe(
      `LET $__existing = (SELECT VALUE id FROM delta_ledger WHERE id = $p0 LIMIT 1);\n` +
        `IF array::len($__existing) = 0 THEN CREATE type::record(s"delta_ledger", rand::ulid()) CONTENT { balance: balance + 1 } ${ENVELOPE} TIMEOUT 5s ELSE UPDATE $__existing[0] MERGE { balance: balance + 1 } ${ENVELOPE} TIMEOUT 5s END;`,
    )
  })

  test("distinct create/update always uses the LET/IF form (never INSERT ON DUPLICATE)", () => {
    const byId = compileUpsertDelta(
      meta,
      {
        create: { id: "delta_ledger:1", name: "A" },
        onMissing: "create",
        update: { name: "B" },
        where: { id: "delta_ledger:1" },
      },
      b(),
    )
    expect(sql(byId)).toBe(
      `LET $__existing = (SELECT VALUE id FROM delta_ledger WHERE id = $p0 LIMIT 1);\n` +
        `IF array::len($__existing) = 0 THEN CREATE delta_ledger:1 CONTENT $p1 ${ENVELOPE} ELSE UPDATE $__existing[0] MERGE $p2 ${ENVELOPE} END;`,
    )
    expect(sql(byId)).not.toContain("INSERT")

    const byUnique = compileUpsertDelta(
      meta,
      {
        create: { name: "A" },
        onMissing: "create",
        update: { note: "x" },
        where: { name: "A" },
      },
      b(),
    )
    expect(sql(byUnique)).toContain(
      `CREATE type::record(s"delta_ledger", rand::ulid()) CONTENT $p1 ${ENVELOPE}`,
    )
  })

  test("mode content keeps the CONTENT body", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            mode: "content",
            onMissing: "create",
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPSERT delta_ledger:1 CONTENT $p0 ${ENVELOPE}`)
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            mode: "content",
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPDATE ONLY delta_ledger:1 CONTENT $p0 ${ENVELOPE}`)
  })

  test("the plugin scope rides the WHERE (never the target)", () => {
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "B" },
            onMissing: "create",
            scope: { owner: { equals: "delta_user:u1" } },
            where: { id: "delta_ledger:1" },
          },
          b(),
        ),
      ),
    ).toBe(`UPSERT delta_ledger:1 MERGE $p0 WHERE owner = $p1 ${ENVELOPE}`)
    expect(
      sql(
        compileUpsertDelta(
          meta,
          {
            data: { name: "A" },
            onMissing: "throw",
            scope: { owner: { equals: "delta_user:u1" } },
            where: { name: "A" },
          },
          b(),
        ),
      ),
    ).toBe(`UPDATE delta_ledger MERGE $p0 WHERE name = $p1 AND owner = $p2 ${ENVELOPE}`)
  })
})

describe("compileUpsertDelta — guards", () => {
  test("payload XOR, onMissing allow-list and mode", () => {
    expect(codeOf(guardArgs({ where: { id: "delta_ledger:1" } }))).toBe("ValidationError")
    expect(
      codeOf(
        guardArgs({
          create: { id: "delta_ledger:1" },
          data: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(guardArgs({ data: { name: "B" }, onMissing: "nope" }))).toBe("ValidationError")
    expect(codeOf(guardArgs({ data: { name: "B" }, mode: "patch" }))).toBe("ValidationError")
    expect(codeOf(guardArgs({ data: { name: "B" }, mode: "set" }))).toBe("ValidationError")
    expect(codeOf(guardArgs({ data: { name: "B" }, mode: "content" }))).toBe("ValidationError")
    expect(
      codeOf(
        guardArgs({
          data: { name: "B" },
          mode: "content",
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
    // The distinct form needs BOTH payloads (create-/ update-reject them).
    expect(codeOf(guardArgs({ create: { name: "A" }, where: { id: "delta_ledger:1" } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(guardArgs({ update: { name: "B" }, where: { id: "delta_ledger:1" } }))).toBe(
      "ValidationError",
    )
    // `data` + one branch rejects it too (the payload shape is ambiguous).
    expect(
      codeOf(
        guardArgs({
          data: { name: "B" },
          update: { name: "C" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    // An explicit `onMissing: "create"` opts into create-or-update (the default is STRICT).
    expect(
      codeOf(
        guardArgs({
          data: { name: "B" },
          onMissing: "create",
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
    // The default is strict: a create/update branch rejects it without the opt-in.
    expect(
      codeOf(
        guardArgs({
          create: { id: "delta_ledger:1", name: "A" },
          update: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    // replace mode on both the create-or-update and the strict path (full payload).
    const full = { balance: new Decimal("1.00"), name: "A" }
    expect(
      codeOf(
        guardArgs({
          data: { ...full },
          mode: "replace",
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
    expect(
      codeOf(
        guardArgs({
          data: { ...full },
          mode: "replace",
          onMissing: "throw",
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
    expect(
      codeOf(
        guardArgs({
          data: { ...full },
          mode: "content",
          onMissing: "throw",
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
  })

  test("strict never creates: no target or a create branch is rejected", () => {
    expect(codeOf(guardArgs({ data: { name: "B" }, onMissing: "throw" }))).toBe("ValidationError")
    expect(
      codeOf(
        guardArgs({
          create: { id: "delta_ledger:1", name: "A" },
          onMissing: "throw",
          update: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("distinct payloads need a target; create.id must match an id target", () => {
    expect(codeOf(guardArgs({ create: { name: "A" }, update: { name: "B" } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(
        guardArgs({
          create: { name: "A" },
          onMissing: "create",
          update: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(
        guardArgs({
          create: { id: "delta_ledger:2", name: "A" },
          onMissing: "create",
          update: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    // A non-object `create` reaches the same guard (no `id` to check).
    expect(
      codeOf(
        guardArgs({
          create: 5,
          onMissing: "create",
          update: { name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("where.id and data.id must name the same record", () => {
    expect(
      codeOf(
        guardArgs({
          data: { id: "delta_ledger:2", name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(
        guardArgs({
          data: { id: "delta_ledger:1", name: "B" },
          where: { id: "delta_ledger:1" },
        }),
      ),
    ).toBeUndefined()
  })
})

describe("upsertDelta — runtime decode", () => {
  test("create: before absent -> created, no delta", async () => {
    const { client: c } = clientFor((line) => (line.startsWith("UPSERT") ? [{ after: ROW }] : null))
    const result = await c.ledgers.upsertDelta({
      data: { name: "A" },
      onMissing: "create",
      where: { id: "delta_ledger:1" },
    })
    expect(result.created).toBe(true)
    expect(result.before).toBeNull()
    expect(result.delta).toBeNull()
    expect(result.changed).toEqual([])
    expect(result.record.id).toBeInstanceOf(RecordId)
    expect(result.record.balance).toBeInstanceOf(Decimal)
    expect(result.record.at).toBeInstanceOf(Date)
  })

  test("create over HTTP: before null counts as create", async () => {
    const { client: c } = clientFor((line) =>
      line.startsWith("CREATE") || line.startsWith("UPSERT")
        ? [{ after: ROW, before: null }]
        : null,
    )
    const result = await c.ledgers.upsertDelta({ data: { name: "A" } })
    expect(result.created).toBe(true)
  })

  test("update: only the changed fields, decoded app values", async () => {
    const after = {
      ...ROW,
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
      balance: new Decimal("12.34"),
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
      at: new DateTime(new Date("2021-02-03T04:05:06.000Z")),
    }
    const { client: c } = clientFor((line) =>
      line.startsWith("UPSERT") ? [{ after, before: ROW }] : null,
    )
    const result = await c.ledgers.upsertDelta({
      data: { balance: new Decimal("12.34") },
      onMissing: "create",
      where: { id: "delta_ledger:1" },
    })
    expect(result.created).toBe(false)
    expect(result.changed).toEqual(["balance", "at"])
    expect(result.delta?.old.balance).toBeInstanceOf(Decimal)
    const oldBalance = result.delta?.old.balance
    const balanceAfter = result.delta?.new.balance
    expect(oldBalance?.equals(new Decimal("10.00"))).toBe(true)
    expect(balanceAfter?.equals(new Decimal("12.34"))).toBe(true)
    expect(result.before?.at).toBeInstanceOf(Date)
    expect(result.record.at).toBeInstanceOf(Date)
  })

  test("no-op update: delta null, changed empty, before present", async () => {
    const before = {
      ...ROW,
      at: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
      balance: new Decimal("10.00"),
    }
    const { client: c } = clientFor((line) =>
      line.startsWith("UPSERT") ? [{ after: { ...ROW }, before }] : null,
    )
    const result = await c.ledgers.upsertDelta({
      data: { name: "A" },
      onMissing: "create",
      where: { id: "delta_ledger:1" },
    })
    expect(result.created).toBe(false)
    expect(result.delta).toBeNull()
    expect(result.changed).toEqual([])
    expect(result.before?.balance).toBeInstanceOf(Decimal)
  })

  test("removed field: present in changed + delta.old, undefined in delta.new", async () => {
    const after = {
      at: ROW.at,
      balance: ROW.balance,
      id: ROW.id,
      name: ROW.name,
      owner: ROW.owner,
    }
    const { client: c } = clientFor((line) =>
      line.startsWith("UPSERT") ? [{ after, before: ROW }] : null,
    )
    const result = await c.ledgers.upsertDelta({
      data: { name: "A" },
      mode: "content",
      onMissing: "create",
      where: { id: "delta_ledger:1" },
    })
    expect(result.changed).toEqual(["note"])
    expect(result.delta?.old.note).toBe("n")
    expect(Object.hasOwn(result.delta?.new ?? {}, "note")).toBe(true)
    expect(result.delta?.new.note).toBeUndefined()
  })

  test("strict hit via UPDATE ONLY returns the single-object envelope", async () => {
    const { client: c } = clientFor((line) =>
      line.startsWith("UPDATE") ? { after: { ...ROW, name: "B" }, before: ROW } : null,
    )
    const result = await c.ledgers.upsertDelta({
      data: { name: "B" },
      onMissing: "throw",
      where: { id: "delta_ledger:1" },
    })
    expect(result.created).toBe(false)
    expect(result.changed).toEqual(["name"])
  })

  test("strict miss rejects ResultNotFound (never creates) — the DEFAULT", async () => {
    const { calls, client: c } = clientFor(() => null)
    const error = (await caught(() =>
      c.ledgers.upsertDelta({
        data: { name: "B" },
        where: { id: "delta_ledger:missing" },
      }),
    )) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(error.table).toBe("delta_ledger")
    expect(error.operation).toBe("upsertDelta")
    expect(error.message).toContain('onMissing: "throw"')
    expect(calls[0]?.sql).toContain("UPDATE ONLY delta_ledger:missing")
    expect(calls[0]?.sql).not.toContain("UPSERT")
  })

  test("a filtered TARGET-LESS create uses the scope message, not the strict one", async () => {
    const { calls, client: c } = clientFor(() => null)
    const error = (await caught(() => c.ledgers.upsertDelta({ data: { name: "A" } }))) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(calls[0]?.sql).toContain("CREATE")
    expect(error.message).toContain("plugin scope")
    expect(error.message).not.toContain('onMissing: "throw"')
  })

  test("a scope-filtered create-mode upsert that writes no row rejects ResultNotFound", async () => {
    const { client: c } = clientFor(() => null)
    const error = (await caught(() =>
      c.ledgers.upsertDelta({
        data: { name: "B" },
        onMissing: "create",
        scope: { owner: { equals: "delta_user:other" } },
        where: { id: "delta_ledger:1" },
      }),
    )) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(error.message).toContain("plugin scope")
  })

  test("a malformed envelope (no after row) rejects ResultNotFound", async () => {
    const { client: c } = clientFor((line) =>
      line.startsWith("UPSERT") ? [{ before: ROW }] : null,
    )
    const error = (await caught(() =>
      c.ledgers.upsertDelta({
        data: { name: "A" },
        onMissing: "create",
        where: { id: "delta_ledger:1" },
      }),
    )) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(error.surql).toContain("UPSERT")
  })

  test("no .throw() ceremony on any branch (delta owns its misses)", async () => {
    const { client: c } = clientFor(() => null)
    const created = c.ledgers.upsertDelta({ data: { name: "A" } })
    expect((created as { throw?: unknown }).throw).toBeUndefined()
    await caught(() => created)
    const strict = c.ledgers.upsertDelta({
      data: { name: "B" },
      onMissing: "throw",
      where: { id: "delta_ledger:1" },
    })
    expect((strict as { throw?: unknown }).throw).toBeUndefined()
    await caught(() => strict)
    const strictDefault = c.ledgers.upsertDelta({
      data: { name: "B" },
      where: { id: "delta_ledger:1" },
    })
    expect((strictDefault as { throw?: unknown }).throw).toBeUndefined()
    await caught(() => strictDefault)
  })
})

describe("equalAppValue / computeFieldDelta", () => {
  test("equalAppValue: codec values, dates, arrays, objects, bytes", () => {
    expect(equalAppValue(new RecordId("t", "1"), new RecordId("t", "1"))).toBe(true)
    expect(equalAppValue(new RecordId("t", "1"), new RecordId("t", "2"))).toBe(false)
    expect(equalAppValue(new Decimal("1.0"), new Decimal("1.00"))).toBe(true)
    expect(equalAppValue(new Decimal("1.0"), new Decimal("1.01"))).toBe(false)
    expect(equalAppValue(new Duration("1s"), new Duration("1s"))).toBe(true)
    expect(
      equalAppValue(new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z")),
    ).toBe(true)
    expect(equalAppValue(Number.NaN, Number.NaN)).toBe(true)
    expect(equalAppValue(new Date(0), new Date(1))).toBe(false)
    expect(equalAppValue(new Date(0), {})).toBe(false)
    expect(equalAppValue(new RecordId("t", "1"), {})).toBe(false)
    expect(equalAppValue([1, [MAGIC_2, MAGIC_3]], [1, [MAGIC_2, MAGIC_3]])).toBe(true)
    expect(equalAppValue([1, MAGIC_2], [1, MAGIC_2, MAGIC_3])).toBe(false)
    expect(equalAppValue([1, MAGIC_2], [1, MAGIC_3])).toBe(false)
    expect(equalAppValue([1], {})).toBe(false)
    expect(equalAppValue({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true)
    expect(equalAppValue({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(equalAppValue({ a: 1 }, { b: 1 })).toBe(false)
    expect(equalAppValue({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false)
    expect(equalAppValue({ a: 1 }, { a: 2 })).toBe(false)
    expect(equalAppValue({}, [])).toBe(false)
    expect(equalAppValue(new Uint8Array([1, MAGIC_2]), new Uint8Array([1, MAGIC_2]))).toBe(true)
    expect(equalAppValue(new Uint8Array([1, MAGIC_2]), new Uint8Array([1, MAGIC_3]))).toBe(false)
    expect(equalAppValue(new Uint8Array([1, MAGIC_2]), new Uint8Array([1]))).toBe(false)
    expect(equalAppValue(new Uint8Array([1]), [1])).toBe(false)
    expect(equalAppValue({}, new Date(0))).toBe(false)
    expect(equalAppValue(null, 0)).toBe(false)
    expect(equalAppValue(undefined, null)).toBe(false)
    expect(equalAppValue(undefined, undefined)).toBe(true)
  })

  test("computeFieldDelta: after-order first, before-only keys appended", () => {
    const before = { a: 1, b: 2, c: 3 }
    const after = { a: 9, c: 3, d: 4 }
    const { changed, delta } = computeFieldDelta(before, after)
    expect(changed).toEqual(["a", "d", "b"])
    expect(delta?.old).toEqual({ a: 1, b: 2, d: undefined })
    expect(delta?.new).toEqual({ a: 9, b: undefined, d: 4 })
    expect(computeFieldDelta({ a: 1 }, { a: 1 })).toEqual({
      changed: [],
      delta: null,
    })
  })
})
