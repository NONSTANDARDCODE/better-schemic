import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "bun:test"

const ENTRY = path.join(import.meta.dir, "../src")

type PackageJson = {
  dependencies: Record<string, string>
  scripts: Record<string, string>
}
type TsConfig = { compilerOptions: { resolveJsonModule?: boolean } }
type Scaffold = {
  app: string
  out: string
  pkg(): PackageJson
  root: string
  status: null | number
  ts(): TsConfig
}

/** Run the scaffolder (always --no-install --no-git -y) into a temp dir; returns paths + exit code. */
function scaffold(args: string[]): Scaffold {
  const root = mkdtempSync(path.join(tmpdir(), "create-better-schemic-"))
  const app = path.join(root, "app")
  const r = spawnSync("bun", [ENTRY, app, ...args, "--no-install", "--no-git", "-y"], {
    encoding: "utf8",
  })
  const pkg = (): PackageJson =>
    JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as PackageJson
  const ts = (): TsConfig =>
    JSON.parse(readFileSync(path.join(app, "tsconfig.json"), "utf8")) as TsConfig
  // clack writes prompts/cancel to stdout, not stderr — check the combined output
  return {
    app,
    out: `${r.stdout}${r.stderr}`,
    pkg,
    root,
    status: r.status,
    ts,
  }
}

describe("create-better-schemic", () => {
  it("scaffolds the project envelope", () => {
    const s = scaffold([])
    try {
      expect(s.status).toBe(0)
      expect(existsSync(path.join(s.app, "package.json"))).toBe(true)
      expect(existsSync(path.join(s.app, "tsconfig.json"))).toBe(true)
      expect(existsSync(path.join(s.app, ".gitignore"))).toBe(true)
      const deps = s.pkg().dependencies
      // ONE package: the authoring surface, the engine and the CLI. Zod and the SurrealDB SDK
      // ship inside it, so the project never installs them itself.
      expect(deps["better-schemic"]).toBeDefined()
      expect(deps.surrealdb).toBeUndefined()
      expect(deps.zod).toBeUndefined()
      // the type declaration for the `with { type: "text" }` seed imports needs resolveJsonModule
      expect(s.ts().compilerOptions.resolveJsonModule).toBe(true)
    } finally {
      rmSync(s.root, { force: true, recursive: true })
    }
  })

  it("rejects an unknown option (a typo never scaffolds a folder named after it)", () => {
    const s = scaffold(["--driver", "surrealdb"])
    try {
      expect(s.status).not.toBe(0)
      expect(s.out).toContain("Unknown option")
    } finally {
      rmSync(s.root, { force: true, recursive: true })
    }
  })

  it("MERGES into an existing project without clobbering it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "create-better-schemic-"))
    const app = path.join(root, "app")
    mkdirSync(app, { recursive: true })
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({
        dependencies: { zod: "^4.0.0" },
        name: "my-app",
        scripts: { dev: "vite" },
        version: "1.2.3",
      }),
    )
    try {
      const r = spawnSync("bun", [ENTRY, app, "--no-install", "--no-git", "-y"], {
        encoding: "utf8",
      })
      expect(r.status).toBe(0)
      const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"))
      expect(pkg.name).toBe("my-app") // kept
      expect(pkg.version).toBe("1.2.3") // kept
      expect(pkg.scripts.dev).toBe("vite") // their script kept
      expect(pkg.scripts.db).toBe("better-schemic") // ours added
      expect(pkg.dependencies.zod).toBe("^4.0.0") // their version kept, not overwritten
      expect(pkg.dependencies["better-schemic"]).toBeDefined() // added
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
