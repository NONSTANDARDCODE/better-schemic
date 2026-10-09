// Decoder unit tests — `decodeRow`/`decodeRows` against the `ProjectionSpec` the compiler emits.
// The delegate tests exercise compile+execute+decode together; this suite pins the decode contract
// itself: codecs, star/omit, explicit paths (nested/implicit-array/index), value, split and failures.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { z } from "zod";
import { surql } from "../../src/index";
import { compileRead, type ReadArgs } from "../../src/orm/compiler/select";
import { createBinds } from "../../src/orm/compiler/shared";
import { decodeRow, decodeRows } from "../../src/orm/decode";
import type { BetterSchemicError } from "../../src/orm/errors";
import type { ModelMeta, TableMeta } from "../../src/orm/meta";
import { buildSchemaIndex } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  at: s.datetime(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
  contacts: s.array(s.object({ type: s.string(), value: s.string() })),
});
const index = buildSchemaIndex({ users: User });
const meta = index.tables.get("users") as TableMeta;

/** Compile the read and decode `rows` through its projection. */
function decode(args: ReadArgs, rows: unknown[], table: ModelMeta = meta) {
  const binds = createBinds();
  const compiled = compileRead(table, args, binds, "test");
  return decodeRows(rows, table, compiled.projection);
}

const rawAt = (iso: string) => new DateTime(new Date(iso));
const fullRow = (over: Record<string, unknown> = {}) => ({
  id: new RecordId("user", "u1"),
  name: "Alice",
  age: 30,
  at: rawAt("2025-01-02T03:04:05Z"),
  tags: ["db"],
  address: { city: "SP", country: "BR" },
  contacts: [{ type: "email", value: "a@x" }],
  ...over,
});

// A primitives-only table (fast primitives + an array of primitives) — the compiled full-row
// decoder's happy path, where Zod is skipped entirely.
const Plain = defineTable("plain", {
  name: s.string(),
  count: s.int(),
  ratio: s.number(),
  ok: s.boolean(),
  note: s.string().optional(),
  tags: s.array(s.string()),
  strictTags: s.array(s.string()).min(1).optional(),
});
const plainMeta = buildSchemaIndex({ plain: Plain }).tables.get(
  "plain",
) as TableMeta;
const plainRow = (over: Record<string, unknown> = {}) => ({
  id: new RecordId("plain", "p1"),
  name: "n",
  count: 2,
  ratio: 1.5,
  ok: true,
  tags: ["a", "b"],
  ...over,
});

