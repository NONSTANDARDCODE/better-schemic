import type { ProjectionSpec } from "../../../src/surreal/orm/compiler/projection"
import { required } from "../../required"
const MAGIC_18 = 18
const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_4 = 4
const MAGIC_5 = 5
// M3 — the include compiler (golden args -> exact `{ sql, vars }`), the relational `where`
// lowering, and the hydration decoder (links/graph/`_count`) against a recording fake connection.
// Offline: no server.
import { describe, expect, test } from "bun:test"
import { DateTime, RecordId } from "surrealdb"

import { relation, s, surql, table } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import { compileIncludeOrderBy } from "../../../src/surreal/orm/compiler/include/projection"
import type { CompileCtx } from "../../../src/surreal/orm/compiler/include/specs"
import { compileRead, type ReadArgs } from "../../../src/surreal/orm/compiler/select"
import { createBinds } from "../../../src/surreal/orm/compiler/shared"
import type { OrmError } from "../../../src/surreal/orm/errors"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"
import { KEEP_ORDER } from "../../order-barrier"
import { fakeConn, lines, ok } from "../orm-fixtures"
const localCompile2 = (
  s2: Parameters<typeof buildSchemaIndex>[0],
  table: string,
  args: ReadArgs,
): ReturnType<typeof compileRead> => {
  const idx = buildSchemaIndex(s2)
  const meta = idx.tables.get(table)
  if (!meta) throw new Error(`no table ${table}`)
  return compileRead(meta, args, createBinds(), "findMany", { index: idx })
}

const UserBase = table("user", {
  age: s.int(),
  at: s.datetime(),
  home: s.object({ city: s.string(), line: s.string() }).optional(),
  name: s.string(),
})
const User = UserBase.extend({
  friends: s
    .recordId(() => UserBase)
    .array()
    .optional(),
  mentor: s.recordId(() => UserBase).optional(),
})
const Post = table("post", {
  author: s.recordId(User),
  published: s.boolean(),
  title: s.string(),
})
const Likes = relation("likes", { score: s.int() }).from(User).to(Post)
const schema = { likes: Likes, posts: Post, users: User }
const index = buildSchemaIndex(schema)

/** Compile a read and capture its statement text + binds. */
function compile(
  args: ReadArgs,
  table = "users",
): { fetch: readonly string[]; spec: ProjectionSpec; sql: string; vars: Record<string, unknown> } {
  const meta = index.tables.get(table)
  if (!meta) throw new Error(`no table ${table}`)
  const binds = createBinds()
  const read = compileRead(meta, args, binds, "findMany", { index })
  return {
    fetch: read.fetch,
    spec: read.projection,
    sql: read.sql,
    vars: binds.vars,
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as OrmError).code
  }
}

describe("include — links", () => {
  test("true is FETCH (last clause), nested paths and multiple links", () => {
    expect(compile({ include: { mentor: true }, limit: 2 })).toEqual({
      fetch: ["mentor"],
      spec: expect.objectContaining({ includes: expect.any(Array) }),
      sql: "SELECT * FROM user LIMIT $p0 FETCH mentor",
      vars: { p0: 2 },
    })
    expect(compile({ include: { mentor: { include: { mentor: true } } } }).sql).toBe(
      "SELECT * FROM user FETCH mentor.mentor",
    )
    expect(
      compile({
        include: {
          mentor: true,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          friends: true,
        },
      }).sql,
    ).toBe("SELECT * FROM user FETCH mentor, friends")
  })

  test("a projected link flattens into `<link>_<path>` aliases (no FETCH)", () => {
    expect(compile({ include: { mentor: { select: { id: true, name: true } } } }).sql).toBe(
      "SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_name FROM user",
    )
    expect(
      compile({
        include: { mentor: { select: { id: true, who: "name" } } },
      }).sql,
    ).toBe("SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_who FROM user")
    expect(compile({ include: { mentor: { select: { "*": true } } } }).sql).toBe(
      "SELECT * FROM user FETCH mentor",
    )
  })

  test("an explicit select keeps its projection and the FETCH link is added", () => {
    expect(
      compile({
        include: { mentor: true },
        select: { id: true },
      }).sql,
    ).toBe("SELECT id, mentor FROM user FETCH mentor")
    expect(
      compile({
        include: { mentor: true },
        select: { id: true, name: true },
      }).sql,
    ).toBe("SELECT id, name, mentor FROM user FETCH mentor")
  })

  test("link guards", () => {
    expect(codeOf(() => compile({ include: { nope: true } }))).toBe("UnknownField")
    expect(
      codeOf(() =>
        compile({
          include: {
            mentor: { include: { mentor: true }, select: { id: true } },
          },
        }),
      ),
    ).toBe("ClauseNotSupported")
    expect(
      codeOf(() =>
        compile({
          include: { mentor: true },
          select: { name: true },
          value: true,
        }),
      ),
    ).toBe("ClauseNotSupported")
    expect(codeOf(() => compile({ include: { id: true } }))).toBe("ValidationError")
    // An empty nested include used to emit no FETCH and return the raw record id.
    expect(codeOf(() => compile({ include: { mentor: { include: {} } } }))).toBe("ValidationError")
  })

  test("nested select objects/aliases flatten and remount at the right path", async () => {
    expect(compile({ include: { mentor: { select: { home: { city: true } } } } }).sql).toBe(
      "SELECT *, mentor.home.city AS mentor_home_city, mentor.id AS mentor_id FROM user",
    )
    expect(compile({ include: { mentor: { select: { home: { label: "line" } } } } }).sql).toBe(
      "SELECT *, mentor.home.line AS mentor_home_label, mentor.id AS mentor_id FROM user",
    )
    const { conn } = fakeConn(() => [
      ok([
        fullUser("b1", {
          mentor_home_city: "BR",
          mentor_id: new RecordId("user", "a1"),
        }),
      ]),
    ])
    const rows = await orm(conn, { schema }).users.findMany({
      include: { mentor: { select: { home: { city: true } } } },
    })
    expect(rows[0]?.mentor).toEqual({ home: { city: "BR" } })
  })
})

