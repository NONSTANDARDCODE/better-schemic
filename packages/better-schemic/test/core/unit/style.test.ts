// The ANSI styling helper — the COLOR-ON path (TTY + NO_COLOR unset) and the color-OFF fallback.
// `process.stdout.isTTY` is a getter, so it is overridden with `Object.defineProperty` and restored.
import { afterEach, describe, expect, test } from "bun:test"

import { colorEnabled, fail, ok, plural, style } from "../../../src/core/cli-kit/style"

const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")?.value as
  boolean | undefined

function setIsTTY(v: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value: v,
    configurable: true,
  })
}

afterEach(() => {
  setIsTTY(realIsTTY!)
  delete process.env.NO_COLOR
})

describe("style", () => {
  test("colors when stdout is a TTY and NO_COLOR is unset", () => {
    setIsTTY(true)
    delete process.env.NO_COLOR
    expect(colorEnabled()).toBe(true)
    expect(style.green("x")).toBe("\u001B[32mx\u001B[0m")
    expect(style.red("x")).toBe("\u001B[31mx\u001B[0m")
    expect(style.yellow("x")).toBe("\u001B[33mx\u001B[0m")
    expect(style.cyan("x")).toBe("\u001B[36mx\u001B[0m")
    expect(style.dim("x")).toBe("\u001B[90mx\u001B[0m")
    expect(style.bold("x")).toBe("\u001B[1mx\u001B[0m")
    expect(ok("done")).toBe("\u001B[32m✓\u001B[0m done")
    expect(fail("bad")).toBe("\u001B[31m✗\u001B[0m bad")
  })

  test("passes through when NO_COLOR is set (even on a TTY)", () => {
    setIsTTY(true)
    process.env.NO_COLOR = "1"
    expect(colorEnabled()).toBe(false)
    expect(style.green("x")).toBe("x")
  })

  test("passes through when stdout is not a TTY", () => {
    setIsTTY(false)
    delete process.env.NO_COLOR
    expect(colorEnabled()).toBe(false)
    expect(style.green("x")).toBe("x")
  })

  test("pluralizes", () => {
    expect(plural(1, "thing")).toBe("1 thing")
    expect(plural(0, "thing")).toBe("0 things")
    expect(plural(2, "thing")).toBe("2 things")
  })
})
