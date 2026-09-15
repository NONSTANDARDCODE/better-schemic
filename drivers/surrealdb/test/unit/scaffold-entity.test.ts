/**
 * `better-schemic new <kind> <name>` -> surrealDriver.scaffoldEntity(kind, name). Each template must be a
 * VALID authoring module: we eval the generated `define*` expression and assert it emits real DDL for
 * `name` (catching template typos / bad API usage), plus the throw paths (inline-only + unknown kinds).
 */
import { describe, expect, test } from "bun:test";
import { surql } from "surrealdb";
import { scaffoldEntity } from "../../src/cli/scaffold";
import { emitDefStatement, emitTable } from "../../src/ddl";
import {
  defineAccess,
  defineAnalyzer,
  defineEvent,
  defineFunction,
  defineRelation,
  defineTable,
  defineView,
  s,
  TableDef,
} from "../../src/pure";

const API = {
  defineTable,
  defineRelation,
  defineView,
  defineFunction,
  defineAccess,
  defineEvent,
  defineAnalyzer,
  s,
  surql,
};
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Eval the module's exported `define*(...)` expression and emit it to SurrealQL. */
function emitScaffold(src: string): string {
  const m = src.match(/export const \w+\s*=\s*([\s\S]*?);/);
  if (!m) throw new Error("no `export const … = …;` in scaffold");
  const js = transpiler.transformSync(`const __f = () => (\n${m[1]}\n);`);
  const fn = new Function(...Object.keys(API), `${js}\nreturn __f();`);
  const def = fn(...Object.values(API));
  return def instanceof TableDef ? emitTable(def) : emitDefStatement(def).ddl;
}

describe("scaffoldEntity — authorable kinds emit valid DDL", () => {
  const cases: [kind: string, ddlIncludes: string][] = [
    ["table", "DEFINE TABLE thing_one TYPE NORMAL SCHEMAFULL"],
    ["relation", "DEFINE TABLE thing_one TYPE RELATION"],
    ["view", "DEFINE TABLE thing_one TYPE ANY SCHEMALESS AS"],
    ["function", "DEFINE FUNCTION fn::thing_one("],
    ["access", "DEFINE ACCESS thing_one ON DATABASE TYPE RECORD"],
    ["event", "DEFINE EVENT thing_one ON TABLE thing"],
    ["analyzer", "DEFINE ANALYZER thing_one TOKENIZERS"],
  ];
  for (const [kind, includes] of cases) {
    test(`${kind} scaffolds + emits`, () => {
      const src = scaffoldEntity(kind, "thing_one");
      // PascalCase export name from the snake_case input.
      expect(src).toContain("export const ThingOne =");
      expect(src).toContain('from "@better-schemic/surrealdb"');
      expect(emitScaffold(src)).toContain(includes);
    });
  }
});

describe("scaffoldEntity — throw paths", () => {
  test("index is inline-only -> throws a helpful message", () => {
    expect(() => scaffoldEntity("index", "by_email")).toThrow(
      /inline on a table/,
    );
  });
  test("field is inline-only -> throws", () => {
    expect(() => scaffoldEntity("field", "email")).toThrow(/inline on a table/);
  });
  test("unknown kind -> throws with the known-kinds list", () => {
    expect(() => scaffoldEntity("widget", "x")).toThrow(
      /can't scaffold a "widget"/,
    );
  });
});
