/* eslint-disable perfectionist/sort-objects -- Object key order mirrors expected serialized output and must stay as authored. */
// Bun AOT — ORM-side surfaces: client cache, lazy resolver, and the generated static façade.
import { describe, expect, test } from "bun:test"

import { renderOrmSurface } from "../../../src/cli/generate-orm"
import { s, table } from "../../../src/surreal"
import {
  clientRef,
  createOrmClientFactory,
  orm,
  setClientResolver,
} from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import { fakeConn } from "../orm-fixtures"

const Customer = table("customer", { name: s.string() })
const schemaDef = schema({ customers: Customer })

describe("ORM client factory — per-connection cache", () => {
  test("cache: 'weak' returns the same client, peek/dispose are explicit", () => {
    const { conn } = fakeConn()
    const factory = createOrmClientFactory({
      schema: schemaDef,
      cache: "weak",
    })
    const a = factory(conn)
    expect(factory(conn)).toBe(a)
    expect(factory.peek(conn)).toBe(a)
    factory.dispose(conn)
    expect(factory.peek(conn)).toBeUndefined()
    expect(factory(conn)).not.toBe(a)
  })

  test("cache: 'none' builds a fresh client each call", () => {
    const { conn } = fakeConn()
    const factory = createOrmClientFactory({ schema: schemaDef })
    expect(factory(conn)).not.toBe(factory(conn))
    expect(factory.peek(conn)).toBeUndefined()
  })
})

describe("ORM client resolver — late binding without dynamic import", () => {
  test("clientRef resolves on access and can be replaced", () => {
    const { conn } = fakeConn()
    const client = orm(conn, { schema: schemaDef })
    setClientResolver(() => client, "aot-test")
    const ref = clientRef("aot-test")
    expect(ref.current()).toBe(client)
    const other = orm(conn, { schema: schemaDef })
    setClientResolver(() => other, "aot-test")
    expect(ref.current()).toBe(other)
  })

  test("an unregistered resolver fails loudly", () => {
    expect(() => clientRef("nonexistent-aot-test").current()).toThrow(
      /no ORM client resolver registered/u,
    )
  })
})

describe("sc generate:orm — renderer", () => {
  test("emits static getters for fixed members + schema models", () => {
    const source = renderOrmSurface({
      models: ["customers", "orders"],
      schemaImport: "./db/schema",
      schemaExport: "schema",
      providerImport: "./db/orm-provider",
      clientExpr: "getOrmClient",
    })
    expect(source).toContain("get customers()")
    expect(source).toContain("get orders()")
    expect(source).toContain("get $query()")
    expect(source).toContain("return getOrmClient().customers;")
    expect(source).toContain("satisfies OrmSurface<typeof schema>")
  })
})
