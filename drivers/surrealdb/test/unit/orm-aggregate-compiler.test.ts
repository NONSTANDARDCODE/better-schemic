// The aggregate compiler in isolation: `count`/`exists` clause tails, and every `aggregate`
// select-entry shape (true / path / string / math / collect / expression / bad) plus its guards.
import { describe, expect, test } from "bun:test";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileAggregate,
  compileCount,
  compileExists,
} from "../../src/orm/compiler/aggregate";
import { createBinds } from "../../src/orm/compiler/shared";
import { defineSchema } from "../../src/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";
import { schema } from "./orm-writes-fixtures";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

const { conn } = fakeConn(() => [ok([])]);
const client = betterSchemic(conn, { schema });
const meta = client.$index.tables.get("users")!;
const b = () => createBinds();

const sm = betterSchemic(fakeConn(() => [ok([])]).conn, {
  schema: defineSchema({ audit: "audit_log" }),
}).$index.schemaless.get("audit")!;

describe("compileCount / compileExists", () => {
  test("defaults and every clause tail", () => {
    expect(compileCount(meta, {}, b())).toContain("count()");
    expect(compileExists(meta, {}, b())).toContain("VALUE id");
    const withAll = {
      with: { index: "i" },
      version: new Date("2025-01-01T00:00:00Z"),
      timeout: 5,
    } as never;
    expect(compileCount(meta, withAll, b())).toContain("WITH INDEX i");
    const exists = compileExists(meta, withAll, b());
    expect(exists).toContain("WITH INDEX i");
    expect(exists).toContain("VERSION");
    expect(exists).toContain("TIMEOUT");
    // a schemaless meta compiles without table where-options.
    expect(compileCount(sm, {}, b())).toContain("count()");
    expect(compileExists(sm, {}, b())).toContain("VALUE id");
  });
});

describe("compileAggregate", () => {
  test("defaults, a projected path and a true non-count entry", () => {
    expect(
      compileAggregate(meta, { select: { _count: true } }, b()).sql,
    ).toContain("GROUP ALL");
    const plan = compileAggregate(
      meta,
      { select: { active: true, city: "address.city" } },
      b(),
    );
    expect(plan.sql).toContain("active");
    expect(plan.sql).toContain("address.city AS city");
  });

  test("min/max decode a leaf; sum falls back to the raw aggregate", () => {
    const plan = compileAggregate(
      meta,
      { select: { lo: { min: "age" }, hi: { max: "age" }, total: { sum: "age" } } },
      b(),
    );
    expect(plan.sql).toContain("math::min(age) AS lo");
    expect(plan.sql).toContain("math::max(age) AS hi");
    expect(plan.sql).toContain("math::sum(age) AS total");
  });

  test("an expression entry skips the static group-key check", () => {
    expect(
      compileAggregate(
        meta,
        { select: { _count: true, x: surql`count() + 1` }, groupBy: ["active"] },
        b(),
      ).sql,
    ).toContain("GROUP BY active");
  });

  test("guards: non-object/empty select, skipped entries, bad aggregator shapes", () => {
    expect(code(() => compileAggregate(meta, { select: 5 }, b()))).toBe(
      "ValidationError",
    );
    // every entry skipped → empty projection.
    expect(
      code(() => compileAggregate(meta, { select: { a: false } }, b())),
    ).toBe("ValidationError");
    // a `false`/`undefined` entry is skipped, the rest compiles.
    expect(
      compileAggregate(meta, { select: { a: false, _count: true } }, b()).sql,
    ).toContain("count()");
    expect(
      compileAggregate(meta, { select: { a: undefined, _count: true } }, b()).sql,
    ).toContain("count()");
    // aggregator field must be a string path.
    expect(
      code(() => compileAggregate(meta, { select: { x: { sum: 5 } } }, b())),
    ).toBe("ValidationError");
    // an empty-string field path is rejected too.
    expect(
      code(() => compileAggregate(meta, { select: { x: { sum: "" } } }, b())),
    ).toBe("ValidationError");
    // an entry that is none of the accepted shapes.
    expect(
      code(() => compileAggregate(meta, { select: { x: 5 } }, b())),
    ).toBe("ValidationError");
  });

  test("a schemaless meta still compiles (no table where-options)", () => {
    expect(
      compileAggregate(sm, { select: { _count: true }, where: { a: 1 } }, b()).sql,
    ).toContain("count()");
  });
});
