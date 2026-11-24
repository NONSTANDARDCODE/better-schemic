// The DIALECT-FREE diff DISPLAY + shared types. The SurrealDB statement-diff engine (buildSnapshot/
// diffSnapshots/renderMigration) lives in `./surreal-diff` and invoks it through the driver; this
// module is what the CLI shell uses to RENDER any driver's Diff (git-style file groups, word-diff,
// unified patch, kind summaries). Dialect-free: `kind` is an opaque string, not a Surreal kind union.
import type { KindRegistry } from "../kind"
import type { SecretRef } from "../secrets"

import { colorEnabled, style } from "./style"

/**
 * One object's change, for display. `kind` is the object kind, `table` its owner (a table name,
 * or the object's own name for db-level objects). `add` carries the new DDL; `remove` carries the
 * `REMOVE` statement (`ddl`) plus the dropped object's prior DDL (`old`, for the unified patch);
 * `change` pairs old↔new.
 */
export type DiffItem = {
  /** The source file this object lives in (or lived in, for a removal). Absent if unknown. */
  file?: string
  key: string
  /** Dialect-defined object kind (e.g. "table"/"field"/"index") — opaque to the display. */
  kind: string
  table: string
} & (
  | { after: string; before: string; op: "change" }
  | { ddl: string; old: string; op: "remove" }
  | { ddl: string; op: "add" }
)

export type Diff = {
  /**
   * Apply-time secret bindings: `$param` name -> a write- {@link SecretRef} (e.g. `env("X")`).
   * Populated by a driver whose DDL emits secret placeholders (SurrealDB `DEFINE ACCESS … KEY $param`).
   * MODEL 1: stored in the migration so it replays without the live schema; the **value never appears
   * here** — the apply layer resolves each ref through a `SecretProvider` and binds it (`db.query(ddl,
   * resolved)`), so secrets stay out of the schema, snapshot, and migration files. Diff-excluded +
   * snapshot-omitted, so a redacted secret never reads as drift.
   */
  bindings?: Record<string, SecretRef>
  down: string[]
  /** Every desired statement (the `next` schema), for the `--full` context view. */
  full?: { ddl: string; key: string; table: string }[]
  /** Structured per-object changes for the human display (word-level diff). */
  items?: DiffItem[]
  up: string[]
}

/** `true` if the two snapshots define the same objects with identical DDL. */
export function isEmptyDiff(diff: Diff): boolean {
  return diff.up.length === 0
}

/**
 * Inline word-level diff of two statements: shared tokens dim, removed tokens red, added tokens
 * green (LCS over space-separated tokens). So a changed field shows the whole statement with
 * the changed words highlighted.
 */
export function tokenDiff(before: string, after: string): string {
  const a = before.split(" ")
  const b = after.split(" ")
  const m = a.length
  const n = b.length
  // With color: red/green/dim. Without (pipe / CI / NO_COLOR): git `--word-diff=plain` markers
  // `[-removed-]`/`{+added+}` so removed-vs-added is unambiguous and assertable.
  const colored = colorEnabled()
  const del = (t: string): string => (colored ? style.red(t) : `[-${t}-]`)
  const ins = (t: string): string => (colored ? style.green(t) : `{+${t}+}`)
  const eq = (t: string): string => (colored ? style.dim(t) : t)
  // A full LCS matrix is O(m*n) cells; above the cap, keep the common prefix/suffix and mark the
  // middle removed + added (a valid, coarser word diff — never an OOM).
  if (m * n > TOKEN_LCS_LIMIT) {
    const head = Array.from({ length: Math.min(m, n) }, (_, i) => i)
    const start = head.find((i) => a[i] !== b[i]) ?? head.length
    let endA = m
    let endB = n
    Array.from({ length: Math.min(m, n) }).some(() => {
      if (endA <= start || endB <= start || a[endA - 1] !== b[endB - 1]) return true
      endA--
      endB--
      return false
    })
    return [
      ...a.slice(0, start).map((t) => eq(t)),
      ...a.slice(start, endA).map((t) => del(t)),
      ...b.slice(start, endB).map((t) => ins(t)),
      ...a.slice(endA, m).map((t) => eq(t)),
    ].join(" ")
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0))
  Array.from({ length: m }, (_, k) => m - 1 - k).forEach((i) => {
    Array.from({ length: n }, (_, k) => n - 1 - k).forEach((j) => {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    })
  })
  const out: string[] = []
  let i = 0
  let j = 0
  Array.from({ length: m + n }).some(() => {
    if (i >= m && j >= n) return true
    if (i >= m) {
      out.push(ins(b[j]))
      j++
    } else if (j >= n) {
      out.push(del(a[i]))
      i++
    } else if (a[i] === b[j]) {
      out.push(eq(a[i]))
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(del(a[i]))
      i++
    } else {
      out.push(ins(b[j]))
      j++
    }
    return false
  })
  return out.join(" ")
}

/** Cell cap for the token LCS (~1M cells ≈ a MB); above it the coarse prefix/suffix path runs. */
const TOKEN_LCS_LIMIT = 1_000_000

/**
 * Prefix EVERY line of `text` with the diff indicator — statements are multi-line now that drivers
 * pretty-print display DDL, and a bare continuation line would read as context, not change.
 */
function mark(text: string, sign: string, color: (s: string) => string): string {
  return text
    .split("\n")
    .map((l) => color(`  ${sign} ${l}`))
    .join("\n")
}

