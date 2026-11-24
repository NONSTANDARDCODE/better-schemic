import { required } from "../../required"
const MAGIC_12_345 = 12_345
const MAGIC_1_103_515_245 = 1_103_515_245
const MAGIC_2_147_483_647 = 2_147_483_647
const MAGIC_0p4 = 0.4
const MAGIC_200 = 200
const MAGIC_3 = 3
const MAGIC_40 = 40
// `orderObjects` — the generic Kahn sort with cluster/ordinal presentation. The heap-based
// implementation must match the original "filter + sort every round" semantics , so this
// suite pins it against a verbatim reference on seeded random graphs (plus the edge cases).
import { describe, expect, test } from "bun:test"

import { type OrderNode, orderObjects } from "../../../src/core/kind/plan"

const refKey = (r: { kind: string; name: string }): string => `${r.kind}:${r.name}`

/** The pre-optimization algorithm, kept as the behavioral reference. */
function reference<T extends OrderNode>(nodes: T[], ordinalOf: (kind: string) => number): T[] {
  const byKey = new Map(nodes.map((n) => [refKey(n), n]))
  const indeg = new Map(nodes.map((n) => [refKey(n), 0]))
  const dependents = new Map<string, string[]>()
  nodes.forEach((n) => {
    n.deps.forEach((d) => {
      if (!byKey.has(refKey(d))) return
      indeg.set(refKey(n), (indeg.get(refKey(n)) ?? 0) + 1)
      const list = dependents.get(refKey(d)) ?? []
      list.push(refKey(n))
      dependents.set(refKey(d), list)
    })
  })
  const done = new Set<string>()
  const step = (out: T[], group: string | undefined): T[] => {
    if (out.length === nodes.length) return out
    const ready = nodes.filter((n) => !done.has(refKey(n)) && indeg.get(refKey(n)) === 0)
    if (ready.length === 0) throw new Error("cycle")
    ready.sort((a, b) => {
      const ao = a.owner && refKey(a.owner) === group ? 0 : 1
      const bo = b.owner && refKey(b.owner) === group ? 0 : 1
      return ao - bo || ordinalOf(a.kind) - ordinalOf(b.kind) || refKey(a).localeCompare(refKey(b))
    })
    const next = ready[0]
    out.push(next)
    done.add(refKey(next))
    const nextGroup = next.owner ? group : refKey(next)
    ;(dependents.get(refKey(next)) ?? []).forEach((dep) =>
      indeg.set(dep, (indeg.get(dep) ?? 1) - 1),
    )
    return step(out, nextGroup)
  }
  return step([], undefined)
}

const KINDS = ["table", "index", "event", "function"]
const ordinalOf = (kind: string): number => {
  const i = KINDS.indexOf(kind)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

describe("orderObjects", () => {
  test("dependencies win over ordinal/cluster; a cycle throws", () => {
    const nodes: OrderNode[] = [
      { deps: [{ kind: "function", name: "f" }], kind: "table", name: "b" },
      { deps: [], kind: "function", name: "f" },
      { deps: [], kind: "table", name: "a" },
    ]
    expect(orderObjects(nodes, ordinalOf).map((n) => n.name)).toEqual(["a", "f", "b"])
    expect(() =>
      orderObjects(
        [
          { deps: [{ kind: "table", name: "y" }], kind: "table", name: "x" },
          { deps: [{ kind: "table", name: "x" }], kind: "table", name: "y" },
        ],
        ordinalOf,
      ),
    ).toThrow(/dependency cycle/u)
  })

  test("matches the reference on seeded random graphs (parity fuzz)", () => {
    let seed = 42
    const rnd = (): number => {
      seed = (seed * MAGIC_1_103_515_245 + MAGIC_12_345) & MAGIC_2_147_483_647
      return seed / MAGIC_2_147_483_647
    }
    Array.from({ length: MAGIC_200 }).forEach(() => {
      const n = MAGIC_3 + Math.floor(rnd() * MAGIC_40)
      const nodes: OrderNode[] = []
      Array.from({ length: n }).forEach((_, i) => {
        const deps: Pick<OrderNode, "kind" | "name">[] = []
        const count = i > 0 ? Math.floor(rnd() * MAGIC_3) : 0
        Array.from({ length: count }).forEach(() => {
          const j = Math.floor(rnd() * i)
          const prior = required(nodes[j])
          deps.push({ kind: prior.kind, name: prior.name })
        })
        const ownerIdx = Math.floor(rnd() * i)
        const owner =
          i > 0 && rnd() < MAGIC_0p4
            ? {
                kind: required(nodes[ownerIdx]).kind,
                name: required(nodes[ownerIdx]).name,
              }
            : undefined
        nodes.push({
          deps,
          kind: KINDS[Math.floor(rnd() * KINDS.length)],
          name: `o${i}`,
          owner,
        })
      })
      const expected = reference(nodes, ordinalOf).map((x) => x.name)
      const actual = orderObjects(nodes, ordinalOf).map((x) => x.name)
      expect(actual).toEqual(expected)
    })
  })
})
