/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-magic-numbers, @typescript-eslint/explicit-function-return-type -- Object key order mirrors expected serialized output and must stay as authored. Literal values are intentional test data and must stay as authored. callbacks de teste: tipo inferido pelo saturador de assercoes; anotar cada um geraria ruido sem valor. */
// `orderObjects` — the generic Kahn sort with cluster/ordinal presentation. The heap-based
// implementation must match the original "filter + sort every round" semantics , so this
// suite pins it against a verbatim reference on seeded random graphs (plus the edge cases).
import { describe, expect, test } from "bun:test"

import { type OrderNode, orderObjects } from "../../../src/core/kind/plan"

const refKey = (r: { kind: string; name: string }) => `${r.kind}:${r.name}`

/** The pre-optimization algorithm, kept as the behavioral reference. */
function reference<T extends OrderNode>(nodes: T[], ordinalOf: (kind: string) => number): T[] {
  const byKey = new Map(nodes.map((n) => [refKey(n), n]))
  const indeg = new Map(nodes.map((n) => [refKey(n), 0]))
  const dependents = new Map<string, string[]>()
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const n of nodes) {
    // eslint-disable-next-line functional/no-loop-statements -- inner walk uses mutable accumulators
    for (const d of n.deps) {
      if (!byKey.has(refKey(d))) continue
      indeg.set(refKey(n), (indeg.get(refKey(n)) ?? 0) + 1)
      const list = dependents.get(refKey(d)) ?? []
      list.push(refKey(n))
      dependents.set(refKey(d), list)
    }
  }
  const out: T[] = []
  const done = new Set<string>()
  let group: string | undefined
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (out.length < nodes.length) {
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
    if (!next.owner) group = refKey(next)
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const dep of dependents.get(refKey(next)) ?? []) indeg.set(dep, (indeg.get(dep) ?? 1) - 1)
  }
  return out
}

const KINDS = ["table", "index", "event", "function"]
const ordinalOf = (kind: string): number => {
  const i = KINDS.indexOf(kind)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

describe("orderObjects", () => {
  test("dependencies win over ordinal/cluster; a cycle throws", () => {
    const nodes: OrderNode[] = [
      { kind: "table", name: "b", deps: [{ kind: "function", name: "f" }] },
      { kind: "function", name: "f", deps: [] },
      { kind: "table", name: "a", deps: [] },
    ]
    expect(orderObjects(nodes, ordinalOf).map((n) => n.name)).toEqual(["a", "f", "b"])
    expect(() =>
      orderObjects(
        [
          { kind: "table", name: "x", deps: [{ kind: "table", name: "y" }] },
          { kind: "table", name: "y", deps: [{ kind: "table", name: "x" }] },
        ],
        ordinalOf,
      ),
    ).toThrow(/dependency cycle/u)
  })

  test("matches the reference on seeded random graphs (parity fuzz)", () => {
    let seed = 42
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 2_147_483_647
      return seed / 2_147_483_647
    }
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + Math.floor(rnd() * 40)
      const nodes: OrderNode[] = []
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (let i = 0; i < n; i++) {
        const deps = []
        const count = i > 0 ? Math.floor(rnd() * 3) : 0
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (let d = 0; d < count; d++) {
          const j = Math.floor(rnd() * i)
          const prior = nodes[j]
          deps.push({ kind: prior.kind, name: prior.name })
        }
        const ownerIdx = Math.floor(rnd() * i)
        const owner =
          i > 0 && rnd() < 0.4
            ? {
                kind: nodes[ownerIdx].kind,
                name: nodes[ownerIdx].name,
              }
            : undefined
        nodes.push({
          kind: KINDS[Math.floor(rnd() * KINDS.length)],
          name: `o${i}`,
          deps,
          owner,
        })
      }
      const expected = reference(nodes, ordinalOf).map((x) => x.name)
      const actual = orderObjects(nodes, ordinalOf).map((x) => x.name)
      expect(actual).toEqual(expected)
    }
  })
})
