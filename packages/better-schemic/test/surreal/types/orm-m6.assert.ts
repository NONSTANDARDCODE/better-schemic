/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-restricted-types, @typescript-eslint/no-generated-empty-object-type, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type -- Object key order mirrors expected serialized output and must stay as authored. Fixtures use object to probe schema typing. Empty object literals are intentional fixtures. Type queries and callback signatures need fixture values. callbacks de teste: tipo inferido pelo saturador de assercoes; anotar cada um geraria ruido sem valor. */
// M6 — TYPE assertions for plugins: `operationArgs` fold into delegate args, `extendModel` lands on
// the delegate and `extendClient` on the client.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test"

import type { Surreal } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import { s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { definePlugin } from "../../../src/surreal/orm/plugins"
import { schema } from "../../../src/surreal/orm/schema"
import type {
  PluginArgs,
  PluginClientExtras,
  PluginModelExtras,
} from "../../../src/surreal/orm/types/plugins"
import { createOnlyGuard as createOnlyGuardPlugin } from "../../../src/surreal/plugins/create-only"
import { softDelete as softDeletePlugin } from "../../../src/surreal/plugins/soft-delete"
import { timestamps as timestampsPlugin } from "../../../src/surreal/plugins/timestamps"

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

/** Keep the fixture's operation args widened — `const Spec` inference would otherwise narrow them
 *  to the literal defaults and break the assertions below. */
const deletedArg: { deleted: "only" | "with" | "without" } = { deleted: "without" }
const modeArg: { mode: "hard" | "soft" } = { mode: "soft" }

const softDelete = definePlugin({
  id: "soft-delete",
  config: { column: "deletedAt" as const },
  operationArgs: {
    findMany: deletedArg,
    delete: modeArg,
  },
  extendModel() {
    return {
      restore: (args: { where: unknown }) => Promise.resolve(args),
    }
  },
})

const withClient = definePlugin({
  id: "with-client",
  extendClient() {
    return { hello: () => "hi" as const }
  },
})

type Soft = typeof softDelete
type WithClient = typeof withClient
type C = Client<typeof schemaDef, Surreal, [Soft]>
type CC = Client<typeof schemaDef, Surreal, [WithClient]>

const findManyDeleted = (client: C) => client.users.findMany({ deleted: "with" })
const deleteSoft = (client: C) => client.users.delete({ where: {}, mode: "soft" })
const restore = (client: C) =>
  (client.users as unknown as { restore(a: unknown): unknown }).restore({})
const hello = (client: CC) => client.hello()

void describe("plugins — official F2 typing", () => {
  const sd = softDeletePlugin()
  const ts = timestampsPlugin()
  const co = createOnlyGuardPlugin()
  type SD = typeof sd
  type TS = typeof ts
  type CO = typeof co

  void it("softDelete adds `deleted` to reads and restore/restoreById to the delegate", () => {
    type CSD = Client<typeof schemaDef, Surreal, [SD]>
    assertType<{ deleted?: "only" | "with" | "without" }, PluginArgs<[SD], "findMany">>()
    assertType<true, "restore" extends keyof PluginModelExtras<[SD]> ? true : false>()
    assertType<true, "restore" extends keyof CSD["users"] ? true : false>()
    assertType<true, "restoreById" extends keyof CSD["users"] ? true : false>()
  })

  void it("timestamps does not add per-operation args", () => {
    assertType<Record<never, never>, PluginArgs<[TS], "create">>()
  })

  void it("createOnlyGuard does not add per-operation args on any op", () => {
    assertType<Record<never, never>, PluginArgs<[CO], "create">>()
    assertType<Record<never, never>, PluginArgs<[CO], "update">>()
    assertType<Record<never, never>, PluginArgs<[CO], "insert">>()
  })
})

void describe("plugins — typing", () => {
  void it("operationArgs fold into the matching delegate method args (optional)", () => {
    assertType<{ deleted?: "only" | "with" | "without" }, PluginArgs<[Soft], "findMany">>()
    assertType<{ mode?: "hard" | "soft" }, PluginArgs<[Soft], "delete">>()
    assertType<Record<never, never>, PluginArgs<[Soft], "create">>()
    assertType<true, ReturnType<typeof findManyDeleted> extends object ? true : false>()
    assertType<true, ReturnType<typeof deleteSoft> extends object ? true : false>()
  })

  void it("extendModel methods land on the delegate", () => {
    assertType<true, "restore" extends keyof PluginModelExtras<[Soft]> ? true : false>()
    assertType<true, "restore" extends keyof C["users"] ? true : false>()
    assertType<unknown, ReturnType<typeof restore>>()
  })

  void it("extendClient methods land on the client", () => {
    assertType<true, "hello" extends keyof PluginClientExtras<[WithClient]> ? true : false>()
    assertType<true, "hello" extends keyof CC ? true : false>()
    assertType<"hi", ReturnType<typeof hello>>()
  })
})
