// M5 — TYPE assertions for the raw escape hatches, context scoping, database functions, APIs, auth
// And admin: the call shapes (tagged template vs string/BoundQuery), the typed function shortcuts
// And the `$withContext` overloads (sync scope vs Promise session).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { defineFunction, defineTable, s } from "../../../src/surreal"
import { defineSchema } from "../../../src/surreal/orm/schema"

import type { Client } from "../../../src/surreal/orm/client"
import type { DbInfo, NsInfo, RootInfo, TableInfo } from "../../../src/surreal/orm/types/admin"
import type { ContextScope, OperationContext } from "../../../src/surreal/orm/types/context"
import type { FnArgs, FnReturn, FnSurface } from "../../../src/surreal/orm/types/fn"
import type { RawOptions, RawStatements } from "../../../src/surreal/orm/types/raw"
import type { FindManyArgs, FindUniqueArgs } from "../../../src/surreal/orm/types/select"
import type { Tokens } from "surrealdb"

const User = defineTable("user", { name: s.string() }),
  Add = defineFunction("add", { a: s.number(), b: s.number() }).returns(s.number()),
  Ping = defineFunction("ping").returns(s.string()),
  schema = defineSchema({ users: User, add: Add, ping: Ping })
type C = Client<typeof schema>
type U = typeof User

/** Call shapes (instantiation expressions don't survive esbuild/tsx). */
const rawTemplate = async (client: C) => client.$raw<string[]>`SELECT 1`,
  rawString = async (client: C) => client.$raw<string[]>("SELECT 1"),
  queryTemplate = async (client: C) => client.$query<[string[], number]>`SELECT 1; SELECT 2`,
  queryFail = async (client: C) => client.$query("SELECT 1", { throwOnError: false }),
  rawCurried = async (client: C) => client.$raw({ meta: { comment: "seed" } })<string[]>`SELECT 1`,
  queryCurried = async (client: C) => client.$query({ throwOnError: false })`SELECT 1; SELECT 2`,
  unsafeCall = async (client: C) => client.$unsafe<number>("SELECT 1", { id: 1 }, { timeout: 100 }),
  fnCall = async (client: C) => client.fn.call<number>("fn::add", [1, 2]),
  fnTyped = async (client: C) => client.fn.add({ a: 1, b: 2 }),
  fnPing = async (client: C) => client.fn.ping(),
  apiGet = async (client: C) => client.api.get<{ id: string }>("/x"),
  apiPost = async (client: C) => client.api.post<{ ok: boolean }>("/x", { body: { a: 1 } }),
  authSignin = async (client: C) => client.auth.signin({ username: "u", password: "p" }),
  infoRoot = async (client: C) => client.info("root"),
  infoNs = async (client: C) => client.info("ns"),
  infoDb = async (client: C) => client.info("db"),
  infoTable = async (client: C) => client.info("table", "user"),
  ctxSync = (client: C) => client.$withContext({ namespace: "tenant_a", database: "app" }),
  ctxAsync = async (client: C) =>
    client.$withContext({
      namespace: "tenant_a",
      database: "app",
      auth: "token",
    }),
  findManyCtx = async (client: C) => client.users.findMany({ context: { database: "analytics" } }),
  findUniqueCtx = async (client: C) =>
    client.users.findUnique({
      where: { id: "user:1" },
      context: { namespace: "a" },
    })

describe("raw — typing", () => {
  it("the template/string/BoundQuery forms all resolve the first result", () => {
    assertType<Promise<string[]>, ReturnType<typeof rawTemplate>>()
    assertType<Promise<string[]>, ReturnType<typeof rawString>>()
    assertType<Promise<[string[], number]>, ReturnType<typeof queryTemplate>>()
  })

  it("throwOnError:false widens to the StatementResult envelopes", () => {
    assertType<Promise<RawStatements>, ReturnType<typeof queryFail>>()
  })

  it("the curried options-tag returns a bound tag", () => {
    assertType<Promise<string[]>, ReturnType<typeof rawCurried>>()
    assertType<Promise<RawStatements>, ReturnType<typeof queryCurried>>()
  })

  it("$unsafe resolves the generic and accepts params/options", () => {
    assertType<Promise<number>, ReturnType<typeof unsafeCall>>()
  })

  it("RawOptions accepts timeout + meta and OperationContext the three keys", () => {
    assertType<true, "timeout" extends keyof RawOptions ? true : false>()
    assertType<true, "meta" extends keyof RawOptions ? true : false>()
    assertType<true, "namespace" extends keyof OperationContext ? true : false>()
    assertType<true, "database" extends keyof OperationContext ? true : false>()
    assertType<true, "meta" extends keyof OperationContext ? true : false>()
    assertType<true, "auth" extends keyof ContextScope ? true : false>()
  })
})

describe("context — typing", () => {
  it("$withContext is sync without auth and a Promise with it", () => {
    assertType<Client<typeof schema>, ReturnType<typeof ctxSync>>()
    assertType<Promise<Client<typeof schema>>, ReturnType<typeof ctxAsync>>()
  })

  it("every read accepts a per-call context override", () => {
    assertType<true, "context" extends keyof FindManyArgs<U> ? true : false>()
    assertType<true, "context" extends keyof FindUniqueArgs<U> ? true : false>()
    // The call compiles (the lazy thenable shape is exercised by the read suites).
    assertType<true, ReturnType<typeof findManyCtx> extends object ? true : false>()
    assertType<true, ReturnType<typeof findUniqueCtx> extends object ? true : false>()
  })
})

describe("fn/api/auth/admin — typing", () => {
  it("fn.call and the typed shortcuts carry the declared types", () => {
    assertType<Promise<number>, ReturnType<typeof fnCall>>()
    assertType<Promise<number>, ReturnType<typeof fnTyped>>()
    assertType<Promise<string>, ReturnType<typeof fnPing>>()
    assertType<{ a: number; b: number }, FnArgs<typeof Add>>()
    assertType<number, FnReturn<typeof Add>>()
    assertType<FnSurface<typeof schema>, C["fn"]>()
  })

  it("api/auth/admin surfaces keep their shapes", () => {
    assertType<Promise<{ id: string }>, ReturnType<typeof apiGet>>()
    assertType<Promise<{ ok: boolean }>, ReturnType<typeof apiPost>>()
    assertType<Promise<Tokens>, ReturnType<typeof authSignin>>()
    assertType<Promise<RootInfo>, ReturnType<typeof infoRoot>>()
    assertType<Promise<NsInfo>, ReturnType<typeof infoNs>>()
    assertType<Promise<DbInfo>, ReturnType<typeof infoDb>>()
    assertType<Promise<TableInfo>, ReturnType<typeof infoTable>>()
  })
})
