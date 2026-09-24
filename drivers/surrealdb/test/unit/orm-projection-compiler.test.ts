// The projection compiler in isolation: `select`/`omit`/`value` guards, the star-schema reshaping
// and the Zod-shape codec walker (`projectedFieldFor` / `resolveLeafCodec`).
import { describe, expect, test } from "bun:test";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileProjection,
  projectedFieldFor,
  resolveLeafCodec,
} from "../../src/orm/compiler/projection";
import { createBinds } from "../../src/orm/compiler/shared";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
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
const sm = betterSchemic(fakeConn(() => [ok([])]).conn, {
  schema: defineSchema({ audit: "audit_log" }),
}).$index.schemaless.get("audit")!;
const b = () => createBinds();

describe("compileProjection", () => {
  test("select shape guards: non-array/non-object, empty, non-string array entry", () => {
    expect(
      code(() => compileProjection(meta, 5, undefined, false, b(), "select")),
    ).toBe("ValidationError");
    expect(
      code(() => compileProjection(meta, [], undefined, false, b(), "select")),
    ).toBe("ValidationError");
    expect(
      code(() => compileProjection(meta, [5], undefined, false, b(), "select")),
    ).toBe("ValidationError");
    // `null` behaves like `undefined` (full row).
    expect(
      compileProjection(meta, null, undefined, false, b(), "select").spec.star,
    ).toBe(true);
  });

  test("value: star conflict, array select, and a non-single expression", () => {
    expect(
      code(() =>
        compileProjection(meta, { "*": true }, undefined, true, b(), "select"),
      ),
    ).toBe("ValidationError");
    expect(
      compileProjection(meta, ["name"], undefined, true, b(), "select").spec
        .value,
    ).toBe(true);
    expect(
      code(() =>
        compileProjection(meta, { name: true, age: true }, undefined, true, b(), "select"),
      ),
    ).toBe("ValidationError");
  });

  test("star schema reshaping: omit, unknown/nested split, and a skipped entry", () => {
    const p = compileProjection(meta, undefined, ["age"], false, b(), "select");
    expect(p.spec.starSchema).toBeDefined();
    expect(p.text).toContain("OMIT");
    expect(
      code(() =>
        compileProjection(meta, undefined, undefined, false, b(), "select", [
          "ghost",
        ]),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileProjection(meta, undefined, undefined, false, b(), "select", [
          "a",
          "b",
        ]),
      ),
    ).toBe("ValidationError");
    // every entry skipped → empty projection.
    expect(
      code(() =>
        compileProjection(meta, { a: false }, undefined, false, b(), "select"),
      ),
    ).toBe("ValidationError");
  });

  test("nested aliases/expressions and bad entries are rejected", () => {
    expect(
      code(() =>
        compileProjection(meta, { a: { b: "c" } }, undefined, false, b(), "select"),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileProjection(
          meta,
          { a: { b: surql`x` } },
          undefined,
          false,
          b(),
          "select",
        ),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileProjection(meta, { a: { b: 5 } }, undefined, false, b(), "select"),
      ),
    ).toBe("ValidationError");
  });
});

describe("projectedFieldFor / resolveLeafCodec", () => {
  test("a schemaless meta returns the raw leaf", () => {
    const leaf = projectedFieldFor(sm, ["a"], ["a"], ["a"]);
    expect(leaf.schema).toBeUndefined();
    expect(leaf.each).toBe(false);
  });

  test("split: element codec, scalar fallback, and a non-matching split", () => {
    expect(
      projectedFieldFor(meta, ["tags"], ["tags"], ["tags"], ["tags"]).each,
    ).toBe(false);
    expect(
      projectedFieldFor(meta, ["name"], ["name"], ["name"], ["name"]).schema,
    ).toBeDefined();
    // split names a different field → isSplit false, keeps the whole-field codec.
    const other = projectedFieldFor(meta, ["name"], ["name"], ["name"], ["tags"]);
    expect(other.schema).toBeDefined();
    expect(other.each).toBe(false);
  });

  test("leaf walk: empty path, unknown field, object child, array index/star", () => {
    expect(resolveLeafCodec(meta, []).each).toBe(false);
    expect(resolveLeafCodec(meta, ["ghost"]).schema).toBeUndefined();
    expect(resolveLeafCodec(meta, ["address", "ghost"]).schema).toBeUndefined();
    // a non-array child with a bracket mode keeps the whole child codec.
    expect(resolveLeafCodec(meta, ["name[*]"]).schema).toBeDefined();
    expect(resolveLeafCodec(meta, ["tags[0]"]).each).toBe(false);
    expect(resolveLeafCodec(meta, ["tags[*]"]).each).toBe(true);
  });
});

// A schema exercising the codec walker's less-common shapes: set fields, wrapped fields
// (nullable/default/prefault/readonly/catch) and nested arrays.
const Extra = defineTable("extra", {
  tags: s.set(s.string()),
  maybe: s.string().nullable(),
  withDefault: s.string().default("x"),
  pre: s.string().prefault("x"),
  ro: s.string().readonly(),
  caught: s.string().catch("x"),
  cube: s.array(s.array(s.array(s.int()))),
});
const extraIndex = betterSchemic(fakeConn(() => [ok([])]).conn, {
  schema: defineSchema({ extras: Extra }),
}).$index;
const extra = extraIndex.tables.get("extras")!;

describe("projection — wrapped/set/nested codecs", () => {
  test("wrapped fields unwrap to their inner codec", () => {
    for (const field of ["maybe", "withDefault", "pre", "ro", "caught"])
      expect(resolveLeafCodec(extra, [field]).schema).toBeDefined();
  });

  test("set fields use valueType; a nested array index/star sets each", () => {
    expect(resolveLeafCodec(extra, ["tags"]).schema).toBeDefined();
    expect(resolveLeafCodec(extra, ["tags[0]"]).each).toBe(false);
    expect(resolveLeafCodec(extra, ["cube[0][*]"]).each).toBe(true);
    // split on a set unfolds to the element codec.
    expect(projectedFieldFor(extra, ["tags"], ["tags"], ["tags"], ["tags"]).each).toBe(
      false,
    );
  });

  test("star-schema with an object select; omit null/empty guards", () => {
    expect(
      compileProjection(meta, { "*": true }, ["age"], false, b(), "select").spec
        .starSchema,
    ).toBeDefined();
    expect(
      compileProjection(meta, undefined, null, false, b(), "select").spec.omit,
    ).toEqual([]);
    expect(
      code(() => compileProjection(meta, undefined, [""], false, b(), "select")),
    ).toBe("ValidationError");
  });

  test("split mismatches fall back to the whole-field codec", () => {
    // lengths differ.
    expect(
      projectedFieldFor(meta, ["a"], ["a"], ["a", "b"], ["x"]).schema,
    ).toBeUndefined();
    // an unknown field with a split → found.schema is undefined.
    expect(
      projectedFieldFor(meta, ["ghost"], ["ghost"], ["ghost"], ["ghost"]).schema,
    ).toBeUndefined();
  });
});
