// Typed-fragments PHASE 1: raw surql predicates inside combinators (with interpolatable
// FieldRefs), chainable Expr combinators (.and/.or/.not — no standalone import), and
// Def.call(args) — the one-object call: a typed BoundQuery<[R]> fragment that is also runnable
// (.run). (M0.5: the fluent builder was retired; the Expr layer is exercised through refs.)
import { setDefaultTimeout } from "bun:test";

// The workspace gate runs every package's suite IN PARALLEL — parallel-suite CPU contention can slow live
// connects/DDL far past bun's 30s default, timing out beforeAll/afterAll hooks (reported as
// "(unnamed)" tests). Live work gets a generous ceiling; isolated runs are unaffected.
setDefaultTimeout(120_000);

import { describe, expect, test } from "bun:test";
import { BoundQuery } from "surrealdb";
import {
  CallQuery,
  defineFunction,
  defineTable,
  s,
  surql,
} from "../../src/index";
import { type FieldRef, lowerExpr, mkRef } from "../../src/surql/predicate";
import type { Ctx } from "../../src/surql/render";

const SendMail = defineFunction("p1_send_mail", {
  email: s.string(),
  code: s.string(),
})
  .returns(s.string())
  .body(surql`RETURN $email + ":" + $code`);

const User = defineTable("p1_user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
});

// --- type-level assertions -----------------------------------------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const callQ = SendMail.call({ email: "a@b.c", code: "X" });
type CallRes = Awaited<ReturnType<(typeof callQ)["run"]>>;
type _call = Expect<Equal<CallRes, string>>; // decoded via .returns(s.string())
type _frag = Expect<
  Equal<typeof callQ extends BoundQuery<[string]> ? true : false, true>
>;

const _argTyping = () => {
  // @ts-expect-error — unknown arg name
  SendMail.call({ email: "a", codee: "X" });
  // @ts-expect-error — missing required arg
  SendMail.call({ email: "a" });
};

describe("Expr combinators — no standalone and/or import needed", () => {
  const ref = <T>(col: string, kind: "string" | "number") =>
    mkRef({ root: { col }, kind }) as FieldRef<T>;
  const lower = (build: (ctx: Ctx) => unknown) => {
    const ctx: Ctx = { vars: {} };
    return { sql: lowerExpr(build(ctx) as never, ctx), vars: ctx.vars };
  };

  test(".and/.or/.not chain and lower with correct grouping", () => {
    const { sql, vars } = lower((ctx) =>
      ref<number>("age", "number")
        .gte(18)
        .and(ref<string>("email", "string").includes("@corp.com"))
        .or(ref<string>("name", "string").eq("root")),
    );
    expect(sql).toMatch(
      /^\(\(age >= \$b\d+ AND email CONTAINS \$b\d+\) OR name = \$b\d+\)$/,
    );
    expect(Object.values(vars)).toEqual(["@corp.com", 18, "root"].sort());
  });

  test(".not() negates", () => {
    const { sql } = lower(() => ref<number>("age", "number").gte(18).not());
    expect(sql).toMatch(/^!\(age >= \$b\d+\)$/);
  });
});

describe("raw predicates in combinators — the escape hatch stays typed", () => {
  test("a surql fragment is a predicate leaf; hand-built bind names get collision-renamed", () => {
    const ctx: Ctx = { vars: {} };
    const handmade = new BoundQuery("age > $b0", { b0: 99 });
    const sql = lowerExpr(
      mkRef({ root: { col: "name" }, kind: "string" })
        .eq("x")
        .and(handmade),
      ctx,
    );
    // The comparison already used $b0 for "x" — the fragment's $b0 renames.
    expect(sql).toMatch(/^\(name = \$b0 AND \(age > \$b0_2\)\)$/);
    expect(ctx.vars.b0).toBe("x");
    expect(ctx.vars.b0_2).toBe(99);
  });
});

describe("Def.call(args) — fragment + runnable, one object", () => {
  test("literals encode + bind; the text is fn::name(...)", () => {
    const q = SendMail.call({ email: "a@b.c", code: "XYZ" });
    expect(q).toBeInstanceOf(CallQuery);
    expect(q).toBeInstanceOf(BoundQuery);
    expect(q.query).toMatch(
      /^fn::p1_send_mail\(\$call__\d+_email, \$call__\d+_code\)$/,
    );
    expect(Object.values(q.bindings ?? {}).sort()).toEqual(["XYZ", "a@b.c"]);
  });

  test("fragment and surql.$ args splice instead of binding", () => {
    const q = SendMail.call({
      email: surql.$.after.email,
      code: surql`string::uppercase(${"abc"})`,
    });
    expect(q.query).toContain(
      "fn::p1_send_mail($after.email, (string::uppercase($bind__",
    );
  });

  test("the call interpolates into a template like any fragment", () => {
    const q = surql`RETURN ${SendMail.call({ email: surql.$.after.email, code: surql.$.code })};`;
    expect(q.query).toBe("RETURN fn::p1_send_mail($after.email, $code);");
  });

  test("an unbound run() rejects with clear guidance", async () => {
    await expect(
      SendMail.call({ email: "a", code: "b" }).run(),
    ).rejects.toThrow(/not bound to a connection/);
  });
});
