// The Zod-check → SurrealQL ASSERT bridge: the `string::is_*` format vocabulary, the
// `optional`/`nullable` peeler every `$`-constraint reads through, and the check/family analysis
// that `SField`'s bound helpers and `$assert()` derivation share. Kept OUT of `pure.ts` (the
// authoring surface) so the check vocabulary and the DDL fragments it maps to live in one focused
// module. Pure Zod + strings — it knows no SurrealDB authoring types.

import type { z } from "zod";

/**
 * Zod string formats whose `string::is_<fmt>` validator exists on SurrealDB v3.x
 * (probed live on 3.1.3: `RETURN string::is_<fmt>("x")`). A matching format builder
 * bakes `string::is_<fmt>($value)` by default; formats absent here (nanoid/cuid/cuid2/
 * xid/ksuid/cidrv4/cidrv6/guid/base64/base64url/e164/jwt/emoji) stay assert-free — no
 * fabricated regex. `uuid` is the native `uuid` type, not a string format (no assert).
 */
const STRING_IS_FORMATS = new Set([
  "email",
  "url",
  "ulid",
  "ipv4",
  "ipv6",
  // batch 2: 3.1.3 `string::is_*` validators with no Zod format builder (plain string
  // app-side; the ASSERT enforces the format in SurrealDB).
  "alpha",
  "alphanum",
  "ascii",
  "numeric",
  "semver",
  "hexadecimal",
  "latitude",
  "longitude",
  "ip",
  "domain",
]);

/** Map a Zod string format to its SurrealDB `string::is_*` assert, when one exists. */
export function formatAssert(format: string): string | undefined {
  return STRING_IS_FORMATS.has(format)
    ? `string::is_${format}($value)`
    : undefined;
}

/**
 * Reverse of {@link formatAssert}: recover a format name from a baked `string::is_<fmt>($value)`
 * assert. Used by `pull` to restore `s.<format>()` instead of `s.string().$assert(...)`. Returns
 * undefined for any other assert — including one that combines a format with extra text — so only an
 * exact, single-format assert reverses (a user's own assert is never swallowed).
 */
export function formatForAssert(assert: string): string | undefined {
  const m = /^string::is_([a-z0-9]+)\(\s*\$value\s*\)$/.exec(assert.trim());
  return m && STRING_IS_FORMATS.has(m[1]) ? m[1] : undefined;
}

/** The check methods that live on concrete Zod subtypes (ZodString/ZodNumber/ZodArray/ZodSet) but
 *  not the base `z.ZodType` — `$`-constraints refine through these by name. */
export type CheckMethod =
  | "min"
  | "max"
  | "length"
  | "size"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** The SurrealQL constraint family a `$`-bound can target (one per base type). */
export type BoundFamily = "string" | "number" | "array" | "set";

/** One entry in a Zod schema's `_zod.def.checks`. */
type ZodCheck = {
  _zod: {
    def: {
      check?: string;
      minimum?: number;
      maximum?: number;
      length?: number;
      /** `size_equals` (Zod set) — `size`, not `length`. */
      size?: number;
      value?: number;
      inclusive?: boolean;
      format?: string;
      pattern?: RegExp;
    };
  };
};

/**
 * The EXACT size a container's Zod checks encode, or undefined: `length_equals` for an array
 * (`.length(N)` / `.$length(N)`), `size_equals` for a set (`.size(N)` / `.$size(N)`). The ONE home
 * of the check → `array<T, N>`/`set<T, N>` mapping that type inference (`inferField`) and ASSERT
 * derivation ({@link deriveAsserts}) both read.
 */
export function exactSizeOf(
  def: { checks?: unknown; [key: string]: unknown },
  kind: "array" | "set",
): number | undefined {
  const check = kind === "set" ? "size_equals" : "length_equals";
  const d = ((def.checks ?? []) as ZodCheck[])
    .map((c) => c._zod.def)
    .find((x) => x.check === check);
  return kind === "set" ? d?.size : d?.length;
}

/**
 * Peel the value-less `optional`/`nullable` wrappers off a schema (outermost first), returning the
 * underlying schema plus the rebuild functions to re-wrap it in the SAME order. A wrapped value still
 * IS its inner type for DDL purposes: `$`-constraints and `$assert()` derivation read the inner, and
 * re-wrapping preserves `nullish()` (which is `optional<nullable<T>>`).
 */
export function peelNullish(schema: z.ZodType): {
  inner: z.ZodType;
  wraps: ((s: z.ZodType) => z.ZodType)[];
} {
  const wraps: ((s: z.ZodType) => z.ZodType)[] = [];
  let inner = schema;
  for (;;) {
    const def = inner._zod.def as { type: string; innerType?: z.ZodType };
    if (def.type === "optional") wraps.push((s) => s.optional());
    else if (def.type === "nullable") wraps.push((s) => s.nullable());
    else break;
    inner = def.innerType as z.ZodType;
  }
  return { inner, wraps };
}

/**
 * The family a schema's OWN Zod check methods can bound (`string`/`number`/`array`/`set`), or null.
 * Literals/enums are deliberately absent: a standalone `s.literal("OK")` has no `.min()` to refine,
 * so a bound on it no-ops (only inside a union do literals count as their value family — see
 * {@link constraintFamily}).
 */
function nativeFamily(schema: z.ZodType): BoundFamily | null {
  switch ((peelNullish(schema).inner._zod.def as { type?: string }).type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "array":
      return "array";
    case "set":
      return "set";
    default:
      return null;
  }
}

