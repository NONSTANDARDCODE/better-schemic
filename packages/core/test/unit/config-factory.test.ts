import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveConnection } from "../../src/client";
import { defineConfig } from "../../src/config";
import { connectionEntry, isConnectionEntry } from "../../src/connection";

// A fake driver entry whose embedded client opener just reflects the resolved config back.
// Direct connectionEntry call so the Client generic INFERS from the opener's return type.
const fake = () =>
  connectionEntry(
    "fakedriver",
    { schema: "./database/schema" },
    {
      client: async (cfg) => ({ connection: cfg.connection, closed: false }),
    },
  );

describe("config-as-factory (defineConfig().connect)", () => {
  test("connect() opens the entry's embedded client (default resolution)", async () => {
    const betterSchemic = defineConfig({ connections: { default: fake() } });
    const db = await betterSchemic.connect();
    expect(db.connection).toBe("default");
  });

  test("connect(name) is typed to the config's connection names", async () => {
    const betterSchemic = defineConfig({
      defaultConnection: "main",
      connections: { main: fake(), reporting: fake() },
    });
    expect((await betterSchemic.connect("reporting")).connection).toBe(
      "reporting",
    );
    expect((await betterSchemic.connect()).connection).toBe("main");
    // @ts-expect-error — "nope" is not a configured connection name
    await expect(betterSchemic.connect("nope")).rejects.toThrow("not defined");
  });

  test("an entry without an embedded client opener fails with a clear error", async () => {
    const betterSchemic = defineConfig({
      connections: { default: connectionEntry("olddriver", { schema: "./s" }) },
    });
    await expect(betterSchemic.connect()).rejects.toThrow(
      "predates config.connect()",
    );
  });

  test("resolver args are the TYPED 2nd param; connect(name, args) selects one config", async () => {
    let seen: { tenant: string } | undefined;
    const entry = connectionEntry(
      "fakedriver",
      (_ctx, args: { tenant: string }) => {
        seen = args;
        return { schema: "./s", key: args.tenant };
      },
      { client: async (cfg) => ({ connection: cfg.connection }) },
    );
    const betterSchemic = defineConfig({ connections: { tenants: entry } });
    const db = await betterSchemic.connect("tenants", { tenant: "acme" });
    expect(db.connection).toBe("tenants:acme");
    expect(seen).toEqual({ tenant: "acme" });
  });

  test("a BULK (array) resolution throws a teaching error from connect", async () => {
    const entry = connectionEntry(
      "fakedriver",
      () => [
        { schema: "./s", key: "a" },
        { schema: "./s", key: "b" },
      ],
      { client: async (cfg) => ({ connection: cfg.connection }) },
    );
    const betterSchemic = defineConfig({ connections: { fleet: entry } });
    await expect(betterSchemic.connect("fleet")).rejects.toThrow(
      /resolved to 2 configs \(a, b\).*Pass args/s,
    );
  });

  test("labels: config key > entry label hook > positional", async () => {
    const { resolveFromConfig } = await import("../../src/client");
    const entry = connectionEntry(
      "fakedriver",
      () => [{ schema: "./s", key: "keyed" }, { schema: "./s" }],
      { label: (cfg) => `lbl:${cfg.connection}` },
    );
    const config = defineConfig({ connections: { fleet: entry } });
    const r = await resolveFromConfig(config, "/proj", { name: "fleet" });
    expect(r.labels).toEqual(["keyed", "lbl:fleet"]);
  });
});

