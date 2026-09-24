// defineSequence — DEFINE SEQUENCE (db-level monotonic counter). The fluent builder validates
// eagerly (so a malformed sequence fails at module load), and the materialized BATCH 1000 / START 0
// defaults are stripped from canonical DDL so an authored minimal sequence round-trips drift-free.
import { describe, expect, test } from "bun:test";
import { parseFilter, planKinds } from "@better-schemic/core";
import { schemaStruct } from "../../src/cli/lower";
import { renderPerFile } from "../../src/cli/pull";
import { structuredSnapshot } from "../../src/cli/structure";
import { normalizeSequence } from "../../src/cli/struct";
import { filterStructured, included } from "../../src/cli/surreal-filter";
import { emitDefStatement, removeStatement } from "../../src/ddl";
import { defineSequence } from "../../src/index";
import { explodeSchema, toStructured } from "../../src/kinds/explode";
import { lowerAll, surrealKinds } from "../../src/kinds/registry";

describe("authoring", () => {
  test("a non-identifier name is rejected", () => {
    expect(() => defineSequence("not ok")).toThrow(/plain identifier/);
    expect(() => defineSequence("1abc")).toThrow(/plain identifier/);
  });

  test("batch must be a positive integer, start an integer, timeout a duration", () => {
    expect(() => defineSequence("s").batch(0)).toThrow(/positive integer/);
    expect(() => defineSequence("s").batch(2.5)).toThrow(/positive integer/);
    expect(() => defineSequence("s").start(1.5)).toThrow(/integer/);
    expect(() => defineSequence("s").timeout("soon")).toThrow(/duration/);
    expect(defineSequence("s").timeout("1h30m").config.timeout).toBe("1h30m");
  });

  test("the builder is immutable (each call returns a new def)", () => {
    const base = defineSequence("s");
    expect(base.config).toEqual({});
    expect(base.batch(10).config).toEqual({ batch: 10 });
    expect(base.config).toEqual({});
    expect(
      defineSequence("s").batch(50).start(1000).timeout("5s").config,
    ).toEqual({ batch: 50, start: 1000, timeout: "5s" });
  });
});

describe("DDL", () => {
  test("defaults (BATCH 1000 / START 0) are omitted", () => {
    const { kind, ddl } = emitDefStatement(defineSequence("invoice"));
    expect(kind).toBe("sequence");
    expect(ddl).toBe("DEFINE SEQUENCE invoice;");
    // explicit defaults collapse to the same minimal form
    expect(
      emitDefStatement(defineSequence("s").batch(1000).start(0)).ddl,
    ).toBe("DEFINE SEQUENCE s;");
  });

  test("non-default tunables are emitted in grammar order (BATCH, START, TIMEOUT)", () => {
    expect(
      emitDefStatement(
        defineSequence("ticket").batch(50).start(1000).timeout("5s"),
      ).ddl,
    ).toBe("DEFINE SEQUENCE ticket BATCH 50 START 1000 TIMEOUT 5s;");
    expect(
      emitDefStatement(defineSequence("s"), { exists: "overwrite" }).ddl,
    ).toBe("DEFINE SEQUENCE OVERWRITE s;");
  });

  test("REMOVE SEQUENCE is the inverse", () => {
    expect(
      removeStatement({ kind: "sequence", name: "invoice" }),
    ).toBe("REMOVE SEQUENCE IF EXISTS invoice;");
  });
});

describe("normalize", () => {
  test("materialized defaults are stripped so authored == introspected", () => {
    // INFO … STRUCTURE reports BATCH 1000 / START 0 explicitly.
    expect(
      normalizeSequence({ name: "s", batch: 1000, start: 0 }),
    ).toEqual({ name: "s" });
    expect(
      normalizeSequence({ name: "s", batch: 10, start: 5, timeout: "2s" }),
    ).toEqual({ name: "s", batch: 10, start: 5, timeout: "2s" });
  });

  test("sequences flow through schemaStruct's normalized Struct IR", () => {
    const db = schemaStruct([], [
      defineSequence("bare"),
      defineSequence("tuned").batch(10).timeout("2s"),
    ]);
    expect(db.sequences).toEqual([
      { name: "bare" },
      { name: "tuned", batch: 10, timeout: "2s" },
    ]);
  });
});

describe("canonical DDL (every clause variant)", () => {
  test("structuredSnapshot emits BATCH/START/TIMEOUT in grammar order", () => {
    const db = schemaStruct([], [
      defineSequence("bare"),
      defineSequence("b").batch(10),
      defineSequence("s").start(5),
      defineSequence("t").timeout("2s"),
      defineSequence("all").batch(10).start(5).timeout("2s"),
    ]);
    const ddls = Object.values(structuredSnapshot(db).statements)
      .map((s) => s.ddl)
      .sort();
    expect(ddls).toEqual([
      "DEFINE SEQUENCE all BATCH 10 START 5 TIMEOUT 2s;",
      "DEFINE SEQUENCE b BATCH 10;",
      "DEFINE SEQUENCE bare;",
      "DEFINE SEQUENCE s START 5;",
      "DEFINE SEQUENCE t TIMEOUT 2s;",
    ]);
  });

  test("an introspected sequence with materialized defaults canonicalizes to bare", () => {
    const snap = structuredSnapshot({
      tables: [],
      functions: [],
      accesses: [],
      analyzers: [],
      params: [],
      sequences: [{ name: "d", batch: 1000, start: 0 }],
    });
    expect(Object.values(snap.statements)[0]?.ddl).toBe("DEFINE SEQUENCE d;");
  });
});

