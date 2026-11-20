// A shared DRIVER CONFORMANCE suite — the runtime contract a `@better-schemic/<driver>` must , asserted
// with `bun:test`. Each driver runs it against its own authoring surface:
//
//   import { describeDriverConformance } from "./testing";
//   import { table, s, surrealDriver } from "../surreal";
//   describeDriverConformance({ name: "surrealdb", s, driver: surrealDriver, defineEntity: table });
//
// WHY a test, not a type: the zod drop-in builders (`s.string()` = `new <D>Field(z.string())`) are
// mechanically identical across drivers, but TypeScript has NO higher-kinded types, so a generic core
// factory can't preserve each driver's field type (it collapses to the base, dropping `$`-methods).
// Each driver hand-authors its drop-ins, and "`s` is a Zod SUPERSET" is enforceable at
// runtime. This suite is that enforcement.
//
// It DUCK-TYPES fields (a field is "something with a `.schema` that is a Zod type") rather than using
// `instanceof SFieldBase` — a driver may extend its own copy of the base, so identity checks are unsafe.

import { describe, expect, test } from "bun:test"
import type * as z from "zod"

import { type Driver, driverNames, getDriver } from "./driver/driver"
import { emitKinds, lowerSchema } from "./kind"

/**
 * The driver's authoring namespace (`s`) — a bag of field builders, some NESTED (e.g.
 * `s.iso.{date,time,datetime,duration}`). Intentionally loose: the suite duck-types fields and
 * enforces the real contract at RUNTIME, not via this type (see the header note), so a precise
 * "function-or-nested-namespace" shape would  fight the internal `s.<key>()` calls for no gain.
 */
type Authoring = Record<string, any>

export interface DriverConformanceOptions {
  /**
   * Authors the driver's primary fielded definable — a table, collection, node-type, … — from a name
   * and a field shape. Used to lower a probe object through the pipeline. Drivers pass their own
   * `define*` for this (e.g. `defineEntity: table`); the suite stays shape-agnostic.
   */
  defineEntity: (name: string, shape: Record<string, any>) => any
  /** The driver under test (already registered by importing its package). */
  driver: Driver<unknown>
  /** The driver's registry name (e.g. `"surrealdb"`). */
  name: string
  /** The driver's authoring namespace — the `s` each package exports. */
  s: Authoring
}

/**
 * The canonical zod DROP-IN set every driver's `s` MUST expose — the structural Zod builders that make
 * a `@better-schemic/<driver>` a drop-in for `z`. Each maps to the DB's natural representation (a driver may
 * also offer richer native aliases, e.g. `text`/`varchar` alongside `string`). `object`/`array` nest a
 * `literal` (present everywhere) so a missing `string` doesn't cascade into their tests.
 */
const DROP_INS: { build: (s: Authoring) => unknown; key: string }[] = [
  { build: (s) => s.string(), key: "string" },
  { build: (s) => s.number(), key: "number" },
  { build: (s) => s.boolean(), key: "boolean" },
  { build: (s) => s.date(), key: "date" },
  { build: (s) => s.literal("a"), key: "literal" },
  { build: (s) => s.enum(["a", "b"]), key: "enum" },
  { build: (s) => s.object({ inner: s.literal("a") }), key: "object" },
  { build: (s) => s.array(s.literal("a")), key: "array" },
]

/** Value pairs that prove a scalar drop-in carries the right Zod schema (unambiguous scalars ). */
const SCALAR_CHECKS: { invalid: unknown; key: string; valid: unknown }[] = [
  { invalid: 123, key: "string", valid: "hello" },
  { invalid: "hello", key: "number", valid: 123 },
  { invalid: "hello", key: "boolean", valid: true },
]

/** Duck-typed: a field exposes a Zod `.schema`; a raw Zod type IS the schema. Throws if neither. */
function toSchema(v: unknown): z.ZodType {
  const field = v as { schema?: unknown } | null
  if (field && isZod(field.schema)) {
    return field.schema as z.ZodType
  }
  if (isZod(v)) {
    return v as z.ZodType
  }
  throw new Error("expected a field (with a `.schema` Zod type) or a Zod type")
}

