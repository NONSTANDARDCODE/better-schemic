// The per-table `idStrategy`: authoring (chainable/immutable/guarded), SchemaIndex resolution
// (default ulid, explicit id-field inference, conflict fail-fast), `$model` introspection, the
// compiler lowering of EVERY create path (create/createMany/skipDuplicates, insert/insertMany,
// upsert/upsertMany, create.relate) for ulid/uuid/rand, and the DDL/Struct-IR invariance that
// keeps migrations diff-free. Offline (no live server needed).
import { describe, expect, test } from "bun:test";
import { BoundQuery, RecordId } from "surrealdb";
import { z } from "zod";
import { schemaStruct } from "../../src/cli/lower";
import { emitTable } from "../../src/ddl";
import { defineSingleton, defineTable, s, surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { createBinds } from "../../src/orm/compiler/shared";
import { compileUpsert, compileUpsertMany } from "../../src/orm/compiler/mutate";
import {
  compileCreate,
  compileCreateMany,
  compileInsert,
  compileInsertMany,
} from "../../src/orm/compiler/write";
import {
  generatedTarget,
  withGeneratedId,
} from "../../src/orm/compiler/write-shared";
import { defineSchema } from "../../src/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";
import { codeOf } from "./orm-writes-fixtures";

// --- fixtures ------------------------------------------------------------------------------------

const UlidT = defineTable("ulid_t", { name: s.string(), email: s.string() }).index(
  "uq_ulid_email",
  ["email"],
  { unique: true },
);
const UuidT = defineTable("uuid_t", { name: s.string(), email: s.string() })
  .idStrategy("uuid")
  .index("uq_uuid_email", ["email"], { unique: true });
const RandT = defineTable("rand_t", { name: s.string(), email: s.string() })
  .idStrategy("rand")
  .index("uq_rand_email", ["email"], { unique: true });
const UuidIdT = defineTable("uuid_id_t", { id: s.uuid(), name: s.string() });
const UuidV7IdT = defineTable("uuid_v7_id_t", { id: s.uuidv7(), name: s.string() });
const UlidIdT = defineTable("ulid_id_t", { id: s.ulid(), name: s.string() });
const UuidV4IdT = defineTable("uuid_v4_id_t", { id: s.uuidv4(), name: s.string() })
  .index("uq_v4_name", ["name"], { unique: true });
/** A raw Zod uuid (no `s.*` wrapper, no pinned version) — the format-only inference path. */
const RawUuidIdT = defineTable("raw_uuid_id_t", { id: z.uuid(), name: s.string() });
const SingletonT = defineSingleton("singleton_t", { value: s.string() });

const schema = defineSchema({
  ulidT: UlidT,
  uuidT: UuidT,
  randT: RandT,
  uuidIdT: UuidIdT,
  uuidV7IdT: UuidV7IdT,
  ulidIdT: UlidIdT,
  uuidV4IdT: UuidV4IdT,
  rawUuidIdT: RawUuidIdT,
  singletonT: SingletonT,
  audit: "audit_log",
});

const { conn, calls } = fakeConn(() => [ok([])]);
const client = betterSchemic(conn, { schema });
const meta = (key: string) => client.$index.tables.get(key)!;
const b = () => createBinds();
/** Statements as the executor runs them (a trailing `;` per statement, never doubled). */
const sql = (plan: { statements: readonly string[] }): string =>
  plan.statements
    .map((statement) => (statement.endsWith(";") ? statement : `${statement};`))
    .join("\n");

// --- authoring -----------------------------------------------------------------------------------

describe("idStrategy — authoring", () => {
  test("chainable, immutable, carried on TableConfig", () => {
    const base = defineTable("t", { name: s.string() });
    const uuid = base.idStrategy("uuid");
    expect(base.config.idStrategy).toBeUndefined();
    expect(uuid.config.idStrategy).toBe("uuid");
    expect(uuid).not.toBe(base);
    expect(defineTable("t", {}).idStrategy("rand").config.idStrategy).toBe("rand");
    expect(defineTable("t", {}).idStrategy("ulid").config.idStrategy).toBe("ulid");
  });

  test("invalid values fail loudly (JS callers bypass the union)", () => {
    expect(() => defineTable("t", {}).idStrategy("nanoid" as never)).toThrow(
      /"ulid" \| "uuid" \| "rand"/,
    );
  });

  test("singleton tables reject idStrategy (their id is fixed)", () => {
    expect(() => defineSingleton("config", {}).idStrategy("uuid")).toThrow(
      /singleton/,
    );
  });
});

// --- schema index --------------------------------------------------------------------------------

describe("idStrategy — schema index", () => {
  test("declared wins; otherwise ulid default", () => {
    expect(meta("ulidT").idStrategy).toBe("ulid");
    expect(meta("uuidT").idStrategy).toBe("uuid");
    expect(meta("randT").idStrategy).toBe("rand");
    expect(meta("singletonT").idStrategy).toBe("ulid");
  });

  test("an explicit id field infers its strategy (uuid/uuidv7/ulid)", () => {
    expect(meta("uuidIdT").idStrategy).toBe("uuid");
    expect(meta("uuidV7IdT").idStrategy).toBe("uuid");
    expect(meta("rawUuidIdT").idStrategy).toBe("uuid");
    expect(meta("ulidIdT").idStrategy).toBe("ulid");
    // uuid v4 can't be produced by any strategy: explicit-only (`"none"`), no generation.
    expect(meta("uuidV4IdT").idStrategy).toBe("none");
  });

  test("a conflicting declared strategy is a fail-fast SchemaInvalid", () => {
    expect(
      codeOf(() =>
        defineSchema({ t: defineTable("t", { id: s.uuid() }).idStrategy("ulid") }),
      ),
    ).toBe("SchemaInvalid");
    expect(
      codeOf(() =>
        defineSchema({ t: defineTable("t", { id: s.ulid() }).idStrategy("rand") }),
      ),
    ).toBe("SchemaInvalid");
    expect(
      codeOf(() =>
        defineSchema({
          t: defineTable("t", { id: s.uuidv4() }).idStrategy("uuid"),
        }),
      ),
    ).toBe("SchemaInvalid");
    // A matching declaration is fine.
    expect(
      codeOf(() =>
        defineSchema({ t: defineTable("t", { id: s.uuid() }).idStrategy("uuid") }),
      ),
    ).toBeUndefined();
  });

  test("$model exposes the resolved strategy (schemaless = ulid)", () => {
    expect(client.uuidT.$model.idStrategy).toBe("uuid");
    expect(client.randT.$model.idStrategy).toBe("rand");
    expect(client.uuidV4IdT.$model.idStrategy).toBe("none");
    expect(client.audit.$model.idStrategy).toBe("ulid");
  });
});

// --- compiler: ulid (the default) ----------------------------------------------------------------

describe("compiler — ulid default", () => {
  test("create targets type::record; explicit id and singleton win", () => {
    expect(sql(compileCreate(meta("ulidT"), { data: { name: "A" } }, b()))).toBe(
      'CREATE type::record(s"ulid_t", rand::ulid()) CONTENT $p0;',
    );
    expect(
      sql(
        compileCreate(
          meta("ulidT"),
          { data: { id: "ulid_t:1", name: "A" } },
          b(),
        ),
      ),
    ).toBe("CREATE ulid_t:1 CONTENT $p0;");
    expect(
      sql(compileCreate(meta("singletonT"), { data: { value: "x" } }, b())),
    ).toBe("CREATE singleton_t:default CONTENT $p0;");
    expect(
      sql(
        compileCreate(
          meta("singletonT"),
          { data: { value: "x" }, only: true },
          b(),
        ),
      ),
    ).toBe("CREATE ONLY singleton_t:default CONTENT $p0;");
  });

  test("createMany generates one id per row; explicit ids stay targeted", () => {
    expect(
      sql(
        compileCreateMany(
          meta("ulidT"),
          { data: [{ name: "A" }, { name: "B" }] },
          b(),
        ),
      ),
    ).toBe(
      'CREATE type::record(s"ulid_t", rand::ulid()) CONTENT $p0;\n' +
        'CREATE type::record(s"ulid_t", rand::ulid()) CONTENT $p1;',
    );
    expect(
      sql(
        compileCreateMany(
          meta("ulidT"),
          { data: [{ id: "ulid_t:1", name: "A" }] },
          b(),
        ),
      ),
    ).toBe("CREATE ulid_t:1 CONTENT $p0;");
    // A singleton's fixed id survives every chained create path.
    expect(
      sql(
        compileCreateMany(
          meta("singletonT"),
          { data: [{ value: "x" }, { value: "y" }] },
          b(),
        ),
      ),
    ).toBe(
      "CREATE singleton_t:default CONTENT $p0;\nCREATE singleton_t:default CONTENT $p1;",
    );
  });

  test("insert/insertMany inject the id expression; explicit ids keep the whole bind", () => {
    expect(sql(compileInsert(meta("ulidT"), { data: { name: "A" } }, b()))).toBe(
      "INSERT INTO ulid_t { name: $b0, id: rand::ulid() };",
    );
    expect(
      sql(
        compileInsert(
          meta("ulidT"),
          { data: { id: "ulid_t:1", name: "A" } },
          b(),
        ),
      ),
    ).toBe("INSERT INTO ulid_t $p0;");
    expect(
      sql(
        compileInsertMany(
          meta("ulidT"),
          { data: [{ name: "A" }, { name: "B" }] },
          b(),
        ),
      ),
    ).toBe(
      "INSERT INTO ulid_t [{ name: $b0, id: rand::ulid() }, { name: $b1, id: rand::ulid() }];",
    );
    // A mixed batch renders the WHOLE array as a literal: the explicit-id row keeps its own bind.
    expect(
      sql(
        compileInsertMany(
          meta("ulidT"),
          {
            data: [{ name: "A" }, { id: "ulid_t:2", name: "B" }],
          },
          b(),
        ),
      ),
    ).toBe(
      "INSERT INTO ulid_t [{ name: $b0, id: rand::ulid() }, { id: $b1, name: $b2 }];",
    );
  });

  test("skipDuplicates generates per row (id-less items no longer fail eagerly)", () => {
    expect(
      sql(
        compileCreateMany(
          meta("ulidT"),
          { data: [{ name: "A" }], skipDuplicates: true },
          b(),
        ),
      ),
    ).toBe("INSERT IGNORE INTO ulid_t { name: $b0, id: rand::ulid() };");
    expect(
      sql(
        compileCreateMany(
          meta("ulidT"),
          { data: [{ id: new RecordId("ulid_t", "1"), name: "A" }], skipDuplicates: true },
          b(),
        ),
      ),
    ).toBe("INSERT IGNORE INTO ulid_t $p0;");
    // Non-objects are still a teaching ValidationError (via the codec).
    expect(
      codeOf(() =>
        compileCreateMany(meta("ulidT"), { data: [5], skipDuplicates: true }, b()),
      ),
    ).toBe("ValidationError");
  });

  test("insert onDuplicate update never touches the injected id", () => {
    const plan = sql(
      compileInsert(meta("ulidT"), { data: { name: "A" }, onDuplicate: "update" }, b()),
    );
    expect(plan).toContain("id: rand::ulid()");
    expect(plan).toContain("ON DUPLICATE KEY UPDATE name = $input.name;");
    expect(plan).not.toContain("id = $input.id");
  });

  test("schemaless entries ride the uniform ulid default", () => {
    const audit = client.$index.schemaless.get("audit")!;
    expect(sql(compileCreate(audit, { data: { x: 1 } }, b()))).toBe(
      'CREATE type::record(s"audit_log", rand::ulid()) CONTENT $p0;',
    );
    expect(sql(compileInsert(audit, { data: { x: 1 } }, b()))).toBe(
      "INSERT INTO audit_log { x: $b0, id: rand::ulid() };",
    );
  });

  test("upsert by unique resolves-or-creates in ONE statement; explicit id wins", () => {
    expect(
      sql(
        compileUpsert(
          meta("ulidT"),
          {
            where: { email: "a@x" },
            data: { email: "a@x", name: "A" },
            onMissing: "create",
          },
          b(),
        ),
      ),
    ).toBe(
      'UPSERT ((SELECT VALUE id FROM ulid_t WHERE email = $p0 LIMIT 1)[0] ?? type::record(s"ulid_t", rand::ulid())) MERGE $p1;',
    );
    // An explicit payload id keeps the legacy plain-table form (it carries the id).
    expect(
      sql(
        compileUpsert(
          meta("ulidT"),
          {
            where: { email: "a@x" },
            data: { id: new RecordId("ulid_t", "9"), email: "a@x" },
            onMissing: "create",
          },
          b(),
        ),
      ),
    ).toBe("UPSERT ulid_t MERGE $p0 WHERE email = $p1;");
    // By-id targets never generate.
    expect(
      sql(
        compileUpsert(
          meta("ulidT"),
          { where: { id: "ulid_t:1" }, data: { name: "A" }, onMissing: "create" },
          b(),
        ),
      ),
    ).toBe("UPSERT ulid_t:1 MERGE $p0;");
    // STRICT (the default) never needs a generated target — a plain UPDATE.
    expect(
      sql(
        compileUpsert(
          meta("ulidT"),
          { where: { email: "a@x" }, data: { name: "A" } },
          b(),
        ),
      ),
    ).toBe("UPDATE ulid_t MERGE $p0 WHERE email = $p1;");
    // `only` rides the generated target (live-probed: an expression target accepts ONLY).
    expect(
      sql(
        compileUpsert(
          meta("ulidT"),
          {
            where: { email: "a@x" },
            data: { email: "a@x" },
            only: true,
            onMissing: "create",
          },
          b(),
        ),
      ),
    ).toBe(
      'UPSERT ONLY ((SELECT VALUE id FROM ulid_t WHERE email = $p0 LIMIT 1)[0] ?? type::record(s"ulid_t", rand::ulid())) MERGE $p1;',
    );
  });

  test("upsert create/update branches generate on the CREATE side only", () => {
    const plan = sql(
      compileUpsert(
        meta("ulidT"),
        {
          where: { email: "a@x" },
          create: { email: "a@x", name: "A" },
          update: { name: "B" },
          onMissing: "create",
        },
        b(),
      ),
    );
    expect(plan).toContain(
      'LET $__existing = (SELECT VALUE id FROM ulid_t WHERE email = $p0 LIMIT 1);',
    );
    expect(plan).toContain(
      'IF array::len($__existing) = 0 THEN CREATE type::record(s"ulid_t", rand::ulid()) CONTENT $p1 ELSE UPDATE $__existing[0] MERGE $p2 END;',
    );
  });

  test("upsertMany conflict resolves-or-creates per item", () => {
    expect(
      sql(
        compileUpsertMany(
          meta("ulidT"),
          { data: [{ email: "a@x", name: "A" }], conflict: "email" },
          b(),
        ),
      ),
    ).toBe(
      'UPSERT ((SELECT VALUE id FROM ulid_t WHERE email = $p0.email LIMIT 1)[0] ?? type::record(s"ulid_t", rand::ulid())) MERGE $p0;',
    );
    const mapped = sql(
      compileUpsertMany(
        meta("ulidT"),
        {
          data: [{ email: "a@x" }],
          conflict: "email",
          update: { name: surql`name` },
        },
        b(),
      ),
    );
    expect(mapped).toContain(
      'THEN CREATE type::record(s"ulid_t", rand::ulid()) CONTENT $p0',
    );
  });
});

// --- compiler: uuid / rand -----------------------------------------------------------------------

describe("compiler — uuid and rand", () => {
  test("uuid lowers to rand::uuid() on every generated target", () => {
    expect(sql(compileCreate(meta("uuidT"), { data: { name: "A" } }, b()))).toBe(
      'CREATE type::record(s"uuid_t", rand::uuid()) CONTENT $p0;',
    );
    expect(sql(compileInsert(meta("uuidT"), { data: { name: "A" } }, b()))).toBe(
      "INSERT INTO uuid_t { name: $b0, id: rand::uuid() };",
    );
    expect(
      sql(
        compileUpsert(
          meta("uuidT"),
          { where: { email: "a@x" }, data: { email: "a@x" }, onMissing: "create" },
          b(),
        ),
      ),
    ).toBe(
      'UPSERT ((SELECT VALUE id FROM uuid_t WHERE email = $p0 LIMIT 1)[0] ?? type::record(s"uuid_t", rand::uuid())) MERGE $p1;',
    );
  });

  test("rand keeps the exact legacy server-default lowering", () => {
    expect(sql(compileCreate(meta("randT"), { data: { name: "A" } }, b()))).toBe(
      "CREATE rand_t CONTENT $p0;",
    );
    expect(sql(compileInsert(meta("randT"), { data: { name: "A" } }, b()))).toBe(
      "INSERT INTO rand_t $p0;",
    );
    expect(
      sql(compileInsertMany(meta("randT"), { data: [{ name: "A" }] }, b())),
    ).toBe("INSERT INTO rand_t $p0;");
    expect(
      sql(
        compileCreateMany(
          meta("randT"),
          { data: [{ name: "A" }], skipDuplicates: true },
          b(),
        ),
      ),
    ).toBe("INSERT IGNORE INTO rand_t $p0;");
    expect(
      sql(
        compileUpsert(
          meta("randT"),
          { where: { email: "a@x" }, data: { email: "a@x" }, onMissing: "create" },
          b(),
        ),
      ),
    ).toBe("UPSERT rand_t MERGE $p0 WHERE email = $p1;");
    expect(
      sql(
        compileUpsertMany(
          meta("randT"),
          { data: [{ email: "a@x" }], conflict: "email" },
          b(),
        ),
      ),
    ).toBe("UPSERT rand_t MERGE $p0 WHERE email = $p0.email;");
  });
});

// --- generated-id helpers: the defensive arms ----------------------------------------------------

describe("generated-id helpers — edge cases", () => {
  test("generatedTarget skips rand and singletons; schemaless defaults to ulid", () => {
    expect(generatedTarget(meta("ulidT"))).toBe(
      'type::record(s"ulid_t", rand::ulid())',
    );
    expect(generatedTarget(meta("uuidT"))).toBe(
      'type::record(s"uuid_t", rand::uuid())',
    );
    expect(generatedTarget(meta("randT"))).toBeUndefined();
    expect(generatedTarget(meta("singletonT"))).toBeUndefined();
    expect(generatedTarget(client.$index.schemaless.get("audit")!)).toBe(
      'type::record(s"audit_log", rand::ulid())',
    );
  });

  test("an explicit-only table (uuid v4 id field) refuses every generated create", () => {
    // No strategy can produce the id — the compiler fails EARLY with a teaching error instead of
    // emitting a doomed server write. Explicit ids keep working.
    expect(() => generatedTarget(meta("uuidV4IdT"))).toThrow(/explicit "id"/);
    expect(
      codeOf(() => compileCreate(meta("uuidV4IdT"), { data: { name: "A" } }, b())),
    ).toBe("ValidationError");
    expect(
      codeOf(() => compileInsert(meta("uuidV4IdT"), { data: { name: "A" } }, b())),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        compileUpsert(
          meta("uuidV4IdT"),
          { where: { name: "A" }, data: { name: "A" }, onMissing: "create" },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    expect(
      sql(
        compileCreate(
          meta("uuidV4IdT"),
          {
            data: {
              id: new RecordId(
                "uuid_v4_id_t",
                "f47ac10b-58cc-4372-a567-0e02b2c3d479",
              ),
              name: "A",
            },
          },
          b(),
        ),
      ),
    ).toContain("CREATE uuid_v4_id_t:");
  });

  test("withGeneratedId passes non-objects and explicit ids through; skips rand/singletons", () => {
    const singleton = meta("singletonT");
    const row = { value: "x" };
    expect(withGeneratedId(meta("ulidT"), 5)).toBe(5);
    const explicit = { id: "ulid_t:1", name: "A" };
    expect(withGeneratedId(meta("ulidT"), explicit)).toBe(explicit);
    const randRow = { name: "A" };
    expect(withGeneratedId(meta("randT"), randRow)).toBe(randRow);
    expect(withGeneratedId(singleton, row)).toBe(row);
    const injected = withGeneratedId(meta("ulidT"), { name: "A" }) as {
      id: unknown;
    };
    expect(injected.id).toBeInstanceOf(BoundQuery);
  });

  test("insert on a singleton keeps the server-default lowering (no injection)", () => {
    expect(
      sql(compileInsert(meta("singletonT"), { data: { value: "x" } }, b())),
    ).toBe("INSERT INTO singleton_t $p0;");
  });
});

// --- no DDL / no struct diff ---------------------------------------------------------------------

describe("idStrategy — no DDL, no Struct-IR diff", () => {
  test("emitTable is identical with and without the strategy", () => {
    const plain = defineTable("inv", { name: s.string() });
    const uuid = defineTable("inv", { name: s.string() }).idStrategy("uuid");
    const rand = defineTable("inv", { name: s.string() }).idStrategy("rand");
    expect(emitTable(uuid)).toBe(emitTable(plain));
    expect(emitTable(rand)).toBe(emitTable(plain));
  });

  test("the Struct IR (snapshots/diff) is identical with and without the strategy", () => {
    const plain = defineTable("inv", { name: s.string() });
    const uuid = defineTable("inv", { name: s.string() }).idStrategy("uuid");
    expect(schemaStruct([uuid], [])).toEqual(schemaStruct([plain], []));
  });
});
