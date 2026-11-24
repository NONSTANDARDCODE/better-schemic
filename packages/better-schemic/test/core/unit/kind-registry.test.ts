// The generic kind registry + planning spine. An in-test "driver" registers three kinds against one
// KindRegistry — `table` (structured, field-level diff), `index` (owned, clustered after its table),
// and `function` (opaque/native) — exercising the engine with NO real driver dependency. It asserts:
//   - the builder passthrough keeps each kind's own DX (shape-based table, chained function);
//   - planKinds produces the expected up/down DDL for add / change / remove;
//   - field-level diff happens INSIDE the table kind's overwrite;
//   - cross-kind ordering follows the dependency graph: an index follows its table, an FK child follows
//     its parent, and a function emits BEFORE the table whose event calls it;
//   - drops reverse the order; down recreates parent-first;
//   - introspect fans out across kinds off one connection.
// The DDL strings below are a generic, made-up syntax: core is dialect-neutral and treats
// every emitted statement as an opaque string — the real dialect lives entirely in the driver packages.

import { describe, expect, test } from "bun:test"

import {
  buildKindDiff,
  emitKinds,
  introspectKinds,
  type KindEngine,
  KindRegistry,
  lowerSchema,
  orderObjects,
  planKinds,
  type PortableObject,
  type Ref,
  snapshotKinds,
  snapshotObjects,
} from "../../../src/core/kind"
const schema = (): (PFunction | PIndex | PTable)[] => [
  table("user", [{ name: "name", type: "string" }]),
  defineIndex("user_email", "user", ["name"]),
  table("post", [{ name: "title", type: "string" }], {
    deps: [{ kind: "table", name: "user" }],
  }),
  defineIndex("post_author", "post", ["title"]),
  defineFunction("fmt").body("RETURN $v"),
  table("audit", [{ name: "at", type: "string" }], {
    deps: [{ kind: "function", name: "fmt" }],
  }),
]

// --- an in-test driver: three kinds on one registry ---------------------------------------------

type PField = {
  name: string
  type: string
}
type PTable = {
  deps: Ref[] // FK parents / functions an event calls
  fields: PField[]
  kind: "table"
  name: string
}
type PIndex = {
  cols: string[]
  kind: "index"
  name: string
  table: string
}
type PFunction = {
  body: string
  kind: "function"
  name: string
}

const registry = new KindRegistry()

// kind 1 (ordinal 0): table — shape-based authoring, field-level diff in `overwrite`.
const tableEngine: KindEngine<PTable, PTable> = {
  deps: (t) => t.deps,
  emit: (t) => [
    `TABLE ${t.name}`,
    ...t.fields.map((f) => `FIELD ${f.name}:${f.type} ON ${t.name}`),
  ],
  lower: (t) => t,
  overwrite: (prev, next) => {
    const before = new Map(prev.fields.map((f) => [f.name, f.type]))
    const after = new Map(next.fields.map((f) => [f.name, f.type]))
    const lines: string[] = []
    ;[...after].forEach(([n, t]) => {
      if (!before.has(n)) lines.push(`FIELD ${n}:${t} ON ${next.name}`)
      else if (before.get(n) !== t) lines.push(`ALTER FIELD ${n}:${t} ON ${next.name}`)
    })
    ;[...before].forEach(([n]) => {
      if (!after.has(n)) lines.push(`DROP FIELD ${n} ON ${next.name}`)
    })
    return lines
  },
  remove: (t) => [`DROP TABLE ${t.name}`],
}
const table = registry.define({
  build: (name: string, fields: PField[], opts?: { deps?: Ref[] }): PTable => ({
    deps: opts?.deps ?? [],
    fields,
    kind: "table",
    name,
  }),
  name: "table",
  ...tableEngine,
})

// kind 2 (ordinal 1): index — owned by its table (clusters after it), depends on it.
const indexEngine: KindEngine<PIndex, PIndex> = {
  deps: (i) => [{ kind: "table", name: i.table }],
  emit: (i) => [`INDEX ${i.name} ON ${i.table}(${i.cols.join(", ")})`],
  lower: (i) => i,
  owner: (i) => ({ kind: "table", name: i.table }),
  remove: (i) => [`DROP INDEX ${i.name} ON ${i.table}`],
}
const defineIndex = registry.define({
  build: (name: string, table: string, cols: string[]): PIndex => ({
    cols,
    kind: "index",
    name,
    table,
  }),
  name: "index",
  ...indexEngine,
})

