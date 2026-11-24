import { describe, it } from "node:test"

import type { Tokens } from "surrealdb"
import type { ZodNumber, ZodString } from "zod"

import { assertType } from "../../../../../scripts/type-assert"
import { defineFunction, s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { DbInfo, NsInfo, RootInfo, TableInfo } from "../../../src/surreal/orm/types/admin"
import type { ContextScope, OperationContext } from "../../../src/surreal/orm/types/context"
import type { FnArgs, FnReturn, FnSurface } from "../../../src/surreal/orm/types/fn"
import type { RawOptions, RawStatements } from "../../../src/surreal/orm/types/raw"
import type { SchemaDef } from "../../../src/surreal/orm/types/schema"
import type { FindManyArgs, FindUniqueArgs } from "../../../src/surreal/orm/types/select"
import type { FunctionDef, SField, TableDef, WithSmartId } from "../../../src/surreal/pure"

const MAGIC_2 = 2
// M5 — TYPE assertions for the raw escape hatches, context scoping, database functions, APIs, auth
// and admin: the call shapes (tagged template vs string/BoundQuery), the typed function shortcuts
// and the `$withContext` overloads (sync scope vs Promise session).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

const User = table("user", { name: s.string() })
const Add = defineFunction("add", { a: s.number(), b: s.number() }).returns(s.number())
const Ping = defineFunction("ping").returns(s.string())
const _schemaDef = schema({ add: Add, ping: Ping, users: User })
type C = Client<typeof _schemaDef>
type U = typeof User

/** Call shapes (instantiation expressions don't survive esbuild/tsx). */
const _rawTemplate = (client: C): Promise<string[]> => client.$raw<string[]>`SELECT 1`
const _rawString = (client: C): Promise<string[]> => client.$raw<string[]>("SELECT 1")
const _queryTemplate = (client: C): Promise<[string[], number]> =>
  client.$query<[string[], number]>`SELECT 1; SELECT 2`
const _queryFail = (client: C): Promise<RawStatements> =>
  client.$query("SELECT 1", { throwOnError: false })
const _rawCurried = (client: C): Promise<string[]> =>
  client.$raw({ meta: { comment: "seed" } })<string[]>`SELECT 1`
const _queryCurried = (client: C): Promise<RawStatements> =>
  client.$query({ throwOnError: false })`SELECT 1; SELECT 2`
const _unsafeCall = (client: C): Promise<number> =>
  client.$unsafe<number>("SELECT 1", { id: 1 }, { timeout: 100 })
const _fnCall = (client: C): Promise<number> => client.fn.call<number>("fn::add", [1, MAGIC_2])
const _fnTyped = (client: C): Promise<number> => client.fn.add({ a: 1, b: 2 })
const _fnPing = (client: C): Promise<string> => client.fn.ping()
const _apiGet = (client: C): Promise<{ id: string }> => client.api.get<{ id: string }>("/x")
const _apiPost = (client: C): Promise<{ ok: boolean }> =>
  client.api.post<{ ok: boolean }>("/x", { body: { a: 1 } })
const _authSignin = (client: C): Promise<Tokens> =>
  client.auth.signin({ password: "p", username: "u" })
const _infoRoot = (client: C): Promise<RootInfo> => client.info("root")
const _infoNs = (client: C): Promise<NsInfo> => client.info("ns")
const _infoDb = (client: C): Promise<DbInfo> => client.info("db")
const _infoTable = (client: C): Promise<TableInfo> => client.info("table", "user")
const _ctxSync = (
  client: C,
): Client<
  SchemaDef<{
    readonly add: FunctionDef<{ a: SField<ZodNumber>; b: SField<ZodNumber> }, number>
    readonly ping: FunctionDef<Record<string, never>, string>
    readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
  }>
> => client.$withContext({ database: "app", namespace: "tenant_a" })
const _ctxAsync = (
  client: C,
): Promise<
  Client<
    SchemaDef<{
      readonly add: FunctionDef<{ a: SField<ZodNumber>; b: SField<ZodNumber> }, number>
      readonly ping: FunctionDef<Record<string, never>, string>
      readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
    }>
  >
> =>
  client.$withContext({
    auth: "token",
    database: "app",
    namespace: "tenant_a",
  })
const _findManyCtx = (client: C): Promise<unknown> =>
  client.users.findMany({ context: { database: "analytics" } })
const _findUniqueCtx = (client: C): Promise<unknown> =>
  client.users.findUnique({
    context: { namespace: "a" },
    where: { id: "user:1" },
  })

void describe("raw — typing", () => {
  void it("the template/string/BoundQuery forms all resolve the first result", () => {
    assertType<Promise<string[]>, ReturnType<typeof _rawTemplate>>()
    assertType<Promise<string[]>, ReturnType<typeof _rawString>>()
    assertType<Promise<[string[], number]>, ReturnType<typeof _queryTemplate>>()
  })

  void it("throwOnError:false widens to the StatementResult envelopes", () => {
    assertType<Promise<RawStatements>, ReturnType<typeof _queryFail>>()
  })

  void it("the curried options-tag returns a bound tag", () => {
    assertType<Promise<string[]>, ReturnType<typeof _rawCurried>>()
    assertType<Promise<RawStatements>, ReturnType<typeof _queryCurried>>()
  })

  void it("$unsafe resolves the generic and accepts params/options", () => {
    assertType<Promise<number>, ReturnType<typeof _unsafeCall>>()
  })

  void it("RawOptions accepts timeout + meta and OperationContext the three keys", () => {
    assertType<true, "timeout" extends keyof RawOptions ? true : false>()
    assertType<true, "meta" extends keyof RawOptions ? true : false>()
    assertType<true, "namespace" extends keyof OperationContext ? true : false>()
    assertType<true, "database" extends keyof OperationContext ? true : false>()
    assertType<true, "meta" extends keyof OperationContext ? true : false>()
    assertType<true, "auth" extends keyof ContextScope ? true : false>()
  })
})

void describe("context — typing", () => {
  void it("$withContext is sync without auth and a Promise with it", () => {
    assertType<Client<typeof _schemaDef>, ReturnType<typeof _ctxSync>>()
    assertType<Promise<Client<typeof _schemaDef>>, ReturnType<typeof _ctxAsync>>()
  })

  void it("every read accepts a per-call context override", () => {
    assertType<true, "context" extends keyof FindManyArgs<U> ? true : false>()
    assertType<true, "context" extends keyof FindUniqueArgs<U> ? true : false>()
    // The call compiles (the lazy thenable shape exerciss it by the read suites).
    assertType<
      true,
      ReturnType<typeof _findManyCtx> extends infer T
        ? T extends null | undefined
          ? false
          : true
        : false
    >()
    assertType<
      true,
      ReturnType<typeof _findUniqueCtx> extends infer T
        ? T extends null | undefined
          ? false
          : true
        : false
    >()
  })
})

void describe("fn/api/auth/admin — typing", () => {
  void it("fn.call and the typed shortcuts carry the declared types", () => {
    assertType<Promise<number>, ReturnType<typeof _fnCall>>()
    assertType<Promise<number>, ReturnType<typeof _fnTyped>>()
    assertType<Promise<string>, ReturnType<typeof _fnPing>>()
    assertType<{ a: number; b: number }, FnArgs<typeof Add>>()
    assertType<number, FnReturn<typeof Add>>()
    assertType<FnSurface<typeof _schemaDef>, C["fn"]>()
  })

  void it("api/auth/admin surfaces keep their shapes", () => {
    assertType<Promise<{ id: string }>, ReturnType<typeof _apiGet>>()
    assertType<Promise<{ ok: boolean }>, ReturnType<typeof _apiPost>>()
    assertType<Promise<Tokens>, ReturnType<typeof _authSignin>>()
    assertType<Promise<RootInfo>, ReturnType<typeof _infoRoot>>()
    assertType<Promise<NsInfo>, ReturnType<typeof _infoNs>>()
    assertType<Promise<DbInfo>, ReturnType<typeof _infoDb>>()
    assertType<Promise<TableInfo>, ReturnType<typeof _infoTable>>()
  })
})
