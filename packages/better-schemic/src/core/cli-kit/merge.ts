// Surgically merge freshly-pulled `s.*` definitions into existing schema files, instead of
// overwriting them. Uses magicast (recast under the hood), so untouched code — user comments,
// extra imports, unrelated consts, hand-formatted fields — survives. The live DB wins on any
// object/field it defines; the thing at risk is LOCAL-content (a field or whole const
// that exists in your files but not in the DB), which the caller resolves via keep/drop.

import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import nodePath from "node:path"

import type { generateCode, parseModule } from "magicast"

import { colorEnabled, style } from "./style"

/** The slice of magicast's API this file uses (loaded on demand via `createRequire`). */
type MagicastApi = { generateCode: typeof generateCode; parseModule: typeof parseModule }

// `magicast` (recast + its parser) is ~115ms of module init that most commands never need —
// `pull`'s merge path parses TS. Load it on FIRST merge (createRequire keeps `mergeUnits`
// synchronous) instead of at barrel import, so `sc --help`/`sc diff` start lean.
const require_ = createRequire(import.meta.url)
let magicastModule: MagicastApi | undefined
const magicast = (): MagicastApi => (magicastModule ??= require_("magicast") as MagicastApi)

/** One rendered object (table / function / access): its const statement + the imports it needs. */
export type RenderedUnit = {
  /** The `export const … = define…(…);` statement source (no import lines). */
  code: string
  /** The exported const identifier (`User`, `math_add`, …). */
  exportName: string
  /** The `import …` lines this unit needs. */
  imports: string[]
  kind: "access" | "function" | "table"
  /** DB object name (drives the file path). */
  name: string
}

/** Local-content a merge would drop when mirroring the DB. */
export type LocalOnly = {
  /** Per existing const: field keys present locally but absent from the DB object. */
  fields: { exportName: string; fields: string[] }[]
  /** Whole consts present locally whose object the DB no longer has. */
  objects: string[]
}

export type MergeResult = {
  content: string
  localOnly: LocalOnly
}

/** Options governing what happens to local-content. */
export type MergeOptions = {
  /** Keep local-fields (graft them back into the merged object). */
  keepLocalFields: boolean
  /** Keep local-consts (objects the DB no longer has). */
  keepLocalObjects: boolean
}

/** What pulling would do to one schema file. */
export type PullFilePlan = {
  /** Absolute path on disk. */
  abs: string
  /**
   * `create` (new file), `update` (merged edits), `unchanged` (already matches the DB), or `delete`
   * (a file that is purely local- entities the DB doesn't have — removed when mirroring).
   */
  action: "create" | "delete" | "unchanged" | "update"
  /** Contents after the pull (the merged result). */
  after: string
  /** Current file contents (`""` for a new file). */
  before: string
  /** Local-content this file would drop when mirroring the DB. */
  localOnly: LocalOnly
  /** Path relative to the project root (for display). */
  rel: string
}

/** A driver's introspection rendered into a per-file write plan (see a driver's `planPull`). */
export type PullPlan = {
  readonly files: PullFilePlan[]
  /** Absolute schema root the plan must stay inside (defense-in-depth against DB-controlled names). */
  readonly root?: string
}

/** Refuse a plan target outside `root` (a hostile DB object name must never escape the schema dir). */
function assertInsideRoot(root: string, abs: string): void {
  const rel = nodePath.relative(nodePath.resolve(root), nodePath.resolve(abs))
  if (rel.startsWith("..") || nodePath.isAbsolute(rel))
    throw new Error(`pull: refusing to write outside the schema root — "${abs}" escapes "${root}".`)
}

/** Refuse to write/delete THROUGH a symlink (a planted link would redirect the write outside root). */
function assertNotSymlink(abs: string): void {
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(
        `pull: refusing to write through the symlink "${abs}" — remove it and re-run.`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pull: refusing")) throw error

    // ENOENT (new file) is fine; anything else (permissions) surfaces on the write itself.
  }
}

