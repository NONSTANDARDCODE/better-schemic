/**
 * The field WALKER — one Zod schema -> `FieldInfo` pass, shared by the DDL emitter and the query
 * layer. It owns two things:
 *
 *  - the SurrealQL **wire type** string + its nested child tree (object subfields `path.key`,
 *    array/record element fields `path.*`) — what `emitTable`/the Struct-IR lowering walk;
 *  - the structured **classification** (operator family, optionality, record-link targets) the
 *    `/orm` layer projects into column/link metadata.
 *
 * Keeping BOTH here is deliberate: the query layer used to re-parse the emitted type string, which
 * made classification a second, silently-diverging source of truth. Now the walker that already
 * knows the shape computes the metadata once, and `inferField` is exported by `./ddl` (and the
 * `/driver` surface) exactly as before.
 *
 * Neutral module: no emit, no CLI, no driver registration.
 */
import { escapeIdent, toSurqlString } from "surrealdb";
import type { z } from "zod";
import { exactSizeOf } from "./checks";
import {
  objectFieldsRegistry,
  type SurrealMeta,
  surrealTypeRegistry,
} from "./pure";
import { splitTopUnion } from "./surql-type-expr";

/** The operator family a field belongs to — drives `where` typing and identifier validation. */
export type FieldFamily =
  | "string"
  | "number"
  | "bool"
  | "date"
  | "duration"
  | "bytes"
  | "record"
  | "geometry"
  | "object"
  | "array"
  | "set"
  | "any"
  | "other";

/** Record-link metadata: `targets` omitted = a bare `record` (any table). */
export interface FieldRecord {
  readonly targets?: readonly string[];
}

/**
 * The SurrealQL type of a field plus any nested fields it expands into:
 * object subfields (`path.key`) and array/record element fields (`path.*`).
 * Exported (with {@link inferField}) so the Struct-IR lowering walks the SAME child tree the
 * emitter does — so the two can't disagree on type strings or dotted field paths.
 */
export interface FieldInfo {
  type: string;
  flexible: boolean;
  children: { suffix: string; info: FieldInfo; surreal?: SurrealMeta }[];
  /** Operator family (query-layer metadata; the DDL never reads it). */
  family: FieldFamily;
  /** `option<…>` / `| null` / a none-ish union member. */
  optional: boolean;
  /** For `array<…>`/`set<…>`: the element's family. */
  element?: FieldFamily;
  /** Present for record links (bare or targeted, single or inside a collection). */
  record?: FieldRecord;
}

const leaf = (
  type: string,
  family: FieldFamily = "other",
  extra: Partial<Pick<FieldInfo, "optional" | "element" | "record">> = {},
): FieldInfo => ({
  type,
  flexible: false,
  children: [],
  family,
  optional: false,
  ...extra,
});

/** Read a Zod schema's internal def with a loose type for traversal. */
function zdef(schema: z.ZodType): { type: string; [k: string]: unknown } {
  return schema._zod.def as unknown as { type: string; [k: string]: unknown };
}

/** Format a literal value as a SurrealQL literal type (e.g. `'admin'`, `42`). */
function surqlLiteral(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return toSurqlString(value).replace(/^s"/, '"');
}

/** Structural metadata of a Surreal NATIVE type string (the registry's `datetime`/`record<…>`/…). */
function nativeMeta(type: string): {
  family: FieldFamily;
  record?: FieldRecord;
} {
  if (type === "datetime") return { family: "date" };
  if (type === "uuid") return { family: "string" };
  if (type === "int" || type === "decimal") return { family: "number" };
  if (type === "bytes") return { family: "bytes" };
  if (type === "duration") return { family: "duration" };
  if (type === "geometry" || type.startsWith("geometry<"))
    return { family: "geometry" };
  if (type === "record") return { family: "record", record: {} };
  if (type.startsWith("record<")) {
    const targets = type
      .slice("record<".length, -1)
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    return { family: "record", record: targets.length ? { targets } : {} };
  }
  return { family: "other" }; // file, or a native type with no query family
}

const nativeLeaf = (type: string): FieldInfo => {
  const meta = nativeMeta(type);
  return leaf(type, meta.family, meta.record ? { record: meta.record } : {});
};

/** The family a literal value carries (enum/literal unions). */
function literalFamily(value: unknown): FieldFamily {
  if (typeof value === "string") return "string";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "boolean") return "bool";
  return "other";
}

const familiesOf = (values: readonly unknown[]): FieldFamily => {
  if (!values.length) return "any";
  const families = new Set(values.map(literalFamily));
  return families.size === 1 ? [...families][0] : "other";
};

/** Infer a field's SurrealQL type + nested structure + classification from a Zod schema. Exported
 *  so the Struct-IR lowering (`fromTableDef`) and the emitter share one source of truth. */
