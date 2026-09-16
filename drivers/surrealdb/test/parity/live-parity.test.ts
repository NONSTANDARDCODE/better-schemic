/**
 * PARITY — live round-trip against SurrealDB.
 *
 * Proves the DDL @better-schemic/core emits is ACCEPTED by a real SurrealDB (probed on 3.1.3)
 * and round-trips through `INFO FOR TABLE ... STRUCTURE`. Skipped automatically when no
 * DB is reachable (CI / no DB), exactly like `test/live`.
 *
 * ISOLATION: everything runs inside a dedicated scratch namespace `__sz_parity` and a
 * fresh database that is DROPPED on teardown. It NEVER touches the `tracker`/`@better-schemic/core`
 * namespaces. We drive the SDK directly with explicit `.use({ namespace, database })`
 * rather than the shared `tryConnect` helper (whose default db must not be written to).
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { planKinds } from "@better-schemic/core";
import { Surreal, surql } from "surrealdb";
import { z } from "zod";
import { renderPerFile } from "../../src/cli/pull";
import { introspectStructured } from "../../src/cli/structure";
import { emitDefStatement, emitTable } from "../../src/ddl";
import { introspectAll } from "../../src/kinds/explode";
import { lowerAll, surrealKinds } from "../../src/kinds/registry";
import {
  defineAccess,
  defineFunction,
  defineRelation,
  defineTable,
  s,
} from "../../src/pure";

// The workspace gate runs every package's suite IN PARALLEL — parallel-suite CPU contention can slow a live
// connect/DDL past bun's 5s DEFAULT hook timeout, failing the `beforeEach`/`afterAll` below as an
// "(unnamed)" test. `beforeAll`s that say `120_000` explicitly are already covered; the default
// applies to every hook that doesn't. Isolated runs are unaffected.
setDefaultTimeout(120_000);

const NS = "__sz_parity";
const DB = "parity_live";

/** Connect to a scratch namespace/db, or null when no DB is reachable. */
async function connectScratch(): Promise<Surreal | null> {
  const db = new Surreal();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await db.connect(process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc");
        await db.signin({
          username: process.env.SURREAL_USER ?? "root",
          password: process.env.SURREAL_PASS ?? "root",
        });
        await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`);
        await db.use({ namespace: NS, database: DB });
        // Fresh, empty scratch db.
        await db.query(
          `REMOVE DATABASE IF EXISTS ${DB}; DEFINE DATABASE ${DB};`,
        );
        await db.use({ namespace: NS, database: DB });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 2000);
      }),
    ]);
    return db;
  } catch {
    await db.close().catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const db = await connectScratch();
const live = describe.skipIf(!db);
if (!db)
  console.warn(
    "[parity-live] SurrealDB unreachable — skipping live parity tests",
  );

/** Apply a multi-statement DDL string one statement at a time, returning rejections. */
async function applyEach(
  conn: Surreal,
  ddl: string,
): Promise<{ stmt: string; error: string }[]> {
  const stmts = ddl
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
  const rejected: { stmt: string; error: string }[] = [];
  for (const st of stmts) {
    try {
      await conn.query(st);
    } catch (e) {
      rejected.push({ stmt: st, error: (e as Error).message.split("\n")[0] });
    }
  }
  return rejected;
}

/** Assert exactly one statement was rejected, and for a TYPE/ASSERT reason (not a syntax slip). */
function expectRejected(rejected: { error: string }[]): string {
  expect(rejected).toHaveLength(1);
  expect(rejected[0].error).toMatch(/must conform|Expected `|coerce/i);
  return rejected[0].error;
}

// A broad mixed-type table exercising most of the type system + every field clause.
const Big = defineTable("pl_big", {
  id: z.string(),
  s: s.string(),
  n: s.number(),
  i: s.int(),
  fl: s.float(),
  dec: s.decimal(),
  bi: s.bigint(),
  b: s.boolean(),
  dt: s.datetime(),
  dur: s.duration(),
  byt: s.bytes(),
  uid: s.uuid(),
  fil: s.file(),
  geo: s.geometry(),
  geop: s.geometry("point"),
  geocol: s.geometry("collection"),
  em: s.email(),
  url: s.url(),
  ip: s.ipv4(),
  lit: s.literal("admin"),
  litn: s.literal(42),
  en: s.enum(["a", "b"]),
  un: s.union([s.string(), s.number()]),
  tup: s.tuple([s.string(), s.number()]),
  rec: s.recordId("pl_big"),
  arr: s.array(s.string()),
  arrr: s.array(s.recordId("pl_big")),
  setf: s.set(s.string()),
  recmap: s.record(z.string(), s.number()),
  opt: s.string().optional(),
  nul: s.string().nullable(),
  nush: s.string().nullish(),
  obj: s.object({ a: s.string(), b: s.number().optional() }),
  flex: s.object({ a: s.string() }).flexible(),
  arrobj: s.array(s.object({ x: s.string() })),
  def: s.string().$default("pending"),
  defa: s.datetime().$defaultAlways(surql`time::now()`),
  val: s.string().$value(surql`string::lowercase($value)`),
  asrt: s.number().$assert(surql`$value > 0`),
  ro: s.string().$readonly(),
  cmt: s.string().$comment("a field"),
  perm: s.string().$permissions({ select: true, update: false }),
  intl: s.string().$internal(),
  idx: s.string().$index(),
  uniq: s.string().$unique(),
});