/**
 * Render one display item: `+`/`-` line for add/remove. A change renders as separate red `-` /
 * green `+` lines by default, or as a single inline word-diff when `inline` sets it (the A/B toggle).
 */
function renderItem(it: DiffItem, inline = false): string {
  if (it.op === "add") return mark(it.ddl, "+", style.green)

  if (it.op === "remove") return mark(it.ddl, "-", style.red)

  if (inline) return `    ${tokenDiff(collapseWs(it.before), collapseWs(it.after))}`

  return `${mark(it.before, "-", style.red)}\n${mark(it.after, "+", style.green)}`
}

/** The inline word-diff is a one-line token view — collapse pretty-printed statements onto it. */
function collapseWs(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim()
}

/**
 * Group diff items by their source file (git-style), so the display reads like a file diff. Items
 * with no file (an older snapshot, or the live DB) fall back to a per-object group headed by the
 * object's bare name. Returns groups in first-seen order, each with its header.
 */
function groupByFile(items: DiffItem[]): { header: string; items: DiffItem[] }[] {
  const order: string[] = []
  const byKey = new Map<string, DiffItem[]>()
  items.forEach((it) => {
    const key = it.file ?? `\0${it.table}` // \0 can't collide with a real path
    let group = byKey.get(key)
    if (!group) {
      group = []
      byKey.set(key, group)
      order.push(key)
    }
    group.push(it)
  })
  return order.map((key) => {
    const group = byKey.get(key) ?? []
    return {
      header: group.find((i) => i.file)?.file ?? group[0].table,
      items: group,
    }
  })
}

/** Render display items as a git-style file diff: each group headed by its source file path. */
export function formatItems(items: DiffItem[], inline = false): string {
  return groupByFile(items)
    .map((g) => [style.bold(g.header), ...g.items.map((it) => renderItem(it, inline))].join("\n"))
    .join("\n\n")
}

/**
 * A standard **unified diff** of the change, grouped one section per source file (git-style) — for
 * piping through a diff viewer (git's pager / delta). Objects with no file fall back to a section
 * headed by the object's bare name. A statement may be pretty-printed multi-line, so every LINE gets
 * its own `+`/`-` and the hunk counts count lines, not statements.
 */
export function formatPatch(diff: Diff): string {
  const items = diff.items ?? []
  if (items.length === 0) return ""

  const out: string[] = []
  groupByFile(items).forEach(({ header, items: group }) => {
    const lines: string[] = []
    let dels = 0
    let adds = 0
    const push = (text: string, sign: "+" | "-"): void => {
      text.split("\n").forEach((l) => {
        lines.push(`${sign}${l}`)
        if (sign === "+") adds++
        else dels++
      })
    }
    group.forEach((it) => {
      if (it.op === "add") push(it.ddl, "+")
      else if (it.op === "remove") push(it.old, "-")
      else {
        push(it.before, "-")
        push(it.after, "+")
      }
    })
    out.push(
      `diff --git a/${header} b/${header}`,
      `--- a/${header}`,
      `+++ b/${header}`,
      `@@ -${dels ? 1 : 0},${dels} +${adds ? 1 : 0},${adds} @@`,
      ...lines,
    )
  })
  return `${out.join("\n")}\n`
}

/** `--full`: the whole desired schema — unchanged dim, additions green, changes word-diffed. */
function formatFull(diff: Diff, inline = false): string {
  const byKey = new Map((diff.items ?? []).map((it) => [it.key, it]))
  const out: string[] = []
  let prev: string | undefined
  ;(diff.full ?? []).forEach((f) => {
    if (prev !== undefined && f.table !== prev) out.push("")

    const it = byKey.get(f.key)
    if (it?.op === "change") out.push(renderItem(it, inline))
    else if (it?.op === "add") out.push(mark(f.ddl, "+", style.green))
    else {
      out.push(
        f.ddl
          .split("\n")
          .map((l) => style.dim(`    ${l}`))
          .join("\n"),
      )
    }
    prev = f.table
  })
  const removed = (diff.items ?? []).filter((it) => it.op === "remove")
  if (removed.length > 0) {
    out.push("")
    removed.forEach((it) => {
      out.push(renderItem(it, inline))
    })
  }
  return out.join("\n")
}

/** A human-readable view of a diff's forward (and optionally reverse) changes. */
export function formatDiff(
  diff: Diff,
  opts: { down?: boolean; full?: boolean; inline?: boolean } = {},
): string {
  if (diff.up.length === 0) return "No changes."

  let out = opts.full ? formatFull(diff, opts.inline) : formatItems(diff.items ?? [], opts.inline)
  if (opts.down) {
    const down = diff.down
      .map((s) =>
        s
          .split("\n")
          .map((l) => style.dim(`  ${l}`))
          .join("\n"),
      )
      .join("\n")
    out += `\n\n${style.dim("  rollback (down):")}\n${down}`
  }
  return out
}

/**
 * A per-kind breakdown of a set of changes, e.g. `1 Table, 2 Fields`. Counts each item by its
 * structured `kind` and labels it from the registry's per-kind {@link KindRegistry.display} (singular
 * when the count is one), so the summary is correct for every dialect — no DDL parsing.
 */
export function summarizeKinds(registry: KindRegistry, items: readonly { kind: string }[]): string {
  const counts = new Map<string, number>()
  items.forEach((it) => counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1))

  const parts: string[] = []
  counts.forEach((n, kind) => {
    const d = registry.display(kind)
    parts.push(`${n} ${n === 1 ? d.label : d.plural}`)
  })
  return parts.join(", ")
}
