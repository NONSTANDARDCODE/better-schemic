// The diff pager resolution (git-style precedence) and the pipe-through helper.
import { afterEach, describe, expect, test } from "bun:test";
import { pipeThroughPager, resolvePager } from "../../src/cli-kit/pager";

const KEYS = [
  "GIT_PAGER",
  "PAGER",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
  string,
  string | undefined
>;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolvePager", () => {
  test("falls back to GIT_PAGER then PAGER when git config is empty", () => {
    // Isolate from any user/system git config so the env fallbacks are reached deterministically.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_PAGER;
    delete process.env.PAGER;
    expect(resolvePager()).toBeUndefined();

    process.env.PAGER = "mypager";
    expect(resolvePager()).toBe("mypager");

    process.env.GIT_PAGER = "gitpager";
    expect(resolvePager()).toBe("gitpager");
  });
});

describe("pipeThroughPager", () => {
  test("pipes text through a shell command and resolves", async () => {
    await pipeThroughPager("cat > /dev/null", "hello\nworld");
  });
});
