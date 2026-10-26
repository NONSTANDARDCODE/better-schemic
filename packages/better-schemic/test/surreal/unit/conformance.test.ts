// Driver conformance — asserts the better-schemic/core Driver contract (registration + IR/exec ops) and the
// Zod drop-in philosophy (s.* is a Zod superset with the canonical type set). Shared suite lives in
// Better-schemic/testing; each driver wires it to its own s / driver / defineEntity.
import { defineTable, s } from "better-schemic"
import { surrealDriver } from "better-schemic/driver"
import { describeDriverConformance } from "better-schemic/testing"

import type { DriverConformanceOptions } from "better-schemic/testing"

describeDriverConformance({
  name: "surrealdb",
  // `s` is a Zod SUPERSET — it has non-function members (e.g. `s.coerce`) that don't fit the suite's
  // Loose `Record<string, fn>` shape. The suite duck-types the canonical methods at runtime, so cast.
  s,
  driver: surrealDriver,
  defineEntity: defineTable,
})
