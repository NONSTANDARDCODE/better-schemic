const MAGIC_0p75 = 0.75
const MAGIC_1p5 = 1.5
import { describe, expect, test } from "bun:test"
import { surql } from "surrealdb"

import { fromStandalone, fromTableDef } from "../../../src/surreal/cli/lower"
import { normalizeTable } from "../../../src/surreal/cli/struct"
import { defineAccess, defineFunction, relation, s, table } from "../../../src/surreal/pure"

// fromTableDef lowers an in-memory TableDef to the raw Struct IR; normalizeTable then folds it to
// the canonical form both lowerings converge on. We assert the NORMALIZED struct (the comparable
// shape), exercising the paths/clauses fromTableDef must populate. No live DB required.

const User = table("user", { name: s.string() })
const Post = table("post", { title: s.string() })

describe("fromTableDef", () => {
  test("plain table: primitives + optional + default + assert", () => {
    const t = table("user", {
      active: s.boolean().$default(true),
      age: s.int().optional(),
      // optional + default: normalize strips `option<>` to `int` (a defaulted field is always
      // present, so INFO/the emitter store the bare type — both sides converge on `int`).
      count: s.int().optional().$default(0),
      email: s.string().$assert(surql`string::is_email($value)`),
    })
    expect(normalizeTable(fromTableDef(t))).toEqual({
      events: [],
      fields: [
        { default: "true", kind: "bool", name: "active", table: "user" },
        { kind: "option<int>", name: "age", table: "user" },
        { default: "0", kind: "int", name: "count", table: "user" },
        {
          assert: "string::is_email($value)",
          kind: "string",
          name: "email",
          table: "user",
        },
      ],
      indexes: [],
      kind: { kind: "NORMAL" },
      name: "user",
      schemafull: true,
    })
  })

  test("nested object field flattens to dotted paths (parent-before-child)", () => {
    const t = table("account", {
      address: s.object({ city: s.string(), zip: s.string().optional() }),
    })
    expect(normalizeTable(fromTableDef(t)).fields).toEqual([
      { kind: "object", name: "address", table: "account" },
      { kind: "string", name: "address.city", table: "account" },
      { kind: "option<string>", name: "address.zip", table: "account" },
    ])
  })

  test("array of primitive -> array<T> (no `.*`)", () => {
    const t = table("post", { tags: s.array(s.string()) })
    expect(normalizeTable(fromTableDef(t)).fields).toEqual([
      { kind: "array<string>", name: "tags", table: "post" },
    ])
  })

  test("array of object emits `.*` element folded into the parent, keeps `.*` subfield", () => {
    const t = table("post", {
      authors: s.array(s.object({ handle: s.string() })),
    })
    expect(normalizeTable(fromTableDef(t)).fields).toEqual([
      { kind: "array<object>", name: "authors", table: "post" },
      { kind: "string", name: "authors.*.handle", table: "post" },
    ])
  })

  test("record reference with ON DELETE", () => {
    const t = table("comment", {
      author: s.recordId("user").$reference({ onDelete: "cascade" }),
    })
    expect(normalizeTable(fromTableDef(t)).fields).toEqual([
      {
        kind: "record<user>",
        name: "author",
        reference: { on_delete: "CASCADE" },
        table: "comment",
      },
    ])
  })

  test("relation: in/out land in kind, not as fields", () => {
    const wrote = relation("wrote", { at: s.datetime() }).from(User).to(Post)
    const out = normalizeTable(fromTableDef(wrote))
    expect(out.kind).toEqual({ in: ["user"], kind: "RELATION", out: ["post"] })
    expect(out.fields).toEqual([{ kind: "datetime", name: "at", table: "wrote" }])
  })

  test("field with non-default permissions is kept", () => {
    const t = table("secret", {
      data: s.string().$permissions({ select: false }),
    })
    expect(normalizeTable(fromTableDef(t)).fields).toEqual([
      {
        kind: "string",
        name: "data",
        permissions: { select: false },
        table: "secret",
      },
    ])
  })

  test("single-field index + table comment", () => {
    const t = table("user", {
      email: s.string().$unique(),
    }).comment("users")
    const out = normalizeTable(fromTableDef(t))
    expect(out.indexes).toEqual([{ cols: ["email"], index: "UNIQUE", name: "user_email_idx" }])
    expect(out.comment).toBe("users")
  })

  test("field .$fulltext()/.$hnsw() lower to a structured index carrying the spec", () => {
    const t = table("doc", {
      body: s
        .string()
        .$fulltext({ analyzer: "eng", bm25: [MAGIC_1p5, MAGIC_0p75], highlights: true }),
      emb: s.array(s.float()).$hnsw({ dimension: 4 }),
      id: s.string(),
    })
    const out = normalizeTable(fromTableDef(t))
    expect(out.indexes).toEqual([
      {
        cols: ["body"],
        index: "FULLTEXT ANALYZER eng BM25(1.5,0.75) HIGHLIGHTS",
        name: "doc_body_idx",
      },
      { cols: ["emb"], index: "HNSW DIMENSION 4", name: "doc_emb_idx" },
    ])
  })
})

describe("fromStandalone", () => {
  test("function -> StructFunction (args, brace-wrapped block, returns)", () => {
    const greet = defineFunction("greet", { name: s.string() })
      .returns(s.string())
      .body(surql`RETURN "hi " + $name`)
    expect(fromStandalone(greet)).toEqual({
      args: [["name", "string"]],
      block: '{ RETURN "hi " + $name }',
      name: "greet",
      returns: "string",
    })
  })

  test("access -> StructAccess (record kind + duration)", () => {
    const account = defineAccess("account")
      .onDatabase()
      .record()
      .duration({ session: "12h", token: "1h" })
    expect(fromStandalone(account)).toEqual({
      duration: { session: "12h", token: "1h" },
      kind: { kind: "RECORD" },
      name: "account",
    })
  })
})
