// Parser/lexer FUZZING — adversarial inputs through every hand-written string scanner, asserting the
// two properties that matter at a boundary: **never throw** (or only a documented error) and **never
// hang** (no catastrophic backtracking), plus the claimed idempotence/round-trips. Unlike the PBT
// suites (which assert semantic invariants over generated *structured* inputs), this focuses on
// arbitrary bytes, deep nesting, quotes/backslashes, huge unions and a committed seed corpus.
//
// A hang is detected by Bun's own per-test timeout (sync code can't be interrupted cooperatively);
// the time-bounded corpus below asserts each call finishes well under budget.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { formatAssert, formatForAssert } from "../../src/checks";
import { normalizeType } from "../../src/cli/struct";
import { emitSurqlType, parseSurqlType } from "../../src/driver/surql-type";
import { hasTopLevelSemi } from "../../src/surql/block";
import { stripOuterParens, toFragment } from "../../src/surql/render";
import { splitTopUnion, topLevelSplitOnce } from "../../src/surql-type-expr";

const RUNS = Number(process.env.FUZZ_RUNS ?? process.env.PBT_RUNS ?? 300);
const SEED = process.env.PBT_SEED ? Number(process.env.PBT_SEED) : undefined;
const check = (prop: fc.IProperty<unknown>): void => {
  fc.assert(prop, {
    numRuns: RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
  });
};

/** A committed corpus of adversarial seed inputs (deep nesting, huge unions, quotes, unicode). */
const CORPUS: string[] = [
  "",
  " ".repeat(1000),
  "(".repeat(500) + ")".repeat(500),
  "<".repeat(500) + ">".repeat(500),
  "|".repeat(1000),
  "array<".repeat(200) + "int" + ">".repeat(200),
  "option<".repeat(200) + "string" + ">".repeat(200),
  `'${"\\".repeat(500)}'`,
  `"${"a".repeat(2000)}"`,
  `record<${Array.from({ length: 200 }, (_, i) => `t${i}`).join(" | ")}>`,
  "\u{1F600}".repeat(500),
  "array<int,".repeat(100) + "0" + ">".repeat(100),
  ";".repeat(500),
  "{{{{}}}}",
  "string::is_".repeat(200),
];

// --- the SurrealQL type-expression lexer --------------------------------------------------------

describe("fuzz: surql-type-expr", () => {
  test("splitTopUnion / topLevelSplitOnce never throw on arbitrary input", () => {
    check(
      fc.property(
        fc.string(),
        fc.constantFrom("|", ",", ".", "x", ""),
        (text, sep) => {
          expect(Array.isArray(splitTopUnion(text))).toBe(true);
          const once = topLevelSplitOnce(text, sep);
          expect(once === null || Array.isArray(once)).toBe(true);
        },
      ),
    );
  });

  test("splitTopUnion rejoins to the input modulo whitespace", () => {
    check(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9_]{0,6}$/), {
          minLength: 1,
          maxLength: 5,
        }),
        (parts) => {
          const text = parts.join("|");
          expect(splitTopUnion(text)).toEqual(parts);
        },
      ),
    );
  });
});

// --- the SurqlType bridge (parse/emit/normalize) ------------------------------------------------

describe("fuzz: type bridge", () => {
  test("parseSurqlType never throws and always returns a PortableType", () => {
    check(
      fc.property(fc.string(), (text) => {
        const parsed = parseSurqlType(text);
        expect(typeof parsed).toBe("object");
        expect(typeof (parsed as { t: unknown }).t).toBe("string");
        expect(typeof emitSurqlType(parsed)).toBe("string");
      }),
    );
  });

  test("canonicalization is idempotent (parse∘emit is a fixpoint)", () => {
    check(
      fc.property(fc.string(), (text) => {
        const once = emitSurqlType(parseSurqlType(text));
        expect(emitSurqlType(parseSurqlType(once))).toBe(once);
      }),
    );
  });

  test("normalizeType never throws and is idempotent", () => {
    check(
      fc.property(fc.string(), (text) => {
        const once = normalizeType(text);
        expect(typeof once).toBe("string");
        expect(normalizeType(once)).toBe(once);
      }),
    );
  });

  test("the adversarial corpus parses within a time budget", () => {
    for (const text of CORPUS) {
      const start = performance.now();
      parseSurqlType(text);
      normalizeType(text);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });
});

// --- the format-assert bridge -------------------------------------------------------------------

describe("fuzz: check formats", () => {
  test("formatForAssert only recovers a real, reversible format", () => {
    check(
      fc.property(fc.string(), (text) => {
        const format = formatForAssert(text);
        if (format !== undefined) {
          expect(typeof format).toBe("string");
          const assert = formatAssert(format);
          expect(assert).toBeDefined();
          expect(formatForAssert(assert as string)).toBe(format);
        }
      }),
    );
  });
});

// --- surql rendering: outer-paren stripping + bind namespacing ----------------------------------

describe("fuzz: surql render", () => {
  test("stripOuterParens never throws and is idempotent", () => {
    check(
      fc.property(fc.string(), (text) => {
        const once = stripOuterParens(text);
        expect(typeof once).toBe("string");
        expect(stripOuterParens(once)).toBe(once);
      }),
    );
  });

  test("stripOuterParens unwraps N redundant parens around a bare atom", () => {
    // `q-z` avoids the KEEP_PARENS keywords (SELECT/IF/…) which intentionally keep their parens.
    check(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.stringMatching(/^[q-z]{1,6}$/),
        (n, atom) => {
          const wrapped = "(".repeat(n) + atom + ")".repeat(n);
          expect(stripOuterParens(wrapped)).toBe(atom);
        },
      ),
    );
  });

  test("toFragment namespaces every bind and keeps the values", () => {
    const names = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,2}$/), {
      minLength: 1,
      maxLength: 4,
    });
    check(
      fc.property(names, (ns) => {
        const vars = Object.fromEntries(ns.map((n) => [n, `V_${n}`]));
        const sql = ns.map((n) => `$${n} = 1`).join(" AND ");
        const frag = toFragment({ sql, vars });

        // Every binding is preserved under a `sub__` namespace, none dropped/added.
        const keys = Object.keys(frag.bindings);
        expect(keys).toHaveLength(ns.length);
        for (const n of ns) {
          const entry = Object.entries(frag.bindings).find(([k]) =>
            new RegExp(`^sub__\\d+_${n}$`).test(k),
          );
          expect(entry?.[1]).toBe(`V_${n}`);
        }

        // Every `$` token is namespaced (no BARE reference survived) and the rewrite is
        // boundary-safe (`$a` must not partially rewrite a longer `$ab`).
        const tokens = [
          ...frag.query.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g),
        ].map((m) => m[1] as string);
        for (const token of tokens)
          expect(token.startsWith("sub__")).toBe(true);
      }),
    );
  });
});

// --- block canonical form: top-level semicolon detection ----------------------------------------

describe("fuzz: hasTopLevelSemi", () => {
  test("never throws; ignores `;` inside quotes and brackets", () => {
    check(
      fc.property(fc.string(), (text) => {
        expect(typeof hasTopLevelSemi(text)).toBe("boolean");
      }),
    );
    expect(hasTopLevelSemi("a; b")).toBe(true);
    expect(hasTopLevelSemi("a")).toBe(false);
    expect(hasTopLevelSemi(`"a;b"`)).toBe(false);
    expect(hasTopLevelSemi("(a; b)")).toBe(false);
    expect(hasTopLevelSemi("{ a; b }")).toBe(false);
    expect(hasTopLevelSemi("[a; b]")).toBe(false);
  });
});
