// M1.1 — the `where` compiler: args -> exact `{ sql, vars }` goldens, family-aware operators,
// path/identifier escaping and injection-proof values. Offline (no server).
import { describe, expect, test } from "bun:test";
import { escapeIdent } from "surrealdb";
import { surql } from "../../src/index";
import { createBinds } from "../../src/orm/compiler/shared";
import { compileWhere } from "../../src/orm/compiler/where";
import type { BetterSchemicError } from "../../src/orm/errors";
import type { TableMeta } from "../../src/orm/meta";
import { buildSchemaIndex } from "../../src/orm/schema";
import { defineTable, range, s } from "../../src/pure";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  createdAt: s.datetime(),
  ttl: s.duration(),
  balance: s.decimal(),
  tags: s.array(s.string()),
  scores: s.array(s.int()),
  address: s.object({ city: s.string(), country: s.string() }),
  contacts: s.array(s.object({ type: s.string(), value: s.string() })),
  location: s.geometry(),
  embedding: s.array(s.float()),
});

const index = buildSchemaIndex({ users: User });
const meta = index.tables.get("users") as TableMeta;

/** Compile a `where` and capture its statement text + binds. */
function compile(where: unknown, table: TableMeta | undefined = meta) {
  const binds = createBinds();
  const sql = compileWhere(where, binds, table ? { meta: table } : {});
  return { sql, vars: binds.vars };
}

/** Normalize the SDK tag's globally-counted `bind__N` names so fragment goldens are stable. */
function stable({
  sql,
  vars,
}: {
  sql: string | undefined;
  vars: Record<string, unknown>;
}) {
  const aliases = new Map<string, string>();
  const text = (sql ?? "").replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!name.startsWith("bind__")) return `$${name}`;
    let alias = aliases.get(name);
    if (!alias) {
      alias = `frag${aliases.size}`;
      aliases.set(name, alias);
    }
    return `$${alias}`;
  });
  const outVars: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(vars))
    outVars[aliases.get(name) ?? name] = value;
  return { sql: text, vars: outVars };
}

/** The `code` of the error a compile call throws (undefined if it doesn't throw). */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}

describe("where — values, equality and presence", () => {
  test("pure values are equals; multiple keys are AND", () => {
    expect(compile({ active: true, age: 30 })).toEqual({
      sql: "active = $p0 AND age = $p1",
      vars: { p0: true, p1: 30 },
    });
  });

  test("null is the NULL literal; NONE has its own operators", () => {
    expect(compile({ name: null })).toEqual({ sql: "name = NULL", vars: {} });
    expect(compile({ name: { isNull: true } }).sql).toBe("name = NULL");
    expect(compile({ name: { isNotNull: true } }).sql).toBe("name != NULL");
    expect(compile({ name: { isNone: true } }).sql).toBe("name = NONE");
    expect(compile({ name: { isNotNone: true } }).sql).toBe("name != NONE");
  });

  test("operators on the same field AND together", () => {
    expect(compile({ age: { gte: 18, lt: 65 } })).toEqual({
      sql: "age >= $p0 AND age < $p1",
      vars: { p0: 18, p1: 65 },
    });
  });

  test("equals/notEquals/exact/in/notIn", () => {
    expect(compile({ name: { equals: "a" } }).sql).toBe("name = $p0");
    expect(compile({ name: { notEquals: "a" } }).sql).toBe("name != $p0");
    expect(compile({ age: { exact: 30 } }).sql).toBe("age == $p0");
    expect(compile({ name: { in: ["a", "b"] } })).toEqual({
      sql: "name IN $p0",
      vars: { p0: ["a", "b"] },
    });
    expect(compile({ name: { notIn: ["a"] } }).sql).toBe("name NOT IN $p0");
  });

  test("`in` accepts a typed range (bounds bind)", () => {
    expect(compile({ age: { in: range({ from: 18, to: 65 }) } })).toEqual({
      sql: "age IN $p0..=$p1",
      vars: { p0: 18, p1: 65 },
    });
  });

  test("between/inRange are inclusive; outside is the interval complement", () => {
    expect(compile({ age: { between: [18, 29] } })).toEqual({
      sql: "age >= $p0 AND age <= $p1",
      vars: { p0: 18, p1: 29 },
    });
    expect(compile({ age: { inRange: [18, 29] } }).sql).toBe(
      "age >= $p0 AND age <= $p1",
    );
    expect(compile({ age: { outside: [18, 29] } }).sql).toBe(
      "(age < $p0 OR age > $p1)",
    );
    expect(compile({ createdAt: { outside: [1, 2] } }).sql).toBe(
      "(createdAt < $p0 OR createdAt > $p1)",
    );
  });

  test("`outside` on an array field is the set operator, not an interval", () => {
    expect(compile({ tags: { outside: ["a", "b"] } }).sql).toBe(
      "tags OUTSIDE $p0",
    );
  });

  test("an object value must go through equals (operator filters are the default)", () => {
    expect(compile({ address: { equals: { city: "SP" } } })).toEqual({
      sql: "address = $p0",
      vars: { p0: { city: "SP" } },
    });
    expect(codeOf(() => compile({ address: { city: "SP" } }))).toBe(
      "ValidationError",
    );
  });

  test("undefined entries are skipped (conditional spreads)", () => {
    expect(compile({ active: undefined, age: 1 }).sql).toBe("age = $p0");
    expect(compile({ age: { gte: undefined } })).toEqual({
      sql: undefined,
      vars: {},
    });
    expect(compile(undefined)).toEqual({ sql: undefined, vars: {} });
  });
});

