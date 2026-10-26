// The 3-state migration model — schema (TS) / snapshot (_snapshot.json) / live DB — exercised
// Across every way the three can diverge. Each test scaffolds its own project + database, drives
// The real CLI, and asserts on what a user would see.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { E2E_ENABLED, ok, startHarness, userSchema } from "./harness"

import type { Harness } from "./harness"

const e2e = describe.skipIf(!E2E_ENABLED)
if (!E2E_ENABLED) console.warn("[e2e] `surreal` binary not found — skipping e2e suite")

let H: Harness
beforeAll(async () => {
  if (E2E_ENABLED) H = await startHarness()
}, 120_000) // Gate parallelism: parallel-suite CPU contention slows the ephemeral server boot
afterAll(async () => {
  await H?.cleanup()
}, 120_000) // EXPLICIT: the harness's setDefaultTimeout only reaches the FIRST file (see harness.ts)

const T = 180_000, // Headroom for gate parallelism (parallel-suite CPU contention)
  POST = `import { s, defineTable } from "better-schemic";

export const Post = defineTable("post", {
  id: s.string(),
  title: s.string(),
});
`

/** Scaffold + init a fresh project on a fresh database; return its handle. */
async function setup() {
  const root = H.scaffold(),
    db = H.freshDb(),
    run = async (args: string[]) => H.run(args, { cwd: root, db })
  await run(["init"])
  return { root, db, run }
}

