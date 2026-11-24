import { describe, expect, test } from "bun:test"

import {
  buildKindDiff,
  emitKinds,
  type KindEngine,
  KindRegistry,
  snapshotKinds,
} from "../../../src/core/kind"

// A registry with one MANAGED kind (table) and one migration-UNMANAGED kind (access, secret-bearing).
type PTable = {
  kind: "table"
  name: string
}
type PAccess = {
  kind: "access"
  name: string
}

const registry = new KindRegistry()
const tableEngine: KindEngine<PTable, PTable> = {
  emit: (t) => [`TABLE ${t.name}`],
  lower: (t) => t,
  remove: (t) => [`DROP TABLE ${t.name}`],
}
registry.define({
  build: (name: string): PTable => ({ kind: "table", name }),
  name: "table",
  ...tableEngine,
})
const accessEngine: KindEngine<PAccess, PAccess> = {
  emit: (a) => [`DEFINE ACCESS ${a.name} KEY $secret`],
  excludeFromMigrations: true, // the flag under test
  introspect: async () => {
    await Promise.resolve()
    return [{ kind: "access", name: "api" }]
  },
  lower: (a) => a,
  remove: (a) => [`REMOVE ACCESS ${a.name}`],
}
registry.define({
  build: (name: string): PAccess => ({ kind: "access", name }),
  name: "access",
  ...accessEngine,
})

const table: PTable = { kind: "table", name: "user" }
const access: PAccess = { kind: "access", name: "api" }

describe("excludeFromMigrations", () => {
  test("registry.isExcludedFromMigrations reflects the flag (per object)", () => {
    expect(registry.isExcludedFromMigrations(access)).toBe(true)
    expect(registry.isExcludedFromMigrations(table)).toBe(false)
    expect(registry.isExcludedFromMigrations({ kind: "unregistered", name: "x" })).toBe(false)
  })

  test("skipsIntrospection is true only for the boolean flag", () => {
    expect(registry.skipsIntrospection("access")).toBe(true)
    expect(registry.skipsIntrospection("table")).toBe(false)
    expect(registry.skipsIntrospection("unregistered")).toBe(false)
  })

  test("snapshotKinds(schema, registry) drops the excluded kind", () => {
    const snap = snapshotKinds([table, access], registry)
    expect(Object.keys(snap.kinds)).toEqual(["table"])
    // without a registry, nothing filters it (backward-compatible)
    expect(Object.keys(snapshotKinds([table, access]).kinds).sort()).toEqual(["access", "table"])
  })

  test("emitKinds skips the excluded kind", () => {
    const ddl = emitKinds(registry, [table, access]).join("\n")
    expect(ddl).toContain("TABLE user")
    expect(ddl).not.toContain("DEFINE ACCESS")
  })

  test("buildKindDiff never diffs the excluded kind (add / change / remove)", () => {
    // add: an access appears in desired but not prev -> no up/down
    const added = buildKindDiff(registry, [], [table, access])
    expect(added.up.join("\n")).toContain("TABLE user")
    expect(added.up.join("\n")).not.toContain("ACCESS")
    expect(added.down.join("\n")).not.toContain("ACCESS")

    // remove: access in prev but gone from desired -> still no output (not auto-dropped)
    const removed = buildKindDiff(registry, [access], [])
    expect(removed.up.join("\n")).not.toContain("ACCESS")

    // change: access key/def changes -> no migration (managed out-of-band)
    const changed = buildKindDiff(
      registry,
      [{ kind: "access", name: "api" }],
      [{ kind: "access", name: "api" }],
    )
    expect(changed.up).toEqual([])
  })
})

describe("excludeFromMigrations predicate (per-object)", () => {
  const predicateRegistry = new KindRegistry()
  predicateRegistry.define({
    build: (name: string): PAccess => ({ kind: "access", name }),
    emit: (a) => [`DEFINE ACCESS ${a.name}`],
    // The predicate under test: `secret_*` objects unmanag them.
    excludeFromMigrations: (p) => p.name.startsWith("secret_"),
    lower: (a) => a,
    name: "access",
    remove: (a) => [`REMOVE ACCESS ${a.name}`],
  })
  const pub: PAccess = { kind: "access", name: "public_a" }
  const secret: PAccess = { kind: "access", name: "secret_a" }

  test("isExcludedFromMigrations evaluates the predicate per object", () => {
    expect(predicateRegistry.isExcludedFromMigrations(secret)).toBe(true)
    expect(predicateRegistry.isExcludedFromMigrations(pub)).toBe(false)
    // A predicate is never a STATIC exclusion — introspection still runs for the kind.
    expect(predicateRegistry.skipsIntrospection("access")).toBe(false)
  })

  test("snapshotKinds drops only the excluded objects", () => {
    const snap = snapshotKinds([pub, secret], predicateRegistry)
    expect(snap.kinds.access.map((o) => o.name)).toEqual(["public_a"])
  })

  test("emitKinds skips only the excluded objects", () => {
    const ddl = emitKinds(predicateRegistry, [pub, secret]).join("\n")
    expect(ddl).toContain("DEFINE ACCESS public_a")
    expect(ddl).not.toContain("secret_a")
  })

  test("buildKindDiff diffs only managed objects (add / remove)", () => {
    const added = buildKindDiff(predicateRegistry, [], [pub, secret])
    expect(added.up.join("\n")).toContain("DEFINE ACCESS public_a")
    expect(added.up.join("\n")).not.toContain("secret_a")

    const removed = buildKindDiff(predicateRegistry, [pub, secret], [])
    expect(removed.up.join("\n")).toContain("REMOVE ACCESS public_a")
    expect(removed.up.join("\n")).not.toContain("secret_a")
  })
})
