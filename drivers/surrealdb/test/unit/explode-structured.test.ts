// The driver-side EXPLODE's inverse: `fromStructured` fans a schema into per-kind portable objects and
// `toStructured` reassembles the `DbStructured` (every opaque kind carrying its `native`), plus the
// `fn::` dependency-edge dedupe.
import { describe, expect, test } from "bun:test";
import { explodeSchema, toStructured } from "../../src/kinds/explode";
import {
  defineAccess,
  defineAnalyzer,
  defineFunction,
  defineParam,
  defineTable,
  s,
  surql,
} from "../../src/index";

const F = defineFunction("ex_fn", { a: s.string() })
  .returns(s.string())
  .body(({ a }) => surql`RETURN ${a}`);

describe("fromStructured / toStructured (all kinds)", () => {
  test("every opaque kind carries its native back through toStructured", () => {
    const T = defineTable("ex_t", { name: s.string() });
    const A = defineAccess("ex_acc").onDatabase().record();
    const An = defineAnalyzer("ex_an");
    const P = defineParam("ex_p", 25);

    const objects = explodeSchema([T], [F, A, An, P]);
    const kinds = new Set<string>(objects.map((o) => o.kind));
    for (const k of ["table", "function", "access", "analyzer", "param"])
      expect(kinds.has(k)).toBe(true);

    const db = toStructured(objects);
    expect(db.tables.map((t) => t.name)).toContain("ex_t");
    expect(db.functions.map((f) => f.name)).toContain("ex_fn");
    expect(db.accesses.map((a) => a.name)).toContain("ex_acc");
    expect(db.analyzers.map((a) => a.name)).toContain("ex_an");
    expect(db.params.map((p) => p.name)).toContain("ex_p");
  });

  test("depsOf dedupes repeated fn:: references on one object", () => {
    const T = defineTable("ex_dep", {
      a: s.string().$default(surql`fn::ex_fn('x')`),
      b: s.string().$default(surql`fn::ex_fn('y')`),
    });
    const table = explodeSchema([T], [F]).find(
      (o) => o.kind === "table" && o.name === "ex_dep",
    ) as { deps: { kind: string; name: string }[] };
    expect(table.deps.filter((d) => d.kind === "function")).toEqual([
      { kind: "function", name: "ex_fn" },
    ]);
  });

  test("a self-referencing function body is not its own dependency edge", () => {
    const R = defineFunction("ex_rec", { n: s.number() })
      .returns(s.number())
      .body(({ n }) => surql`RETURN fn::ex_rec(${n})`);
    const fn = explodeSchema([], [R]).find((o) => o.kind === "function") as {
      deps: unknown[];
    };
    expect(fn.deps).toEqual([]);
  });
});
