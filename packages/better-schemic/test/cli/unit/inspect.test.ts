import type { KindEngine, KindRegistry, PortableObject } from "better-schemic/core"
import { describe, expect, test } from "bun:test"

import { addressesOfKind, addressOf, pickSource, requireKind } from "../../../src/cli/inspect"

// Pure logic of the `ls`/`info` inspection commands: source-flag resolution (declared default,
// --snapshot/--live mutually exclusive), table-scoped addressing (parent hook, owner fallback), and
// per-kind address listing.

const fakeRegistry = (names: string[]): KindRegistry =>
  ({ names: (): string[] => names }) as unknown as KindRegistry

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bivariant fake engine for kind erasure.
type FakeEngine = KindEngine<any, any>

// A minimal fake engine: emit joins a `ddl` field; owner/parent read `table`/`parent` fields off the
// object. `owner` = diff clustering, `parent` = addressing (the CLI prefers parent).
function fakeEngine(opts: { owner?: boolean; parent?: boolean } = {}): FakeEngine {
  return {
    emit: (o: PortableObject & { ddl?: string }) => [o.ddl ?? o.name],
    lower: (a: PortableObject) => a,
    owner: opts.owner
      ? (o: PortableObject & { table?: string }): { kind: string; name: string } => ({
          kind: "table",
          name: o.table ?? "",
        })
      : undefined,
    parent: opts.parent
      ? (o: PortableObject & { parent?: string }): { kind: string; name: string } => ({
          kind: "table",
          name: o.parent ?? "",
        })
      : undefined,
    remove: () => [],
  }
}

const obj = (kind: string, name: string, extra: Record<string, unknown> = {}): PortableObject => ({
  kind,
  name,
  ...extra,
})

describe("pickSource", () => {
  test("defaults to declared (what you wrote — offline, never stale)", () => {
    expect(pickSource({})).toBe("declared")
  })
  test("--snapshot → snapshot, --live → live", () => {
    expect(pickSource({ snapshot: true })).toBe("snapshot")
    expect(pickSource({ live: true })).toBe("live")
  })
  test("--snapshot + --live is a teaching error", () => {
    expect(() => pickSource({ live: true, snapshot: true })).toThrow(/mutually exclusive/u)
  })
})

describe("addressOf", () => {
  test("top-level kind (no parent/owner) → bare name", () => {
    expect(addressOf(fakeEngine(), obj("table", "user"))).toBe("user")
  })
  test("owner-only kind → parent.name via the owner fallback", () => {
    expect(addressOf(fakeEngine({ owner: true }), obj("index", "email", { table: "user" }))).toBe(
      "user.email",
    )
  })
  test("parent-only kind (owner declined) → parent.name via the parent hook", () => {
    expect(addressOf(fakeEngine({ parent: true }), obj("index", "email", { parent: "user" }))).toBe(
      "user.email",
    )
  })
  test("parent WINS over owner when both are set", () => {
    expect(
      addressOf(
        fakeEngine({ owner: true, parent: true }),
        obj("index", "email", { parent: "addrTbl", table: "clusterTbl" }),
      ),
    ).toBe("addrTbl.email")
  })
})

describe("requireKind (verb-first `sc ls <kind>` / `sc info <kind>`)", () => {
  const engines = new Map([["table", fakeEngine()]])
  test("returns the engine for a known kind", () => {
    expect(requireKind(fakeRegistry(["table"]), engines, "table")).toBeDefined()
  })
  test("teaching error listing valid kinds for an unknown kind", () => {
    expect(() => {
      requireKind(fakeRegistry(["table", "index"]), engines, "bogus")
    }).toThrow(/unknown kind "bogus".*table, index/u)
  })
})

describe("addressesOfKind", () => {
  test("filters to the kind, addresses dotted, and sorts", () => {
    const eng = fakeEngine({ parent: true })
    const objects = [
      obj("index", "b_idx", { parent: "user" }),
      obj("index", "a_idx", { parent: "post" }),
      obj("table", "user"),
    ]
    expect(addressesOfKind(eng, "index", objects)).toEqual(["post.a_idx", "user.b_idx"])
  })
  test("empty when the kind has no objects", () => {
    expect(addressesOfKind(fakeEngine(), "event", [obj("table", "user")])).toEqual([])
  })
})