/** Apply a plan: write created/updated files, delete local-files. Returns the paths touched. */
export function applyPull(plan: PullPlan): string[] {
  const touched: string[] = []
  plan.files.forEach((f) => {
    if (f.action === "unchanged") return

    if (plan.root !== undefined) assertInsideRoot(plan.root, f.abs)

    assertNotSymlink(f.abs)
    if (f.action === "delete") rmSync(f.abs, { force: true })
    else {
      mkdirSync(nodePath.dirname(f.abs), { recursive: true })
      writeFileSync(f.abs, f.after)
    }
    touched.push(f.rel)
  })
  return touched
}

// --- AST helpers ------------------------------------------------------------------------------
// A permissive view over the recast/babel nodes we touch — every property we read, all optional,
// navigation needs no per-access casts.
type AstNode = Partial<Record<"arguments", AstNode[]>> & {
  body?: AstNode
  callee?: AstNode
  comments?: { leading?: boolean }[]
  declaration?: AstNode
  declarations?: { id?: { name?: string }; init?: AstNode }[]
  key?: { name?: string; value?: string }
  name?: string
  object?: AstNode
  properties?: AstNode[]
  type: string
}

type MagicastModule = {
  $ast: { body: AstNode[] }
  imports: {
    $add: (s: { from: string; imported: string; local: string }) => void
  }
}

const asMod = (mod: unknown): MagicastModule => mod as MagicastModule

/** The exported const's name, or null if this statement isn't an `export const X = …`. */
function exportConstName(node: AstNode): null | string {
  if (node.type !== "ExportNamedDeclaration") return null

  if (node.declaration?.type !== "VariableDeclaration") return null

  return node.declaration.declarations?.[0]?.id?.name ?? null
}

/** The init expression of an `export const X = <init>`. */
function exportConstInit(node: AstNode): AstNode | null {
  return node.declaration?.declarations?.[0]?.init ?? null
}

/** Walk a `define…(…).a().b()` chain down to the `define…(…)` CallExpression. */
function defineCall(init: AstNode | null): AstNode | null {
  const walk = (n: AstNode | null): AstNode | null => {
    if (!n) return null
    if (n.type === "CallExpression") {
      if (
        n.callee?.type === "Identifier" &&
        ((n.callee.name ?? "").startsWith("define") ||
          n.callee.name === "table" ||
          n.callee.name === "relation")
      )
        return n

      return walk(
        n.callee?.type === "MemberExpression" ? (n.callee.object ?? null) : (n.callee ?? null),
      )
    }
    return n.type === "MemberExpression" ? walk(n.object ?? null) : null
  }
  return walk(init)
}

/** The fields ObjectExpression of a `table`/`relation` call (handles the `self` arrow form). */
function fieldsObject(init: AstNode | null): AstNode | null {
  const call = defineCall(init)
  if (!call) return null

  let obj = call.arguments?.[1] ?? null
  if (obj?.type === "ArrowFunctionExpression") obj = obj.body ?? null

  return obj?.type === "ObjectExpression" ? obj : null
}

/** Property key as a string (`name` / `"weird-key"`). */
function propKey(p: AstNode): string | undefined {
  return p.key?.name ?? p.key?.value
}

/** Whether a node carries a leading comment (so we don't clobber/duplicate it). */
function hasLeadingComment(node: AstNode): boolean {
  return Boolean(node.comments?.some((c) => c.leading))
}

