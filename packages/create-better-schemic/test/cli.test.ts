import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRY = join(import.meta.dir, "../src")

/** Run the scaffolder (always --no-install --no-git -y) into a temp dir; returns paths + exit code. */
function scaffold(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "create-better-schemic-")),
    app = join(root, "app"),
    r = spawnSync("bun", [ENTRY, app, ...args, "--no-install", "--no-git", "-y"], {
      encoding: "utf8",
    }),
    pkg = () => JSON.parse(readFileSync(join(app, "package.json"), "utf8")),
    ts = () => JSON.parse(readFileSync(join(app, "tsconfig.json"), "utf8"))
  // Clack writes prompts/cancel to stdout, not stderr — check the combined output
  return {
    root,
    app,
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    pkg,
    ts,
  }
}

describe("create-better-schemic", () => {
  it("scaffolds the project envelope", () => {
    const s = scaffold([])
    try {
      expect(s.status).toBe(0)
      expect(existsSync(join(s.app, "package.json"))).toBe(true)
      expect(existsSync(join(s.app, "tsconfig.json"))).toBe(true)
      expect(existsSync(join(s.app, ".gitignore"))).toBe(true)
      const deps = s.pkg().dependencies
      // ONE package: the authoring surface, the engine and the CLI. Zod and the SurrealDB SDK
      // Ship inside it, so the project never installs them itself.
      expect(deps["better-schemic"]).toBeDefined()
      expect(deps.surrealdb).toBeUndefined()
      expect(deps.zod).toBeUndefined()
      // The type declaration for the `with { type: "text" }` seed imports needs resolveJsonModule
      expect(s.ts().compilerOptions.resolveJsonModule).toBe(true)
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  })

  it("rejects an unknown option (a typo never scaffolds a folder named after it)", () => {
    const s = scaffold(["--driver", "surrealdb"])
    try {
      expect(s.status).not.toBe(0)
      expect(s.out).toContain("Unknown option")
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  })

  it("MERGES into an existing project without clobbering it", () => {
    const root = mkdtempSync(join(tmpdir(), "create-better-schemic-")),
      app = join(root, "app")
    mkdirSync(app, { recursive: true })
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({
        name: "my-app",
        version: "1.2.3",
        scripts: { dev: "vite" },
        dependencies: { zod: "^4.0.0" },
      }),
    )
    try {
      const r = spawnSync("bun", [ENTRY, app, "--no-install", "--no-git", "-y"], {
        encoding: "utf8",
      })
      expect(r.status).toBe(0)
      const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"))
      expect(pkg.name).toBe("my-app") // Kept
      expect(pkg.version).toBe("1.2.3") // Kept
      expect(pkg.scripts.dev).toBe("vite") // Their script kept
      expect(pkg.scripts.db).toBe("better-schemic") // Ours added
      expect(pkg.dependencies.zod).toBe("^4.0.0") // Their version kept, not overwritten
      expect(pkg.dependencies["better-schemic"]).toBeDefined() // Added
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