export function inferField(
  schema: z.ZodType,
  seen: Set<z.ZodType> = new Set(),
): FieldInfo {
  // Surreal-native schemas (datetime, recordId) carry their type explicitly.
  const explicit = surrealTypeRegistry.get(schema);
  if (explicit) return nativeLeaf(explicit);

  const def = zdef(schema);
  switch (def.type) {
    case "string":
    case "template_literal": // z.templateLiteral — a string-typed literal pattern
      return leaf("string", "string");
    case "number": {
      // z.int/int32/uint32/float64 share def.type "number"; the format discriminates.
      const fmt = def.format as string | undefined;
      if (fmt?.includes("float")) return leaf("float", "number");
      if (fmt?.includes("int")) return leaf("int", "number");
      return leaf("number", "number");
    }
    case "bigint":
      return leaf("int", "number");
    case "boolean":
      return leaf("bool", "bool");
    case "date":
      return leaf("datetime", "date");
    case "any":
    case "unknown":
      return leaf("any", "any");
    case "null":
      return leaf("null", "other");

    // No SurrealQL mapping — these exist on `s.*` only for drop-in `z.*` parity, and are
    // rejected when used as a table field. (Registered native types — datetime/uuid/record/…
    // — are caught by the `surrealTypeRegistry` check at the top, so they never reach here.)
    case "symbol":
    case "undefined":
    case "void":
    case "never":
    case "nan":
    case "function":
    case "promise":
    case "custom":
      throw new Error(
        `s.${def.type}() has no SurrealQL type and can't be used as a table field. ` +
          `Use a Surreal-native builder (e.g. s.string / s.int / s.datetime / s.uuid / ` +
          `s.recordId) instead, or keep this schema out of your table definitions.`,
      );

    case "optional":
    case "default":
    case "prefault": {
      const inner = inferField(def.innerType as z.ZodType, seen);
      // `any` already admits NONE/NULL, so `option<any>` is invalid SurrealQL — leave it as `any`.
      if (inner.type === "any") return inner;
      return { ...inner, type: `option<${inner.type}>`, optional: true };
    }
    case "nullable": {
      const inner = inferField(def.innerType as z.ZodType, seen);
      if (inner.type === "any") return inner; // `any` already includes null
      // Fold null INTO an existing option<X> so .optional().nullable() matches
      // .nullish()/.nullable().optional(): option<X> | null -> option<X | null>.
      if (inner.type.startsWith("option<") && inner.type.endsWith(">")) {
        const x = inner.type.slice("option<".length, -1);
        return { ...inner, type: `option<${x} | null>`, optional: true };
      }
      return { ...inner, type: `${inner.type} | null`, optional: true };
    }
    case "readonly":
    case "catch": // app-side error recovery — the stored type is the inner type
      return inferField(def.innerType as z.ZodType, seen);
    case "pipe": // a codec with no explicit type — use its encoded (wire) side
      return inferField(def.in as z.ZodType, seen);

    case "lazy": {
      // Track the lazy schema itself: its getter returns a fresh instance each call,
      // but the recursive reference reuses the same lazy node.
      if (seen.has(schema)) return leaf("any", "any");
      seen.add(schema);
      const info = inferField((def.getter as () => z.ZodType)(), seen);
      seen.delete(schema);
      return info;
    }

    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      const fields = objectFieldsRegistry.get(schema); // SField shape if built via s.object
      const catchall = def.catchall as z.ZodType | undefined;
      const flexible = !!catchall && zdef(catchall).type === "unknown";
      const children = Object.entries(shape).map(([key, value]) => ({
        suffix: `.${escapeIdent(key)}`,
        info: inferField(value, seen),
        surreal: fields?.[key]?.surreal,
      }));
      return {
        type: "object",
        flexible,
        children,
        family: "object",
        optional: false,
      };
    }

    case "intersection": {
      const left = inferField(def.left as z.ZodType, seen);
      const right = inferField(def.right as z.ZodType, seen);
      if (left.type === "object" && right.type === "object") {
        const merged = new Map(left.children.map((c) => [c.suffix, c]));
        for (const c of right.children) merged.set(c.suffix, c); // right wins on overlap
        return {
          type: "object",
          flexible: left.flexible || right.flexible,
          children: [...merged.values()],
          family: "object",
          optional: false,
        };
      }
      return leaf("any", "any");
    }

    case "array":
    case "set": {
      const elem = inferField(
        (def.element ?? def.valueType) as z.ZodType,
        seen,
      );
      // A FLEXIBLE element bubbles to the ARRAY field — SurrealDB stores `array<object> FLEXIBLE`
      // on the field, with the auto-created `.*` element a plain `object` (re-defining `.*` errors).
      // So the child keeps the element's structure but drops its `flexible` (it lives on the parent).
      const childElem = elem.flexible ? { ...elem, flexible: false } : elem;
      // Element subfields live under `path.*`, but only when the element is structured.
      const children =
        childElem.children.length > 0 || childElem.type === "object"
          ? [{ suffix: ".*", info: childElem }]
          : [];
      // `set<T>` is distinct from `array<T>` in SurrealDB (dedup) and round-trips — preserve it.
      const kw = def.type === "set" ? "set" : "array";
      // `array<T, N>` / `set<T, N>` — N is an EXACT size in SurrealQL (not a maximum), so it maps ONLY
      // from Zod's exact-size check: `.length(N)` / `.$length(N)` (`length_equals`) on arrays,
      // `.size(N)` / `.$size(N)` (`size_equals`) on sets. A `.max()` bound is a DB ASSERT
      // (`array::len($value) <= N`), never a type size.
      const size = exactSizeOf(def, kw);
      const sizeSql = typeof size === "number" ? `, ${size}` : "";
      return {
        type: `${kw}<${elem.type}${sizeSql}>`,
        flexible: elem.flexible,
        children,
        family: kw,
        optional: false,
        element: elem.family,
        ...(elem.record ? { record: elem.record } : {}),
      };
    }

    case "record":
    case "map": {
      const value = inferField(def.valueType as z.ZodType, seen);
      return {
        type: "object",
        flexible: false,
        children: [{ suffix: ".*", info: value }],
        family: "object",
        optional: false,
      };
    }

    case "union": {
      const opts = (def.options ?? []) as z.ZodType[];
      // A `none`-ish member (z.undefined()/z.void()) makes the union optional: `T | none` -> `option<T>`.
      const noneish = (o: z.ZodType) => {
        const t = zdef(o).type;
        return t === "undefined" || t === "void";
      };
      let hasNone = opts.some(noneish);
      const members = opts
        .filter((o) => !noneish(o))
        .map((o) => inferField(o, seen));
      // Flatten every member's type into top-level ATOMS, hoisting `option<…>` onto the union:
      // SurrealDB canonicalizes `option<X> | Y` to `none | X | Y` (== `option<X | Y>`), and a
      // member that is itself a union (`X | null`) contributes its members — e.g.
      // `s.union([s.string().optional(), s.string().nullable()])` -> `option<string | null>`,
      // exactly what `normalizeType`/`fromInfo` produce (duplicates would phantom-diff).
      const atoms: string[] = [];
      for (const m of members) {
        const opt = /^option<([\s\S]+)>$/.exec(m.type);
        let body = m.type;
        if (opt) {
          hasNone = true;
          body = opt[1];
        }
        for (const atom of splitTopUnion(body)) if (atom) atoms.push(atom);
      }
      const types = [...new Set(atoms)];
      // A union whose type contains an object carries FLEXIBLE on the field (e.g. `object | string
      // FLEXIBLE`) when any object member was made flexible.
      const flexible = members.some((m) => m.flexible);
      // `any` absorbs every other member (including none) — `any | string` is invalid → `any`.
      if (types.includes("any")) return leaf("any", "any");
      const joined = types.join(" | ") || "any";
      const type = hasNone && joined !== "any" ? `option<${joined}>` : joined;

      // Classification: `null` members make the field optional (without changing the type text);
      // the family comes from the remaining members — homogeneous unions keep it, mixed ones
      // degrade to `other`. Record targets merge across members (a bare `record` erases them).
      const nullish = members.some((m) => m.type === "null");
      const real = members.filter((m) => m.type !== "null");
      const families = new Set(real.map((m) => m.family));
      const family: FieldFamily =
        families.size === 1 ? [...families][0] : "other";
      const optional = hasNone || nullish || real.some((m) => m.optional);
      const record =
        family === "record" &&
        real.length > 0 &&
        real.every((m) => m.record !== undefined)
          ? real.every((m) => m.record?.targets !== undefined)
            ? {
                targets: [
                  ...new Set(real.flatMap((m) => m.record?.targets ?? [])),
                ],
              }
            : {}
          : undefined;
      return {
        type,
        flexible,
        children: [],
        family,
        optional,
        ...(record ? { record } : {}),
      };
    }
    case "enum": {
      const entries = (def.entries ?? {}) as Record<string, string | number>;
      // Drop TS numeric-enum reverse mappings (name->number); keep the real values.
      const values = Object.values(entries).filter(
        (v) => typeof entries[v as string] !== "number",
      );
      const types = [...new Set(values.map(surqlLiteral))];
      return leaf(types.join(" | ") || "any", familiesOf(values));
    }
    case "literal": {
      const values = (def.values ?? []) as unknown[];
      const types = [...new Set(values.map(surqlLiteral))];
      return leaf(types.join(" | ") || "any", familiesOf(values));
    }
    case "tuple": {
      if (def.rest) return leaf("array", "array", { element: "other" }); // variadic tuple
      const items = (def.items ?? []) as z.ZodType[];
      return leaf(
        `[${items.map((i) => inferField(i, seen).type).join(", ")}]`,
        "other",
      );
    }

    default:
      return leaf("any", "any");
  }
}
