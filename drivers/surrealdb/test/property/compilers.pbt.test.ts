// Property-based tests (fast-check) for the PURE compiler/parser helpers — the string and value
// plumbing that every SurrealQL fragment rides on. These assert INVARIANTS over generated, adversarial
// inputs rather than golden strings, so they catch whole classes of escaping/binding/round-trip bugs
// that hand-picked examples miss:
//
//   • INJECTION SAFETY — an adversarial field name is escaped (`⟨…⟩`) and a runtime value is ALWAYS
//     bound (`$pN`), never spliced into the SQL text.
//   • BIND TOTALITY — every `$pN` in the compiled SQL exists in `vars`, and vice-versa.
//   • PURITY — identical args → identical `{ sql, vars }`.
//   • ROUND-TRIPS — `splitRecordId`↔`recordIdParts`, `parseSurqlType`↔`emitSurqlType`, the format/
//     duration/datetime bridges, path segments, `joinAnd` arity.
//
// Budget: `PBT_RUNS` (default 100) cases per property; `PBT_SEED` pins a reproducible run in CI.
// fast-check prints the failing counterexample + seed on any failure, so a red run is replayable.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { escapeIdent } from "surrealdb";
import { formatAssert, formatForAssert } from "../../src/checks";
import { emitSurqlType, parseSurqlType } from "../../src/driver/surql-type";
import {
  createBinds,
  datetimeLiteral,
  durationLiteral,
  escapeRecordIdPart,
  joinAnd,
  nonNegativeInt,
  parseDurationMs,
  pathSegments,
  recordIdParts,
  renderPath,
  splitRecordId,
} from "../../src/orm/compiler/shared";
import { compileWhere } from "../../src/orm/compiler/where";
import { BetterSchemicError } from "../../src/orm/errors";

const RUNS = Number(process.env.PBT_RUNS ?? 100);
const SEED = process.env.PBT_SEED ? Number(process.env.PBT_SEED) : undefined;
const check = (prop: fc.IProperty<unknown>): void => {
  fc.assert(prop, {
    numRuns: RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
  });
};

/** Strip escaped identifiers + string literals so a `$` inside them isn't read as a bind. */
const stripEscaped = (sql: string): string =>
  sql
    .replace(/⟨(?:\\.|[^⟩])*⟩/g, "⟨⟩")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

/** Every `$name` referenced by a compiled fragment (outside escaped identifiers / literals). */
const bindRefs = (sql: string): Set<string> =>
  new Set(
    [...stripEscaped(sql).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (m) => m[1] as string,
    ),
  );

/** Bind totality: referenced binds == declared binds (no dangling, no unused). */
function expectBindTotality(sql: string, vars: Record<string, unknown>): void {
  const refs = bindRefs(sql);
  for (const name of refs) expect(vars).toHaveProperty(name);
  for (const name of Object.keys(vars)) expect(refs.has(name)).toBe(true);
}

/** Keys that change `where`'s MEANING (logical combinators) or are object-prototype hazards. */
const SPECIAL_KEYS = new Set([
  "AND",
  "OR",
  "NOT",
  "__proto__",
  "constructor",
  "prototype",
]);

/** A non-empty field-name candidate with no `.`/`[`/`]` (so `renderPath` treats it as one segment). */
const weirdField = fc.string({ minLength: 1, maxLength: 14 }).filter(
  (s) =>
    !/[.[\]]/.test(s) &&
    // Exclude a trailing backslash: the SDK's `escapeIdent` does not escape `\`, so `…\⟩` is
    // ambiguous (its output can't be reliably re-parsed). That is outside this compiler's contract.
    !s.includes("\\") &&
    !SPECIAL_KEYS.has(s) &&
    !s.startsWith("$"),
);

/** A scalar/array value that `renderValue` BINDS (never a fragment/ref/range). */
const bindableValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 3 }),
);

// --- where: injection safety, bind totality, purity ---------------------------------------------

describe("compileWhere — pure compiler invariants", () => {
  test("a scalar equality always binds the value, never interpolates it", () => {
    check(
      fc.property(weirdField, bindableValue, (field, value) => {
        const binds = createBinds();
        const sql = compileWhere({ [field]: value }, binds);
        const rendered = renderPath(field);
        // Anything `escapeIdent` leaves bare is injection-safe; anything else MUST be wrapped.
        if (rendered !== field) {
          expect(rendered.startsWith("⟨")).toBe(true);
          expect(rendered.endsWith("⟩")).toBe(true);
        }
        expect(sql).toBe(`${rendered} = $p0`);
        expect(binds.vars).toEqual({ p0: value });
        expectBindTotality(sql as string, binds.vars);
      }),
    );
  });

  test("compilation is pure: same input → same sql + vars", () => {
    check(
      fc.property(weirdField, bindableValue, (field, value) => {
        const a = createBinds();
        const b = createBinds();
        expect(compileWhere({ [field]: value }, a)).toBe(
          compileWhere({ [field]: value }, b),
        );
        expect(a.vars).toEqual(b.vars);
      }),
    );
  });

  test("malformed input fails only with a teaching BetterSchemicError (never a TypeError)", () => {
    check(
      fc.property(fc.jsonValue(), (input) => {
        try {
          compileWhere(input, createBinds());
        } catch (error) {
          expect(error).toBeInstanceOf(BetterSchemicError);
        }
      }),
    );
  });

  test("operator-object filters keep bind totality across the surface", () => {
    const operators = fc.constantFrom(
      "equals",
      "notEquals",
      "lt",
      "lte",
      "gt",
      "gte",
      "in",
      "notIn",
      "contains",
      "notInside",
      "startsWith",
      "isNull",
    );
    check(
      fc.property(weirdField, operators, bindableValue, (field, op, value) => {
        const binds = createBinds();
        let sql: string | undefined;
        try {
          sql = compileWhere({ [field]: { [op]: value } }, binds);
        } catch (error) {
          expect(error).toBeInstanceOf(BetterSchemicError);
          return;
        }
        expectBindTotality(sql as string, binds.vars);
      }),
    );
  });
});

