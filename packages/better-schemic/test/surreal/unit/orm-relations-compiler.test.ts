import { describe, expect, test } from "bun:test"

import { surql } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import {
  availableKeys,
  classifyWhereByOwner,
  edgeMeta,
  edgeTraversal,
  findEdge,
  type OwnedWhere,
  resolveEdge,
  targetMetas,
} from "../../../src/surreal/orm/compiler/relations"
import { schema } from "../../../src/surreal/orm/schema"
import { relation, s, table } from "../../../src/surreal/pure"
import { required } from "../../required"
import { fakeConn, ok } from "../orm-fixtures"

import { schemaDef } from "./orm-writes-fixtures"
const classify = (where: unknown): OwnedWhere =>
  classifyWhereByOwner({
    context: "where.likes",
    edge: likes,
    idOwner: "edge",
    operation: "op",
    targets: [user, post],
    where,
  })

const MAGIC_5 = 5
// The relation resolver + where-owner classifier in isolation: direction resolution (auto/explicit
// and its fail-fast guards), the edge/target split, logical-group handling and the teaching errors.

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

const client = orm(fakeConn(() => [ok([])]).conn, { schema: schemaDef })
const index = client.$index
const user = required(index.tables.get("users"))
const post = required(index.tables.get("posts"))
const likes = required(index.tables.get("likes"))

describe("resolveEdge", () => {
  test("auto prefers outgoing, falls back to incoming", () => {
    expect(resolveEdge(user, "likes", undefined, "op").direction).toBe("out")
    expect(resolveEdge(post, "likes", undefined, "op").direction).toBe("in")
  })

  test("explicit out/in/both, and the direction guards", () => {
    expect(resolveEdge(user, "likes", "out", "op").direction).toBe("out")
    expect(resolveEdge(post, "likes", "in", "op").direction).toBe("in")
    expect(resolveEdge(user, "likes", "both", "op").direction).toBe("both")
    // user is a FROM endpoint; post is a TO endpoint.
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
    expect(edgeTraversal({ direction: "out", edge: "likes" })).toBe("->likes")
    expect(edgeTraversal({ direction: "in", edge: "likes" })).toBe("<-likes")
    expect(edgeTraversal({ direction: "both", edge: "likes" })).toBe("<->likes")
    expect(edgeTraversal({ direction: "out", edge: "likes", targets: ["post"] })).toBe(
      "->likes->post",
    )
    expect(
      edgeTraversal({
        direction: "out",
        edge: "likes",
        targets: ["post", "user"],
      }),
    ).toBe("->likes->(post, user)")
    expect(edgeTraversal({ direction: "out", edge: "likes", targets: [] })).toBe("->likes->?")
    expect(
      edgeTraversal({
        direction: "out",
        edge: "likes",
        edgeFilter: "score > 1",
        targetFilter: "name = 'x'",
        targets: ["post"],
      }),
    ).toBe("->(likes WHERE score > 1)->(post WHERE name = 'x')")
  })
})

