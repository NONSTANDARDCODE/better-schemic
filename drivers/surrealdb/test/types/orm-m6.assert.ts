// M6 — TYPE assertions for plugins: `operationArgs` fold into delegate args, `extendModel` lands on
// the delegate and `extendClient` on the client.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import type { Surreal } from "surrealdb";
import { defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import { definePlugin } from "../../src/orm/plugins";
import { defineSchema } from "../../src/orm/schema";
import type {
  PluginArgs,
  PluginClientExtras,
  PluginModelExtras,
} from "../../src/orm/types/plugins";
import { createOnlyGuard as createOnlyGuardPlugin } from "../../src/plugins/create-only";
import { softDelete as softDeletePlugin } from "../../src/plugins/soft-delete";
import { timestamps as timestampsPlugin } from "../../src/plugins/timestamps";


const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

const softDelete = definePlugin({
  id: "soft-delete",
  config: { column: "deletedAt" as const },
  operationArgs: {
    findMany: { deleted: "without" as "with" | "without" | "only" },
    delete: { mode: "soft" as "soft" | "hard" },
  },
  extendModel() {
    return {
      restore: (args: { where: unknown }) => Promise.resolve(args),
    };
  },
});

const withClient = definePlugin({
  id: "with-client",
  extendClient() {
    return { hello: () => "hi" as const };
  },
});

type Soft = typeof softDelete;
type WithClient = typeof withClient;
type C = Client<typeof schema, Surreal, [Soft]>;
type CC = Client<typeof schema, Surreal, [WithClient]>;

const findManyDeleted = (client: C) =>
  client.users.findMany({ deleted: "with" });
const deleteSoft = (client: C) =>
  client.users.delete({ where: {}, mode: "soft" });
const restore = (client: C) =>
  (client.users as unknown as { restore(a: unknown): unknown }).restore({});
const hello = (client: CC) => client.hello();

describe("plugins — official F2 typing", () => {
  const sd = softDeletePlugin();
  const ts = timestampsPlugin();
  const co = createOnlyGuardPlugin();
  type SD = typeof sd;
  type TS = typeof ts;
  type CO = typeof co;

  it("softDelete adds `deleted` to reads and restore/restoreById to the delegate", () => {
    type CSD = Client<typeof schema, Surreal, [SD]>;
    assertType<
      { deleted?: "with" | "without" | "only" },
      PluginArgs<[SD], "findMany">
    >();
    assertType<
      true,
      "restore" extends keyof PluginModelExtras<[SD]> ? true : false
    >();
    assertType<true, "restore" extends keyof CSD["users"] ? true : false>();
    assertType<true, "restoreById" extends keyof CSD["users"] ? true : false>();
  });

  it("timestamps does not add per-operation args", () => {
    assertType<Record<never, never>, PluginArgs<[TS], "create">>();
  });

  it("createOnlyGuard does not add per-operation args on any op", () => {
    assertType<Record<never, never>, PluginArgs<[CO], "create">>();
    assertType<Record<never, never>, PluginArgs<[CO], "update">>();
    assertType<Record<never, never>, PluginArgs<[CO], "insert">>();
  });
});

describe("plugins — typing", () => {
  it("operationArgs fold into the matching delegate method args (optional)", () => {
    assertType<
      { deleted?: "with" | "without" | "only" },
      PluginArgs<[Soft], "findMany">
    >();
    assertType<{ mode?: "soft" | "hard" }, PluginArgs<[Soft], "delete">>();
    assertType<Record<never, never>, PluginArgs<[Soft], "create">>();
    assertType<
      true,
      ReturnType<typeof findManyDeleted> extends object ? true : false
    >();
    assertType<true, ReturnType<typeof deleteSoft> extends object ? true : false>();
  });

  it("extendModel methods land on the delegate", () => {
    assertType<
      true,
      "restore" extends keyof PluginModelExtras<[Soft]> ? true : false
    >();
    assertType<true, "restore" extends keyof C["users"] ? true : false>();
    assertType<unknown, ReturnType<typeof restore>>();
  });

  it("extendClient methods land on the client", () => {
    assertType<
      true,
      "hello" extends keyof PluginClientExtras<[WithClient]> ? true : false
    >();
    assertType<true, "hello" extends keyof CC ? true : false>();
    assertType<"hi", ReturnType<typeof hello>>();
  });
});