describe("decode — compiled fast path (full rows)", () => {
  test("primitives + primitive arrays decode, unknown keys strip (Zod parity)", () => {
    const [row] = decode({}, [plainRow({ extra: "x" })], plainMeta) as Record<
      string,
      unknown
    >[];
    expect(row).toEqual({
      id: new RecordId("plain", "p1"),
      name: "n",
      count: 2,
      ratio: 1.5,
      ok: true,
      tags: ["a", "b"],
    });
    // A fresh array (Zod never aliases the input array).
    expect(row?.tags).not.toBe(plainRow().tags);
  });

  test("an absent optional is dropped; an explicit undefined is kept", () => {
    const [absent] = decode({}, [plainRow()], plainMeta) as Record<
      string,
      unknown
    >[];
    expect(Object.hasOwn(absent as object, "note")).toBe(false);
    const [explicit] = decode(
      {},
      [plainRow({ note: undefined })],
      plainMeta,
    ) as Record<string, unknown>[];
    expect(Object.hasOwn(explicit as object, "note")).toBe(true);
    expect(explicit?.note).toBeUndefined();
  });

  test("a mismatch falls back to Zod — same ValidationError with the field path", () => {
    for (const bad of [
      { count: "x" },
      { count: 1.5 },
      { ok: 1 },
      { tags: ["a", 2] },
      { tags: "not-array" },
      { ratio: Number.POSITIVE_INFINITY },
      { ratio: Number.NaN },
    ]) {
      const err = (() => {
        try {
          decode({}, [plainRow(bad)], plainMeta);
          return undefined;
        } catch (e) {
          return e as BetterSchemicError;
        }
      })();
      expect(err?.code).toBe("ValidationError");
      expect(err?.message).toMatch(/Validation failed at "/);
    }
  });

  test("a missing required fast field still throws (Zod parity)", () => {
    const err = (() => {
      try {
        decode({}, [{ id: new RecordId("plain", "p1"), name: "n" }], plainMeta);
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
  });

  test("array-level checks stay in Zod (an empty min-array still throws)", () => {
    const err = (() => {
      try {
        decode({}, [plainRow({ strictTags: [] })], plainMeta);
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
  });

  test("projected fast leaves decode without Zod and reject mismatches", () => {
    expect(
      decode({ select: { count: true, tags: true } }, [plainRow()], plainMeta),
    ).toEqual([{ count: 2, tags: ["a", "b"] }]);
    expect(() =>
      decode(
        { select: { count: true } },
        [plainRow({ count: "x" })],
        plainMeta,
      ),
    ).toThrow(/Validation failed/);
  });

  test("compiled full-row decode matches pure Zod on random rows (parity fuzz)", () => {
    const values: unknown[] = [
      undefined,
      null,
      "s",
      3,
      1.5,
      true,
      [],
      ["a"],
      ["a", 2],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { city: "x" },
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const keys = [
      "name",
      "count",
      "ratio",
      "ok",
      "note",
      "tags",
      "strictTags",
      "extra",
    ];
    for (let i = 0; i < 500; i++) {
      const row: Record<string, unknown> = { id: new RecordId("plain", "p1") };
      for (const key of keys)
        if (rnd() < 0.7) row[key] = values[Math.floor(rnd() * values.length)];
      let expected: unknown;
      let actual: unknown;
      let expectedError = false;
      let actualError = false;
      try {
        expected = z.decode(Plain.object, row as never);
      } catch {
        expectedError = true;
      }
      try {
        actual = decodeRow(row, plainMeta, {
          star: true,
          fields: [],
          omit: [],
          value: false,
          includes: [],
        });
      } catch {
        actualError = true;
      }
      expect(actualError).toBe(expectedError);
      if (!expectedError && !actualError) {
        expect(Object.keys(actual as object)).toEqual(
          Object.keys(expected as object),
        );
        expect(actual).toEqual(expected);
      }
    }
  });
});

describe("decode — full rows", () => {
  test("decodes through the table codec (datetime -> Date, id -> RecordId)", () => {
    const [row] = decode({}, [fullRow()]) as {
      id: RecordId;
      at: Date;
      name: string;
    }[];
    expect(row?.id).toBeInstanceOf(RecordId);
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.at.toISOString()).toBe("2025-01-02T03:04:05.000Z");
  });

  test("omit strips the keys even when the raw row carries them", () => {
    const [row] = decode({ omit: ["age", "at"] }, [fullRow()]) as Record<
      string,
      unknown
    >[];
    expect(Object.keys(row as object)).not.toContain("age");
    expect(Object.keys(row as object)).not.toContain("at");
    expect(row?.name).toBe("Alice");
    expect(row?.tags).toEqual(["db"]);
  });

  test("star + explicit expression overlays the decoded row", () => {
    const [row] = decode({ select: { "*": true, bump: surql`age + ${1}` } }, [
      fullRow({ bump: 31 }),
    ]) as Record<string, unknown>[];
    expect(row?.name).toBe("Alice");
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.bump).toBe(31);
  });
});

describe("decode — explicit projections", () => {
  test("paths nest, aliases flatten and arrays decode element-wise", () => {
    expect(
      decode(
        {
          select: {
            "address.city": true,
            city: "address.city",
            "contacts[*].type": true,
            "contacts.type": true,
            "tags[0]": true,
          },
        },
        [
          {
            address: { city: "SP" },
            city: "SP",
            contacts: { type: ["email", "phone"] },
            tags: "db",
          },
        ],
      ),
    ).toEqual([
      {
        address: { city: "SP" },
        city: "SP",
        contacts: { type: ["email", "phone"] },
        tags: "db",
      },
    ]);
  });

  test("a projected field missing from the raw row stays undefined", () => {
    expect(
      decode({ select: { name: true, age: true } }, [{ name: "A" }]),
    ).toEqual([{ name: "A", age: undefined }]);
  });

  test("schemaless models pass values through", () => {
    const schemaless = {
      key: "audit",
      name: "audit_log",
      schemaless: true as const,
    };
    expect(
      decode(
        { select: { who: true, "meta.at": true } },
        [{ who: "u1", meta: { at: 1 } }],
        schemaless,
      ),
    ).toEqual([{ who: "u1", meta: { at: 1 } }]);
  });
});

describe("decode — value and split", () => {
  test("value returns the leaf directly (decoded)", () => {
    expect(
      decode({ select: { at: true }, value: true }, [
        rawAt("2025-03-01T00:00:00Z"),
      ]),
    ).toEqual([new Date("2025-03-01T00:00:00Z")]);
  });

  test("split unfolds the field to its ELEMENT codec", () => {
    const [row] = decode({ split: "tags" }, [
      fullRow({ tags: "db" }),
    ]) as Record<string, unknown>[];
    expect(row?.tags).toBe("db");
  });

  test("a nested split needs an explicit select", () => {
    expect(() => decode({ split: "address.city" }, [fullRow()])).toThrow(
      /nested path/,
    );
  });
});

describe("decode — failures are teaching errors", () => {
  test("a codec mismatch names the table and field", () => {
    const err = (() => {
      try {
        decode({ select: { at: true } }, [{ at: "not-a-datetime" }]);
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.table).toBe("user");
    expect(err?.field).toBe("at");
  });

  test("decodeRow is the single-row entry point", () => {
    expect(
      decodeRow(fullRow(), meta, {
        star: true,
        fields: [],
        omit: [],
        value: false,
        includes: [],
      }),
    ).toMatchObject({ name: "Alice" });
  });
});