describe("classifyWhereByOwner", () => {
  test("undefined / null -> empty; a lowerable fragment -> fragment", () => {
    expect(classify(undefined)).toEqual({})
    expect(classify(null)).toEqual({})
    expect(classify(surql`x = 1`)).toHaveProperty("fragment")
  })

  test("a non-object, non-fragment -> ValidationError", () => {
    expect(code(() => classify(MAGIC_5))).toBe("ValidationError")
  })

  test("edge-only field -> edge; target field -> target; unknown -> UnknownField", () => {
    expect(classify({ score: { gt: 1 } })).toEqual({
      edge: { score: { gt: 1 } },
    })
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
        context: "where",
        edge: likes,
        idOwner: "target",
        operation: "op",
        targets: [],
        where: { name: "A" },
      }),
    ).toEqual({ target: { name: "A" } })
  })

  test("a field on BOTH edge and target is ambiguous (non-id)", () => {
    const U = table("amb_user", { name: s.string() })
    const E = relation("amb_edge", { name: s.string() }).from(U).to(U)
    const idx = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ edges: E, users: U }),
    }).$index
    const edge = required(idx.tables.get("edges"))
    expect(
      code(() =>
        classifyWhereByOwner({
          context: "where",
          edge,
          idOwner: "edge",
          operation: "op",
          targets: [required(idx.tables.get("users"))],
          where: { name: "x" },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("no edge meta: fields fall to the target", () => {
    expect(
      classifyWhereByOwner({
        context: "where",
        idOwner: "target",
        operation: "op",
        targets: [user],
        where: { name: "A" },
      }),
    ).toEqual({ target: { name: "A" } })
  })
})

describe("relations — extra branches", () => {
  test("findEdge matches the schema KEY, and a relation-less table has no known keys", () => {
    const Solo = table("solo", { name: s.string() })
    const keyed = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ posts: post.def, rel: likes.def, users: user.def }),
    }).$index
    const keyedUser = required(keyed.tables.get("users"))
    expect(findEdge(keyedUser, "rel")?.name).toBe("likes")
    const solo = required(
      orm(fakeConn(() => [ok([])]).conn, {
        schema: schema({ solo: Solo }),
      }).$index.tables.get("solo"),
    )
    expect(code(() => resolveEdge(solo, "ghost", undefined, "op"))).toBe("UnknownField")
  })

  test("direction both on an incoming-only table", () => {
    const both = resolveEdge(post, "likes", "both", "op")
    expect(both.direction).toBe("both")
    expect(both.targets).toContain("user")
  })

  test("targetMetas / edgeMeta skip schemaless entries", () => {
    const idx = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ audit_log: "audit_log" }),
    }).$index
    expect(targetMetas(idx, ["audit_log"])).toEqual([])
    expect(edgeMeta(idx, "audit_log")).toBeUndefined()
  })

  test("ownsField follows links and edges", () => {
    const U = table("link_user", {
      mentor: s.recordId("link_user").optional(),
      name: s.string(),
    })
    const idx = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ users: U }),
    }).$index
    const u = required(idx.tables.get("users"))
    expect(
      classifyWhereByOwner({
        context: "where",
        idOwner: "target",
        operation: "op",
        targets: [u],
        where: { mentor: "user:1" },
      }),
    ).toEqual({ target: { mentor: "user:1" } })
    // a nested edge name owns it too.
    expect(
      classifyWhereByOwner({
        context: "where",
        idOwner: "target",
        operation: "op",
        targets: [user],
        where: { likes: { some: { score: 1 } } },
      }),
    ).toEqual({ target: { likes: { some: { score: 1 } } } })
  })

  test("logical groups: scalar entries are ignored, nested logicals recurse", () => {
    expect(
      classifyWhereByOwner({
        context: "where",
        edge: likes,
        idOwner: "edge",
        operation: "op",
        targets: [user, post],
        where: { AND: [{ score: { gt: 1 } }, MAGIC_5] },
      }),
    ).toEqual({ edge: { AND: [{ score: { gt: 1 } }, MAGIC_5] } })
    expect(
      classifyWhereByOwner({
        context: "where",
        edge: likes,
        idOwner: "edge",
        operation: "op",
        targets: [user, post],
        where: { AND: { AND: { score: { gt: 1 } } } },
      }),
    ).toEqual({ edge: { AND: { AND: { score: { gt: 1 } } } } })
  })

  test("ownsField follows edge names on both sides (and the ambiguity guard)", () => {
    // `likes` is an outgoing edge of `user` and an incoming edge of `post`.
    expect(
      code(() =>
        classifyWhereByOwner({
          context: "where",
          edge: user,
          idOwner: "target",
          operation: "op",
          targets: [post],
          where: { likes: { some: { score: 1 } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("resolveEdge matches an incoming edge by its schema KEY", () => {
    const keyed = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ posts: post.def, rel: likes.def, users: user.def }),
    }).$index
    const keyedPost = required(keyed.tables.get("posts"))
    expect(resolveEdge(keyedPost, "rel", undefined, "op").direction).toBe("in")
    expect(
      classifyWhereByOwner({
        context: "where",
        idOwner: "target",
        operation: "op",
        targets: [keyedPost],
        where: { rel: { some: { score: 1 } } },
      }),
    ).toEqual({ target: { rel: { some: { score: 1 } } } })
  })

  test("id with an empty target set routes by idOwner", () => {
    expect(
      classifyWhereByOwner({
        context: "where",
        edge: likes,
        idOwner: "target",
        operation: "op",
        targets: [],
        where: { id: "user:1" },
      }),
    ).toEqual({ target: { id: "user:1" } })
  })
})
