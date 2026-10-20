import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The authoring entry must stay BUNDLE-CLEAN: importing `s.*` may not drag the DDL emitter, the
 * diff/migration engine or the CLI into an app bundle. When the driver was a separate package,
 * the package boundary enforced this for free — inside ONE package, the `exports` map is the only
 * boundary left, so it needs a test.
 */
const PKG = resolve(import.meta.dir, "../../..");

/** Build a probe that imports `named` from `entry` and report the SOURCE FILES the bundle pulled in. */
async function bundledSources(
  entry: string,
  named: string,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "sc-bundle-"));
  try {
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      `import { ${named} } from ${JSON.stringify(entry)};\n` +
        `export const used = ${named};\n`,
    );
    const result = await Bun.build({
      entrypoints: [probe],
      target: "node",
      format: "esm",
      metafile: true,
      // The package's own deps stay external — we are asking WHICH OF OUR FILES were pulled in.
      packages: "external",
    });
    if (!result.success || !result.metafile)
      throw new Error(
        `bundle failed: ${result.logs.map((l) => l.message).join("; ")}`,
      );
    return Object.keys(result.metafile.inputs).map((p) => resolve(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bundle purity — the authoring entry stays side-effect-free", () => {
  test("importing `s.*` pulls NEITHER the DDL emitter NOR the diff engine NOR the CLI", async () => {
    const sources = await bundledSources(join(PKG, "src/index.ts"), "defineTable");
    const engine = sources.filter(
      (p) =>
        p.includes("/src/surreal/ddl.ts") ||
        p.includes("/src/surreal/driver/") ||
        p.includes("/src/core/cli-kit/") ||
        p.includes("/src/cli/"),
    );
    expect(engine).toEqual([]);
    // …and the authoring surface IS there (the test would pass vacuously otherwise).
    expect(sources.some((p) => p.endsWith("/src/surreal/pure.ts"))).toBe(true);
  });

  test("the `/driver` engine entry DOES pull the emitter (the split is real)", async () => {
    const sources = await bundledSources(join(PKG, "src/driver.ts"), "emitTable");
    expect(sources.some((p) => p.endsWith("/src/surreal/ddl.ts"))).toBe(true);
  });
});