describe("where — strings", () => {
  test("contains/startsWith/endsWith", () => {
    expect(compile({ name: { contains: "aeon" } })).toEqual({
      sql: "name CONTAINS $p0",
      vars: { p0: "aeon" },
    });
    expect(compile({ name: { startsWith: "A" } }).sql).toBe(
      "string::starts_with(name, $p0)",
    );
    expect(compile({ name: { endsWith: "z" } }).sql).toBe(
      "string::ends_with(name, $p0)",
    );
  });

  test("matches emits a regex literal (flags inline)", () => {
    expect(compile({ name: { matches: /^post-[a-z]+$/ } }).sql).toBe(
      "string::matches(name, /^post-[a-z]+$/)",
    );
    expect(compile({ name: { matches: /ab/i } }).sql).toBe(
      "string::matches(name, /(?i)ab/)",
    );
  });

  test("case-insensitive operators lowercase both sides", () => {
    expect(compile({ name: { eqInsensitive: "A" } }).sql).toBe(
      "string::lowercase(name) = string::lowercase($p0)",
    );
    expect(compile({ name: { containsInsensitive: "A" } }).sql).toBe(
      "string::lowercase(name) CONTAINS string::lowercase($p0)",
    );
  });

  test("matchesFullText: @@ and @n@ (indexes AND/OR)", () => {
    expect(compile({ name: { matchesFullText: "hello" } }).sql).toBe(
      "name @@ $p0",
    );
    expect(
      compile({ name: { matchesFullText: { query: "x", index: 0 } } }).sql,
    ).toBe("name @0@ $p0");
    expect(
      compile({ name: { matchesFullText: { query: "x", indexes: [0, 1] } } })
        .sql,
    ).toBe("(name @0@ $p0 AND name @1@ $p0)");
    expect(
      compile({
        name: {
          matchesFullText: { query: "x", indexes: [0, 1], operator: "OR" },
        },
      }).sql,
    ).toBe("(name @0@ $p0 OR name @1@ $p0)");
  });

  test("length is family-aware (string::len vs array::len)", () => {
    expect(compile({ name: { length: 3 } }).sql).toBe(
      "string::len(name) = $p0",
    );
    expect(compile({ tags: { length: 3 } }).sql).toBe("array::len(tags) = $p0");
  });
});

