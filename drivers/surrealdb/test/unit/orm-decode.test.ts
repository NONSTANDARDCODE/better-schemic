// Decoder unit tests — `decodeRow`/`decodeRows` against the `ProjectionSpec` the compiler emits.
// The delegate tests exercise compile+execute+decode together; this suite pins the decode contract
// itself: codecs, star/omit, explicit paths (nested/implicit-array/index), value, split and failures.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
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
      }),
    ).toMatchObject({ name: "Alice" });
  });
});