live("DB accepts @better-schemic/core's generated DDL", () => {
  test("the whole mixed-type table applies with ZERO rejections", async () => {
    const rejected = await applyEach(
      db!,
      emitTable(Big, { exists: "overwrite" }),
    );
    // Any rejection is a real bug — surface the exact statement(s).
    expect(rejected).toEqual([]);
  });

  test("INFO FOR TABLE STRUCTURE round-trips the field types we care about", async () => {
    const [info] = await db!.query<
      [{ fields: { name: string; kind?: string }[] }]
    >("INFO FOR TABLE pl_big STRUCTURE;");
    const kind = (n: string) => info.fields.find((f) => f.name === n)?.kind;
    expect(kind("uid")).toBe("uuid");
    expect(kind("dt")).toBe("datetime");
    expect(kind("dur")).toBe("duration");
    expect(kind("dec")).toBe("decimal");
    expect(kind("byt")).toBe("bytes");
    expect(kind("fil")).toBe("file");
    expect(kind("rec")).toBe("record<pl_big>");
    expect(kind("geop")).toBe("geometry<point>");
    // The DB canonicalizes `option<string>` to its desugared `none | string` form (equivalent).
    expect(kind("opt")).toBe("none | string");
    expect(kind("lit")).toBe("'admin'");
  });

  test("relations (restricted + open) apply cleanly", async () => {
    const Rel = defineRelation("pl_rel", { weight: s.number() })
      .from(Big)
      .to(Big);
    const Open = defineRelation("pl_rel_open", {});
    expect(
      await applyEach(db!, emitTable(Rel, { exists: "overwrite" })),
    ).toEqual([]);
    expect(
      await applyEach(db!, emitTable(Open, { exists: "overwrite" })),
    ).toEqual([]);
  });

  test("table-level clauses (ANY / DROP / PERMISSIONS / composite index)", async () => {
    const any = defineTable("pl_any", { id: z.string() }).typeAny();
    const drop = defineTable("pl_drop", { id: z.string() }).schemaless().drop();
    const perms = defineTable("pl_perms", { id: z.string() }).permissions({
      select: true,
      create: surql`$auth.id != NONE`,
    });
    const comp = defineTable("pl_comp", {
      id: z.string(),
      a: s.string(),
      b: s.string(),
    }).index("ab_idx", ["a", "b"], { unique: true });
    for (const t of [any, drop, perms, comp]) {
      expect(
        await applyEach(db!, emitTable(t, { exists: "overwrite" })),
      ).toEqual([]);
    }
  });

  test("event / function / access (record, jwt, bearer) apply cleanly", async () => {
    const ev = defineTable("pl_ev", {
      id: z.string(),
      email: s.email(),
    }).event("reverify", {
      when: surql`$before.email != $after.email`,
      // biome-ignore lint/suspicious/noThenProperty: event DSL "then" clause, not a thenable
      then: surql`UPDATE $after.id SET email = $after.email`,
    });
    expect(
      await applyEach(db!, emitTable(ev, { exists: "overwrite" })),
    ).toEqual([]);

    const fn = defineFunction("pl_greet", { name: s.string() })
      .returns(s.string())
      .body(surql`RETURN "Hi " + $name`);
    expect(
      await applyEach(db!, emitDefStatement(fn, { exists: "overwrite" }).ddl),
    ).toEqual([]);

    const accesses = [
      defineAccess("pl_app")
        .onDatabase()
        .record()
        .signin(surql`SELECT * FROM pl_big WHERE email = $email`)
        .duration({ token: "1h", session: "12h" }),
      defineAccess("pl_jwt")
        .onDatabase()
        .jwt({ alg: "HS512", key: "supersecretvalue" }),
      defineAccess("pl_svc")
        .onDatabase()
        .bearer({ for: "record" })
        .duration({ grant: "30d" }),
    ];
    for (const a of accesses) {
      expect(
        await applyEach(db!, emitDefStatement(a, { exists: "overwrite" }).ddl),
      ).toEqual([]);
    }
  });

  test("access with default durations round-trips (no phantom OVERWRITE)", async () => {
    // Regression: SurrealDB materializes FOR TOKEN 1h (every access) + FOR GRANT 4w2d (BEARER) as
    // defaults; an access that omits them must not diff against the introspected materialized form.
    const defs = [
      defineAccess("pl_rt_rec").onDatabase().record(), // no duration
      defineAccess("pl_rt_rec2")
        .onDatabase()
        .record()
        .duration({ session: "12h" }), // token omitted
      defineAccess("pl_rt_bear").onDatabase().bearer({ for: "user" }), // grant default
    ];
    for (const a of defs)
      await applyEach(db!, emitDefStatement(a, { exists: "overwrite" }).ddl);
    // Restrict to our names — the shared scratch DB also holds other objects.
    const plan = planKinds(
      surrealKinds,
      await introspectAll(db!),
      lowerAll([], defs),
    );
    expect(plan.up.filter((d) => /pl_rt_/.test(d))).toEqual([]);
  });
});