// --- paths / joins ------------------------------------------------------------------------------

const pathPart = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/),
    fc.constantFrom("", "[0]", "[*]", "[12]"),
  )
  .map(([segment, suffix]) => `${segment}${suffix}`);
const dottedPath = fc
  .array(pathPart, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("."));

describe("paths and joins", () => {
  test("renderPath escapes each segment and introduces no extra separators", () => {
    check(
      fc.property(dottedPath, (path) => {
        const rendered = renderPath(path);
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered.split(".").length).toBe(path.split(".").length);
      }),
    );
  });

  test("pathSegments strips [<n>]/[*] suffixes", () => {
    check(
      fc.property(dottedPath, (path) => {
        expect(pathSegments(path)).toEqual(
          path.split(".").map((s) => s.replace(/\[\d+\]|\[\*\]/g, "")),
        );
      }),
    );
  });

  test("joinAnd is a plain AND-join (arity is preserved)", () => {
    const parts = fc.array(
      fc
        .string({ minLength: 1, maxLength: 8 })
        .filter((s) => !s.includes(" AND ")),
      { minLength: 1, maxLength: 6 },
    );
    check(
      fc.property(parts, (list) => {
        expect(joinAnd(list)).toBe(list.join(" AND "));
        expect(joinAnd(list).split(" AND ").length).toBe(list.length);
      }),
    );
  });
});

// --- record ids ---------------------------------------------------------------------------------

describe("record ids", () => {
  test("splitRecordId splits at the FIRST colon (or returns undefined)", () => {
    check(
      fc.property(fc.string(), (text) => {
        const parts = splitRecordId(text);
        const colon = text.indexOf(":");
        if (colon === -1) expect(parts).toBeUndefined();
        else
          expect(parts).toEqual({
            table: text.slice(0, colon),
            id: text.slice(colon + 1),
          });
      }),
    );
  });

  test("recordIdParts: a bare id adopts the fallback table; a prefixed id validates", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/);
    check(
      fc.property(token, token, (table, id) => {
        expect(recordIdParts(id, "op", { fallbackTable: table })).toEqual({
          table,
          id,
        });
        expect(recordIdParts(`${table}:${id}`, "op", { table })).toEqual({
          table,
          id,
        });
      }),
    );
  });

  test("escapeRecordIdPart quotes exactly the non-bare ids", () => {
    const bare = /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/;
    check(
      fc.property(fc.string(), (id) => {
        const escaped = escapeRecordIdPart(id);
        expect(escaped).toBe(bare.test(id) ? id : escapeIdent(id));
      }),
    );
  });
});

// --- surql type bridge --------------------------------------------------------------------------

