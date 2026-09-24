// TYPE assertions for the query logger: the `logger` client option union (flag/preset/options), the
// `createQueryLogger`/`resolveLogger` return shapes, the resolved-option fields and the invalid
// values the types reject. Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import { createQueryLogger, type resolveLogger } from "../../src/logger";
import type { Client } from "../../src/orm/client";
import { betterSchemic } from "../../src/orm/client";
import type { Queryable } from "../../src/orm/execute";
import { defineSchema } from "../../src/orm/schema";
import type {
  ExplainPolicy,
  LogFormat,
  LoggerLevel,
  LoggerOption,
  LoggerOptions,
  QueryLogger,
  ResolvedLoggerOptions,
} from "../../src/orm/types/logger";
import { defineTable, s } from "../../src/pure";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

describe("logger option — accepted shapes", () => {
  it("the flag, a preset and an options bag all typecheck on the client", () => {
    const flag = (conn: Queryable) =>
      betterSchemic(conn, { schema, logger: true });
    const preset = (conn: Queryable) =>
      betterSchemic(conn, { schema, logger: "json" });
    const bag = (conn: Queryable) =>
      betterSchemic(conn, { schema, logger: { level: "info", slowMs: 5 } });
    attest<Client<typeof schema>, ReturnType<typeof flag>>();
    attest<Client<typeof schema>, ReturnType<typeof preset>>();
    attest<Client<typeof schema>, ReturnType<typeof bag>>();
  });

  it("LoggerOption is exactly boolean | preset | options", () => {
    attest<true, boolean extends LoggerOption ? true : false>();
    attest<true, "pretty" extends LoggerOption ? true : false>();
    attest<true, "json" extends LoggerOption ? true : false>();
    attest<true, "compact" extends LoggerOption ? true : false>();
    attest<true, "silent" extends LoggerOption ? true : false>();
    attest<true, LoggerOptions extends LoggerOption ? true : false>();
  });

  it("options fields are the narrow unions", () => {
    attest<LoggerLevel | undefined, LoggerOptions["level"]>();
    attest<LogFormat | undefined, LoggerOptions["format"]>();
    attest<ExplainPolicy | undefined, LoggerOptions["explain"]>();
    attest<boolean | "auto" | undefined, LoggerOptions["colors"]>();
    attest<((line: string) => void) | undefined, LoggerOptions["write"]>();
  });

  it("rejects unknown levels/formats/explain policies and non-option flags", () => {
    attest<false, { level: "trace" } extends LoggerOptions ? true : false>();
    attest<false, { format: "xml" } extends LoggerOptions ? true : false>();
    attest<false, { explain: "always" } extends LoggerOptions ? true : false>();
    attest<false, 123 extends LoggerOption ? true : false>();
    attest<false, "verbose" extends LoggerOption ? true : false>();
  });
});

describe("logger factory — runtime surface", () => {
  it("createQueryLogger returns a QueryLogger with resolved options", () => {
    const logger = createQueryLogger({ slowMs: 5 });
    attest<QueryLogger, typeof logger>();
    attest<boolean, QueryLogger["enabled"]>();
    attest<ResolvedLoggerOptions, QueryLogger["options"]>();
    attest<LogFormat, QueryLogger["options"]["format"]>();
    attest<LoggerLevel, QueryLogger["options"]["level"]>();
    attest<ExplainPolicy, QueryLogger["options"]["explain"]>();
    attest<string | undefined, ReturnType<QueryLogger["planStatement"]>>();
  });

  it("resolveLogger is optional (off) and reads the env", () => {
    attest<QueryLogger | undefined, ReturnType<typeof resolveLogger>>();
    attest<QueryLogger | undefined, ReturnType<typeof resolveLogger>>();
  });
});