live("batch 1 + 2 features round-trip on the DB", () => {
  test("s.set() -> set<T>; .length/.size -> exact sizes; { max } -> bounded base type", async () => {
    const T = defineTable("pl_b2_coll", {
      id: z.string(),
      tags: s.set(s.string()),
      sized: s.array(s.string()).length(3),
      sizedset: s.set(s.int()).size(5),
      bounded: s.array(s.string(), { max: 3 }),
      boundedset: s.set(s.int(), { max: 5 }),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
    const [info] = await db!.query<
      [{ fields: { name: string; kind?: string }[] }]
    >("INFO FOR TABLE pl_b2_coll STRUCTURE;");
    const kind = (n: string) => info.fields.find((f) => f.name === n)?.kind;
    expect(kind("tags")).toBe("set<string>");
    // `.length(3)`/`.size(5)` are the exact `array<T, N>`/`set<T, N>` forms; `{ max }` is a bound,
    // so the type stays bare.
    expect(kind("sized")).toBe("array<string, 3>");
    expect(kind("sizedset")).toBe("set<int, 5>");
    expect(kind("bounded")).toBe("array<string>");
    expect(kind("boundedset")).toBe("set<int>");
  });

  test("exact sizes are ENFORCED on write; { max } bounds only the top end", async () => {
    const T = defineTable("pl_b3_len", {
      id: z.string(),
      exact: s.array(s.string()).length(3),
      exactset: s.set(s.int()).size(2),
      bounded: s.array(s.string(), { max: 3 }),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
    const create = (
      id: string,
      exact: string,
      exactset: string,
      bounded: string,
    ) =>
      `CREATE pl_b3_len:${id} SET exact = ${exact}, exactset = ${exactset}, bounded = ${bounded};`;
    // exact == N and bounded <= N pass.
    expect(
      await applyEach(
        db!,
        create("ok", "['a','b','c']", "<set>[1,2]", "['a']"),
      ),
    ).toEqual([]);
    // exact N rejects N-1 and N+1...
    expectRejected(
      await applyEach(db!, create("short", "['a','b']", "<set>[1,2]", "[]")),
    );
    expectRejected(
      await applyEach(
        db!,
        create("long", "['a','b','c','d']", "<set>[1,2]", "[]"),
      ),
    );
    // ...and the exact set rejects a wrong size too (bounded has no lower bound).
    expectRejected(
      await applyEach(
        db!,
        create("setshort", "['a','b','c']", "<set>[1]", "[]"),
      ),
    );
    expectRejected(
      await applyEach(
        db!,
        create("setlong", "['a','b','c']", "<set>[1,2,3]", "[]"),
      ),
    );
  });

  test("nullable fields admit NULL; derived asserts are null-guarded", async () => {
    const T = defineTable("pl_b3_null", {
      id: z.string(),
      n: s.number().nullable().$gt(0),
      email: s.email().nullable(),
      nush: s.string().nullish().$min(2),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
    // NULL is a value the type admits -> every assert lets it through.
    expect(
      await applyEach(
        db!,
        "CREATE pl_b3_null:nulls SET n = NULL, email = NULL, nush = NULL;",
      ),
    ).toEqual([]);
    // NONE is absent -> allowed for the nullish field, rejected where the type is `T | null`.
    expect(
      await applyEach(
        db!,
        "CREATE pl_b3_null:none SET n = NULL, email = NULL;",
      ),
    ).toEqual([]);
    // Valid non-null values pass; invalid ones are still rejected by the guarded assert.
    expect(
      await applyEach(
        db!,
        "CREATE pl_b3_null:ok SET n = 5, email = 'a@b.com', nush = 'xy';",
      ),
    ).toEqual([]);
    expectRejected(
      await applyEach(
        db!,
        "CREATE pl_b3_null:badn SET n = -1, email = NULL, nush = NULL;",
      ),
    );
    expectRejected(
      await applyEach(
        db!,
        "CREATE pl_b3_null:bademail SET n = NULL, email = 'nope', nush = NULL;",
      ),
    );
    expectRejected(
      await applyEach(
        db!,
        "CREATE pl_b3_null:badshort SET n = NULL, email = NULL, nush = 'x';",
      ),
    );
  });

  test("pull reverses null guards + exact sizes to bare source (no re-emit churn)", async () => {
    const T = defineTable("pl_b3_pull", {
      id: z.string(),
      nulg: s.number().nullable().$gt(0),
      mail: s.email().nullable(),
      exarr: s.array(s.string()).$length(2),
      exset: s.set(s.int()).$size(4),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
    // The live INFO shape has `x.*` element children — the renderer must still carry the size, and
    // must undo the null guard the emitter baked (the `| null` type re-adds it on the next emit).
    const info = await introspectStructured(db!, new Set());
    const out = [...renderPerFile(info, (_k, n) => n).values()].join("\n");
    expect(out).toContain(
      "nulg: s.number().nullable().$assert(surql`$value > 0`)",
    );
    expect(out).toContain("mail: s.email().nullable()");
    expect(out).toContain(
      "exarr: s.string().array().length(2).$assert(surql`array::len($value) == 2`)",
    );
    expect(out).toContain(
      "exset: s.set(s.int()).size(4).$assert(surql`array::len($value) == 4`)",
    );
    expect(out).not.toContain("$value = NULL OR $value = NULL");
  });

  test("record REFERENCE [ON DELETE …] via .$reference()", async () => {
    const T = defineTable("pl_b2_ref", {
      id: z.string(),
      author: s.recordId("pl_b2_ref").$reference({ onDelete: "cascade" }),
      friends: s
        .array(s.recordId("pl_b2_ref"))
        .$reference({ onDelete: "unset" }),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
  });

  test("TYPE RELATION … ENFORCED via .enforced()", async () => {
    const A = defineTable("pl_b2_a", { id: z.string() });
    const Rel = defineRelation("pl_b2_rel", {}).from(A).to(A).enforced();
    expect(await applyEach(db!, emitTable(A, { exists: "overwrite" }))).toEqual(
      [],
    );
    expect(
      await applyEach(db!, emitTable(Rel, { exists: "overwrite" })),
    ).toEqual([]);
  });

  test("all 10 batch-2 string::is_* validators are accepted (names are real)", async () => {
    const T = defineTable("pl_b2_val", {
      id: z.string(),
      a: s.alpha(),
      an: s.alphanum(),
      asc: s.ascii(),
      num: s.numeric(),
      sv: s.semver(),
      hx: s.hexadecimal(),
      lat: s.latitude(),
      lon: s.longitude(),
      ip: s.ip(),
      dom: s.domain(),
    });
    expect(await applyEach(db!, emitTable(T, { exists: "overwrite" }))).toEqual(
      [],
    );
  });
});

// --- These document live-confirmed GAPS: features the DB ACCEPTS but @better-schemic/core
//     cannot express (or expresses lossily). Marked todo so the suite stays green. ---
live("known gaps (DB supports these; @better-schemic/core does not)", () => {
  test("object-literal union is accepted by the DB (@better-schemic/core emits plain object)", async () => {
    const rejected = await applyEach(
      db!,
      `DEFINE TABLE pl_litobj SCHEMAFULL; DEFINE FIELD r ON TABLE pl_litobj TYPE { kind: "a", x: string } | { kind: "b", y: number };`,
    );
    expect(rejected).toEqual([]);
  });

  test.todo("GAP: FULLTEXT / vector (HNSW) indexes + DEFINE ANALYZER — see PARITY.md", () => {});
});

afterAll(async () => {
  if (db) {
    // Drop everything we created; leave the empty scratch namespace (cheap, isolated).
    await db.query(`REMOVE DATABASE IF EXISTS ${DB};`).catch(() => {});
    await db.close();
  }
});