// kind 3 (ordinal 2): function — opaque/native, multi-stage chained authoring.
const functionEngine: KindEngine<PFunction, PFunction> = {
  emit: (f) => [`FUNCTION ${f.name} { ${f.body} }`],
  lower: (f) => f,
  remove: (f) => [`DROP FUNCTION ${f.name}`],
  // no `overwrite` -> the spine recreates (remove + emit), the opaque-kind default.
}
const defineFunction = registry.define({
  build: (name: string) => ({
    body: (sql: string): PFunction => ({ body: sql, kind: "function", name }),
  }),
  name: "function",
  ...functionEngine,
})

// --- builder DX (the passthrough keeps each kind's own authoring shape) --------------------------

describe("createKind preserves each kind's authoring DX", () => {
  test("shape-based table builder returns a typed table def", () => {
    const user = table("user", [{ name: "name", type: "string" }])
    expect(user.kind).toBe("table")
    expect(user.name).toBe("user")
    expect(user.fields).toEqual([{ name: "name", type: "string" }])
  })

  test("chained function builder threads through `.body(...)`", () => {
    const fmt = defineFunction("fmt").body("RETURN $v")
    expect(fmt).toEqual({ body: "RETURN $v", kind: "function", name: "fmt" })
  })
})

// --- planKinds: up/down DDL for add / change / remove -------------------------------------------

describe("planKinds (add / change / remove)", () => {
  test("adding a field -> emit up, drop down (field-level diff in the table kind)", () => {
    const prev = [table("user", [{ name: "name", type: "string" }])]
    const next = [
      table("user", [
        { name: "name", type: "string" },
        { name: "age", type: "int" },
      ]),
    ]
    const { down, up } = planKinds(registry, prev, next)
    expect(up).toEqual(["FIELD age:int ON user"])
    expect(down).toEqual(["DROP FIELD age ON user"])
  })

  test("changing a field type -> ALTER both ways", () => {
    const prev = [table("user", [{ name: "age", type: "int" }])]
    const next = [table("user", [{ name: "age", type: "float" }])]
    const { down, up } = planKinds(registry, prev, next)
    expect(up).toEqual(["ALTER FIELD age:float ON user"])
    expect(down).toEqual(["ALTER FIELD age:int ON user"])
  })

  test("removing a table -> drop up, full recreate down (table before its fields)", () => {
    const prev = [
      table("user", [{ name: "name", type: "string" }]),
      table("post", [{ name: "title", type: "string" }]),
    ]
    const next = [table("user", [{ name: "name", type: "string" }])]
    const { down, up } = planKinds(registry, prev, next)
    expect(up).toEqual(["DROP TABLE post"])
    expect(down).toEqual(["TABLE post", "FIELD title:string ON post"])
  })

  test("an opaque function change recreates (remove + emit), no overwrite", () => {
    const prev = [defineFunction("fmt").body("RETURN 1")]
    const next = [defineFunction("fmt").body("RETURN 2")]
    const { down, up } = planKinds(registry, prev, next)
    expect(up).toEqual(["DROP FUNCTION fmt", "FUNCTION fmt { RETURN 2 }"])
    expect(down).toEqual(["DROP FUNCTION fmt", "FUNCTION fmt { RETURN 1 }"])
  })

  test("identical schemas plan to nothing", () => {
    const db = [
      table("user", [{ name: "name", type: "string" }]),
      defineFunction("fmt").body("RETURN 1"),
    ]
    expect(planKinds(registry, db, db)).toEqual({ down: [], up: [] })
  })
})

// --- cross-kind ordering by the dependency graph ------------------------------------------------

const headers = (ddl: string[]): string[] =>
  ddl.filter((l): boolean => /^(TABLE|INDEX|FUNCTION) /u.test(l))

