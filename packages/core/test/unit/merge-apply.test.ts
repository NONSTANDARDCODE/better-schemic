// applyPull safety: the plan carries its schema root and applyPull never writes/deletes outside it
// (a hostile DB object name must not escape the schema dir) nor through a symlink.
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPull, type PullFilePlan } from "../../src/cli-kit/merge";

const root = mkdtempSync(join(tmpdir(), "pull-apply-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = (abs: string, after = "x\n"): PullFilePlan => ({
  rel: abs,
  abs,
  action: "create",
  before: "",
  after,
  localOnly: { fields: [], objects: [] },
});

describe("applyPull — containment", () => {
  test("writes inside the root", () => {
    const abs = join(root, "tables", "user.ts");
    const touched = applyPull({ root, files: [file(abs)] });
    expect(touched).toEqual([abs]);
    expect(readFileSync(abs, "utf8")).toBe("x\n");
  });

  test("refuses a path escaping the root", () => {
    const abs = join(root, "..", "evil.ts");
    expect(() => applyPull({ root, files: [file(abs)] })).toThrow(
      /outside the schema root/,
    );
  });

  test("refuses a symlinked target", () => {
    const real = join(root, "real.ts");
    writeFileSync(real, "real");
    const link = join(root, "link.ts");
    symlinkSync(real, link);
    expect(() => applyPull({ root, files: [file(link)] })).toThrow(/symlink/);
    expect(readFileSync(real, "utf8")).toBe("real");
  });

  test("a plan without a root keeps the legacy behavior (no containment check)", () => {
    const abs = join(root, "loose.ts");
    mkdirSync(root, { recursive: true });
    expect(applyPull({ files: [file(abs)] })).toEqual([abs]);
  });
});
