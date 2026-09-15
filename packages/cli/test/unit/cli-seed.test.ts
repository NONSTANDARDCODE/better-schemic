import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "@better-schemic/core";
import { seed } from "../../src/cli/migrate";

/** A fake driver connection that records which seeds ran + any SQL they applied. */
function recorder() {
  const ran: string[] = [];
  const sql: string[] = [];
  return {
    db: { ran: (n: string) => ran.push(n), query: (s: string) => sql.push(s) },
    ran,
    sql,
  };
}

describe("seed (folder of named scripts)", () => {
  let root: string;
  const cfg = () => ({ root }) as unknown as ResolvedConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "better-schemic-seed-"));
    const dir = join(root, "database/seed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "schema.surql"), "DEFINE TABLE user;\n");
    writeFileSync(
      join(dir, "seeds.d.ts"),
      'declare module "*.surql" { const s: string; export default s; }\n',
    );
    writeFileSync(
      join(dir, "01-users.ts"),
      'import schema from "./schema.surql" with { type: "text" };\n' +
        "export default async (db: any) => { db.ran('users'); db.query(schema); };\n",
    );
    writeFileSync(
      join(dir, "02-data.ts"),
      "export default async (db: any) => { db.ran('data'); };\n",
    );
    writeFileSync(join(dir, "_helper.ts"), "export const x = 1;\n");
    writeFileSync(
      join(dir, "index.ts"),
      "export default async (db: any) => { db.ran('index'); };\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("runs only index.ts when no name/--all is given", async () => {
    const r = recorder();
    await seed(r.db, cfg(), {});
    expect(r.ran).toEqual(["index"]);
  });

  it("runs every script in filename order with --all (index excluded)", async () => {
    const r = recorder();
    await seed(r.db, cfg(), { all: true });
    expect(r.ran).toEqual(["users", "data"]);
  });

  it("addresses a seed by name with the numeric prefix stripped", async () => {
    const r = recorder();
    await seed(r.db, cfg(), { name: "data" });
    expect(r.ran).toEqual(["data"]);
  });

  it("loads a .surql supporting file via `with { type: 'text' }`", async () => {
    const r = recorder();
    await seed(r.db, cfg(), { name: "users" });
    expect(r.sql).toEqual(["DEFINE TABLE user;\n"]);
  });

  it("errors with the available names on an unknown seed", async () => {
    await expect(seed(recorder().db, cfg(), { name: "nope" })).rejects.toThrow(
      /No seed named "nope".*users, data/,
    );
  });

  it("ignores `_`-prefixed files and `.d.ts` declarations", async () => {
    const r = recorder();
    await seed(r.db, cfg(), { all: true });
    expect(r.ran).not.toContain("helper");
    expect(r.ran).not.toContain("seeds");
  });
});