/** Parse `import { a, b } from "x"` lines into `{from, names}` (our generated imports use no aliases). */
function parseImportLine(line: string): null | { from: string; names: string[] } {
  const m = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/u.exec(line)
  if (!m) return null

  return {
    from: m[2],
    names: m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/** Lift fields present in the prior table but absent from the rendered one; report and graft them. */
function reconcileFields(
  prior: AstNode,
  desiredNode: AstNode,
  exportName: string,
  keepLocalFields: boolean,
  localOnly: LocalOnly,
): void {
  const priorObj = fieldsObject(exportConstInit(prior))
  const desiredObj = fieldsObject(exportConstInit(desiredNode))
  if (!priorObj?.properties || !desiredObj?.properties) return

  const desiredKeys = new Set(desiredObj.properties.map(propKey))
  const localFields = priorObj.properties.filter((p) => !desiredKeys.has(propKey(p)))
  if (localFields.length === 0) return

  localOnly.fields.push({
    exportName,
    fields: localFields.map((p) => propKey(p) ?? "?"),
  })
  // Graft the local-field nodes (with their comments) onto the merged object.
  if (!keepLocalFields) return
  const target = desiredObj.properties
  localFields.forEach((p) => target.push(p))
}

/**
 * Merge `units` into `existingSrc`. Each unit replaces the matching `export const` in place (DB wins),
 * preserving everything else in the file. New units append them; needed imports union them in.
 * Local- fields/objects report them, and kept or dropped per `opts`.
 */
export function mergeUnits(
  existingSrc: string,
  units: RenderedUnit[],
  opts: MergeOptions,
): MergeResult {
  const { generateCode, parseModule } = magicast()
  const mod = parseModule(existingSrc)
  const body = asMod(mod).$ast.body

  // Index existing exported consts by name.
  const existing = new Map<string, AstNode>()
  body.forEach((node) => {
    const name = exportConstName(node)
    if (name) existing.set(name, node)
  })

  const localOnly: LocalOnly = { fields: [], objects: [] }
  const desiredNames = new Set(units.map((u) => u.exportName))

  units.forEach((unit) => {
    // Parse the freshly-rendered unit to lift its statement node.
    const unitBody = asMod(parseModule(unit.code)).$ast.body
    const desiredNode = unitBody.find((n) => exportConstName(n) === unit.exportName)
    if (!desiredNode) return
    // shouldn't happen — the renderer always emits the const

    const prior = existing.get(unit.exportName)
    if (prior) {
      // Table/relation: reconcile fields. Functions/access are atomic (whole-const replace).
      if (unit.kind === "table")
        reconcileFields(prior, desiredNode, unit.exportName, opts.keepLocalFields, localOnly)
      // Preserve a user's leading comment above the const (the renderer emits none for tables;
      // for access the renderer's own NOTE already lives on desiredNode, so don't double it).
      if (!hasLeadingComment(desiredNode)) desiredNode.comments = prior.comments

      body[body.indexOf(prior)] = desiredNode
    } else body.push(desiredNode)

    addImports(mod, unit.imports)
  })

  // Existing consts the DB no longer has → local-objects.
  existing.forEach((node, name) => {
    if (desiredNames.has(name)) return

    localOnly.objects.push(name)
    if (!opts.keepLocalObjects) body.splice(body.indexOf(node), 1)
  })

  return { content: ensureTrailingNewline(generateCode(mod).code), localOnly }
}

/** Union the named imports from `lines` into the module (magicast dedupes against existing). */
function addImports(mod: unknown, lines: string[]): void {
  const imports = asMod(mod).imports
  lines.forEach((line) => {
    const parsed = parseImportLine(line)
    if (!parsed) return

    parsed.names.forEach((name) => {
      imports.$add({ from: parsed.from, imported: name, local: name })
    })
  })
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`
}

// --- Line diff (colored preview + git-style patch) -------------------------------------------

type LineOp = {
  line: string
  tag: " " | "+" | "-"
}

const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/u, "").split("\n"))

/** LCS line-level ops between two texts (a trailing newline ignors it). */
function lineOps(before: string, after: string): LineOp[] {
  const a = splitLines(before)
  const b = splitLines(after)
  // A full LCS matrix is O(m*n) cells — a 10k-line file would ~100M cells. Above the cap,
  // fall back to a prefix/suffix diff (still a VALID op sequence, coarser).
  if (a.length * b.length > LCS_CELL_LIMIT) return coarseLineOps(a, b)

  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0))
  Array.from({ length: m }, (_, k) => m - 1 - k).forEach((i) => {
    Array.from({ length: n }, (_, k) => n - 1 - k).forEach((j) => {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    })
  })
  const ops: LineOp[] = []
  let i = 0
  let j = 0
  Array.from({ length: m + n }).some(() => {
    if (i >= m && j >= n) return true
    if (i >= m) {
      ops.push({ line: b[j], tag: "+" })
      j++
    } else if (j >= n) {
      ops.push({ line: a[i], tag: "-" })
      i++
    } else if (a[i] === b[j]) {
      ops.push({ line: a[i], tag: " " })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ line: a[i], tag: "-" })
      i++
    } else {
      ops.push({ line: b[j], tag: "+" })
      j++
    }
    return false
  })
  return ops
}

/** The O(1)-memory fallback: keep the common prefix/suffix, mark the middle removed + added. */
const LCS_CELL_LIMIT = 4_000_000
function coarseLineOps(a: string[], b: string[]): LineOp[] {
  const head = Array.from({ length: Math.min(a.length, b.length) }, (_, i) => i)
  const start = head.find((i) => a[i] !== b[i]) ?? head.length
  let endA = a.length
  let endB = b.length
  Array.from({ length: Math.min(a.length, b.length) }).some(() => {
    if (endA <= start || endB <= start || a[endA - 1] !== b[endB - 1]) return true
    endA--
    endB--
    return false
  })
  return [
    ...a.slice(0, start).map((line) => ({ line, tag: " " as const })),
    ...a.slice(start, endA).map((line) => ({ line, tag: "-" as const })),
    ...b.slice(start, endB).map((line) => ({ line, tag: "+" as const })),
    ...a.slice(endA).map((line) => ({ line, tag: " " as const })),
  ]
}

/**
 * A compact colored line diff for previews. A new file renders as all-green additions; an edit
 * renders removed (red `-`) / added (green `+`) lines with a little surrounding context (long
 * unchanged runs collapse to `…`).
 */
export function lineDiff(before: string, after: string): string {
  const ops = lineOps(before, after)
  // Keep changed lines plus up to 2 lines of context around each; collapse long unchanged runs.
  const CONTEXT = 2
  const keep = Array.from({ length: ops.length }, () => false)
  ops.forEach((op, idx) => {
    if (op.tag === " ") return

    const from = Math.max(0, idx - CONTEXT)
    const count = Math.min(ops.length - 1, idx + CONTEXT) - from + 1
    Array.from({ length: count }, (_, offset) => from + offset).forEach((k) => {
      keep[k] = true
    })
  })
  const out: string[] = []
  let gap = false
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!gap) out.push(style.dim("  …"))

      gap = true
      return
    }
    gap = false
    if (op.tag === " ") out.push(style.dim(`  ${op.line}`))
    else if (op.tag === "-") out.push(style.red(`- ${op.line}`))
    else out.push(style.green(`+ ${op.line}`))
  })
  return out.join("\n")
}

/**
 * A git-style unified diff between two texts, headed by `label` as the file path — for piping to a
 * diff viewer (delta / git's pager). Returns "" when there's no change.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  const ops = lineOps(before, after)
  if (!ops.some((o) => o.tag !== " ")) return ""

  const oldLen = ops.filter((o) => o.tag !== "+").length
  const addedLen = ops.filter((o) => o.tag !== "-").length
  const body = ops.map((o) => (o.tag === " " ? ` ${o.line}` : `${o.tag}${o.line}`))
  return `${[
    `diff --git a/${label} b/${label}`,
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -1,${oldLen} +1,${addedLen} @@`,
    ...body,
  ].join("\n")}\n`
}

/** Colored verb for a pull action (`new` / `update` / `delete` / `unchanged`). */
export function actionLabel(action: "create" | "delete" | "unchanged" | "update"): string {
  if (action === "create") return colorEnabled() ? style.green("new") : "new"

  if (action === "update") return colorEnabled() ? style.yellow("update") : "update"

  if (action === "delete") return colorEnabled() ? style.red("delete") : "delete"

  return style.dim("unchanged")
}
