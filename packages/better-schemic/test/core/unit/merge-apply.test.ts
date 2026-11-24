// applyPull safety: the plan carries its schema root and applyPull never writes/deletes outside it
// (a hostile DB object name must not escape the schema dir) nor through a symlink.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { applyPull, type PullFilePlan } from "../../../src/core/cli-kit/merge"

const root = mkdtempSync(path.join(tmpdir(), "pull-apply-"))
afterAll(() => {
  rmSync(root, { force: true, recursive: true })
})

const file = (abs: string, after = "x\n"): PullFilePlan => ({
  abs,
  action: "create",
  after,
  before: "",
  localOnly: { fields: [], objects: [] },
  rel: abs,
})

describe("applyPull — containment", () => {
  test("writes inside the root", () => {
    const abs = path.join(root, "tables", "user.ts")
    const touched = applyPull({ files: [file(abs)], root })
    expect(touched).toEqual([abs])
    expect(readFileSync(abs, "utf8")).toBe("x\n")
  })

  test("refuses a path escaping the root", () => {
    const abs = path.join(root, "..", "evil.ts")
    expect(() => applyPull({ files: [file(abs)], root })).toThrow(/outside the schema root/u)
  })

  test("refuses a symlinked target", () => {
    const real = path.join(root, "real.ts")
    writeFileSync(real, "real")
    const link = path.join(root, "link.ts")
    symlinkSync(real, link)
    expect(() => applyPull({ files: [file(link)], root })).toThrow(/symlink/u)
    expect(readFileSync(real, "utf8")).toBe("real")
  })

  test("a plan without a root keeps the legacy behavior (no containment check)", () => {
    const abs = path.join(root, "loose.ts")
    mkdirSync(root, { recursive: true })
    expect(applyPull({ files: [file(abs)] })).toEqual([abs])
  })
})
