// Shared fixtures for the `/orm` write unit suites: the sample schema, golden rows, the recording
// fake client factory and the golden-SQL/error helpers. Kept in ONE place so each write suite stays
// focused on behavior (and no suite sprawls past a readable size).

import { RecordId } from "surrealdb";
import type { Client } from "../../src/orm/client";
import { betterSchemic } from "../../src/orm/client";
import type { BetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { defineRelation, defineTable, s } from "../../src/pure";
import { fakeConn, ok } from "../orm-fixtures";

export const User = defineTable("user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string() }),
}).index("uniq_email", ["email"], { unique: true });
export const Post = defineTable("post", { title: s.string() });
export const Likes = defineRelation("likes", { score: s.int() })
  .from(User)
  .to(Post);
export const schema = defineSchema({
  users: User,
  posts: Post,
  likes: Likes,
});

export const LIKE_ROW = {
  id: new RecordId("likes", "1"),
  in: new RecordId("user", "1"),
  out: new RecordId("post", "1"),
  score: 5,
};

export const ROW = {
  id: new RecordId("user", "1"),
  name: "A",
  email: "a@x",
  age: 30,
  active: true,
  tags: [],
  address: { city: "SP" },
};

export const data = {
  name: "A",
  email: "a@x",
  age: 1,
  active: true,
  tags: [],
  address: { city: "SP" },
};

/** A client over a fake connection that answers every statement with `result` rows. */
export function makeClient(result: unknown = [ROW]): {
  client: Client<typeof schema>;
  calls: { sql: string; vars?: Record<string, unknown> }[];
} {
  const { conn, calls } = fakeConn((sql) =>
    sql.split("\n").map(() => ok(result)),
  );
  return {
    client: betterSchemic(conn, { schema }) as Client<typeof schema>,
    calls,
  };
}

/** Capture the LAST call's script + bindings (both always present on our statements). */
export function lastCall(
  calls: { sql: string; vars?: Record<string, unknown> }[],
) {
  const call = calls[calls.length - 1];
  return { sql: call?.sql ?? "", vars: call?.vars ?? {} };
}

/** Normalize the SDK tag's counted `bind__N` names for stable fragment goldens. */
export function stable(sql: string, vars: Record<string, unknown> | undefined) {
  const aliases = new Map<string, string>();
  const text = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    if (!name.startsWith("bind__")) return `$${name}`;
    let alias = aliases.get(name);
    if (!alias) {
      alias = `frag${aliases.size}`;
      aliases.set(name, alias);
    }
    return `$${alias}`;
  });
  const outVars: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(vars ?? {}))
    outVars[aliases.get(name) ?? name] = value;
  return { sql: text, vars: outVars };
}

export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}
