import path from "node:path"

import { describe, expect, it } from "bun:test"

// Building the commander program (every `.command()`/`.option()`) happens at module load. A
// conflicting option — e.g. a subcommand re-adding a flag `dbFlags` already supplies — throws THERE,
// which breaks EVERY command, not the offending one. `--help` exercises that construction, so a
// clean exit 0 proves the whole program assembled. (Regression guard: the seed `--all` collision.)
const ENTRY = path.join(import.meta.dir, "../../../src/cli")

function helpExitCode(args: string[]): number {
  const p = Bun.spawnSync(["bun", ENTRY, ...args, "--help"], {
    stderr: "ignore",
    stdout: "ignore",
  })
  return p.exitCode
}

describe("CLI program constructs", () => {
  it("root --help exits 0 (whole program assembled, no option conflicts)", () => {
    expect(helpExitCode([])).toBe(0)
  })

  ;[
    "init",
    "gen",
    "generate",
    "compile",
    "generate:orm",
    "migrate",
    "diff",
    "seed",
    "pull",
    "new",
  ].forEach((cmd) => {
    it(`${cmd} --help exits 0`, () => {
      expect(helpExitCode([cmd])).toBe(0)
    })
  })
})
