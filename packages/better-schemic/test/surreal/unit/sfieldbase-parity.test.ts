import { SFieldBase as CoreSFieldBase } from "better-schemic/authoring"
import { expect, test } from "bun:test"

import { s } from "../../../src/surreal"

// DRIFT GUARD. surrealdb's `SField` can't extend core's `SFieldBase` (smart-id table covariance vs the
// erased `AnyField` — see surrealdb-sfieldbase-unification-blocked), so shared-base methods mirror them
// onto our local base. This test fails the next time core adds a base method we haven't mirrored,
// the surface can't drift the way `~standard` did. We own it (this package imports both
// core's SFieldBase and our SField); core announces every base addition in #drivers.
test("SField mirrors every method/getter on core's SFieldBase", () => {
  const coreNames = Object.getOwnPropertyNames(CoreSFieldBase.prototype).filter(
    (n) => n !== "constructor",
  )
  // A concrete field walks the full prototype chain, so `in` catches inherited + own members.
  const field = s.string() as unknown as Record<string, unknown>
  const missing = coreNames.filter((n) => !(n in field))
  expect({ missing }).toEqual({ missing: [] })
})
