const _MAGIC_123 = 123
// TYPE assertions for the query logger: the `logger` client option union (flag/preset/options), the
// `createQueryLogger`/`resolveLogger` return shapes, the resolved-option fields and the invalid
// values the types reject. Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

import { describe, it } from "node:test"

import type { ZodString } from "zod"

import { assertType } from "../../../../../scripts/type-assert"
import { createQueryLogger, type resolveLogger } from "../../../src/surreal/logger"
import { type Client, orm } from "../../../src/surreal/orm/client"
import type { Queryable } from "../../../src/surreal/orm/execute"
import { schema } from "../../../src/surreal/orm/schema"
import type {
  ExplainPolicy,
  LogFormat,
  LoggerLevel,
  LoggerOption,
  LoggerOptions,
  QueryLogger,
  ResolvedLoggerOptions,
} from "../../../src/surreal/orm/types/logger"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

void describe("logger option — accepted shapes", () => {
  void it("the flag, a preset and an options bag all typecheck on the client", () => {
    const _flag = (
      conn: Queryable,
    ): Client<{
      readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
    }> => orm(conn, { logger: true, schema: schemaDef })
    const _preset = (
      conn: Queryable,
    ): Client<{
      readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
    }> => orm(conn, { logger: "json", schema: schemaDef })
    const _bag = (
      conn: Queryable,
    ): Client<{
      readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
    }> => orm(conn, { logger: { level: "info", slowMs: 5 }, schema: schemaDef })
    assertType<Client<typeof schemaDef>, ReturnType<typeof _flag>>()
    assertType<Client<typeof schemaDef>, ReturnType<typeof _preset>>()
    assertType<Client<typeof schemaDef>, ReturnType<typeof _bag>>()
  })

  void it("LoggerOption is exactly boolean | preset | options | a built QueryLogger", () => {
    assertType<true, boolean extends LoggerOption ? true : false>()
    assertType<true, "pretty" extends LoggerOption ? true : false>()
    assertType<true, "json" extends LoggerOption ? true : false>()
    assertType<true, "compact" extends LoggerOption ? true : false>()
    assertType<true, "silent" extends LoggerOption ? true : false>()
    assertType<true, LoggerOptions extends LoggerOption ? true : false>()
    assertType<true, QueryLogger extends LoggerOption ? true : false>()
  })

  void it("a pre-built QueryLogger typechecks on the client", () => {
    const _built = (
      conn: Queryable,
    ): Client<{
      readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
    }> => orm(conn, { logger: createQueryLogger(), schema: schemaDef })
    assertType<Client<typeof schemaDef>, ReturnType<typeof _built>>()
  })

  void it("options fields are the narrow unions", () => {
    assertType<LoggerLevel | undefined, LoggerOptions["level"]>()
    assertType<LogFormat | undefined, LoggerOptions["format"]>()
    assertType<ExplainPolicy | undefined, LoggerOptions["explain"]>()
    assertType<"auto" | boolean | undefined, LoggerOptions["colors"]>()
    assertType<((line: string) => void) | undefined, LoggerOptions["write"]>()
  })

  void it("rejects unknown levels/formats/explain policies and non-option flags", () => {
    assertType<false, { level: "trace" } extends LoggerOptions ? true : false>()
    assertType<false, { format: "xml" } extends LoggerOptions ? true : false>()
    assertType<false, { explain: "always" } extends LoggerOptions ? true : false>()
    assertType<false, typeof _MAGIC_123 extends LoggerOption ? true : false>()
    assertType<false, "verbose" extends LoggerOption ? true : false>()
  })
})

void describe("logger factory — runtime surface", () => {
  void it("createQueryLogger returns a QueryLogger with resolved options", () => {
    const _logger = createQueryLogger({ slowMs: 5 })
    assertType<QueryLogger, typeof _logger>()
    assertType<boolean, QueryLogger["enabled"]>()
    assertType<ResolvedLoggerOptions, QueryLogger["options"]>()
    assertType<LogFormat, QueryLogger["options"]["format"]>()
    assertType<LoggerLevel, QueryLogger["options"]["level"]>()
    assertType<ExplainPolicy, QueryLogger["options"]["explain"]>()
    assertType<string | undefined, ReturnType<QueryLogger["planStatement"]>>()
  })

  void it("resolveLogger is optional (off) and reads the env", () => {
    assertType<QueryLogger | undefined, ReturnType<typeof resolveLogger>>()
    assertType<QueryLogger | undefined, ReturnType<typeof resolveLogger>>()
  })
})
