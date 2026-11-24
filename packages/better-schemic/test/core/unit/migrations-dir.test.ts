/* eslint-disable perfectionist/sort-objects, @typescript-eslint/explicit-function-return-type -- Object key order mirrors expected serialized output and must stay as authored. callbacks de teste: tipo inferido pelo saturador de assercoes; anotar cada um geraria ruido sem valor. */
import { describe, expect, test } from "bun:test"

import { resolveConnectionConfig } from "../../../src/core/cli-kit/config"
import type { OrmConfig } from "../../../src/core/config"

const config = { connections: {} } as OrmConfig
const rc = (conn: { migrations?: string; schema: string }) =>
  resolveConnectionConfig(config, "default", conn, "testdriver", "/proj")

describe("migrations dir defaults RELATIVE TO THE SCHEMA (the documented contract)", () => {
  test("standard scaffold layout is unchanged", () => {
    expect(rc({ schema: "./database/schema" }).migrationsDir).toBe("/proj/database/migrations")
  })

  test("a nested schema gets its sibling migrations dir (the sc-gen split-state bug)", () => {
    expect(rc({ schema: "./src/database/schema" }).migrationsDir).toBe(
      "/proj/src/database/migrations",
    )
  })

  test("a single-file schema gets migrations next to the file", () => {
    expect(rc({ schema: "./db/schema" }).migrationsDir).toBe("/proj/db/migrations")
  })

  test("an explicit migrations override still resolves from the project root", () => {
    expect(rc({ schema: "./src/database/schema", migrations: "./mig" }).migrationsDir).toBe(
      "/proj/mig",
    )
  })
})