/**
 * The SurrealQL constraint family a UNION MEMBER contributes: its value family. Literals/enums count
 * as their VALUE family (`s.literal("OK")` bounds a string), so
 * `s.union([s.literal("OK"), s.string()])` is a single-family (string) union. Anything else
 * (object, bool, record, date, unsupported literal values) has no length/value bound.
 */
function constraintFamily(schema: z.ZodType): BoundFamily | null {
  const def = peelNullish(schema).inner._zod.def as {
    type?: string;
    values?: unknown[];
    entries?: Record<string, string | number>;
  };
  switch (def.type) {
    case "literal": {
      const values = def.values ?? [];
      if (values.every((v) => typeof v === "string")) return "string";
      return values.every((v) => typeof v === "number") ? "number" : null;
    }
    case "enum": {
      // Drop TS numeric-enum reverse mappings (name -> number), as `inferField` does.
      const entries = def.entries ?? {};
      const values = Object.values(entries).filter(
        (v) => typeof entries[v as string] !== "number",
      );
      if (values.every((v) => typeof v === "string")) return "string";
      return values.every((v) => typeof v === "number") ? "number" : null;
    }
    default:
      return nativeFamily(schema);
  }
}

/** Whether the (possibly wrapped) schema is a Zod union. */
export function isUnionSchema(schema: z.ZodType): boolean {
  return (
    (peelNullish(schema).inner._zod.def as { type?: string }).type === "union"
  );
}

/**
 * The ONE constraint family a field can be bounded by, or null when unsupported or when the members
 * DISAGREE. A mixed union (`int | string`) has no single SurrealQL function that applies to every
 * member — `string::len` on a number errors — so no bound is emitted. None-ish and `null` members
 * are ignored (they carry no bound; NULL is admitted by the emit-time null guard); any other
 * unknown member disqualifies the union. A non-union answers with its own base family.
 */
export function boundedFamily(schema: z.ZodType): BoundFamily | null {
  const def = peelNullish(schema).inner._zod.def as {
    type?: string;
    options?: z.ZodType[];
  };
  if (def.type !== "union") return nativeFamily(schema);
  const families = new Set<BoundFamily>();
  for (const member of def.options ?? []) {
    const t = (peelNullish(member).inner._zod.def as { type?: string }).type;
    if (t === "undefined" || t === "void" || t === "null") continue;
    const family = constraintFamily(member);
    if (!family) return null;
    families.add(family);
  }
  return families.size === 1 ? [...families][0] : null;
}

/**
 * Best-effort: derive DB `ASSERT` fragments from a Zod schema's checks, looking through
 * `optional`/`nullable` wrappers. Reads the Zod 4 check shape (`schema._zod.def.checks[]._zod.def`):
 * `min_length`/`max_length`/`length_equals` (strings AND arrays — emit `string::len`/`array::len`
 * by base type), set `min_size`/`max_size`/`size_equals` (sets only — a `map`'s checks would
 * mis-fire `array::len` on an object), `string_format` (regex -> `$value = /…/`;
 * email/url/… -> `string::is_*`), and number `greater_than`/`less_than` (with `inclusive`). The
 * schema may itself be a `string_format` (e.g. `z.email()`), so its top-level `def.format` is mapped
 * too. Unknown checks are skipped silently.
 */
export function deriveAsserts(schema: z.ZodType): string[] {
  const { inner } = peelNullish(schema);
  const def = inner._zod.def as {
    type?: string;
    check?: string;
    format?: string;
    checks?: ZodCheck[];
  };
  const out: string[] = [];
  const isSet = def.type === "set";
  // String and array checks share Zod's `min_length`/`max_length`/`length_equals` names; the
  // SurrealQL function differs by base type. (`min_size`/`max_size`/`size_equals` are the set/map
  // names — only a SET maps to a SurrealQL `set<…>`; a map lowers to `object`.)
  const len = def.type === "array" ? "array::len" : "string::len";

  // The schema itself may be a string-format (z.email()/z.url()/…).
  if (def.check === "string_format" && typeof def.format === "string") {
    const frag = formatAssert(def.format);
    if (frag) out.push(frag);
  }

  for (const c of def.checks ?? []) {
    const d = c._zod.def;
    switch (d.check) {
      case "min_length":
        out.push(`${len}($value) >= ${d.minimum}`);
        break;
      case "max_length":
        out.push(`${len}($value) <= ${d.maximum}`);
        break;
      case "length_equals":
        out.push(`${len}($value) == ${d.length}`);
        break;
      case "min_size":
        if (isSet) out.push(`array::len($value) >= ${d.minimum}`);
        break;
      case "max_size":
        if (isSet) out.push(`array::len($value) <= ${d.maximum}`);
        break;
      case "size_equals":
        if (isSet) out.push(`array::len($value) == ${d.size}`);
        break;
      case "string_format":
        if (d.format === "regex" && d.pattern) {
          out.push(`$value = /${d.pattern.source}/`);
        } else if (typeof d.format === "string") {
          const frag = formatAssert(d.format);
          if (frag) out.push(frag);
        }
        break;
      case "greater_than":
        out.push(`$value >${d.inclusive ? "=" : ""} ${d.value}`);
        break;
      case "less_than":
        out.push(`$value <${d.inclusive ? "=" : ""} ${d.value}`);
        break;
    }
  }
  return out;
}
