/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-dynamic-delete -- Helpers stay colocated with the tests that use them. Defensive checks document fixture intent. Assertions await void-returning matchers. Environment cleanup deletes dynamic keys. */
// The diff pager resolution (git-style precedence) and the shell-free pipe-through helper.
import { afterEach, describe, expect, test } from "bun:test"

import { parsePagerCommand, pipeThroughPager, resolvePager } from "../../../src/core/cli-kit/pager"

const KEYS = [
  "GIT_PAGER",
  "PAGER",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
  string,
  string | undefined
>

afterEach(() => {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("resolvePager", () => {
  test("falls back to GIT_PAGER then PAGER when git config is empty", () => {
    // Isolate from any user/system git config so the env fallbacks reach them deterministically.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    delete process.env.GIT_PAGER
    delete process.env.PAGER
    expect(resolvePager()).toBeUndefined()

    process.env.PAGER = "mypager"
    expect(resolvePager()).toBe("mypager")

    process.env.GIT_PAGER = "gitpager"
    expect(resolvePager()).toBe("gitpager")
  })
})

describe("pipeThroughPager", () => {
  test("pipes text through a program + args, shell-free", async () => {
    await pipeThroughPager("true", "hello\nworld")
  })

  test("parses quotes/escapes into argv (no shell expansion)", () => {
    expect(parsePagerCommand("delta --side-by-side")).toEqual(["delta", "--side-by-side"])
    expect(parsePagerCommand('less -R -P "hello world"')).toEqual([
      "less",
      "-R",
      "-P",
      "hello world",
    ])
    expect(parsePagerCommand("")).toEqual([])
  })

  test("refuses to run a shell as the pager (the diff would become its script)", async () => {
    await expect(pipeThroughPager("sh -c 'cat'", "x")).rejects.toThrow(/refusing to run/u)
    await expect(pipeThroughPager("/bin/bash", "x")).rejects.toThrow(/refusing to run/u)
  })
})
