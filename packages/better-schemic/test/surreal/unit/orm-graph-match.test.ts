import { describe, expect, test } from "bun:test";
import { table, s } from "../../../src/surreal/pure";
import { orm } from "../../../src/surreal/orm/client";
import { buildSchemaIndex } from "../../../src/surreal/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";

const User = table("user", { name: s.string(), email: s.string() });
const Agent = table("agent", { name: s.string(), model: s.string() });
const Knows = (require("../../../src/surreal/pure").relation as any)("knows", {}).from(User).to(User); // simplified
const schema = { users: User, agents: Agent, knows: Knows };

describe("graph match", () => {
  test("where match", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])]);
    const client: any = orm(conn, { schema } as any);
    await client.users.from("user:A").graph((g: any) =>
      g.out(Knows).where((r: any) => r.match(User, (u: any) => u.name.eq("x")))
    );
    console.log("MATCHW:", calls[0]?.sql);
    expect(calls[0]?.sql).toContain("record::tb(id) = 'user'");
  });

  test("select match", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])]);
    const client: any = orm(conn, { schema } as any);
    await client.users.from("user:A").graph((g: any) =>
      g.out(Knows).select((r: any) => ({ email: r.match(User, (u: any) => u.email) }))
    );
    console.log("MATCHS:", calls[0]?.sql);
    expect(calls[0]?.sql).toContain("IF record::tb(id) = 'user' THEN email ELSE NONE END");
  });
});