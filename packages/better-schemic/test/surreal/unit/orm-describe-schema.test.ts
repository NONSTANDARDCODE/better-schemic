// `describeSchema()` — a JSON-safe, agent-readable derivation of the authored schema. No DDL, no DB.
import { describe, expect, test } from "bun:test"

import { defineFunction, relation, s, surql, table } from "../../../src/surreal"
import { describeSchema } from "../../../src/surreal/orm/describe"
import { schema } from "../../../src/surreal/orm/schema"

const User = table("user", {
  name: s.string().$assert(surql`string::len($value) > 0`),
  email: s.email().$unique(),
  createdAt: s
    .datetime()
    .$default(surql`time::now()`)
    .$readonly(),
  age: s.int(),
})
  .index("uq_user_email", ["email"], { unique: true })
  .comment("application users")

const Post = table("post", { title: s.string() })
const Likes = relation("likes", { score: s.int() }).from(User).to(Post)
const TotalAge = defineFunction("total_age")
  .returns(s.number())
  .body(surql`RETURN math::sum(age) FROM user GROUP ALL`)

describe("describeSchema()", () => {
  test("describes tables, columns, constraints, relations, functions and schemaless entries", () => {
    const def = schema({
      users: User,
      posts: Post,
      likes: Likes,
      totalAge: TotalAge,
      bare: "notes",
    })
    const described = describeSchema(def)
    expect(described.version).toBe(1)

    const users = described.tables.find((t) => t.key === "users")
    expect(users).toBeDefined()
    expect(users?.name).toBe("user")
    expect(users?.kind).toBe("table")
    expect(users?.schemafull).toBe(true)
    expect(users?.comment).toBe("application users")
    expect(users?.uniqueFields).toContain("email")
    expect(users?.columns.map((c) => c.name)).toEqual(["name", "email", "createdAt", "age", "id"])
    expect(users?.columns[0]?.asserts).toEqual(["string::len($value) > 0"])
    expect(users?.columns[1]?.index).toMatchObject({ unique: true })
    expect(users?.columns[2]?.default).toBe("time::now()")
    expect(users?.columns[2]?.readonly).toBe(true)

    const likes = described.tables.find((t) => t.key === "likes")
    expect(likes?.kind).toBe("relation")
    expect(likes?.endpoints).toEqual({
      from: ["user"],
      to: ["post"],
      enforced: false,
    })

    expect(described.schemaless).toEqual([{ key: "bare", name: "notes" }])
    expect(described.functions).toEqual([
      {
        key: "totalAge",
        name: "total_age",
        args: [],
        returns: { type: "number", family: "number" },
        permissions: {},
      },
    ])
  })

  test("accepts a plain key→def object and is fully JSON-safe", () => {
    const described = describeSchema({ users: User })
    expect(() => JSON.stringify(described)).not.toThrow()
    expect(JSON.parse(JSON.stringify(described))).toEqual(described)
  })
})
