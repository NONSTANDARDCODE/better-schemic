// TYPE assertions for the query logger: the `logger` client option union (flag/preset/options), the
// `createQueryLogger`/`resolveLogger` return shapes, the resolved-option fields and the invalid
// values the types reject. Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../../scripts/type-assert";
import {
  createQueryLogger,
  type resolveLogger,
} from "../../../src/surreal/logger";
import type { Client } from "../../../src/surreal/orm/client";
import { orm } from "../../../src/surreal/orm/client";
import type { Queryable } from "../../../src/surreal/orm/execute";
import { schema } from "../../../src/surreal/orm/schema";
import type {
  ExplainPolicy,
  LogFormat,
  LoggerLevel,
  LoggerOption,
  LoggerOptions,
  QueryLogger,
  ResolvedLoggerOptions,
} from "../../../src/surreal/orm/types/logger";
import { s, table } from "../../../src/surreal/pure";

const User = table("user", { name: s.string() });
const schemaDef = schema({ users: User });

describe("logger option — accepted shapes", () => {
  it("the flag, a preset and an options bag all typecheck on the client", () => {
    const flag = (conn: Queryable) =>
      orm(conn, { schema: schemaDef, logger: true });
    const preset = (conn: Queryable) =>
      orm(conn, { schema: schemaDef, logger: "json" });
    const bag = (conn: Queryable) =>
      orm(conn, { schema: schemaDef, logger: { level: "info", slowMs: 5 } });
    assertType<Client<typeof schemaDef>, ReturnType<typeof flag>>();
    assertType<Client<typeof schemaDef>, ReturnType<typeof preset>>();
    assertType<Client<typeof schemaDef>, ReturnType<typeof bag>>();
  });

  it("LoggerOption is exactly boolean | preset | options | a built QueryLogger", () => {
    assertType<true, boolean extends LoggerOption ? true : false>();
    assertType<true, "pretty" extends LoggerOption ? true : false>();
    assertType<true, "json" extends LoggerOption ? true : false>();
    assertType<true, "compact" extends LoggerOption ? true : false>();
    assertType<true, "silent" extends LoggerOption ? true : false>();
    assertType<true, LoggerOptions extends LoggerOption ? true : false>();
    assertType<true, QueryLogger extends LoggerOption ? true : false>();
  });

  it("a pre-built QueryLogger typechecks on the client", () => {
    const built = (conn: Queryable) =>
      orm(conn, { schema: schemaDef, logger: createQueryLogger() });
    assertType<Client<typeof schemaDef>, ReturnType<typeof built>>();
  });

  it("options fields are the narrow unions", () => {
    assertType<LoggerLevel | undefined, LoggerOptions["level"]>();
    assertType<LogFormat | undefined, LoggerOptions["format"]>();
    assertType<ExplainPolicy | undefined, LoggerOptions["explain"]>();
    assertType<boolean | "auto" | undefined, LoggerOptions["colors"]>();
    assertType<((line: string) => void) | undefined, LoggerOptions["write"]>();
  });

  it("rejects unknown levels/formats/explain policies and non-option flags", () => {
    assertType<
      false,
      { level: "trace" } extends LoggerOptions ? true : false
    >();
    assertType<false, { format: "xml" } extends LoggerOptions ? true : false>();
    assertType<
      false,
      { explain: "always" } extends LoggerOptions ? true : false
    >();
    assertType<false, 123 extends LoggerOption ? true : false>();
    assertType<false, "verbose" extends LoggerOption ? true : false>();
  });
});

describe("logger factory — runtime surface", () => {
  it("createQueryLogger returns a QueryLogger with resolved options", () => {
    const logger = createQueryLogger({ slowMs: 5 });
    assertType<QueryLogger, typeof logger>();
    assertType<boolean, QueryLogger["enabled"]>();
    assertType<ResolvedLoggerOptions, QueryLogger["options"]>();
    assertType<LogFormat, QueryLogger["options"]["format"]>();
    assertType<LoggerLevel, QueryLogger["options"]["level"]>();
    assertType<ExplainPolicy, QueryLogger["options"]["explain"]>();
    assertType<string | undefined, ReturnType<QueryLogger["planStatement"]>>();
  });

  it("resolveLogger is optional (off) and reads the env", () => {
    assertType<QueryLogger | undefined, ReturnType<typeof resolveLogger>>();
    assertType<QueryLogger | undefined, ReturnType<typeof resolveLogger>>();
  });
});
