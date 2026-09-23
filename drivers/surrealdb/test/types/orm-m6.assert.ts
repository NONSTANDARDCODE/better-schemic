// M6 — TYPE assertions for plugins: `operationArgs` fold into delegate args, `extendModel` lands on
// the delegate and `extendClient` on the client. Run under node/tsx (NOT bun):
// `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest, setup, teardown } from "@ark/attest";
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
import { softDelete as softDeletePlugin } from "../../src/plugins/soft-delete";
import { timestamps as timestampsPlugin } from "../../src/plugins/timestamps";

let cleanup: (() => void) | undefined;
before(() => {
  cleanup = setup() as unknown as () => void;
});
after(() => {
  cleanup?.();
  teardown();
});

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
  type SD = typeof sd;
  type TS = typeof ts;

  it("softDelete adds `deleted` to reads and restore/restoreById to the delegate", () => {
    type CSD = Client<typeof schema, Surreal, [SD]>;
    attest<
      { deleted?: "with" | "without" | "only" },
      PluginArgs<[SD], "findMany">
    >();
    attest<
      true,
      "restore" extends keyof PluginModelExtras<[SD]> ? true : false
    >();
    attest<true, "restore" extends keyof CSD["users"] ? true : false>();
    attest<true, "restoreById" extends keyof CSD["users"] ? true : false>();
  });

  it("timestamps does not add per-operation args", () => {
    attest<Record<never, never>, PluginArgs<[TS], "create">>();
  });
});

describe("plugins — typing", () => {
  it("operationArgs fold into the matching delegate method args (optional)", () => {
    attest<
      { deleted?: "with" | "without" | "only" },
      PluginArgs<[Soft], "findMany">
    >();
    attest<{ mode?: "soft" | "hard" }, PluginArgs<[Soft], "delete">>();
    attest<Record<never, never>, PluginArgs<[Soft], "create">>();
    attest<
      true,
      ReturnType<typeof findManyDeleted> extends object ? true : false
    >();
    attest<true, ReturnType<typeof deleteSoft> extends object ? true : false>();
  });

  it("extendModel methods land on the delegate", () => {
    attest<
      true,
      "restore" extends keyof PluginModelExtras<[Soft]> ? true : false
    >();
    attest<true, "restore" extends keyof C["users"] ? true : false>();
    attest<unknown, ReturnType<typeof restore>>();
  });

  it("extendClient methods land on the client", () => {
    attest<
      true,
      "hello" extends keyof PluginClientExtras<[WithClient]> ? true : false
    >();
    attest<true, "hello" extends keyof CC ? true : false>();
    attest<"hi", ReturnType<typeof hello>>();
  });
});
