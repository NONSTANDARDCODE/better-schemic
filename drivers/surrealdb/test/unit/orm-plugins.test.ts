// M6.2 — `definePlugin`: transforms (mutate where/data/kind), operationArgs passthrough, hooks,
// extendClient/extendModel, setup fail-fast, per-delegate state and `$withoutPlugins`. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import { BetterSchemicError, isBetterSchemicError } from "../../src/orm/errors";
import {
  createPluginPipeline,
  definePlugin,
  isPlugin,
  RuntimeOperation,
} from "../../src/orm/plugins";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", {
  name: s.string(),
  flag: s.boolean().optional(),
});
const schema = defineSchema({ users: User });

const row = () => [{ id: new RecordId("user", 1), name: "A", flag: false }];

function conn() {
  return fakeConn((sql) => lines(sql).map(() => ok(row())));
}

describe("definePlugin — transforms", () => {
  test("a transform mutates data before compile", async () => {
    const timestamps = definePlugin({
      id: "timestamps",
      config: { createdAt: "createdAt" },
      transform(op) {
        if (op.kind === "create")
          op.data[this.config.createdAt] = surql`time::now()`;
      },
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [timestamps] });
    await client.users.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("createdAt: time::now()");
  });

  test("a transform can change the operation kind (delete -> update)", async () => {
    const softDelete = definePlugin({
      id: "soft-delete",
      config: { column: "deletedAt" },
      transform(op) {
        if (op.kind === "delete") {
          op.kind = "update";
          op.data[this.config.column] = surql`time::now()`;
        }
      },
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [softDelete] });
    await client.users.delete({ where: { id: "user:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).not.toContain("DELETE");
  });

  test("a transform reads the delegate state set via $withState", async () => {
    const stamper = definePlugin({
      id: "stamper",
      transform(op) {
        if (op.state.stamp === true) op.data.flag = true;
      },
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [stamper] });
    await client.users.create({ data: { name: "A" } });
    expect(calls[0]?.vars?.p0).toEqual({ name: "A" });
    calls.length = 0;
    await client.users
      .$withState({ stamp: true })
      .create({ data: { name: "A" } });
    expect(calls[0]?.vars?.p0).toEqual({ name: "A", flag: true });
  });

  test("$withoutPlugins skips transforms", async () => {
    const timestamps = definePlugin({
      id: "timestamps",
      transform(op) {
        if (op.kind === "create") op.data.createdAt = surql`time::now()`;
      },
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [timestamps] });
    await client.users.$withoutPlugins().create({ data: { name: "A" } });
    expect(calls[0]?.sql).not.toContain("time::now()");
  });

  test("a transform returning false skips the operation", async () => {
    const skipper = definePlugin({
      id: "skipper",
      transform: () => false,
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [skipper] });
    const result = await client.users.findMany({});
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("definePlugin — hooks and extensions", () => {
  test("a plugin's hooks are merged with the client's", async () => {
    const events: string[] = [];
    const observer = definePlugin({
      id: "observer",
      hooks: {
        beforeQuery: () => {
          events.push("plugin");
        },
      },
    });
    const { conn: c } = conn();
    const client = betterSchemic(c, {
      schema,
      plugins: [observer],
      hooks: {
        beforeQuery: () => {
          events.push("client");
        },
      },
    });
    await client.users.findMany({});
    expect(events).toEqual(["client", "plugin"]);
  });

  test("extendClient grafts methods onto the client", () => {
    const ext = definePlugin({
      id: "ext",
      extendClient() {
        return { hello: () => "hi" };
      },
    });
    const { conn: c } = conn();
    const client = betterSchemic(c, { schema, plugins: [ext] });
    expect((client as unknown as { hello(): string }).hello()).toBe("hi");
  });

  test("extendModel grafts methods onto every delegate (restore recipe)", async () => {
    const soft = definePlugin({
      id: "soft",
      config: { column: "deletedAt" },
      extendModel({ model }) {
        return {
          restore: (args: { where: unknown }) =>
            (model as Delegate).update({
              where: args.where as never,
              mode: "set",
              data: { [this.config.column]: null },
            }),
        };
      },
    });
    const { conn: c, calls } = conn();
    const client = betterSchemic(c, { schema, plugins: [soft] });
    const delegate = client.users as unknown as {
      restore(args: { where: unknown }): Promise<unknown>;
    };
    await delegate.restore({ where: { id: "user:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).toContain("deletedAt = $p0");
    expect(calls[0]?.vars?.p0).toBeNull();
  });
});

describe("definePlugin — bootstrap validation", () => {
  test("setup runs exactly once at bootstrap", () => {
    let setups = 0;
    const plugin = definePlugin({
      id: "setup",
      setup() {
        setups++;
      },
    });
    const { conn: c } = conn();
    betterSchemic(c, { schema, plugins: [plugin] });
    expect(setups).toBe(1);
  });

  test("a duplicate plugin id fails fast with PluginError", () => {
    const plugin = definePlugin({ id: "dup" });
    const { conn: c } = conn();
    try {
      betterSchemic(c, { schema, plugins: [plugin, plugin] });
      throw new Error("expected a PluginError");
    } catch (e) {
      expect(isBetterSchemicError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("PluginError");
    }
  });

  test("a throwing setup is wrapped in PluginError", () => {
    const plugin = definePlugin({
      id: "bad",
      setup() {
        throw new Error("misconfigured");
      },
    });
    const { conn: c } = conn();
    try {
      betterSchemic(c, { schema, plugins: [plugin] });
      throw new Error("expected a PluginError");
    } catch (e) {
      expect(isBetterSchemicError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("PluginError");
    }
  });

  test("an extendClient collision fails fast", () => {
    const plugin = definePlugin({
      id: "collide",
      extendClient() {
        return { close: 1 };
      },
    });
    const { conn: c } = conn();
    try {
      betterSchemic(c, { schema, plugins: [plugin] });
      throw new Error("expected a PluginError");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PluginError");
    }
  });
});

describe("plugin runtime — edge paths", () => {
  test("a non-string or empty plugin id fails fast", () => {
    expect(() => createPluginPipeline([{ id: "" } as never])).toThrow(
      /non-empty/,
    );
    expect(() => createPluginPipeline([{ id: 5 } as never])).toThrow(
      /non-empty/,
    );
  });

  test("a plugin without transform is skipped by the pipeline", () => {
    const pipeline = createPluginPipeline([definePlugin({ id: "noop" })])!;
    expect(pipeline.hasTransforms).toBe(false);
    const op = new RuntimeOperation(
      "create",
      "user",
      {},
      {} as never,
      {} as never,
    );
    expect(pipeline.transform(op)).toBe(false);
  });

  test("a BetterSchemicError thrown by a plugin method is returned unchanged", () => {
    const mine = new BetterSchemicError("PluginError", "custom");
    const plugin = definePlugin({
      id: "p",
      setup() {
        throw mine;
      },
    });
    const pipeline = createPluginPipeline([plugin])!;
    try {
      pipeline.setup({} as never);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBe(mine);
    }
  });

  test("extendClient / extendModel failures wrap in PluginError", () => {
    const p = definePlugin({
      id: "p",
      extendClient() {
        throw new Error("x");
      },
      extendModel() {
        throw new Error("y");
      },
    });
    const pipeline = createPluginPipeline([p])!;
    expect(() => pipeline.extendClient({} as never)).toThrow(/extendClient/);
    expect(() => pipeline.extendModel({} as never, {} as never)).toThrow(
      /extendModel/,
    );
  });

  test("RuntimeOperation proxies where/data and commits only what changed", () => {
    const op = new RuntimeOperation(
      "create",
      "user",
      { where: { a: 1 }, data: { b: 2 } },
      {} as never,
      {} as never,
    );
    expect(op.where).toEqual({ a: 1 }); // existing args.where
    expect(op.data).toEqual({ b: 2 }); // existing args.data
    op.where = { c: 3 };
    op.data = { d: 4 };
    expect(op.where).toEqual({ c: 3 });
    op.commit();
    expect(op.args.where).toEqual({ c: 3 });
    expect(op.args.data).toEqual({ d: 4 });

    // A fresh op lazily creates empty bags (and returns the SAME bag on re-read).
    const fresh = new RuntimeOperation(
      "create",
      "user",
      {},
      {} as never,
      {} as never,
    );
    const bag = fresh.where;
    expect(bag).toEqual({});
    expect(fresh.where).toBe(bag);
    expect(fresh.data).toEqual({});
  });

  test("isPlugin brand check", () => {
    expect(isPlugin(definePlugin({ id: "p" }))).toBe(true);
    expect(isPlugin({})).toBe(false);
    expect(isPlugin(null)).toBe(false);
    expect(isPlugin(5)).toBe(false);
  });
});
