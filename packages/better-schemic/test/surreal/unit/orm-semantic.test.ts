/* eslint-disable perfectionist/sort-objects -- Object key order mirrors expected serialized output and must stay as authored. */
// The semantic layer: typed metric declarations, glossary, and declared (validated) lineage. No new
// SQL — metric args are the ORM's existing `combine` args.
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { defineGlossary, defineMetric, lineage } from "../../../src/surreal/orm/semantic"
import { s, table } from "../../../src/surreal/pure"
import { fakeConn } from "../orm-fixtures"

const Order = table("order", {
  region: s.string(),
  amount: s.number(),
  customer: s.string(),
})

const revenue = defineMetric({
  key: "revenue",
  name: "Revenue",
  description: "Sum of order amounts",
  from: Order,
  measure: { op: "sum", field: "amount" },
  dimensions: ["region"],
})
const orders = defineMetric({
  key: "orders",
  from: Order,
  measure: { op: "count" },
})

describe("semantic layer", () => {
  test("defineMetric produces deterministic aggregate args", () => {
    expect(revenue.table).toBe("order")
    expect(revenue.args).toEqual({
      select: { _count: true, value: { sum: "amount" }, region: "region" },
      groupBy: ["region"],
    })
    expect(orders.args).toEqual({ select: { _count: true } })
  })

  test("metric args compile through the existing aggregate surface", async () => {
    const { conn, calls } = fakeConn(() => [
      {
        success: true,
        type: "other",
        result: [{ _count: 3, value: 42, region: "eu" }],
      },
    ])
    const client = orm(conn, { schema: { orders: Order } })
    const rows = await client.orders.aggregate(
      revenue.args as Parameters<typeof client.orders.aggregate>[0],
    )
    expect(rows as unknown).toEqual([{ _count: 3, value: 42, region: "eu" }])
    expect(calls[0]?.sql).toContain("math::sum(amount) AS ⟨value⟩")
    expect(calls[0]?.sql).toContain("GROUP BY region")
  })

  test("glossary is a plain JSON-safe registry", () => {
    const terms = defineGlossary({
      revenue: { definition: "Total order value", metric: "revenue" },
      region: { definition: "Sales region", synonyms: ["territory"] },
    })
    expect(JSON.parse(JSON.stringify(terms))).toEqual(terms)
    expect(() => defineGlossary({ bad: { definition: "" } })).toThrow("definition")
  })

  test("lineage is declared-field-only and fails closed on bad declarations", () => {
    expect(lineage([revenue, orders], { orders: Order })).toEqual([
      {
        key: "revenue",
        table: "order",
        fields: ["amount", "region"],
        dimensions: ["region"],
        measure: { op: "sum", field: "amount" },
      },
      {
        key: "orders",
        table: "order",
        fields: [],
        dimensions: [],
        measure: { op: "count" },
      },
    ])
    const bad = defineMetric({
      key: "bad",
      from: Order,
      measure: { op: "sum", field: "missing" as "amount" },
    })
    expect(() => lineage([bad], { orders: Order })).toThrow("missing")
  })
})
