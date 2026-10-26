// The golden path a user walks: init -> gen -> migrate -> status -> diff -> check. Drives the real
// CLI end to end against a throwaway in-memory SurrealDB.

import { Glob } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { E2E_ENABLED, ok, startHarness } from "./harness"

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

const T = 180_000 // Headroom for gate parallelism (parallel-suite CPU contention) // subprocess + jiti + (for check) a nested ephemeral server

e2e("lifecycle: init -> gen -> migrate -> status -> diff -> check", () => {
  test(
    "the full golden path",
    async () => {
      const root = H.scaffold(),
        db = H.freshDb(),
        run = async (args: string[]) => H.run(args, { cwd: root, db }),
        // Init scaffolds the project.
        init = await run(["init"])
      ok(init)
      expect(init.out).toContain("better-schemic.config.ts")
      expect(init.out).toContain("database/schema/tables/user.ts")
      expect(init.out).toContain("Initialized")

      // Re-init is a no-op (never clobbers existing files).
      const reinit = await run(["init"])
      expect(reinit.out).toContain("Nothing to do")
      expect(reinit.out).toContain("(exists, skipped)")

      // Gen writes the baseline migration from the empty snapshot.
      const gen = await run(["gen", "init_schema", "-y"])
      ok(gen)
      expect(gen.out).toContain("change")
      // Gen prints the rendered migration it wrote — idempotent DEFINE … OVERWRITE, not a diff.
      expect(gen.out).toContain("DEFINE TABLE OVERWRITE user")
      expect(gen.out).toContain("init_schema")
      // …and writes an IDEMPOTENT migration FILE — added objects as DEFINE … OVERWRITE.
      const migRel = [...new Glob("**/*_init_schema.surql").scanSync(root)][0]
      expect(migRel).toBeDefined()
      expect(readFileSync(join(root, migRel), "utf8")).toContain("DEFINE TABLE OVERWRITE user")

      // Status: one pending migration (nothing applied yet).
      const statusPending = await run(["status"])
      expect(statusPending.out).toContain("pending")
      expect(statusPending.out).toContain("init_schema")

      // Migrate applies it.
      const migrate = await run(["migrate"])
      ok(migrate)
      expect(migrate.out).toContain("init_schema")
      expect(migrate.out).toContain("Applied 1 migration")

      // Status: now applied.
      const statusApplied = await run(["status"])
      expect(statusApplied.out).toContain("applied")
      expect(statusApplied.out).toContain("init_schema")

      // Diff --live: schema now matches the database.
      const diffLive = await run(["diff", "--live"])
      ok(diffLive)
      expect(diffLive.out).toContain("No changes.")

      // Gen again: nothing to generate (snapshot caught up).
      const genAgain = await run(["gen", "noop", "-y"])
      expect(genAgain.out).toContain("nothing to generate")

      // Migrate again: up to date.
      const migrateAgain = await run(["migrate"])
      expect(migrateAgain.out).toContain("Up to date")

      // Check: replay the migrations on a throwaway engine and confirm they reproduce the schema.
      const check = await run(["check"])
      ok(check)
      expect(check.out).toContain("Migrations reproduce the schema.")
    },
    T,
  )
})

e2e("seed: the scaffolded default seed runs against the migrated DB", () => {
  test(
    "init -> gen -> migrate -> seed creates user:ada",
    async () => {
      const root = H.scaffold(),
        db = H.freshDb(),
        run = async (args: string[]) => H.run(args, { cwd: root, db })

      ok(await run(["init"]))
      ok(await run(["gen", "init_schema", "-y"]))
      ok(await run(["migrate"]))

      // The scaffolded seed imports `../schema/tables/user` and runs
      // `db.create(User.record().for("ada")).content({ … })`. A broken import or a write that the
      // 2.x SDK / 3.x server combo rejects would exit non-zero — so a clean exit proves the row landed.
      const seed = await run(["seed"])
      ok(seed)
      expect(seed.out.toLowerCase()).not.toContain("error")
    },
    T,
  )
})
