import { describe, expect, test } from "bun:test";
import * as z from "zod";
import { SFieldBase } from "../../src/authoring";

// Minimal concrete field — drivers subclass SFieldBase exactly this way (SField).
class TestField<
  S extends z.ZodType = z.ZodType,
  F extends string = never,
> extends SFieldBase<S, F, Record<string, never>> {
  protected rebuild<S2 extends z.ZodType, F2 extends string>(
    schema: S2,
    native: Record<string, never>,
  ): TestField<S2, F2> {
    return new TestField<S2, F2>(schema, native);
  }
  protected blank(): Record<string, never> {
    return {};
  }
}
const field = <S extends z.ZodType>(s: S) => new TestField(s, {});

describe("SFieldBase Zod parity (shared-base methods)", () => {
  test("isOptional / isNullable reflect the inner schema", () => {
    expect(field(z.string()).isOptional()).toBe(false);
    expect(field(z.string().optional()).isOptional()).toBe(true);
    expect(field(z.string().nullable()).isNullable()).toBe(true);
  });

  test("nonoptional strips an optional", () => {
    expect(field(z.string().optional()).nonoptional().isOptional()).toBe(false);
  });

  test("exactOptional yields a field", () => {
    expect(field(z.string()).exactOptional().schema).toBeDefined();
  });

  test("description getter reads back .describe()", () => {
    expect(field(z.string().describe("a name")).description).toBe("a name");
    expect(field(z.string()).description).toBeUndefined();
  });

  test("toJSONSchema delegates to z.toJSONSchema", () => {
    const js = field(z.string()).toJSONSchema() as { type?: string };
    expect(js.type).toBe("string");
  });

  test("register adds the inner schema to a registry and chains", () => {
    const reg = z.registry<{ title: string }>();
    const f = field(z.string());
    expect(f.register(reg, { title: "T" })).toBe(f); // chainable
    expect(reg.has(f.schema)).toBe(true);
  });

  test("spa is the async safe-parse (decode direction)", async () => {
    expect(await field(z.string()).spa("hi")).toEqual({
      success: true,
      data: "hi",
    });
  });
});

describe("SFieldBase — codec + Zod passthrough chain", () => {
  test("decode/encode + async + safe + deprecated aliases", async () => {
    const s = field(z.string());
    expect(s.decode("x")).toBe("x");
    expect(s.encode("x")).toBe("x");
    expect(s.safeDecode("x")).toEqual({ success: true, data: "x" });
    expect(s.safeEncode("x")).toEqual({ success: true, data: "x" });
    expect(await s.decodeAsync("x")).toBe("x");
    expect(await s.encodeAsync("x")).toBe("x");
    expect(await s.safeDecodeAsync("x")).toEqual({ success: true, data: "x" });
    expect(await s.safeEncodeAsync("x")).toEqual({ success: true, data: "x" });
    expect(s.parse("x")).toBe("x");
    expect(s.safeParse("x")).toEqual({ success: true, data: "x" });
    expect(await s.parseAsync("x")).toBe("x");
    expect(await s.safeParseAsync("x")).toEqual({ success: true, data: "x" });
  });

  test("wrapper methods rebuild and preserve behavior", () => {
    expect(field(z.string()).nullable().isNullable()).toBe(true);
    expect(field(z.string()).optional().isOptional()).toBe(true);
    expect(field(z.string()).default("d").schema.parse(undefined)).toBe("d");
    expect(field(z.string()).prefault("p").schema.parse(undefined)).toBe("p");
    expect(field(z.string()).catch("c").schema.parse(5)).toBe("c");
    expect(field(z.string()).array().schema.parse(["a"])).toEqual(["a"]);
    expect(field(z.string()).nullish().isOptional()).toBe(true);
    expect(field(z.string()).nonoptional().isOptional()).toBe(false);
    expect(field(z.string()).exactOptional().schema).toBeDefined();
    expect(field(z.string()).or(z.number()).schema.parse(5)).toBe(5);
    expect(field(z.string()).and(z.string()).schema.parse("a")).toBe("a");
    expect(
      field(z.string())
        .refine((v) => v.length > 0)
        .schema.safeParse("").success,
    ).toBe(false);
    expect(
      field(z.string()).superRefine(() => {}).schema.safeParse("a").success,
    ).toBe(true);
    expect(
      field(z.string()).check(() => {}).schema.safeParse("a").success,
    ).toBe(true);
    expect(
      field(z.string())
        .overwrite((v) => v.toUpperCase())
        .schema.parse("a"),
    ).toBe("A");
    expect(field(z.string()).brand("B").schema.safeParse("a").success).toBe(
      true,
    );
    expect(field(z.string()).describe("d").description).toBe("d");
    expect(field(z.string()).meta({ m: 1 }).schema.meta()).toEqual({ m: 1 });
    expect(field(z.string()).readonly().schema.safeParse("a").success).toBe(
      true,
    );
    expect(
      field(z.string())
        .transform((v) => v.length)
        .schema.parse("abc"),
    ).toBe(3);
    expect(
      field(z.string())
        .pipe(z.string().transform((v) => `${v}!`))
        .schema.parse("a"),
    ).toBe("a!");
  });

  test("unwrap peels a wrapper, falling back to the schema itself", () => {
    expect(
      field(z.string().nullable()).unwrap().schema.safeParse("a").success,
    ).toBe(true);
    expect(
      field(z.string().array()).unwrap().schema.safeParse("a").success,
    ).toBe(true);
    expect(field(z.string()).unwrap().schema.safeParse("a").success).toBe(true);
  });

  test("object loose/strict/flexible, and a non-object no-op", () => {
    const obj = field(z.object({ a: z.string() }));
    expect(obj.loose().schema.safeParse({ a: "x", b: 1 }).success).toBe(true);
    expect(obj.strict().schema.safeParse({ a: "x", b: 1 }).success).toBe(false);
    expect(obj.flexible().schema.safeParse({ a: "x", b: 1 }).success).toBe(
      true,
    );
    // A non-object schema has no loose/strict — the mode is a no-op returning the same field.
    expect(field(z.string()).loose()).toBeInstanceOf(TestField);
  });
});