describe("cross-kind dependency ordering", () => {
  // A schema exercising every ordering rule:
  //   user, user_email(idx), post(FK->user), post_author(idx), fmt(fn), audit(event calls fmt)

  test("emit order follows the graph (index after table, FK order, function before its table)", () => {
    const up = emitKinds(registry, schema())
    expect(headers(up)).toEqual([
      "TABLE user",
      "INDEX user_email ON user(name)",
      "TABLE post",
      "INDEX post_author ON post(title)",
      "FUNCTION fmt { RETURN $v }",
      "TABLE audit",
    ])
  })

  test("dropping the whole schema reverses the order (children/FKs first, function after its table)", () => {
    const { up } = planKinds(registry, schema(), [])
    expect(up.filter((l) => /^DROP (TABLE|INDEX|FUNCTION) /u.test(l))).toEqual([
      "DROP TABLE audit",
      "DROP FUNCTION fmt",
      "DROP INDEX post_author ON post",
      "DROP TABLE post",
      "DROP INDEX user_email ON user",
      "DROP TABLE user",
    ])
  })

  test("a dependency cycle is a named error", () => {
    const a = table("a", [], { deps: [{ kind: "table", name: "b" }] })
    const b = table("b", [], { deps: [{ kind: "table", name: "a" }] })
    expect(() => planKinds(registry, [], [a, b])).toThrow(/cycle/u)
  })
})

describe("orderObjects (the graph primitive in isolation)", () => {
  test("an external dep (object not in the set) is not a constraint", () => {
    const nodes = [{ deps: [{ kind: "table", name: "gone" }], kind: "index", name: "i" }]
    expect(orderObjects(nodes, () => 0).map((n) => n.name)).toEqual(["i"])
  })
})

// --- display + ordinal defaults -----------------------------------------------------------------

