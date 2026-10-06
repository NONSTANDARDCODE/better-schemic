// `surql.ident(name)` — an ESCAPED identifier fragment for presets/plugins composing dynamic
// column names. Always escapes (never binds), so a config-supplied name can't inject syntax.
import { describe, expect, test } from "bun:test";
import { surql } from "../../src/index";

describe("surql.ident", () => {
  test("plain identifiers pass through untouched", () => {
    expect(surql`${surql.ident("tenant_id")}`.query).toBe("tenant_id");
    expect(surql`${surql.ident("_x1")}`.query).toBe("_x1");
  });

  test("exotic names are escaped (and never bound)", () => {
    const q = surql`${surql.ident("tenant id")} = 1`;
    expect(q.query).toBe("⟨tenant id⟩ = 1");
    expect(q.bindings).toEqual({});
    const injected = surql`${surql.ident('a" OR 1=1 --')}`;
    expect(injected.query).toBe('⟨a" OR 1=1 --⟩');
    expect(injected.bindings).toEqual({});
  });

  test("composes with param refs and other fragments", () => {
    const q = surql`${surql.ident("org_id")} = ${surql.$.auth.id}`;
    expect(q.query).toBe("org_id = $auth.id");
    expect(q.bindings).toEqual({});
  });
});
