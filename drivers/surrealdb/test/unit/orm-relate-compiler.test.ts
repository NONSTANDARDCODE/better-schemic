// The RELATE lowering in isolation: the default operations, endpoint validation, named/empty edge
// ids and the `create.relate` sugar guards. Direct calls pin the failure codes.
import { describe, expect, test } from "bun:test";
import { betterSchemic } from "../../src/orm/client";
import {
  compileRelate,
  compileRelateMany,
  compileUnrelate,
  compileUnrelateMany,
  relateStatement,
  relateSugar,
} from "../../src/orm/compiler/relate";
import { createBinds } from "../../src/orm/compiler/shared";
import { defineSchema } from "../../src/orm/schema";
import { defineRelation } from "../../src/pure";
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
const likes = client.$index.tables.get("likes")!;
const user = client.$index.tables.get("users")!;
const b = () => createBinds();

describe("relate / unrelate — defaults and guards", () => {
  test("default operations; named and empty edge ids", () => {
    expect(
      compileRelate(likes, { from: "user:1", to: "post:1" }, b()).statements[0],
    ).toContain("RELATE");
    expect(
      compileRelateMany(
        likes,
        { data: [{ from: "user:1", to: "post:1" }] },
        b(),
      ).statements[0],
    ).toContain("RELATE");
    expect(
      compileUnrelate(likes, { from: "user:1", to: "post:1" }, b()).statements[0],
    ).toContain("DELETE");
    expect(
      compileUnrelateMany(likes, { all: true }, b()).statements[0],
    ).toContain("DELETE");
    expect(
      compileRelate(
        likes,
        { from: "user:1", to: "post:1", id: "likes:1" },
        b(),
      ).statements[0],
    ).toContain("likes:1");
    expect(
      code(() =>
        compileRelate(likes, { from: "user:1", to: "post:1", id: "" }, b()),
      ),
    ).toBe("ValidationError");
  });

  test("relateMany: missing from, per-item return; unrelate missing from", () => {
    expect(
      code(() => compileRelateMany(likes, { data: [{ to: "post:1" }] }, b())),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileRelateMany(
          likes,
          { data: [{ from: "user:1", to: "post:1", return: "none" }] },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    expect(
      compileRelateMany(
        likes,
        { data: [{ from: "user:1", to: "post:1", return: "after" }] },
        b(),
      ).statements,
    ).toHaveLength(1);
    expect(code(() => compileUnrelate(likes, { to: "post:1" }, b()))).toBe(
      "ValidationError",
    );
  });

  test("endpoints: a TO mismatch, an undefined endpoint, and no meta", () => {
    expect(
      code(() => compileRelate(likes, { from: "user:1", to: "user:1" }, b())),
    ).toBe("ValidationError");
    const stmt = relateStatement(
      {
        from: "user:1",
        edge: "likes",
        to: "post:1",
        data: { score: 1 },
        ret: "after",
      },
      b(),
      "relate",
    );
    expect(stmt).toContain("SET");
    expect(
      code(() =>
        relateStatement(
          { from: undefined, edge: "likes", to: "post:1", ret: "after" },
          b(),
          "relate",
        ),
      ),
    ).toBe("ValidationError");
  });

  test("a relation with no declared endpoints accepts any table", () => {
    const Bare = defineRelation("bare", {});
    const c = betterSchemic(fakeConn(() => [ok([])]).conn, {
      schema: defineSchema({ bare: Bare }),
    });
    const bare = c.$index.tables.get("bare")!;
    expect(
      compileRelate(bare, { from: "x:1", to: "y:1" }, b()).statements[0],
    ).toContain("x:1");
  });
});

describe("relateSugar", () => {
  test("def edge, missing keys, unknown/table edges, no resolver", () => {
    expect(
      relateSugar(
        [{ from: "user:1", edge: { name: "likes" }, to: "post:1" }],
        "create",
        likes,
      )[0]?.edge,
    ).toContain("likes");
    expect(
      code(() => relateSugar([{ edge: "likes", to: "post:1" }], "create", likes)),
    ).toBe("ValidationError");
    expect(
      code(() =>
        relateSugar([{ from: "user:1", to: "post:1" }], "create", likes),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        relateSugar(
          [{ from: "user:1", edge: "ghost", to: "post:1" }],
          "create",
          likes,
          () => undefined,
        ),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        relateSugar([{ from: "user:1", edge: 5, to: "post:1" }], "create", likes),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        relateSugar(
          [{ from: "user:1", edge: "user", to: "post:1" }],
          "create",
          likes,
          () => user,
        ),
      ),
    ).toBe("ValidationError");
    const entries = relateSugar(
      [{ from: "user:1", edge: "likes", to: "post:1", data: { score: 1 } }],
      "create",
      likes,
    );
    expect(entries[0]?.meta).toBeUndefined();
  });
});