e2e("3-state divergence matrix", () => {
  test(
    "empty database: diff --live shows the whole schema as additions",
    async () => {
      const { run } = await setup(),
        diff = await run(["diff", "--live"])
      ok(diff)
      expect(diff.out).toContain("DEFINE TABLE user")
      expect(diff.out).toContain("vs the live database")
    },
    T,
  )

  test(
    "database behind schema: a new table is added by push",
    async () => {
      const { root, run } = await setup()
      await run(["push"]) // Db now has `user`
      H.write(root, "database/schema/tables/post.ts", POST)

      const before = await run(["diff", "--live"])
      expect(before.out).toContain("DEFINE TABLE post")
      expect(before.out).not.toContain("DEFINE TABLE user") // User already in db

      const push = await run(["push"])
      expect(push.out).toMatch(/synced/)

      const after = await run(["diff", "--live"])
      expect(after.out).toContain("No changes.")
    },
    T,
  )

  test(
    "database ahead of schema: push prunes the extra; --no-prune keeps it; pull re-adds it",
    async () => {
      const { root, run } = await setup()
      H.write(root, "database/schema/tables/post.ts", POST)
      await run(["push"]) // Db has user + post
      // Schema drops post (file removed) — db is now ahead of the schema.
      const { rmSync } = await import("node:fs")
      rmSync(`${root}/database/schema/tables/post.ts`)

      const diff = await run(["diff", "--live"])
      expect(diff.out).toMatch(/REMOVE TABLE post|post/)

      // --no-prune leaves the extra table in place (only-removals → nothing to do).
      const keep = await run(["push", "--no-prune"])
      expect(keep.out).toContain("Database already matches the schema.")

      // Pull surfaces the db-only table as a file to (re-)create.
      const pull = await run(["pull"])
      expect(pull.out).toContain("post")
      expect(pull.out).toMatch(/would change/)

      // Push (with prune) removes it from the db.
      const prune = await run(["push"])
      expect(prune.out).toMatch(/pruned 1/)
      const clean = await run(["diff", "--live"])
      expect(clean.out).toContain("No changes.")
    },
    T,
  )

  test(
    "snapshot vs schema (offline): a schema edit is a pending change until gen",
    async () => {
      const { root, run } = await setup()
      await run(["gen", "base", "-y"])
      await run(["migrate"])

      // Offline diff is clean right after gen (snapshot == schema).
      const clean = await run(["diff"])
      expect(clean.out).toContain("No changes.")

      // Edit the schema: add a field. Now schema is ahead of the snapshot.
      H.write(
        root,
        "database/schema/tables/user.ts",
        userSchema("  nickname: s.string().optional(),"),
      )

      const diff = await run(["diff"])
      expect(diff.out).toContain("nickname")
      expect(diff.out).toContain("vs the snapshot")

      // The TS view of the same offline change.
      const diffTs = await run(["diff", "--ts"])
      expect(diffTs.out).toContain("nickname")

      // Gen captures exactly that one field.
      const gen = await run(["gen", "add_nickname", "-y"])
      expect(gen.out).toContain("nickname")
      expect(gen.out).toContain("add_nickname")
    },
    T,
  )

  test(
    "database + snapshot ahead of schema: removing a TS field drops it",
    async () => {
      const { root, run } = await setup()
      // Start with an extra field in TS, captured into snapshot + db.
      H.write(
        root,
        "database/schema/tables/user.ts",
        userSchema("  nickname: s.string().optional(),"),
      )
      await run(["gen", "base", "-y"])
      await run(["migrate"]) // Snapshot + db both have nickname

      // Remove the field from TS — schema now trails the snapshot and the db.
      H.write(root, "database/schema/tables/user.ts", userSchema())

      const offline = await run(["diff"])
      expect(offline.out).toMatch(/REMOVE FIELD nickname|nickname/)
      expect(offline.out).toMatch(/REMOVE/)

      const live = await run(["diff", "--live"])
      expect(live.out).toMatch(/nickname/)
      expect(live.out).toMatch(/REMOVE/)

      const gen = await run(["gen", "drop_nickname", "-y"])
      expect(gen.out).toMatch(/REMOVE FIELD/)
    },
    T,
  )

  test(
    "database + schema ahead of snapshot: snapshot reset re-baselines the full schema",
    async () => {
      const { run } = await setup()
      await run(["gen", "base", "-y"])
      await run(["migrate"]) // Snapshot + db in sync

      const reset = await run(["snapshot", "reset"])
      expect(reset.out).toContain("Snapshot cleared.")

      // With the snapshot empty but db + schema populated, offline diff re-proposes everything.
      const diff = await run(["diff"])
      expect(diff.out).toContain("DEFINE TABLE user")
    },
    T,
  )

  test(
    "three-way drift: snapshot, database, and schema each differ",
    async () => {
      const { root, run } = await setup()
      await run(["gen", "base", "-y"])
      await run(["migrate"]) // All three agree on the sample user

      // Push field `a` straight to the db (no migration) → db ahead of snapshot.
      H.write(root, "database/schema/tables/user.ts", userSchema("  a: s.string().optional(),"))
      await run(["push"]) // Db has `a`; snapshot does NOT

      // Add field `b` in TS only → schema ahead of the db.
      H.write(
        root,
        "database/schema/tables/user.ts",
        userSchema("  a: s.string().optional(),\n  b: s.string().optional(),"),
      )

      // Offline (snapshot vs schema): both new fields are pending.
      const offline = await run(["diff"])
      expect(offline.out).toContain("a")
      expect(offline.out).toContain("b")

      // Live (db vs schema): only `b` is missing — `a` was already pushed.
      const live = await run(["diff", "--live"])
      expect(live.out).toContain("DEFINE FIELD b")
      expect(live.out).not.toContain("DEFINE FIELD a")
    },
    T,
  )

  test(
    "migrate is idempotent against a database populated out-of-band (push then migrate)",
    async () => {
      // The classic inconsistency: the DB already has a pending migration's objects (applied via
      // Push/pull, not recorded in _migrations). Plain DEFINE would fail "already exists" and abort;
      // Idempotent (OVERWRITE) migration files replay cleanly.
      const { run } = await setup()
      await run(["gen", "base", "-y"]) // Migration on disk, pending
      await run(["push"]) // DB populated directly; nothing recorded as applied

      const migrate = await run(["migrate"])
      ok(migrate)
      expect(migrate.out).not.toContain("already exists")
      expect(migrate.out).toContain("Applied 1 migration")

      const status = await run(["status"])
      expect(status.out).toContain("applied")
      expect(status.out).toContain("0 pending")
      expect(status.out).not.toMatch(/· pending/) // No pending migration rows
    },
    T,
  )

  test(
    "push applies a flexible array-of-object field (implicit .* wildcard)",
    async () => {
      // Regression: `s.object({}).loose().array()` emits an implicit `<field>.*` element that the
      // Parent's definition auto-creates, so the apply MUST mark it OVERWRITE. Without that, push
      // Failed with "the field '….*' already exists" → "failed transaction".
      const { root, run } = await setup()
      H.write(
        root,
        "database/schema/tables/doc.ts",
        `import { s, defineTable } from "better-schemic";

export const Doc = defineTable("doc", {
  id: s.string(),
  tags: s.object({}).loose().array(),
});
`,
      )
      const push = await run(["push"])
      ok(push)
      expect(push.out).toMatch(/synced/)
      expect(push.out).not.toContain("failed transaction")

      // Idempotent: the schema is fully applied.
      const again = await run(["diff", "--live"])
      expect(again.out).toContain("No changes.")
    },
    T,
  )
})
