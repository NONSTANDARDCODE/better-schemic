// The semantic layer: typed metric declarations, glossary, and declared (validated) lineage. No new
// SQL — metric args are the ORM's existing `combine` args.
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { defineGlossary, defineMetric, lineage } from "../../../src/surreal/orm/semantic"
import { s, table } from "../../../src/surreal/pure"
import { fakeConn } from "../orm-fixtures"

const Order = table("order", {
  amount: s.number(),
  customer: s.string(),
  region: s.string(),
})

const revenue = defineMetric({
  description: "Sum of order amounts",
  dimensions: ["region"],
  from: Order,
  key: "revenue",
  measure: { field: "amount", op: "sum" },
  name: "Revenue",
})
const orders = defineMetric({
  from: Order,
  key: "orders",
  measure: { op: "count" },
})

describe("semantic layer", () => {
  test("defineMetric produces deterministic aggregate args", () => {
    expect(revenue.table).toBe("order")
    expect(revenue.args).toEqual({
      groupBy: ["region"],
      select: { _count: true, region: "region", value: { sum: "amount" } },
    })
    expect(orders.args).toEqual({ select: { _count: true } })
  })

  test("metric args compile through the existing aggregate surface", async () => {
    const { calls, conn } = fakeConn(() => [
      {
        result: [{ _count: 3, region: "eu", value: 42 }],
        success: true,
        type: "other",
      },
    ])
    const client = orm(conn, { schema: { orders: Order } })
    const rows = await client.orders.aggregate(
      revenue.args as Parameters<typeof client.orders.aggregate>[0],
    )
    expect(rows as unknown).toEqual([{ _count: 3, region: "eu", value: 42 }])
    expect(calls[0]?.sql).toContain("math::sum(amount) AS ⟨value⟩")
    expect(calls[0]?.sql).toContain("GROUP BY region")
  })

  test("glossary is a plain JSON-safe registry", () => {
    const terms = defineGlossary({
      region: { definition: "Sales region", synonyms: ["territory"] },
      revenue: { definition: "Total order value", metric: "revenue" },
    })
    expect(JSON.parse(JSON.stringify(terms))).toEqual(terms)
    expect(() => defineGlossary({ bad: { definition: "" } })).toThrow("definition")
  })

  test("lineage is declared-field-only and fails closed on bad declarations", () => {
    expect(lineage([revenue, orders], { orders: Order })).toEqual([
      {
        dimensions: ["region"],
        fields: ["amount", "region"],
        key: "revenue",
        measure: { field: "amount", op: "sum" },
        table: "order",
      },
      {
        dimensions: [],
        fields: [],
        key: "orders",
        measure: { op: "count" },
        table: "order",
      },
    ])
    const bad = defineMetric({
      from: Order,
      key: "bad",
      measure: { field: "missing" as "amount", op: "sum" },
    })
    expect(() => lineage([bad], { orders: Order })).toThrow("missing")
  })
})