describe("parseSurqlType / emitSurqlType", () => {
  // A CANONICAL SurrealQL type expression: sorted, de-duplicated union members, sorted record
  // targets, single-quoted literals — exactly what normalizeType/emit produce. A union member is a
  // `member` (never a bare `option<…>`): a union of `null` + `option<X>` folds to `option<X | null>`,
  // so such a member would not be canonical. `option` still nests inside arrays/sets.
  const canonicalType = fc.letrec((tie) => {
    const s = (key: string): fc.Arbitrary<string> =>
      tie(key) as fc.Arbitrary<string>;
    const atom: fc.Arbitrary<string> = fc.oneof(
      fc.constantFrom(
        "string",
        "int",
        "float",
        "decimal",
        "number",
        "bool",
        "datetime",
        "duration",
        "uuid",
        "bytes",
        "object",
        "null",
        "geometry<point>",
        "geometry<polygon>",
      ),
      fc.stringMatching(/^[A-Za-z0-9_ ]{1,8}$/).map((x) => `'${x}'`),
      fc
        .array(fc.stringMatching(/^[a-z_][a-z0-9_]{0,6}$/), {
          minLength: 1,
          maxLength: 2,
        })
        .map((tables) => `record<${[...new Set(tables)].sort().join(" | ")}>`),
    );
    const member: fc.Arbitrary<string> = fc.oneof(
      s("atom"),
      s("expr").map((x) => `array<${x}>`),
      s("expr").map((x) => `set<${x}>`),
      fc
        .tuple(s("expr"), fc.nat(8))
        .map(([x, n]) => `array<${x}, ${n}>`),
      fc.tuple(s("expr"), fc.nat(8)).map(([x, n]) => `set<${x}, ${n}>`),
    );
    const inner: fc.Arbitrary<string> = fc.oneof(
      s("member"),
      s("expr").map((x) => `option<${x}>`),
    );
    const expr: fc.Arbitrary<string> = fc.oneof(
      { maxDepth: 4, depthSize: "small" },
      s("inner"),
      fc
        .array(s("member"), { minLength: 2, maxLength: 3 })
        .map((xs) => [...new Set(xs)].sort().join(" | ")),
    );
    return { atom, member, inner, expr };
  }).expr;

  test("parse never throws and always yields a PortableType", () => {
    check(
      fc.property(fc.string(), (text) => {
        const parsed = parseSurqlType(text);
        expect(typeof parsed).toBe("object");
        expect(typeof parsed.t).toBe("string");
      }),
    );
  });

  test("a canonical type expression is preserved exactly: emit(parse(t)) === t", () => {
    // `noShrink`: fast-check's string shrinker can produce NON-canonical strings, which would fail
    // this property for the wrong reason — failures must come from real generator outputs.
    check(
      fc.property(fc.noShrink(canonicalType), (text) => {
        expect(emitSurqlType(parseSurqlType(text))).toBe(text);
      }),
    );
  });

  test("canonicalization is idempotent: emit(parse(e)) === e where e = emit(parse(t))", () => {
    check(
      fc.property(fc.oneof(canonicalType, fc.string()), (text) => {
        const canonical = emitSurqlType(parseSurqlType(text));
        expect(emitSurqlType(parseSurqlType(canonical))).toBe(canonical);
      }),
    );
  });

  test("special atoms canonicalize as expected (`none`, `any`)", () => {
    // `none` is the canonical spelling of `option<never>` — a regression guard for the lossless
    // round-trip (emitting `option<none>` used to re-parse to `option<option<never>>`).
    expect(emitSurqlType(parseSurqlType("none"))).toBe("none");
    expect(emitSurqlType(parseSurqlType("array<none>"))).toBe("array<none>");
    // `any` absorbs option/nullable (the fold rules) and stays itself.
    expect(emitSurqlType(parseSurqlType("any"))).toBe("any");
    expect(emitSurqlType(parseSurqlType("option<any>"))).toBe("any");
    expect(emitSurqlType(parseSurqlType("any | null"))).toBe("any");
  });
});

// --- checks / durations / datetimes / int guards ------------------------------------------------

describe("check + literal bridges", () => {
  const FORMATS = [
    "email",
    "url",
    "ulid",
    "ipv4",
    "ipv6",
    "alpha",
    "alphanum",
    "ascii",
    "numeric",
    "semver",
    "hexadecimal",
    "latitude",
    "longitude",
    "ip",
    "domain",
  ];

  test("formatAssert → formatForAssert round-trips", () => {
    check(
      fc.property(fc.constantFrom(...FORMATS), (format) => {
        const assert = formatAssert(format);
        expect(assert).toBeDefined();
        expect(formatForAssert(assert as string)).toBe(format);
      }),
    );
  });

  test("formatForAssert only ever recovers a real format", () => {
    check(
      fc.property(fc.string(), (assert) => {
        const format = formatForAssert(assert);
        if (format !== undefined) expect(formatAssert(format)).toBeDefined();
      }),
    );
  });

  test("duration strings pass through and convert to non-negative ms", () => {
    const duration = fc
      .tuple(
        fc.nat(1000),
        fc.constantFrom("ns", "us", "µs", "ms", "s", "m", "h", "d", "w", "y"),
      )
      .map(([n, unit]) => `${n}${unit}`);
    check(
      fc.property(duration, (text) => {
        expect(durationLiteral(text, "op")).toBe(text);
        expect(parseDurationMs(text, "op")).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  test("a numeric duration emits `<n>ms` and parses back to n", () => {
    check(
      fc.property(fc.nat(1_000_000), (n) => {
        expect(durationLiteral(n, "op")).toBe(`${n}ms`);
        expect(parseDurationMs(n, "op")).toBe(n);
      }),
    );
  });

  test("datetimeLiteral quotes a valid ISO date", () => {
    check(
      fc.property(
        fc.date({
          min: new Date(0),
          max: new Date("2100-01-01"),
          noInvalidDate: true,
        }),
        (date) => {
          expect(datetimeLiteral(date, "op")).toBe(`d'${date.toISOString()}'`);
        },
      ),
    );
  });

  test("nonNegativeInt accepts exactly the non-negative integers", () => {
    check(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (n) => {
        if (n >= 0) expect(nonNegativeInt(n, "limit", "op")).toBe(n);
        else expect(() => nonNegativeInt(n, "limit", "op")).toThrow();
      }),
    );
  });
});