describe("where — arrays and sets", () => {
  test("containment operators", () => {
    expect(compile({ tags: { contains: "db" } }).sql).toBe("tags CONTAINS $p0");
    expect(compile({ tags: { containsNot: "db" } }).sql).toBe(
      "tags CONTAINSNOT $p0",
    );
    expect(compile({ tags: { containsAll: ["a", "b"] } }).sql).toBe(
      "tags CONTAINSALL $p0",
    );
    expect(compile({ tags: { containsAny: ["a"] } }).sql).toBe(
      "tags CONTAINSANY $p0",
    );
    expect(compile({ tags: { containsNone: ["a"] } }).sql).toBe(
      "tags CONTAINSNONE $p0",
    );
  });

  test("inside family", () => {
    expect(compile({ tags: { inside: ["a"] } }).sql).toBe("tags INSIDE $p0");
    expect(compile({ tags: { notInside: ["a"] } }).sql).toBe(
      "tags NOTINSIDE $p0",
    );
    expect(compile({ tags: { allInside: ["a"] } }).sql).toBe(
      "tags ALLINSIDE $p0",
    );
    expect(compile({ tags: { anyInside: ["a"] } }).sql).toBe(
      "tags ANYINSIDE $p0",
    );
    expect(compile({ tags: { noneInside: ["a"] } }).sql).toBe(
      "tags NONEINSIDE $p0",
    );
    expect(compile({ tags: { intersects: ["a"] } }).sql).toBe(
      "tags INTERSECTS $p0",
    );
  });

  test("anyEquals/allEquals use ?= and *=", () => {
    expect(compile({ tags: { anyEquals: "a" } }).sql).toBe("tags ?= $p0");
    expect(compile({ tags: { allEquals: "a" } }).sql).toBe("tags *= $p0");
  });

  test("any/all comparison families use ?< and *<", () => {
    expect(compile({ scores: { any: { gt: 90 } } }).sql).toBe("scores ?> $p0");
    expect(compile({ scores: { any: { equals: 3 } } }).sql).toBe(
      "scores ?= $p0",
    );
    expect(compile({ scores: { all: { gte: 1, lte: 5 } } }).sql).toBe(
      "scores *>= $p0 AND scores *<= $p1",
    );
  });
});

describe("where — paths", () => {
  test("dotted paths and bracketed paths escape per segment", () => {
    expect(compile({ "address.city": "BR" })).toEqual({
      sql: "address.city = $p0",
      vars: { p0: "BR" },
    });
    expect(compile({ "contacts[0].value": { contains: "@" } }).sql).toBe(
      "contacts[0].value CONTAINS $p0",
    );
  });

  test("a [*] path's value is an array — equality becomes CONTAINS", () => {
    expect(compile({ "contacts[*].type": "email" })).toEqual({
      sql: "contacts[*].type CONTAINS $p0",
      vars: { p0: "email" },
    });
    expect(compile({ "contacts[*].type": { notEquals: "email" } }).sql).toBe(
      "contacts[*].type CONTAINSNOT $p0",
    );
    expect(compile({ "contacts[*].type": { equals: "email" } }).sql).toBe(
      "contacts[*].type CONTAINS $p0",
    );
  });
});

describe("where — logical combinators", () => {
  test("AND/OR/NOT nest with explicit parens", () => {
    expect(compile({ AND: [{ active: true }, { age: { gte: 18 } }] }).sql).toBe(
      "(active = $p0 AND age >= $p1)",
    );
    expect(compile({ OR: [{ age: 1 }, { age: 2 }] }).sql).toBe(
      "(age = $p0 OR age = $p1)",
    );
    expect(compile({ NOT: { active: true } }).sql).toBe("NOT (active = $p0)");
    expect(compile({ active: true, OR: [{ age: 1 }, { age: 2 }] }).sql).toBe(
      "active = $p0 AND (age = $p1 OR age = $p2)",
    );
    expect(
      compile({
        AND: [{ active: true }, { OR: [{ age: 1 }, { age: 2 }] }],
      }).sql,
    ).toBe("(active = $p0 AND (age = $p1 OR age = $p2))");
  });

  test("field-level not negates the compiled field filter", () => {
    expect(compile({ name: { not: { contains: "x" } } }).sql).toBe(
      "NOT (name CONTAINS $p0)",
    );
    expect(compile({ name: { not: { equals: "x" } } }).sql).toBe(
      "NOT (name = $p0)",
    );
  });
});