describe("kind registry: diff (emit / overwrite / remove) + explode round-trip", () => {
  test("planKinds adds, overwrites and removes a sequence", () => {
    const Bare = lowerAll([], [defineSequence("k")]);
    const Tuned = lowerAll([], [defineSequence("k").batch(10)]);
    expect(planKinds(surrealKinds, [], Bare).up.join("\n")).toContain(
      "DEFINE SEQUENCE k;",
    );
    expect(planKinds(surrealKinds, Bare, Tuned).up.join("\n")).toContain(
      "OVERWRITE k BATCH 10",
    );
    expect(planKinds(surrealKinds, Tuned, []).up.join("\n")).toContain(
      "REMOVE SEQUENCE IF EXISTS k;",
    );
    expect(planKinds(surrealKinds, Bare, lowerAll([], [defineSequence("k")])).up).toEqual(
      [],
    );
  });

  test("explode -> toStructured round-trips the sequence native", () => {
    const objs = explodeSchema([], [defineSequence("x").batch(3)]);
    const seq = objs.find((o) => o.kind === "sequence");
    expect(seq?.name).toBe("x");
    expect(toStructured(objs).sequences).toEqual([{ name: "x", batch: 3 }]);
  });
});

describe("filter + pull", () => {
  test("sequences pass the object filter and render one file each", () => {
    const db = schemaStruct([], [defineSequence("x")]);
    expect(filterStructured(db, parseFilter({})).sequences).toEqual([
      { name: "x" },
    ]);
    // A legacy DbStructured without `sequences` defaults to [] (the `?? []` fallback).
    expect(
      filterStructured(
        { tables: [], functions: [], accesses: [], analyzers: [], params: [] },
        parseFilter({}),
      ).sequences,
    ).toEqual([]);
    expect(
      [...renderPerFile(db, (_k, n) => `${n}.ts`).values()].join("\n"),
    ).toContain('defineSequence("x")');
    expect(
      included(parseFilter({}), {
        kind: "sequence",
        name: "x",
        ddl: "DEFINE SEQUENCE x;",
      }),
    ).toBe(true);
  });
});

// --- live (SURREAL_URL-gated) ---------------------------------------------------------------------
const URL = process.env.SURREAL_URL;

describe.skipIf(!URL)("defineSequence live", () => {
  test("apply → introspect → diff is empty; pull regenerates the fluent call", async () => {
    const { Surreal } = await import("surrealdb");
    const { planKinds } = await import("@better-schemic/core");
    const { introspectAll } = await import("../../src/kinds/explode");
    const { lowerAll, surrealKinds } = await import("../../src/kinds/registry");
    const { normalizeDb } = await import("../../src/cli/struct");
    const { renderSchemaToTS } = await import("../../src/cli/pull");
    const { introspectStructured } = await import("../../src/cli/structure");

    const Bare = defineSequence("dsq_bare");
    const Tuned = defineSequence("dsq_tuned").batch(50).start(1000).timeout("5s");

    const c = new Surreal();
    await c.connect(URL as string);
    await c.signin({ username: "root", password: "root" });
    await c.use({ namespace: "dsq", database: "dsq" });
    await c.query(
      "REMOVE SEQUENCE IF EXISTS dsq_bare; REMOVE SEQUENCE IF EXISTS dsq_tuned;",
    );
    for (const def of [Bare, Tuned])
      await c.query(emitDefStatement(def, { exists: "overwrite" }).ddl);

    // Drift-free: the lowered authored side diffs to zero against the introspected live side.
    const plan = planKinds(
      surrealKinds,
      await introspectAll(c),
      lowerAll([], [Bare, Tuned]),
    );
    expect(plan.up).toEqual([]);

    // The sequence actually advances.
    const [n] = (await c.query("RETURN sequence::nextval('dsq_tuned')")) as [
      number,
    ];
    expect(n).toBe(1000);

    // Pull regenerates the fluent authoring.
    const rendered = renderSchemaToTS(
      normalizeDb(await introspectStructured(c)),
    );
    expect(rendered).toContain('defineSequence("dsq_bare")');
    expect(rendered).toContain(
      'defineSequence("dsq_tuned").batch(50).start(1000).timeout("5s")',
    );

    await c.query(
      "REMOVE SEQUENCE IF EXISTS dsq_bare; REMOVE SEQUENCE IF EXISTS dsq_tuned;",
    );
    await c.close();
  }, 60_000);
});