describe("KindRegistry.display / ordinal defaults", () => {
  test("name-derived label/plural/folder when a kind declares no display", () => {
    expect(registry.display("table")).toEqual({
      folder: "tables",
      label: "Table",
      plural: "Tables",
    })
  })

  test("pluralizes y-endings to -ies and sibilants to -es", () => {
    expect(registry.display("policy").plural).toBe("Policies")
    expect(registry.display("status").plural).toBe("Statuses")
  })

  test("an unregistered / empty kind still gets name-derived defaults", () => {
    expect(registry.display("widget").label).toBe("Widget")
    expect(registry.display("").label).toBe("")
  })

  test("a declared display overrides the derived defaults", () => {
    const reg = new KindRegistry()
    reg.define({
      build: (name: string) => ({ kind: "gadget", name }),
      display: { folder: "gizmos", label: "Gizmo", plural: "Gizmos" },
      emit: () => [],
      lower: (g: { kind: "gadget"; name: string }) => g,
      name: "gadget",
      remove: () => [],
    })
    expect(reg.display("gadget")).toEqual({
      folder: "gizmos",
      label: "Gizmo",
      plural: "Gizmos",
    })
  })

  test("ordinal is the registration index; an unknown kind sorts last", () => {
    expect(registry.ordinal("table")).toBe(0)
    expect(registry.ordinal("index")).toBe(1)
    expect(registry.ordinal("unknown")).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// --- introspect fan-out -------------------------------------------------------------------------

describe("introspectKinds fans out across kinds off one connection", () => {
  test("each introspectable kind contributes its objects; others are skipped", async () => {
    const reg = new KindRegistry()
    reg.define({
      build: (name: string): PTable => ({
        deps: [],
        fields: [],
        kind: "table",
        name,
      }),
      emit: () => [],
      introspect: () => Promise.resolve([{ deps: [], fields: [], kind: "table", name: "user" }]),
      lower: (t: PTable) => t as never,
      name: "table",
      remove: () => [],
    })
    reg.define({
      build: (name: string): PFunction => ({
        body: "",
        kind: "function",
        name,
      }),
      emit: () => [],
      lower: (f: PFunction) => f,
      name: "function",
      remove: () => [],
      // no `introspect` -> contributes nothing.
    })
    const found = await introspectKinds(reg, /* conn */ {})
    expect(found.map((o) => `${o.kind}:${o.name}`)).toEqual(["table:user"])
  })
})

// --- lowering + snapshot round-trip -------------------------------------------------------------

describe("lowerSchema + snapshot", () => {
  test("lowerSchema runs each definable through its kind's engine", () => {
    const portable = lowerSchema(registry, [
      table("user", [{ name: "name", type: "string" }]),
      defineFunction("fmt").body("RETURN 1"),
    ])
    expect(portable.map((o) => `${o.kind}:${o.name}`)).toEqual(["table:user", "function:fmt"])
  })

  test("snapshot groups by kind and round-trips through JSON to a zero diff", () => {
    const portable = lowerSchema(registry, [
      table("user", [{ name: "name", type: "string" }]),
      defineIndex("user_name", "user", ["name"]),
      defineFunction("fmt").body("RETURN 1"),
    ])
    const snap = snapshotKinds(portable)
    expect(Object.keys(snap.kinds).sort()).toEqual(["function", "index", "table"])
    // Serialize -> parse -> flatten back; diffing the restored snapshot vs the live schema is empty.
    const restored = snapshotObjects(JSON.parse(JSON.stringify(snap)))
    expect(planKinds(registry, restored, portable)).toEqual({
      down: [],
      up: [],
    })
  })
})

// --- buildKindDiff (the full Diff the CLI consumes) ---------------------------------------------

describe("buildKindDiff produces up/down + display items + full", () => {
  const prev = lowerSchema(registry, [table("user", [{ name: "name", type: "string" }])])
  const next = lowerSchema(registry, [
    table("user", [
      { name: "name", type: "string" },
      { name: "age", type: "int" },
    ]),
    defineFunction("fmt").body("RETURN 1"),
  ])

  test("up/down match planKinds; a change item + an add item are reported", () => {
    const diff = buildKindDiff(registry, prev, next)
    expect({ down: diff.down, up: diff.up }).toEqual(planKinds(registry, prev, next))
    // user changed (field added); fmt added.
    const items = diff.items ?? []
    expect(items.find((i) => i.key === "table::user")?.op).toBe("change")
    expect(items.find((i) => i.key === "function::fmt")?.op).toBe("add")
  })

  test("`full` lists every desired object's DDL, ordered across kinds", () => {
    const full = buildKindDiff(registry, prev, next).full ?? []
    expect(full.map((s) => s.key)).toEqual(["table::user", "function::fmt"])
    expect(full[0].ddl).toContain("TABLE user")
    expect(full[0].ddl).toContain("FIELD age:int ON user")
  })
})

// --- canonical change-detection hook (emit faithful, equality normalized) ------------------------

describe("KindEngine.canonical separates change-detection from faithful emit", () => {
  // A kind whose emit is FAITHFUL (carries a comment the DB never reads back), but whose canonical
  // EXCLUDES it — so a comment- delta, or a faithful-vs-introspected (comment-less) pair, is NOT a
  // phantom change. The same shape a SQL driver needs for DEFAULT / CHECK / COMMENT: emit-faithful, but
  // dropped from equality.
  type PDoc = {
    body: string
    comment?: string
    kind: "doc"
    name: string
  } & PortableObject
  const reg = new KindRegistry()
  const defineDoc = reg.define({
    build: (name: string, body: string, comment?: string): PDoc => ({
      body,
      kind: "doc",
      name,
      ...(comment === undefined ? {} : { comment }),
    }),
    // canonical EXCLUDES the comment — it's create-time-, never a change.
    canonical: (d: PDoc) => `DOC ${d.name} body=${d.body}`,
    // emit is FAITHFUL — includes the comment (create-time).
    emit: (d: PDoc) => [
      `DOC ${d.name} body=${d.body}`,
      ...(d.comment === undefined ? [] : [`NOTE ON ${d.name}: ${d.comment}`]),
    ],
    lower: (d: PDoc) => d,
    name: "doc",
    overwrite: (_p: PDoc, n: PDoc) => [`ALTER DOC ${n.name} body=${n.body}`],
    remove: (d: PDoc) => [`DROP DOC ${d.name}`],
  })

  test("a comment-only delta is NOT a change (faithful emit, normalized equality)", () => {
    const prev = [defineDoc("a", "x")]
    const next = [defineDoc("a", "x", "a note")]
    expect(planKinds(reg, prev, next)).toEqual({ down: [], up: [] })
  })

  test("introspected (comment-less) vs authored (commented) does not phantom-diff", () => {
    const authored = [defineDoc("a", "x", "a note")]
    const introspected = [defineDoc("a", "x")] // DB never read the comment back
    expect(planKinds(reg, introspected, authored)).toEqual({
      down: [],
      up: [],
    })
  })

  test("a real body change IS detected (and emit stays faithful for a fresh apply)", () => {
    const prev = [defineDoc("a", "x", "a note")]
    const next = [defineDoc("a", "y", "a note")]
    expect(planKinds(reg, prev, next).up).toEqual(["ALTER DOC a body=y"])
    // fresh apply emits the comment (faithful), even though canonical ignores it.
    expect(emitKinds(reg, [defineDoc("a", "x", "a note")])).toEqual([
      "DOC a body=x",
      "NOTE ON a: a note",
    ])
  })
})

// --- displayItems: per-field display granularity (grouped under the table) -----------------------

describe("KindEngine.displayItems decomposes a change into per-field items", () => {
  type PTbl = {
    cols: { name: string; type: string }[]
    kind: "tbl"
    name: string
  } & PortableObject
  const reg = new KindRegistry()
  const defineTbl = reg.define({
    build: (name: string, cols: { name: string; type: string }[]): PTbl => ({
      cols,
      kind: "tbl",
      name,
    }),
    // per-FIELD display items, each carrying its owning table for hierarchical grouping.
    displayItems: (prev: PTbl | undefined, next: PTbl | undefined) => {
      const before = new Map((prev?.cols ?? []).map((c) => [c.name, c.type]))
      const after = new Map((next?.cols ?? []).map((c) => [c.name, c.type]))
      const table = (next ?? prev)?.name ?? ""
      const out: DiffItemLike[] = []
      ;[...after].forEach(([n, t]) => {
        const b = before.get(n)
        const key = `field:${table}:${n}`
        const ddl = `FIELD ${n}:${t} ON ${table}`
        if (b === undefined) out.push({ ddl, key, kind: "field", op: "add", table })
        else if (b !== t) {
          out.push({
            after: ddl,
            before: `FIELD ${n}:${b} ON ${table}`,
            key,
            kind: "field",
            op: "change",
            table,
          })
        }
      })
      ;[...before].forEach(([n, t]) => {
        if (!after.has(n)) {
          out.push({
            ddl: `DROP FIELD ${n} ON ${table}`,
            key: `field:${table}:${n}`,
            kind: "field",
            old: `FIELD ${n}:${t} ON ${table}`,
            op: "remove",
            table,
          })
        }
      })
      return out
    },
    emit: (t: PTbl) => [
      `TABLE ${t.name}`,
      ...t.cols.map((c) => `FIELD ${c.name}:${c.type} ON ${t.name}`),
    ],
    lower: (t: PTbl) => t,
    name: "tbl",
    overwrite: (_p: PTbl, n: PTbl) => [`ALTER TABLE ${n.name}`],
    remove: (t: PTbl) => [`DROP TABLE ${t.name}`],
  })

  test("a field change yields a per-field item (grouped by table), not a whole-table item", () => {
    const prev = [defineTbl("user", [{ name: "name", type: "string" }])]
    const next = [defineTbl("user", [{ name: "name", type: "int" }])]
    const diff = buildKindDiff(reg, prev, next)
    expect(diff.items).toHaveLength(1)
    const it = (diff.items ?? [])[0]
    expect(it.key).toBe("field:user:name")
    expect(it.table).toBe("user") // hierarchy: the field appears under its table
    expect(it.op).toBe("change")
    // up/down stay whole-object (the kind's overwrite), unaffected by display granularity.
    expect(diff.up).toEqual(["ALTER TABLE user"])
  })

  test("`full` is per-field too (the displayItems(undefined, p) projection)", () => {
    const next = [
      defineTbl("user", [
        { name: "id", type: "string" },
        { name: "name", type: "string" },
      ]),
    ]
    const full = buildKindDiff(reg, [], next).full ?? []
    expect(full.map((s) => s.key)).toEqual(["field:user:id", "field:user:name"])
    expect(full[1].ddl).toBe("FIELD name:string ON user")
  })
})

// A loose shape mirroring core's DiffItem for the test's displayItems return (kept local + minimal).
type DiffItemLike = {
  key: string
  kind: string
  table: string
} & (
  | { after: string; before: string; op: "change" }
  | { ddl: string; old: string; op: "remove" }
  | { ddl: string; op: "add" }
)