describe("better-schemic.ts discovery", () => {
  const dir = mkdtempSync(join(import.meta.dir, "..", "..", ".cfg-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A real project has its deps installed — link this workspace package into the temp
  // project's node_modules so the fixture's bare `@better-schemic/core/*` imports resolve
  // (same symlink-farm idea as the surrealdb e2e harness).
  {
    const scope = join(dir, "node_modules", "@better-schemic");
    mkdirSync(scope, { recursive: true });
    for (const link of ["core"]) {
      const abs = join(scope, link);
      if (!existsSync(abs)) symlinkSync(join(import.meta.dir, "..", ".."), abs);
    }
  }

  const CONFIG_BODY =
    `import { defineConfig } from "@better-schemic/core/config";\n` +
    `import { connectionEntry } from "@better-schemic/core";\n` +
    `export const betterSchemic = defineConfig({ connections: { default: connectionEntry("testdriver", { schema: "./database/schema" }) } });\n` +
    `export default betterSchemic;\n`;

  test("a bare better-schemic.ts (named + default export) is discovered", async () => {
    writeFileSync(join(dir, "better-schemic.ts"), CONFIG_BODY);
    const rc = await resolveConnection({ cwd: dir });
    expect(rc.driver).toBe("testdriver");
  });

  test("a NAMED-ONLY `betterSchemic` export (no default) loads — the scaffolded form", async () => {
    writeFileSync(
      join(dir, "better-schemic.config.ts"),
      CONFIG_BODY.replace("export default betterSchemic;\n", "").replace(
        "testdriver",
        "nameddriver",
      ),
    );
    const rc = await resolveConnection({ cwd: dir });
    expect(rc.driver).toBe("nameddriver");
    rmSync(join(dir, "better-schemic.config.ts"));
  });

  test("better-schemic.config.ts wins over better-schemic.ts when both exist", async () => {
    writeFileSync(
      join(dir, "better-schemic.config.ts"),
      CONFIG_BODY.replace("testdriver", "configdriver"),
    );
    const rc = await resolveConnection({ cwd: dir });
    expect(rc.driver).toBe("configdriver");
    rmSync(join(dir, "better-schemic.config.ts"));
  });

  test("legacy `schemic.config.ts` + named `schemic` export still load", async () => {
    rmSync(join(dir, "better-schemic.ts"));
    writeFileSync(
      join(dir, "schemic.config.ts"),
      CONFIG_BODY.replaceAll("betterSchemic", "schemic")
        .replace("export default schemic;\n", "")
        .replace("testdriver", "legacydriver"),
    );
    const rc = await resolveConnection({ cwd: dir });
    expect(rc.driver).toBe("legacydriver");
    rmSync(join(dir, "schemic.config.ts"));
    writeFileSync(join(dir, "better-schemic.ts"), CONFIG_BODY);
  });

  test("an unrelated better-schemic.ts (no connections) errors helpfully", async () => {
    writeFileSync(
      join(dir, "better-schemic.ts"),
      `export const helper = 42;\n`,
    );
    await expect(resolveConnection({ cwd: dir })).rejects.toThrow(
      "doesn't export a config",
    );
  });
});

describe("isConnectionEntry", () => {
  test("distinguishes a real factory output from stray values", () => {
    expect(isConnectionEntry(connectionEntry("d", { schema: "./s" }))).toBe(
      true,
    );
    expect(isConnectionEntry({})).toBe(false);
    expect(isConnectionEntry(null)).toBe(false);
    expect(isConnectionEntry(42)).toBe(false);
  });
});

describe("chained config (defineConfig().connection(...))", () => {
  const fakeFactory = (
    input: import("../../src/connection").ConnectionInput<
      { schema: string; key?: string },
      // biome-ignore lint/suspicious/noExplicitAny: test factory
      any
    >,
  ) =>
    connectionEntry("fakedriver", input, {
      client: async (cfg) => ({
        connection: cfg.connection,
        query: async () => ["row"],
      }),
    });

  test("chained static + parameterized with typed accumulated ctx", async () => {
    let sawSibling: unknown;
    const betterSchemic = defineConfig()
      .connection("main", fakeFactory, { schema: "./s" })
      .connection(
        "tenants",
        fakeFactory,
        async (ctx, args: { org: string }) => {
          const main = await ctx.connections.main; // thenable handle -> full client
          sawSibling = await main.query();
          return { schema: "./s", key: args.org };
        },
      );
    const db = await betterSchemic.connect("tenants", { org: "acme" });
    expect(db.connection).toBe("tenants:acme");
    expect(sawSibling).toEqual(["row"]);
    expect((await betterSchemic.connect("main")).connection).toBe("main");
    // @ts-expect-error — "nope" is not a chained connection name
    await expect(betterSchemic.connect("nope")).rejects.toThrow("not defined");
  });

  test("order = visibility: a resolver reaching FORWARD is a compile error (and later a cycle guard)", async () => {
    defineConfig().connection("a", fakeFactory, (ctx) => {
      // @ts-expect-error — "b" is declared AFTER "a", so it is not visible here
      void ctx.connections.b;
      return { schema: "./s" };
    });
  });
});