describe("where — fragments", () => {
  test("a field value fragment splices with its binds", () => {
    expect(stable(compile({ age: surql`age + ${1}` }))).toEqual({
      sql: "age = (age + $frag0)",
      vars: { frag0: 1 },
    });
  });

  test("a whole-clause fragment replaces the compiled filter", () => {
    expect(stable(compile(surql`age > ${18} AND active = ${true}`))).toEqual({
      sql: "(age > $frag0 AND active = $frag1)",
      vars: { frag0: 18, frag1: true },
    });
  });

  test("fragments compose with typed filters (binds stay unique)", () => {
    expect(stable(compile({ active: true, age: surql`age > ${18}` }))).toEqual({
      sql: "active = $p0 AND age = (age > $frag0)",
      vars: { p0: true, frag0: 18 },
    });
  });
});

describe("where — near (vector and geo)", () => {
  test("KNN emits <|k|> / <|k, METRIC|>", () => {
    expect(
      compile({ embedding: { near: { vector: [0.1, 0.5], k: 3 } } }),
    ).toEqual({
      sql: "embedding <|3|> $p0",
      vars: { p0: [0.1, 0.5] },
    });
    expect(
      compile({
        embedding: { near: { vector: [0.1], k: 3, distance: "cosine" } },
      }).sql,
    ).toBe("embedding <|3, COSINE|> $p0");
  });

  test("a geo point emits geo::distance(f, $p) <= $r", () => {
    const point = { type: "Point", coordinates: [0, 0] };
    expect(compile({ location: { near: { point, distance: 10 } } })).toEqual({
      sql: "geo::distance(location, $p0) <= $p1",
      vars: { p0: point, p1: 10 },
    });
  });
});

describe("where — injection is impossible", () => {
  test("hostile field names are escaped as identifiers", () => {
    const evil = "x'; DROP TABLE user; --";
    expect(compile({ [evil]: 1 })).toEqual({
      sql: `⟨${evil}⟩ = $p0`,
      vars: { p0: 1 },
    });
    expect(compile({ [evil]: 1 }).sql).toBe(`${escapeIdent(evil)} = $p0`);
  });

  test("hostile values are always bound, never interpolated", () => {
    const evil = "x' OR 1=1 --";
    expect(compile({ name: evil })).toEqual({
      sql: "name = $p0",
      vars: { p0: evil },
    });
    expect(compile({ name: { contains: evil } }).sql).toBe("name CONTAINS $p0");
    expect(compile({ age: { between: [evil, evil] } }).vars).toEqual({
      p0: evil,
      p1: evil,
    });
  });

  test("a [*] path segment can't smuggle syntax", () => {
    expect(codeOf(() => compile({ "tags[x].name": 1 }))).toBe(
      "ValidationError",
    );
  });
});

describe("where — teaching errors", () => {
  test("unknown operators fail fast with the vocabulary pointer", () => {
    const err = (() => {
      try {
        compile({ age: { nope: 1 } });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain("nope");
    expect(err?.message).toContain("§2.2.2");
  });

  test("removed fuzzy operators are UnsupportedCapability (not emitted)", () => {
    expect(codeOf(() => compile({ name: { fuzzy: "x" } }))).toBe(
      "UnsupportedCapability",
    );
    expect(codeOf(() => compile({ name: { anyFuzzy: "x" } }))).toBe(
      "UnsupportedCapability",
    );
    expect(codeOf(() => compile({ name: { allFuzzy: "x" } }))).toBe(
      "UnsupportedCapability",
    );
  });

  test("malformed operands fail fast", () => {
    expect(codeOf(() => compile({ age: { isNull: false } }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ age: { between: [1] } }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ name: { matches: "x" } }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ AND: [] }))).toBe("ValidationError");
    expect(codeOf(() => compile({ AND: [{}] }))).toBe("ValidationError");
    expect(codeOf(() => compile({ age: { any: {} } }))).toBe("ValidationError");
    expect(
      codeOf(() =>
        compile({
          name: { matchesFullText: { query: "x", index: 0, indexes: [1] } },
        }),
      ),
    ).toBe("ValidationError");
    expect(codeOf(() => compile(42))).toBe("ValidationError");
  });

  test("schemaless models (no meta) still compile", () => {
    expect(compile({ anything: 1 }, undefined).sql).toBe("anything = $p0");
  });
});
