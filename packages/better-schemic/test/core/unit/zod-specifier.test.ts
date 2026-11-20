import { describe, expect, test } from "bun:test"

import { rewriteZodSpecifiers, zodSpecifierOf } from "../../../src/core/cli-kit/zod-specifier"
import { config, core, z, ZodRealError } from "../../../src/zod"

// The exact header zod-compiler@2.0.10 hardcodes into generated files.
const HEADER =
  'import { config as __zodCompilerConfig, ZodRealError as __zcZodError } from "zod";\n' +
  'import * as __zcCore from "zod/v4/core";'

const REWRITTEN_HEADER =
  'import { config as __zodCompilerConfig, ZodRealError as __zcZodError } from "better-schemic/zod";\n' +
  'import * as __zcCore from "better-schemic/zod/core";'

describe("rewriteZodSpecifiers", () => {
  test("rewrites both generated-header specifiers", () => {
    expect(rewriteZodSpecifiers(HEADER)).toBe(REWRITTEN_HEADER)
  })

  test("is idempotent", () => {
    expect(rewriteZodSpecifiers(REWRITTEN_HEADER)).toBe(REWRITTEN_HEADER)
  })

  test("handles single quotes", () => {
    const source = "import { config } from 'zod';\nimport * as __zcCore from 'zod/v4/core';"
    expect(rewriteZodSpecifiers(source)).toBe(
      "import { config } from 'better-schemic/zod';\n" +
        "import * as __zcCore from 'better-schemic/zod/core';",
    )
  })

  test("leaves source unchanged when specifier is zod or empty", () => {
    expect(rewriteZodSpecifiers(HEADER, "zod")).toBe(HEADER)
    expect(rewriteZodSpecifiers(HEADER, "")).toBe(HEADER)
  })

  test("supports a custom specifier", () => {
    expect(rewriteZodSpecifiers(HEADER, "@acme/zod")).toBe(
      'import { config as __zodCompilerConfig, ZodRealError as __zcZodError } from "@acme/zod";\n' +
        'import * as __zcCore from "@acme/zod/core";',
    )
  })

  test("does not rewrite zod text outside import/export/from clauses", () => {
    const source = 'const label = "zod";\nconst core = "zod/v4/core";\nimport { z } from "zod";'
    expect(rewriteZodSpecifiers(source)).toBe(
      'const label = "zod";\nconst core = "zod/v4/core";\nimport { z } from "better-schemic/zod";',
    )
  })
})

describe("zodSpecifierOf", () => {
  test("resolves default, opt-out and custom specifiers", () => {
    expect(zodSpecifierOf()).toEqual({
      core: "better-schemic/zod/core",
      runtime: "better-schemic/zod",
    })
    expect(zodSpecifierOf("zod")).toEqual({ core: "zod/v4/core", runtime: "zod" })
    expect(zodSpecifierOf("")).toEqual({ core: "zod/v4/core", runtime: "zod" })
    expect(zodSpecifierOf("@acme/zod")).toEqual({
      core: "@acme/zod/core",
      runtime: "@acme/zod",
    })
  })
})

describe("src/zod bridge", () => {
  test("reexports the shared Zod instance and core namespace", () => {
    expect(typeof config).toBe("function")
    expect(typeof ZodRealError).toBe("function")
    expect(typeof z).toBe("object")
    expect(typeof core).toBe("object")
    expect(typeof core.$ZodRealError).toBe("function")
  })
})