describe("include — graph edges", () => {
  test("target records come from a correlated subquery", () => {
    expect(compile({ include: { likes: true } }).sql).toBe(
      "SELECT *, (SELECT * FROM ->likes->post) AS likes FROM user",
    )
    expect(compile({ include: { likes: { select: { id: true, title: true } } } }).sql).toBe(
      "SELECT *, (SELECT id, title FROM ->likes->post) AS likes FROM user",
    )
  })

  test("where splits into edge and target filters", () => {
    expect(
      compile({
        include: { likes: { where: { published: true, score: { gt: 4 } } } },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->(likes WHERE score > $p0)->post WHERE published = $p1) AS likes FROM user",
    )
    expect(
      compile({
        include: {
          likes: { where: { OR: [{ published: true }, { title: "x" }] } },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->likes->post WHERE (published = $p0 OR title = $p1)) AS likes FROM user",
    )
  })

  test("orderBy/limit/start ride the subquery (order idiom must be projected)", () => {
    expect(
      compile({
        include: {
          likes: {
            limit: 2,
            orderBy: [{ title: "desc" }],
            select: { id: true, title: true },
            start: 1,
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT id, title FROM ->likes->post ORDER BY title DESC LIMIT $p0 START $p1) AS likes FROM user",
    )
    expect(
      codeOf(() =>
        compile({
          include: {
            likes: { orderBy: [{ title: "asc" }], select: { id: true } },
          },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("edge records (`edge: true`) and the `{ edge, target }` remount", () => {
    expect(compile({ include: { likes: { edge: true } } }).sql).toBe(
      "SELECT *, (SELECT * FROM ->likes) AS likes FROM user",
    )
    expect(
      compile({
        include: {
          likes: {
            edge: { select: { score: true } },
            orderBy: [{ score: "desc" }],
            target: { select: { id: true, title: true } },
            where: { published: false, score: { gt: 4 } },
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT score, out.* FROM ->(likes WHERE score > $p0) WHERE out.published = $p1 ORDER BY score DESC) AS likes FROM user",
    )
  })

  test("incoming direction flips both arrows and materializes `in.*`", () => {
    expect(compile({ include: { likes: true } }, "posts").sql).toBe(
      "SELECT *, (SELECT * FROM <-likes<-user) AS likes FROM post",
    )
    expect(compile({ include: { likes: { select: { id: true, name: true } } } }, "posts").sql).toBe(
      "SELECT *, (SELECT id, name FROM <-likes<-user) AS likes FROM post",
    )
    expect(
      compile(
        {
          include: {
            likes: {
              edge: { select: { score: true } },
              target: { select: { id: true, name: true } },
            },
          },
        },
        "posts",
      ).sql,
    ).toBe("SELECT *, (SELECT score, in.* FROM <-likes) AS likes FROM post")
  })

  test("direction both: edge records and target records are allowed; edge+target is rejected", () => {
    expect(compile({ include: { likes: { direction: "both", edge: true } } }).sql).toBe(
      "SELECT *, (SELECT * FROM <->likes) AS likes FROM user",
    )
    expect(
      compile({
        include: { likes: { direction: "both", select: { id: true } } },
      }).sql,
    ).toBe("SELECT *, (SELECT id FROM <->likes<->post) AS likes FROM user")
    const err = codeOf(() =>
      compile({
        include: { likes: { direction: "both", edge: true, target: true } },
      }),
    )
    expect(err).toBe("ClauseNotSupported")
  })

  test("an edge-only include rejects a target-owned filter (it used to drop it silently)", () => {
    expect(
      codeOf(() =>
        compile({
          include: { likes: { edge: true, where: { published: true } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      compile({
        include: { likes: { edge: true, where: { score: { gt: 4 } } } },
      }).sql,
    ).toBe("SELECT *, (SELECT * FROM ->(likes WHERE score > $p0)) AS likes FROM user")
    // The wildcard edge row IS the edge — the filter applies to it (never dropped).
    expect(
      compile({
        include: {
          rel: { edge: true, where: { score: { gt: 4 } }, wildcard: true },
        },
      }).sql,
    ).toBe("SELECT *, (SELECT * FROM ->(? WHERE score > $p0)) AS rel FROM user")
  })

  test("wildcards traverse any edge (`->?` for outgoing, target via `out.*`)", () => {
    expect(compile({ include: { rel: { edge: true, wildcard: true } } }).sql).toBe(
      "SELECT *, (SELECT * FROM ->?) AS rel FROM user",
    )
    expect(compile({ include: { rel: { target: true, wildcard: true } } }).sql).toBe(
      "SELECT *, (SELECT out.* FROM ->?) AS rel FROM user",
    )
  })
})

describe("include — _count", () => {
  test("edges and array links lower to correlated counts", () => {
    expect(
      compile({
        include: {
          _count: {
            select: {
              likes: true,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              friends: true,
            },
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, count(->likes->post) AS _count_likes, count(friends) AS _count_friends FROM user",
    )
  })

  test("filters split edge/target (and array elements)", () => {
    expect(
      compile({
        include: {
          _count: {
            select: { likes: { where: { published: true, score: { gt: 4 } } } },
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, count(->(likes WHERE score > $p0)->(post WHERE published = $p1)) AS _count_likes FROM user",
    )
    expect(
      compile({
        include: {
          _count: { select: { friends: { where: { age: { gt: 18 } } } } },
        },
      }).sql,
    ).toBe("SELECT *, count(friends[WHERE age > $p0]) AS _count_friends FROM user")
  })

  test("single links and unknown keys are rejected", () => {
    expect(codeOf(() => compile({ include: { _count: { select: { mentor: true } } } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => compile({ include: { _count: { select: { nope: true } } } }))).toBe(
      "UnknownField",
    )
    // `direction` is edge-; unknown options never pass .
    expect(
      codeOf(() =>
        compile({
          include: { _count: { select: { friends: { direction: "in" } } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() => compile({ include: { _count: { select: { likes: { nope: true } } } } })),
    ).toBe("ValidationError")
  })
})

describe("relational where — lowering", () => {
  test("is/isNot prefix the target filter; isNot negates the group", () => {
    expect(compile({ where: { mentor: { is: { name: "Alice" } } } }).sql).toBe(
      "SELECT * FROM user WHERE mentor.name = $p0",
    )
    expect(
      compile({
        where: {
          mentor: {
            is: {
              name: "Alice",
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              ...KEEP_ORDER,
              age: { gte: 18 },
            },
          },
        },
      }).sql,
    ).toBe("SELECT * FROM user WHERE mentor.name = $p0 AND mentor.age >= $p1")
    expect(compile({ where: { mentor: { isNot: { name: "Alice" } } } }).sql).toBe(
      "SELECT * FROM user WHERE NOT (mentor.name = $p0)",
    )
  })

  test("edges: some/none count, every compares counts; direction override", () => {
    expect(compile({ where: { likes: { some: { published: true } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(->likes->(post WHERE published = $p0)) > 0",
    )
    expect(compile({ where: { likes: { none: { published: true } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(->likes->(post WHERE published = $p0)) = 0",
    )
    expect(compile({ where: { likes: { every: { published: true } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(->likes->post) = count(->likes->(post WHERE published = $p0))",
    )
    expect(compile({ where: { likes: { some: { score: { gt: 4 } } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(->(likes WHERE score > $p0)->post) > 0",
    )
    expect(
      compile({ where: { likes: { direction: "in", some: { name: "Alice" } } } }, "posts").sql,
    ).toBe("SELECT * FROM post WHERE count(<-likes<-(user WHERE name = $p0)) > 0")
  })

  test("array links: some/every/none over `count(field[WHERE …])`", () => {
    expect(compile({ where: { friends: { some: { age: { gt: 18 } } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(friends[WHERE age > $p0]) > 0",
    )
    expect(compile({ where: { friends: { every: { age: { gt: 18 } } } } }).sql).toBe(
      "SELECT * FROM user WHERE count(friends) = count(friends[WHERE age > $p0])",
    )
  })

  test("relation guards: wrong operator, mixed logical owners", () => {
    const err = ((): OrmError | undefined => {
      try {
        compile({ where: { mentor: { some: { name: "Alice" } } } })
        return undefined
      } catch (error) {
        return error as OrmError
      }
    })()
    expect(err?.code).toBe("ValidationError")
    expect(err?.message).toContain("is")

    const mixed = ((): OrmError | undefined => {
      try {
        compile({
          where: {
            likes: { some: { OR: [{ score: 4 }, { published: true }] } },
          },
        })
        return undefined
      } catch (error) {
        return error as OrmError
      }
    })()
    expect(mixed?.code).toBe("ValidationError")
    expect(mixed?.message).toContain("mixes edge and target")
  })

  test("a fragment on a relation key is a whole predicate", () => {
    expect(compile({ where: { mentor: surql`name = ${"A"}` } }).sql).toContain("(name = $")
  })

  test("some/every/none accept fragments; non-object operands are rejected", () => {
    expect(compile({ where: { likes: { some: surql`score > ${MAGIC_4}` } } }).sql).toContain(
      "count(",
    )
    expect(compile({ where: { friends: { some: surql`age > ${MAGIC_18}` } } }).sql).toContain(
      "count(",
    )
    expect(codeOf(() => compile({ where: { likes: { some: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { friends: { some: 5 } } }))).toBe("ValidationError")
  })

  test("is/isNot on an edge or an array link is rejected", () => {
    expect(codeOf(() => compile({ where: { likes: { is: { published: true } } } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => compile({ where: { friends: { is: { age: 1 } } } }))).toBe(
      "ValidationError",
    )
  })
})

describe("include — dispatch guards", () => {
  test("null include is a no-op; undefined entries are skipped", () => {
    expect(compile({ include: null }).sql).toBe("SELECT * FROM user")
    expect(compile({ include: { friends: true, mentor: undefined } }).sql).toContain(
      "FETCH friends",
    )
  })

  test("a non-object include is rejected", () => {
    expect(codeOf(() => compile({ include: 5 }))).toBe("ValidationError")
  })

  test("select/split/orderBy shapes and the include clause guards", () => {
    expect(compile({ select: null }).sql).toBe("SELECT * FROM user")
    expect(codeOf(() => compile({ select: 5 }))).toBe("ValidationError")
    expect(compile({ select: { age: true, name: undefined } }).sql).toContain("age")
    expect(compile({ split: surql`x` }).sql).toContain("SPLIT x")
    expect(compile({ orderBy: { age: "asc" } }).sql).toContain("ORDER BY")
    // include needs the schema index.
    const m = required(index.tables.get("users"))
    expect(
      codeOf(() => compileRead(m, { include: { mentor: true } }, createBinds(), "findMany")),
    ).toBe("ValidationError")
    // include cannot combine with groupBy.
    expect(codeOf(() => compile({ groupBy: ["active"], include: { mentor: true } }))).toBe(
      "ClauseNotSupported",
    )
    // split cannot combine with groupBy.
    expect(codeOf(() => compile({ groupBy: ["active"], split: "friends" }))).toBe(
      "ClauseNotSupported",
    )
  })
})

describe("where compiler — relation/operator guards", () => {
  test("mixing a relational operator with a plain one is rejected", () => {
    expect(codeOf(() => compile({ where: { mentor: { is: { name: "A" }, name: "B" } } }))).toBe(
      "ValidationError",
    )
  })

  test("a relational operator on a non-relation field is rejected", () => {
    expect(codeOf(() => compile({ where: { name: { some: { x: 1 } } } }))).toBe("ValidationError")
  })

  test("direction must be out/in/both, and is link-invalid", () => {
    expect(
      codeOf(() =>
        compile({
          where: { likes: { direction: "bad", some: { published: true } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() => compile({ where: { mentor: { direction: "in", is: { name: "A" } } } })),
    ).toBe("ValidationError")
  })

  test("is/some operands must be non-empty filter objects", () => {
    expect(codeOf(() => compile({ where: { mentor: { is: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { mentor: { is: {} } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { likes: { some: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { likes: { some: {} } } }))).toBe("ValidationError")
  })

  test("is supports lte", () => {
    expect(compile({ where: { mentor: { is: { age: { lte: 5 } } } } }).sql).toContain(
      "mentor.age <= $p",
    )
  })

  test("not guards and lowering", () => {
    expect(codeOf(() => compile({ where: { name: { not: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { name: { not: {} } } }))).toBe("ValidationError")
    expect(compile({ where: { name: { not: { equals: "A" } } } }).sql).toContain("NOT (")
  })
})

describe("where compiler — full-text / near", () => {
  test("matchesFullText string / single-index / multi-index forms", () => {
    expect(compile({ where: { name: { matchesFullText: "alice" } } }).sql).toBe(
      "SELECT * FROM user WHERE name @@ $p0",
    )
    expect(
      compile({
        where: { name: { matchesFullText: { index: 0, query: "a" } } },
      }).sql,
    ).toBe("SELECT * FROM user WHERE name @0@ $p0")
    expect(
      compile({
        where: {
          name: {
            matchesFullText: { indexes: [0, 1], operator: "OR", query: "a" },
          },
        },
      }).sql,
    ).toContain("(name @0@ $p0 OR name @1@ $p0)")
  })

  test("matchesFullText guards", () => {
    expect(codeOf(() => compile({ where: { name: { matchesFullText: 5 } } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => compile({ where: { name: { matchesFullText: { query: 5 } } } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() =>
        compile({
          where: {
            name: { matchesFullText: { index: 0, indexes: [0], query: "x" } },
          },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        compile({
          where: { name: { matchesFullText: { index: -1, query: "x" } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        compile({
          where: { name: { matchesFullText: { operator: "X", query: "x" } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("near KNN + geo forms, and its guards", () => {
    expect(
      compile({ where: { name: { near: { k: 5, vector: [1, MAGIC_2, MAGIC_3] } } } }).sql,
    ).toContain("<|5|>")
    expect(codeOf(() => compile({ where: { name: { near: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { name: { near: { k: 0, vector: [1] } } } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() =>
        compile({
          where: { name: { near: { distance: "x", point: [1, MAGIC_2] } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(() => compile({ where: { name: { near: { k: 1 } } } }))).toBe("ValidationError")
  })
})

describe("_count include — guards", () => {
  test("entry shape, unknown option, empty select, bad relation option", () => {
    expect(codeOf(() => compile({ include: { _count: 5 } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { _count: { select: 5 } } }))).toBe("ValidationError")
    expect(
      codeOf(() =>
        compile({
          include: { _count: { foo: true, select: { likes: true } } },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { _count: { select: {} } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { _count: { select: { likes: 5 } } } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() => compile({ include: { _count: { select: { likes: { foo: true } } } } })),
    ).toBe("ValidationError")
  })

  test("an invalid direction in an edge count is rejected", () => {
    expect(
      codeOf(() =>
        compile({
          include: { _count: { select: { likes: { direction: "bad" } } } },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("include projection — array/id/wildcard paths", () => {
  test("link select: false entries skipped, array select, bad array entry, id presence", () => {
    expect(
      compile({
        include: { mentor: { select: { age: false, name: true } } },
      }).sql,
    ).toContain("mentor_name")
    expect(compile({ include: { mentor: { select: ["name"] } } }).sql).toContain("mentor_name")
    expect(codeOf(() => compile({ include: { mentor: { select: [MAGIC_5] } } }))).toBe(
      "ValidationError",
    )
    expect(compile({ include: { mentor: { select: { id: true } } } }).sql).toContain("mentor_id")
  })

  test("an array link projection has no presence leaf", () => {
    expect(compile({ include: { friends: { select: { id: true } } } }).sql).toContain("friends_id")
  })

  test("wildcard target projections: star, empty, and a bad shape", () => {
    expect(
      compile({
        include: { rel: { target: { select: { "*": true } }, wildcard: true } },
      }).sql,
    ).toContain("out.*")
    expect(
      codeOf(() =>
        compile({
          include: { rel: { target: { select: {} }, wildcard: true } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        compile({
          include: { rel: { target: { select: 5 }, wildcard: true } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("include orderBy skips a bare undefined entry", () => {
    expect(compile({ include: { likes: { orderBy: [undefined] } } }).sql).not.toContain("ORDER BY")
  })

  test("link select: undefined entry, null select, and an id alias", () => {
    expect(
      compile({
        include: { mentor: { select: { age: undefined, name: true } } },
      }).sql,
    ).toContain("mentor_name")
    expect(codeOf(() => compile({ include: { mentor: { select: null } } }))).toBe("ValidationError")
    // aliasing `id` under another name suppresses the extra presence leaf.
    expect(compile({ include: { mentor: { select: { other: "id" } } } }).sql).toBe(
      "SELECT *, mentor.id AS mentor_other FROM user",
    )
  })

  test("a nested '*' in a wildcard target is rejected", () => {
    expect(
      codeOf(() =>
        compile({
          include: {
            rel: {
              target: { select: { nested: { "*": true } } },
              wildcard: true,
            },
          },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("wildcard edge/target shapes", () => {
    // unknown edge with an edge projection → SCHEMALESS edge meta.
    expect(
      compile({
        include: { rel: { edge: { select: { score: true } }, wildcard: true } },
      }).sql,
    ).toContain("rel")
    // an array target select accepts it.
    expect(
      compile({
        include: { rel: { target: { select: ["name"] }, wildcard: true } },
      }).sql,
    ).toContain("name")
    // wildcard on a DECLARED edge routs it as a wildcard (edgeRef stays undefined).
    expect(compile({ include: { likes: { wildcard: true } } }).sql).toContain("->?")
    // an incoming wildcard target projects `in.*`.
    expect(
      compile({
        include: {
          rel: { direction: "in", target: true, wildcard: true },
        },
      }).sql,
    ).toContain("in.*")
  })

  test("_count edges accept a direction", () => {
    expect(
      compile({
        include: { _count: { select: { likes: { direction: "out" } } } },
      }).sql,
    ).toContain("count(")
    expect(
      codeOf(() =>
        compile({
          include: { _count: { select: { likes: { direction: "bad" } } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("include orderBy: object form, non-string dir, star bypass", () => {
    expect(
      compile({ include: { likes: { edge: true, orderBy: { score: "asc" } } } }).sql,
    ).toContain("ORDER BY score ASC")
    expect(
      codeOf(() => compile({ include: { likes: { edge: true, orderBy: { score: 5 } } } })),
    ).toBe("ValidationError")
    expect(
      compile({
        include: {
          likes: {
            edge: true,
            orderBy: { score: "asc" },
            select: { "*": true },
          },
        },
      }).sql,
    ).toContain("ORDER BY score ASC")
  })

  test("compileIncludeOrderBy: a fragment with no spec, and no orderBy", () => {
    const ctx = {
      binds: createBinds(),
      operation: "findMany",
    } as unknown as CompileCtx
    expect(compileIncludeOrderBy([surql`score`], undefined, ctx, "likes", "edge")).toBe(
      "ORDER BY (score)",
    )
    expect(compileIncludeOrderBy(undefined, undefined, ctx, "likes", "edge")).toBeUndefined()
  })
})

describe("include projection — link select + orderBy guards", () => {
  test("link select: mixing '*' with fields, bad entries, empty, missing select", () => {
    expect(
      codeOf(() => compile({ include: { mentor: { select: { "*": true, name: true } } } })),
    ).toBe("ClauseNotSupported")
    expect(codeOf(() => compile({ include: { mentor: { select: { name: 5 } } } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => compile({ include: { mentor: { select: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { mentor: { select: [] } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { mentor: { select: {} } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { mentor: {} } }))).toBe("ValidationError")
  })

  test("duplicate flat leaves are rejected", () => {
    expect(
      codeOf(() =>
        compile({
          include: {
            mentor: { select: { home: { city: true }, "home.city": true } },
          },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("include orderBy: fragment, bad entry, bad direction, skipped undefined", () => {
    expect(compile({ include: { likes: { orderBy: [surql`rand()`] } } }).sql).toContain(
      "ORDER BY (rand())",
    )
    expect(codeOf(() => compile({ include: { likes: { orderBy: [MAGIC_5] } } }))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => compile({ include: { likes: { orderBy: [{ title: "up" }] } } }))).toBe(
      "ValidationError",
    )
    expect(compile({ include: { likes: { orderBy: [{ title: undefined }] } } }).sql).not.toContain(
      "ORDER BY",
    )
  })
})

describe("link include — guards", () => {
  test("a non-object, non-true link entry is rejected; unknown options too", () => {
    expect(codeOf(() => compile({ include: { mentor: 5 } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { mentor: { foo: true } } }))).toBe("ValidationError")
  })

  test("nested include: non-object, unknown link, projected link, skipped false", () => {
    expect(codeOf(() => compile({ include: { mentor: { include: 5 } } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { mentor: { include: { nope: true } } } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() =>
        compile({
          include: {
            mentor: { include: { mentor: { select: { id: true } } } },
          },
        }),
      ),
    ).toBe("ClauseNotSupported")
    // A false nested entry skipps it; the true one still fetches.
    expect(
      compile({
        include: { mentor: { include: { friends: false, mentor: true } } },
      }).sql,
    ).toContain("FETCH mentor.mentor")
  })

  test("a union link can't nest (needs a single target)", () => {
    const A = table("la", { name: s.string() })
    const B = table("lb", { name: s.string() })
    const C = table("lc", { link: s.recordId([A, B]).optional() })
    expect(
      codeOf(() =>
        localCompile2({ a: A, b: B, c: C }, "c", {
          include: { link: { include: { name: true } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("a link whose target is not a typed table can't nest", () => {
    const C = table("lc", { link: s.recordId("ghost").optional() })
    expect(
      codeOf(() =>
        localCompile2({ c: C }, "c", {
          include: { link: { include: { name: true } } },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("edge include — guards", () => {
  test("entry shape, unknown option, target+select, bad direction, bad target option", () => {
    expect(codeOf(() => compile({ include: { likes: 5 } }))).toBe("ValidationError")
    expect(codeOf(() => compile({ include: { likes: { foo: true } } }))).toBe("ValidationError")
    expect(
      codeOf(() => compile({ include: { likes: { select: { id: true }, target: true } } })),
    ).toBe("ClauseNotSupported")
    expect(codeOf(() => compile({ include: { likes: { direction: "bad" } } }))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() =>
        compile({
          include: { likes: { target: { foo: true, select: { id: true } } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("edge: false with a target projects only the target", () => {
    expect(compile({ include: { likes: { edge: false, target: true } } }).sql).toContain(
      "->likes->post",
    )
  })
})

describe("include — shape/schemaless/collision guards", () => {
  test("include must be an object; a false entry is skipped", () => {
    expect(codeOf(() => compile({ include: 5 }))).toBe("ValidationError")
    expect(compile({ include: { mentor: false } }).sql).toBe("SELECT * FROM user")
  })

  test("include on a schemaless model is rejected", () => {
    const idx = buildSchemaIndex({ audit: "audit_log" })
    const meta = idx.schemaless.get("audit")
    if (!meta) throw new Error("no schemaless meta")
    expect(
      codeOf(() =>
        compileRead(meta, { include: { x: true } }, createBinds(), "findMany", {
          index: idx,
        }),
      ),
    ).toBe("ValidationError")
  })

  test("an include alias colliding with a column is rejected", () => {
    const U = table("cu", { name: s.string() })
    const P = table("cp", {
      author: s.recordId(U).optional(),
      author_id: s.string(),
    })
    expect(
      codeOf(() =>
        localCompile2({ p: P, u: U }, "p", {
          include: { author: { select: { id: true } } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("an unknown include on a relation-less table lists (none)", () => {
    const B = table("cb", { name: s.string() })
    const err = ((): undefined | { message?: string | undefined } => {
      try {
        localCompile2({ b: B }, "b", { include: { nope: true } })
        return undefined
      } catch (error) {
        return error as { message?: string }
      }
    })()
    expect(err?.message).toContain("(none)")
  })
})

describe("include — clause-combination guards", () => {
  test("include cannot combine with split/groupBy/groupAll/value", () => {
    expect(codeOf(() => compile({ include: { mentor: true }, split: "tags" }))).toBe(
      "ClauseNotSupported",
    )
    expect(codeOf(() => compile({ groupAll: true, include: { mentor: true } }))).toBe(
      "ClauseNotSupported",
    )
    expect(codeOf(() => compile({ include: { mentor: true }, value: true }))).toBe(
      "ClauseNotSupported",
    )
  })

  test("an included key also explicitly selected is rejected", () => {
    expect(
      codeOf(() =>
        compile({
          include: { mentor: { select: { name: true } } },
          select: { mentor: true },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("relational where — write batches", () => {
  test("updateMany/deleteMany lower the same relational filters as reads", async () => {
    const update = fakeConn(() => [ok([])])
    await orm(update.conn, { schema }).users.updateMany({
      data: { name: "Renamed" },
      where: { likes: { some: { published: true } } },
    })
    expect(update.calls[0]?.sql).toContain(
      "UPDATE user MERGE $p1 WHERE count(->likes->(post WHERE published = $p0)) > 0",
    )

    const remove = fakeConn(() => [ok([])])
    await orm(remove.conn, { schema }).users.deleteMany({
      where: { mentor: { is: { name: "Alice" } } },
    })
    expect(remove.calls[0]?.sql).toBe("DELETE FROM user WHERE mentor.name = $p0 RETURN BEFORE;")
  })
})

describe("M3.5 — traversal/recursion via select fragments", () => {
  test("recursion and traversal sugar compile as projection expressions", () => {
    expect(
      compile({
        select: {
          name: true,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          descendants: surql`@.{1..10}->parent_of->person`.as<unknown[]>(),
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          ...KEEP_ORDER,
          likedCount: surql`count(->likes)`.as<number>(),
        },
      }).sql,
    ).toBe(
      "SELECT name, (@.{1..10}->parent_of->person) AS descendants, (count(->likes)) AS likedCount FROM user",
    )
  })
})

// --- hydration -----------------------------------------------------------------------------------

const fullUser = (
  id: string,
  over: Record<string, unknown> = {},
): { age: number; at: DateTime; id: RecordId<"user", string>; name: string } => ({
  age: 30,
  at: new DateTime(new Date("2025-01-02T03:04:05Z")),
  id: new RecordId("user", id),
  name: "Alice",
  ...over,
})

describe("include — hydration", () => {
  test("FETCH decodes the link with the TARGET codec (nested too)", async () => {
    const { calls, conn } = fakeConn(() => [
      ok([
        fullUser("b1", {
          friends: [fullUser("a1", { name: "Ann" })],
          mentor: fullUser("a1", { name: "Ann" }),
          name: "Bob",
        }),
      ]),
    ])
    const client = orm(conn, { schema })
    const rows = await client.users.findMany({
      include: {
        mentor: true,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        friends: true,
      },
    })
    expect(calls[0]?.sql).toBe("SELECT * FROM user FETCH mentor, friends;")
    expect(rows[0]?.mentor?.name).toBe("Ann")
    expect(rows[0]?.mentor?.at).toBeInstanceOf(Date)
    expect(rows[0]?.friends?.[0]?.name).toBe("Ann")
  })

  test("a fetched nested link hydrates recursively (missing -> null)", async () => {
    const { conn } = fakeConn(() => [
      ok([
        fullUser("c1", {
          mentor: fullUser("b1", {
            mentor: fullUser("a1", { name: "Ann" }),
            name: "Bob",
          }),
          name: "Carol",
        }),
      ]),
    ])
    const client = orm(conn, { schema })
    const rows = await client.users.findMany({
      include: { mentor: { include: { mentor: true } } },
    })
    expect(rows[0]?.mentor?.mentor?.name).toBe("Ann")

    const { conn: conn2 } = fakeConn(() => [ok([fullUser("c2", { name: "C" })])])
    const client2 = orm(conn2, { schema })
    const nulled = await client2.users.findMany({
      include: { mentor: { include: { mentor: true } } },
    })
    expect(nulled[0]?.mentor).toBeNull()
  })

  test("a projected link remounts from the flat columns", async () => {
    const { calls, conn } = fakeConn(() => [
      ok([
        {
          age: 20,
          at: new DateTime(new Date("2025-01-01T00:00:00Z")),
          id: new RecordId("user", "b1"),
          mentor_id: new RecordId("user", "a1"),
          mentor_name: "Ann",
          mentor_who: "Ann",
          name: "Bob",
        },
      ]),
    ])
    const client = orm(conn, { schema })
    const rows = await client.users.findMany({
      include: { mentor: { select: { id: true, name: true, who: "name" } } },
    })
    expect(calls[0]?.sql).toBe(
      "SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_name, mentor.name AS mentor_who FROM user;",
    )
    expect(rows[0]?.mentor).toEqual({
      id: new RecordId("user", "a1"),
      name: "Ann",
      who: "Ann",
    })
  })

  test("a projected link without `id` still detects absence and decodes to null", async () => {
    expect(compile({ include: { mentor: { select: { name: true } } } }).sql).toBe(
      "SELECT *, mentor.name AS mentor_name, mentor.id AS mentor_id FROM user",
    )
    const { conn } = fakeConn(() => [
      ok([fullUser("x1", { mentor_id: undefined, mentor_name: undefined })]),
    ])
    const rows = await orm(conn, { schema }).users.findMany({
      include: { mentor: { select: { name: true } } },
    })
    expect(rows[0]?.mentor).toBeNull()

    const present = fakeConn(() => [
      ok([
        fullUser("x1", {
          mentor_id: new RecordId("user", "a1"),
          mentor_name: "Ann",
        }),
      ]),
    ])
    const found = await orm(present.conn, { schema }).users.findMany({
      include: { mentor: { select: { name: true } } },
    })
    expect(found[0]?.mentor).toEqual({ name: "Ann" })
  })

  test("graph targets decode with the target codec; edge+target remounts `{ edge, target }`", async () => {
    const target = {
      author: new RecordId("user", "a1"),
      id: new RecordId("post", "p1"),
      published: true,
      title: "Hello",
    }
    const { conn } = fakeConn((sql) =>
      sql.includes("out.*")
        ? [
            ok([
              fullUser("a1", {
                likes: [{ out: target, score: 5 }],
                name: "Ann",
              }),
            ]),
          ]
        : [ok([fullUser("a1", { likes: [target], name: "Ann" })])],
    )
    const client = orm(conn, { schema })

    const rows = await client.users.findMany({ include: { likes: true } })
    expect(rows[0]?.likes?.[0]?.id).toEqual(new RecordId("post", "p1"))

    const both = await client.users.findMany({
      include: {
        likes: {
          edge: { select: { score: true } },
          target: { select: { id: true, title: true } },
        },
      },
    })
    expect(both[0]?.likes?.[0]).toEqual({
      edge: { score: 5 },
      target: { id: new RecordId("post", "p1"), title: "Hello" },
    })
  })

  test("_count remounts as one `_count` object", async () => {
    const { calls, conn } = fakeConn(() => [
      ok([fullUser("a1", { _count_friends: 2, _count_likes: 3 })]),
    ])
    const client = orm(conn, { schema })
    const rows = await client.users.findMany({
      include: {
        _count: {
          select: {
            likes: true,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            ...KEEP_ORDER,
            friends: true,
          },
        },
      },
    })
    expect(calls[0]?.sql).toBe(
      "SELECT *, count(->likes->post) AS _count_likes, count(friends) AS _count_friends FROM user;",
    )
    expect(rows[0]?._count).toEqual({ friends: 2, likes: 3 })
  })

  test("explain:true EXPLAINs the include statement (never executes)", async () => {
    const { calls, conn } = fakeConn((sql) => [ok(sql.startsWith("EXPLAIN") ? "plan" : [])])
    const client = orm(conn, { schema })
    const plan = await client.users.findMany({
      explain: true,
      include: { likes: { where: { published: true } } },
    })
    expect(plan.statements[0]?.surql).toContain("(SELECT * FROM ->likes->post")
    expect(plan.statements[0]?.surql).toContain("WHERE published = $p0")
    expect(calls[0]?.sql.startsWith("EXPLAIN SELECT")).toBe(true)
  })

  test("include rides findUnique (FROM ONLY + FETCH) and paginate", async () => {
    const { calls, conn } = fakeConn(() => [ok(fullUser("u1"))])
    const client = orm(conn, { schema })
    const one = await client.users.findUnique({
      include: { mentor: true },
      where: { id: "user:u1" },
    })
    expect(calls[0]?.sql).toBe("SELECT * FROM ONLY user:u1 FETCH mentor;")
    expect(one?.id).toEqual(new RecordId("user", "u1"))

    const { calls: calls2, conn: conn2 } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 1 }]) : ok([fullUser("u2")]),
      ),
    )
    const paged = orm(conn2, { schema }).users.paginate({
      include: { mentor: true },
      limit: 1,
    })
    await paged
    expect(calls2[0]?.sql).toContain("FETCH mentor;")
    expect(calls2[0]?.sql).toContain("\nSELECT count()")
  })
})
