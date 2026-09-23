// M4.2 — TYPE assertions for live queries: the notification envelope (discriminated on `action`),
// the row shape following `select`, the delegate/client surfaces and the args guardrails.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { RecordId } from "surrealdb";
import { type App, defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import type {
  LiveArgs,
  LiveChange,
  LiveNotification,
  LiveReconnected,
  LiveResult,
  LiveRow,
  LiveSubscription,
} from "../../src/orm/types/live";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

const UserBase = defineTable("user", { name: s.string(), age: s.int() });
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
});
const schema = defineSchema({ users: User });
type C = Client<typeof schema>;
type U = typeof User;
type LiveRowName = { name: string };

/** Call shapes (instantiation expressions don't survive esbuild/tsx). */
const liveSelected = (client: C) =>
  client.users.live({
    where: { age: { gte: 18 } },
    select: { id: true, name: true },
  });
const liveFull = (client: C) => client.users.live({ diff: true });
const liveDynamic = (client: C) =>
  client.live("users", { where: { name: "A" } });
describe("live — typing", () => {
  it("the subscription row follows select (and the full row otherwise)", () => {
    // Derived from the SAME `App` field so the expected type can't drift on RecordId generics.
    attest<
      { id: App<U>["id"]; name: string },
      LiveRow<U, { select: { id: true; name: true } }>
    >();
    attest<App<U>, LiveRow<U, { diff: true }>>();
    attest<
      LiveResult<U, { select: { id: true; name: true } }>,
      ReturnType<typeof liveSelected>
    >();
    attest<LiveResult<U, { diff: true }>, ReturnType<typeof liveFull>>();
    // The dynamic form is the full-row default (no `select`).
    attest<
      LiveResult<U, Record<string, never>>,
      ReturnType<typeof liveDynamic>
    >();
  });

  it("notifications discriminate on action (RECONNECTED has no recordId)", () => {
    // The union IS the change payload plus the lifecycle event (no Extract — tsgo defers
    // conditional-type instantiation inside attest's constraint check).
    attest<
      LiveNotification<LiveRowName>,
      LiveChange<LiveRowName> | LiveReconnected
    >();
    attest<null, LiveReconnected["value"]>();
    attest<false, "recordId" extends keyof LiveReconnected ? true : false>();
    attest<RecordId, LiveChange<LiveRowName>["recordId"]>();
    attest<{ name: string } | null, LiveChange<LiveRowName>["value"]>();
  });

  it("live args accept the read where/select and link fetches only", () => {
    attest<
      true,
      "mentor" extends NonNullable<LiveArgs<U>["fetch"]>[number] ? true : false
    >();
    attest<
      false,
      "nope" extends NonNullable<LiveArgs<U>["fetch"]>[number] ? true : false
    >();
    attest<true, "diff" extends keyof LiveArgs<U> ? true : false>();
    attest<true, "where" extends keyof LiveArgs<U> ? true : false>();
    attest<true, "select" extends keyof LiveArgs<U> ? true : false>();
  });

  it("client surfaces keep their shapes", () => {
    attest<
      Promise<LiveSubscription<Record<string, unknown>>>,
      ReturnType<C["liveOf"]>
    >();
    attest<Promise<void>, ReturnType<C["kill"]>>();
  });
});
