// The relation resolver + where-owner classifier in isolation: direction resolution (auto/explicit
// And its fail-fast guards), the edge/target split, logical-group handling and the teaching errors.
import { describe, expect, test } from "bun:test"

import { surql } from "../../../src/surreal"
import { betterSchemic } from "../../../src/surreal/orm/client"
import {
  availableKeys,
  classifyWhereByOwner,
  edgeMeta,
  edgeTraversal,
  findEdge,
  resolveEdge,
  targetMetas,
} from "../../../src/surreal/orm/compiler/relations"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { defineRelation, defineTable, s } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

import { schema } from "./orm-writes-fixtures"

const code = (fn: () => unknown): string | undefined => {
    try {
      fn()
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  },
  client = betterSchemic(fakeConn(() => [ok([])]).conn, { schema }),
  index = client.$index,
  user = index.tables.get("users")!,
  post = index.tables.get("posts")!,
  likes = index.tables.get("likes")!

describe("resolveEdge", () => {
  test("auto prefers outgoing, falls back to incoming", () => {
    expect(resolveEdge(user, "likes", undefined, "op").direction).toBe("out")
    expect(resolveEdge(post, "likes", undefined, "op").direction).toBe("in")
  })

  test("explicit out/in/both, and the direction guards", () => {
    expect(resolveEdge(user, "likes", "out", "op").direction).toBe("out")
    expect(resolveEdge(post, "likes", "in", "op").direction).toBe("in")
    expect(resolveEdge(user, "likes", "both", "op").direction).toBe("both")
    // User is only a FROM endpoint; post is only a TO endpoint.
    expect(code(() => resolveEdge(user, "likes", "in", "op"))).toBe("ValidationError")
    expect(code(() => resolveEdge(post, "likes", "out", "op"))).toBe("ValidationError")
  })

  test("an unknown edge name is UnknownField", () => {
    expect(code(() => resolveEdge(user, "ghost", undefined, "op"))).toBe("UnknownField")
  })

  test("findEdge + availableKeys + targetMetas", () => {
    expect(findEdge(user, "likes")?.name).toBe("likes")
    expect(findEdge(user, "ghost")).toBeUndefined()
    expect(availableKeys(user).edges).toContain("likes")
    expect(targetMetas(index, undefined)).toEqual([])
    expect(targetMetas(index, ["post"]).map((m) => m.name)).toEqual(["post"])
    expect(targetMetas(index, ["ghost"])).toEqual([])
  })
})

describe("edgeTraversal", () => {
  test("arrow + target rendering (edge-only, single, multi, wildcard)", () => {
    expect(edgeTraversal({ edge: "likes", direction: "out" })).toBe("->likes")
    expect(edgeTraversal({ edge: "likes", direction: "in" })).toBe("<-likes")
    expect(edgeTraversal({ edge: "likes", direction: "both" })).toBe("<->likes")
    expect(edgeTraversal({ edge: "likes", direction: "out", targets: ["post"] })).toBe(
      "->likes->post",
    )
    expect(edgeTraversal({ edge: "likes", direction: "out", targets: ["post", "user"] })).toBe(
      "->likes->(post, user)",
    )
    expect(edgeTraversal({ edge: "likes", direction: "out", targets: [] })).toBe("->likes->?")
    expect(
      edgeTraversal({
        edge: "likes",
        direction: "out",
        edgeFilter: "score > 1",
        targets: ["post"],
        targetFilter: "name = 'x'",
      }),
    ).toBe("->(likes WHERE score > 1)->(post WHERE name = 'x')")
  })
})

describe("classifyWhereByOwner", () => {
  const classify = (where: unknown) =>
    classifyWhereByOwner({
      where,
      edge: likes,
      targets: [user, post],
      idOwner: "edge",
      operation: "op",
      context: "where.likes",
    })

  test("undefined / null -> empty; a lowerable fragment -> fragment", () => {
    expect(classify(undefined)).toEqual({})
    expect(classify(null)).toEqual({})
    expect(classify(surql`x = 1`)).toHaveProperty("fragment")
  })

  test("a non-object, non-fragment -> ValidationError", () => {
    expect(code(() => classify(5))).toBe("ValidationError")
  })

  test("edge-only field -> edge; target field -> target; unknown -> UnknownField", () => {
    expect(classify({ score: { gt: 1 } })).toEqual({ edge: { score: { gt: 1 } } })
    expect(classify({ name: "A" })).toEqual({ target: { name: "A" } })
    expect(code(() => classify({ nope: 1 }))).toBe("UnknownField")
  })

  test("id routes by idOwner; undefined values are skipped", () => {
    expect(classify({ id: "user:1" })).toEqual({ edge: { id: "user:1" } })
    expect(classify({ score: undefined })).toEqual({})
  })

  test("a homogeneous logical group keeps its owner; empty/mixed are rejected", () => {
    expect(classify({ AND: [{ score: { gt: 1 } }, { score: { lt: 5 } }] })).toEqual({
      edge: { AND: [{ score: { gt: 1 } }, { score: { lt: 5 } }] },
    })
    expect(code(() => classify({ AND: [] }))).toBe("ValidationError")
    expect(code(() => classify({ AND: [{ score: { gt: 1 } }, { name: "A" }] }))).toBe(
      "ValidationError",
    )
  })

  test("targets: [] treats every non-edge field as a target", () => {
    expect(
      classifyWhereByOwner({
        where: { name: "A" },
        edge: likes,
        targets: [],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { name: "A" } })
  })

  test("a field on BOTH edge and target is ambiguous (non-id)", () => {
    const U = defineTable("amb_user", { name: s.string() }),
      E = defineRelation("amb_edge", { name: s.string() }).from(U).to(U),
      idx = betterSchemic(fakeConn(() => [ok([])]).conn, {
        schema: defineSchema({ users: U, edges: E }),
      }).$index,
      edge = idx.tables.get("edges")!
    expect(
      code(() =>
        classifyWhereByOwner({
          where: { name: "x" },
          edge,
          targets: [idx.tables.get("users")!],
          idOwner: "edge",
          operation: "op",
          context: "where",
        }),
      ),
    ).toBe("ValidationError")
  })

  test("no edge meta: fields fall to the target", () => {
    expect(
      classifyWhereByOwner({
        where: { name: "A" },
        targets: [user],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { name: "A" } })
  })
})

describe("relations — extra branches", () => {
  test("findEdge matches the schema KEY, and a relation-less table has no known keys", () => {
    const Solo = defineTable("solo", { name: s.string() }),
      keyed = betterSchemic(fakeConn(() => [ok([])]).conn, {
        schema: defineSchema({ users: user.def, posts: post.def, rel: likes.def }),
      }).$index,
      keyedUser = keyed.tables.get("users")!
    expect(findEdge(keyedUser, "rel")?.name).toBe("likes")
    const solo = betterSchemic(fakeConn(() => [ok([])]).conn, {
      schema: defineSchema({ solo: Solo }),
    }).$index.tables.get("solo")!
    expect(code(() => resolveEdge(solo, "ghost", undefined, "op"))).toBe("UnknownField")
  })

  test("direction both on an incoming-only table", () => {
    const both = resolveEdge(post, "likes", "both", "op")
    expect(both.direction).toBe("both")
    expect(both.targets).toContain("user")
  })

  test("targetMetas / edgeMeta skip schemaless entries", () => {
    const idx = betterSchemic(fakeConn(() => [ok([])]).conn, {
      schema: defineSchema({ audit_log: "audit_log" }),
    }).$index
    expect(targetMetas(idx, ["audit_log"])).toEqual([])
    expect(edgeMeta(idx, "audit_log")).toBeUndefined()
  })

  test("ownsField follows links and edges", () => {
    const U = defineTable("link_user", {
        name: s.string(),
        mentor: s.recordId("link_user").optional(),
      }),
      idx = betterSchemic(fakeConn(() => [ok([])]).conn, {
        schema: defineSchema({ users: U }),
      }).$index,
      u = idx.tables.get("users")!
    expect(
      classifyWhereByOwner({
        where: { mentor: "user:1" },
        targets: [u],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { mentor: "user:1" } })
    // A nested edge name is owned too.
    expect(
      classifyWhereByOwner({
        where: { likes: { some: { score: 1 } } },
        targets: [user],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { likes: { some: { score: 1 } } } })
  })

  test("logical groups: scalar entries are ignored, nested logicals recurse", () => {
    expect(
      classifyWhereByOwner({
        where: { AND: [{ score: { gt: 1 } }, 5] },
        edge: likes,
        targets: [user, post],
        idOwner: "edge",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ edge: { AND: [{ score: { gt: 1 } }, 5] } })
    expect(
      classifyWhereByOwner({
        where: { AND: { AND: { score: { gt: 1 } } } },
        edge: likes,
        targets: [user, post],
        idOwner: "edge",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ edge: { AND: { AND: { score: { gt: 1 } } } } })
  })

  test("ownsField follows edge names on both sides (and the ambiguity guard)", () => {
    // `likes` is an outgoing edge of `user` and an incoming edge of `post`.
    expect(
      code(() =>
        classifyWhereByOwner({
          where: { likes: { some: { score: 1 } } },
          edge: user,
          targets: [post],
          idOwner: "target",
          operation: "op",
          context: "where",
        }),
      ),
    ).toBe("ValidationError")
  })

  test("resolveEdge matches an incoming edge by its schema KEY", () => {
    const keyed = betterSchemic(fakeConn(() => [ok([])]).conn, {
        schema: defineSchema({ users: user.def, posts: post.def, rel: likes.def }),
      }).$index,
      keyedPost = keyed.tables.get("posts")!
    expect(resolveEdge(keyedPost, "rel", undefined, "op").direction).toBe("in")
    expect(
      classifyWhereByOwner({
        where: { rel: { some: { score: 1 } } },
        targets: [keyedPost],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { rel: { some: { score: 1 } } } })
  })

  test("id with an empty target set routes by idOwner", () => {
    expect(
      classifyWhereByOwner({
        where: { id: "user:1" },
        edge: likes,
        targets: [],
        idOwner: "target",
        operation: "op",
        context: "where",
      }),
    ).toEqual({ target: { id: "user:1" } })
  })
})
