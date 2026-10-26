import { describe, expect, it } from "bun:test"
import { join } from "node:path"

// Building the commander program (every `.command()`/`.option()`) happens at module load. A
// Conflicting option — e.g. a subcommand re-adding a flag `dbFlags` already supplies — throws THERE,
// Which breaks EVERY command, not just the offending one. `--help` exercises that construction, so a
// Clean exit 0 proves the whole program assembled. (Regression guard: the seed `--all` collision.)
const ENTRY = join(import.meta.dir, "../../../src/cli")

function helpExitCode(args: string[]): number {
  const p = Bun.spawnSync(["bun", ENTRY, ...args, "--help"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  return p.exitCode ?? -1
}

describe("CLI program constructs", () => {
  it("root --help exits 0 (whole program assembled, no option conflicts)", () => {
    expect(helpExitCode([])).toBe(0)
  })

  for (const cmd of ["init", "gen", "migrate", "diff", "seed", "pull", "new"]) {
    it(`${cmd} --help exits 0`, () => {
      expect(helpExitCode([cmd])).toBe(0)
    })
  }
})