function isZod(v: unknown): boolean {
  return !!v && typeof (v as { safeParse?: unknown }).safeParse === "function"
}

/** Is `v` a driver field (has a `.schema` that is a Zod type)? */
function isField(v: unknown): boolean {
  return isZod((v as { schema?: unknown } | null)?.schema)
}

/**
 * Assert a `@better-schemic/<driver>` conforms to the Better-schemic driver contract: the Driver registers it with
 * the IR pipeline + execution ops, and its `s` is a Zod-drop-in SUPERSET (the canonical drop-in set is
 * present, carries the right schemas, composes through wrappers, and lowers to the portable IR).
 */
export function describeDriverConformance(opts: DriverConformanceOptions): void {
  const { defineEntity, driver, name, s } = opts

  describe(`driver conformance: ${name}`, () => {
    describe("Driver contract", () => {
      test("is registered under its name", () => {
        expect(driverNames()).toContain(name)
        expect(getDriver(name)).toBe(driver)
        expect(driver.name).toBe(name)
      })

      test("exposes a kind registry + the schema/execution ops", () => {
        // Schema ops are generic over `registry`; the driver provides the fan-out + execution.
        expect(driver.registry).toBeDefined()
        expect(typeof driver.registry.entries).toBe("function")
        expect(driver.registry.names().length).toBeGreaterThan(0)
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (const op of ["explode", "introspectAll", "connect", "apply", "close"] as const) {
          expect(typeof driver[op]).toBe("function")
        }
      })
    })

    describe("zod drop-in surface (s.* is a Zod superset)", () => {
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const { build, key } of DROP_INS) {
        test(`s.${key}() exists and returns a field`, () => {
          expect(typeof s[key]).toBe("function")
          const field = build(s)
          expect(isField(field)).toBe(true)
        })
      }

      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const { invalid, key, valid } of SCALAR_CHECKS) {
        test(`s.${key}() carries a "${key}" Zod schema`, () => {
          const schema = toSchema(s[key]())
          expect(schema.safeParse(valid).success).toBe(true)
          expect(schema.safeParse(invalid).success).toBe(false)
        })
      }
    })

    describe("Zod-clean codecs + wrappers", () => {
      test("decode/encode delegate to the inner Zod schema", () => {
        const field = s.string() as {
          decode: (v: unknown) => unknown
          encode: (v: unknown) => unknown
        }
        expect(field.decode("hi")).toBe("hi")
        expect(field.encode("hi")).toBe("hi")
      })

      test("wrappers preserve field-ness (optional/array compose)", () => {
        const field = s.string() as {
          array: () => unknown
          optional: () => unknown
        }
        expect(isField(field.optional())).toBe(true)
        expect(isField(field.array())).toBe(true)
      })
    })

    describe("lowering (drop-in fields → kind registry)", () => {
      test("an entity of drop-in fields explodes + lowers + emits, carrying every field", () => {
        const shape: Record<string, unknown> = {}
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (const { build, key } of DROP_INS) {
          shape[`f_${key}`] = build(s)
        }
        const entity = defineEntity("better_schemic_conformance_probe", shape)

        // explode (authoring -> kinded definables) -> lowerSchema -> portable objects.
        const portable = lowerSchema(driver.registry, driver.explode([entity], []))
        // Kind-agnostic: the probe lowers to at least one object (its kind is the driver's own —
        // `table`, `collection`, …); the per-field check below is what proves lowering is faithful.
        expect(portable.length).toBeGreaterThan(0)

        // The portable shape is the driver's own, but the emitted DDL is generic: every drop-in
        // field name must appear in it (lowering + emit carried it through).
        const ddl = emitKinds(driver.registry, portable).join("\n")
        expect(ddl.length).toBeGreaterThan(0)
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (const { key } of DROP_INS) {
          expect(ddl).toContain(`f_${key}`)
        }
      })
    })
  })
}
