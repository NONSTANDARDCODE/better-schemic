// The GENERIC migration spine over a {@link KindRegistry} — core's kind-blind orchestration. It
// classifies each portable object as add/change/remove, ORDERS them across kinds by a dependency
// graph, and emits up/down DDL + the display {@link Diff}. It never names a kind: every kind-specific
// decision is delegated to that kind's {@link KindEngine}.
//
// The spine works on PORTABLE objects (both sides already lowered), exactly like the fixed-slot
// `Driver.diff(prev, next)`: the stored snapshot IS portable, and the authoring side is lowered once
// via {@link lowerSchema}. So `prev` is a snapshot, `next` is `lowerSchema(registry, defs)`.
//
// Cross-kind ordering is the load-bearing part (docs/kind-registry.md §7.1). THREE layers:
//   1. dependency GRAPH + topological sort  -> CORRECTNESS (an object emits after everything it deps on)
//   2. kind ORDINAL (registration order)     -> stable TIE-BREAK among independent objects (layering)
//   3. OWNER clustering                       -> READABILITY (an index right after its table)
// A per-kind ordinal ALONE is wrong: a table's event can call a function, so the function must emit
// BEFORE the table — a function-before-table the graph handles and an ordinal cannot. Drops reverse it.

// NOTE: `Diff`/`DiffItem` are a type-only import (erased at compile — no runtime cli->kind coupling),
// the same arrangement as ./driver/portable-diff.ts.
import type { Diff, DiffItem } from "../cli-kit/diff";
import type {
  Definable,
  KindEngine,
  KindRegistry,
  PortableObject,
  Ref,
} from "./registry";

const refKey = (r: Ref) => `${r.kind}:${r.name}`;

/** A node in the dependency graph: identity + the edges/owner used to order it. */
export interface OrderNode {
  readonly kind: string;
  readonly name: string;
  /** Objects this node must come AFTER (only intra-set refs constrain; external refs are ignored). */
  readonly deps: Ref[];
  /** Owning object to cluster next to (readability tie-break only; never overrides `deps`). */
  readonly owner?: Ref;
}

/**
 * A tiny binary min-heap over on-demand comparators. `orderObjects` keeps one "all ready" heap plus
 * one per owner, so picking the next node is O(log n) instead of a full sort per step (the old
 * `ready.sort(...)` made a 2000-object schema ~300ms of ordering alone). Stale entries are skipped
 * by the caller with a `done` set (lazy deletion).
 */
class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(value: T): void {
    const items = this.items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i] as T, items[parent] as T) >= 0) break;
      [items[i], items[parent]] = [items[parent] as T, items[i] as T];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0] as T;
    const last = items.pop() as T;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (
        left < items.length &&
        this.compare(items[left] as T, items[smallest] as T) < 0
      )
        smallest = left;
      if (
        right < items.length &&
        this.compare(items[right] as T, items[smallest] as T) < 0
      )
        smallest = right;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest] as T, items[i] as T];
      i = smallest;
    }
    return top;
  }
}

/**
 * Kahn's topological sort with two presentation tweaks among the nodes whose deps are all satisfied:
 * prefer one OWNED by the currently-open cluster (so a table's children follow it), then lowest
 * (kind-ordinal, then name). Correctness (deps) always wins — an owned/low-ordinal node can't jump a
 * dependency. A genuine cycle throws (a named error). Refs to nodes outside `nodes` are ignored (an
 * object may depend on something untouched by this diff — it already exists / isn't changing).
 */
export function orderObjects<T extends OrderNode>(
  nodes: T[],
  ordinalOf: (kind: string) => number,
): T[] {
  // Identity is computed ONCE per node: `orderObjects` runs inside every diff/gen/push, and the
  // old loop re-derived `refKey` (a string concat) in the map build, the filter, the sort...
  const keys = new Map<T, string>();
  const key = (n: T): string => {
    let k = keys.get(n);
    if (k === undefined) {
      k = refKey(n);
      keys.set(n, k);
    }
    return k;
  };
  const byKey = new Map<string, T>();
  for (const n of nodes) byKey.set(key(n), n);
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(key(n), 0);
    dependents.set(key(n), []);
  }
  for (const n of nodes) {
    const nk = key(n);
    for (const d of n.deps) {
      const dk = refKey(d);
      if (!byKey.has(dk)) continue; // external dep -> not a constraint within this set
      indeg.set(nk, (indeg.get(nk) ?? 0) + 1);
      (dependents.get(dk) as string[]).push(nk);
    }
  }

  const compare = (a: T, b: T): number =>
    ordinalOf(a.kind) - ordinalOf(b.kind) || key(a).localeCompare(key(b));
  const ready = new MinHeap<T>(compare);
  const byOwner = new Map<string, MinHeap<T>>();
  const pushReady = (n: T): void => {
    ready.push(n);
    if (n.owner) {
      const ok = refKey(n.owner);
      let heap = byOwner.get(ok);
      if (!heap) {
        heap = new MinHeap<T>(compare);
        byOwner.set(ok, heap);
      }
      heap.push(n);
    }
  };
  for (const n of nodes) if (indeg.get(key(n)) === 0) pushReady(n);

  const done = new Set<string>();
  const out: T[] = [];
  let group: string | undefined; // the last unowned node emitted == the open cluster
  const drain = (heap: MinHeap<T> | undefined): T | undefined => {
    while (heap && heap.size > 0) {
      const top = heap.pop() as T;
      if (!done.has(key(top))) return top;
    }
    return undefined;
  };
  while (out.length < nodes.length) {
    // Prefer a child of the open cluster (readability), else the best-ranked ready node.
    const next =
      (group !== undefined ? drain(byOwner.get(group)) : undefined) ??
      drain(ready);
    if (!next) {
      throw new Error(
        `dependency cycle among: ${nodes
          .filter((n) => !done.has(key(n)))
          .map((n) => key(n))
          .join(", ")}`,
      );
    }
    out.push(next);
    done.add(key(next));
    if (!next.owner) group = key(next); // a top-level object opens a new cluster
    for (const dep of dependents.get(key(next)) ?? []) {
      const left = (indeg.get(dep) ?? 1) - 1;
      indeg.set(dep, left);
      if (left === 0) pushReady(byKey.get(dep) as T);
    }
  }
  return out;
}

// --- lowering + snapshot ------------------------------------------------------------------------

/**
 * Author -> portable: lower each definable through its kind's engine (skipping unregistered kinds).
 * The single place authoring becomes portable; everything downstream (diff/emit/snapshot) is portable.
 */
export function lowerSchema(
  registry: KindRegistry,
  defs: Definable[],
): PortableObject[] {
  const out: PortableObject[] = [];
  for (const d of defs) {
    const engine = registry.engine(d.kind);
    if (engine) out.push(engine.lower(d));
  }
  return out;
}

/**
 * The registry SNAPSHOT — portable objects grouped by kind. The open, generic replacement for
 * `PortableDb`'s fixed slots; serializes as plain JSON (it is plain data). Pre-launch: the format is
 * free to change, no version migration.
 */
export interface KindSnapshot {
  kinds: Record<string, PortableObject[]>;
}

/**
 * Group a flat portable schema into a snapshot (by kind). Pass `registry` to DROP kinds/objects
 * marked {@link KindEngine.excludeFromMigrations} (e.g. SurrealDB key-bearing access) so unmanaged,
 * secret-bearing objects never enter a snapshot / migration. Omit it to snapshot every object
 * unchanged.
 */
export function snapshotKinds(
  schema: PortableObject[],
  registry?: KindRegistry,
): KindSnapshot {
  const kinds: Record<string, PortableObject[]> = {};
  for (const o of schema) {
    if (registry?.isExcludedFromMigrations(o)) continue;
    // `Object.hasOwn` (not `?? []`): a kind named `__proto__`/`constructor` must not read an
    // inherited member as its bucket.
    const bucket = Object.hasOwn(kinds, o.kind) ? kinds[o.kind] : undefined;
    if (bucket) bucket.push(o);
    else kinds[o.kind] = [o];
  }
  return { kinds };
}

/** Flatten a snapshot back into a portable schema (the inverse of {@link snapshotKinds}). */
export function snapshotObjects(snap: KindSnapshot): PortableObject[] {
  return Object.values(snap.kinds).flat();
}

// --- diff / plan --------------------------------------------------------------------------------

/** One classified object change, carrying its ordering metadata + the portable sides for DDL. */
interface Change extends OrderNode {
  readonly op: "add" | "change" | "remove";
  readonly prev?: PortableObject;
  readonly next?: PortableObject;
}

/** An up/down DDL program (each a list of statements). */
export interface KindPlan {
  up: string[];
  down: string[];
}

/** The canonical change-detection key for an object — the kind's `canonical`, else its emitted DDL. */
const canonicalOf = (engine: KindEngine, p: PortableObject): string =>
  engine.canonical?.(p) ?? engine.emit(p).join("\n");

const orderNodeOf = (
  engine: KindEngine,
  portable: PortableObject,
): OrderNode => ({
  kind: portable.kind,
  name: portable.name,
  deps: engine.deps?.(portable) ?? [],
  owner: engine.owner?.(portable),
});

/** Display identity: `kind:owner:name` (owner blank for a top-level object) + the display owner. */
const itemKey = (n: OrderNode) => `${n.kind}:${n.owner?.name ?? ""}:${n.name}`;
const itemTable = (n: OrderNode) => n.owner?.name ?? n.name;
const byKey = (schema: PortableObject[]) =>
  new Map(schema.map((o) => [refKey(o), o]));

/**
 * Classify both sides into ordered add/change/remove sets — the shared core of plan + diff. A `change`
 * is two objects of the same key whose emitted DDL differs (same test as the fixed-slot engine). Each
 * class is topologically ordered parent-first; the caller reverses one class for drops/inversion.
 */
function orderedChanges(
  registry: KindRegistry,
  prev: PortableObject[],
  next: PortableObject[],
): { nonRemoves: Change[]; removes: Change[] } {
  const prevByKey = byKey(prev);
  const nextByKey = byKey(next);
  const changes: Change[] = [];
  for (const k of new Set([...prevByKey.keys(), ...nextByKey.keys()])) {
    const p = prevByKey.get(k);
    const n = nextByKey.get(k);
    const portable = n ?? p;
    if (!portable) continue;
    // Migration-unmanaged kinds/objects (e.g. key-bearing access) never diff — they're reconciled
    // out-of-band by driver commands, so they must not appear in gen/migrate/diff-live output.
    // Central choke point (a per-object predicate is fed the object that would be emitted).
    if (registry.isExcludedFromMigrations(portable)) continue;
    const engine = registry.engine(portable.kind);
    if (!engine) continue;
    const node = orderNodeOf(engine, portable);
    if (p && !n) changes.push({ op: "remove", prev: p, ...node });
    else if (!p && n) changes.push({ op: "add", next: n, ...node });
    else if (p && n && canonicalOf(engine, p) !== canonicalOf(engine, n))
      changes.push({ op: "change", prev: p, next: n, ...node });
  }
  const ord = (kind: string) => registry.ordinal(kind);
  return {
    nonRemoves: orderObjects(
      changes.filter((c) => c.op !== "remove"),
      ord,
    ),
    removes: orderObjects(
      changes.filter((c) => c.op === "remove"),
      ord,
    ),
  };
}

const overwriteUp = (
  engine: KindEngine,
  a: PortableObject,
  b: PortableObject,
): string[] =>
  engine.overwrite?.(a, b) ?? [...engine.remove(a), ...engine.emit(b)];

/**
 * Diff two portable schema states into an executable up/down program, generically over the registry.
 *
 * `up` runs creates/changes parent-first (the dependency graph) then drops child-first; `down` is the
 * mirror: recreate drops parent-first, then undo creates/changes child-first. We invert PER OBJECT (not
 * by reversing the flat DDL list) so a kind's multi-line block — a table emitted with its fields —
 * keeps its internal order in both directions.
 */
export function planKinds(
  registry: KindRegistry,
  prev: PortableObject[],
  next: PortableObject[],
): KindPlan {
  const { nonRemoves, removes } = orderedChanges(registry, prev, next);
  return planFromChanges(registry, nonRemoves, removes);
}

/** Emit the up/down program from an ALREADY-classified change set (shared with `buildKindDiff`). */
function planFromChanges(
  registry: KindRegistry,
  nonRemoves: Change[],
  removes: Change[],
): KindPlan {
  const up: string[] = [];
  const down: string[] = [];
  for (const c of nonRemoves) {
    const e = registry.engine(c.kind);
    if (!e) continue;
    if (c.op === "add" && c.next) up.push(...e.emit(c.next));
    else if (c.op === "change" && c.prev && c.next)
      up.push(...overwriteUp(e, c.prev, c.next));
  }
  for (const c of [...removes].reverse()) {
    const e = registry.engine(c.kind); // drops child-first
    if (e && c.prev) up.push(...e.remove(c.prev));
  }
  for (const c of removes) {
    const e = registry.engine(c.kind); // recreate dropped objects parent-first
    if (e && c.prev) down.push(...e.emit(c.prev));
  }
  for (const c of [...nonRemoves].reverse()) {
    const e = registry.engine(c.kind); // undo creates/changes child-first
    if (!e) continue;
    if (c.op === "add" && c.next) down.push(...e.remove(c.next));
    else if (c.op === "change" && c.prev && c.next)
      down.push(...overwriteUp(e, c.next, c.prev));
  }
  return { up, down };
}

/**
 * Display items for a change set, in up order (creates/changes parent-first, drops child-first). A kind
 * with `displayItems` decomposes into FINE-grained sub-items (per-field, each carrying its `table` so
 * the display groups them under it); otherwise it falls back to ONE whole-object item.
 */
function diffItems(
  registry: KindRegistry,
  nonRemoves: Change[],
  removes: Change[],
): DiffItem[] {
  const items: DiffItem[] = [];
  const push = (c: Change) => {
    const e = registry.engine(c.kind);
    if (!e) return;
    if (e.displayItems) {
      items.push(...e.displayItems(c.prev, c.next));
      return;
    }
    const base = { key: itemKey(c), table: itemTable(c), kind: c.kind };
    if (c.op === "add" && c.next)
      items.push({ ...base, op: "add", ddl: e.emit(c.next).join("\n") });
    else if (c.op === "remove" && c.prev)
      items.push({
        ...base,
        op: "remove",
        ddl: e.remove(c.prev).join("\n"),
        old: e.emit(c.prev).join("\n"),
      });
    else if (c.op === "change" && c.prev && c.next)
      items.push({
        ...base,
        op: "change",
        before: e.emit(c.prev).join("\n"),
        after: e.emit(c.next).join("\n"),
      });
  };
  for (const c of nonRemoves) push(c);
  for (const c of [...removes].reverse()) push(c);
  return items;
}

/**
 * The full {@link Diff} the CLI + migration model consume — up/down DDL + per-object display items +
 * the whole desired schema (`full`, for `--full`). This is what a driver's `Driver.diff` returns once
 * its kinds are on the registry (the generic counterpart of the fixed-slot `buildDiff`). Source-file
 * linkage on the items is attached by the caller (the snapshot's `files` map), so `file` is left unset.
 */
export function buildKindDiff(
  registry: KindRegistry,
  prev: PortableObject[],
  next: PortableObject[],
): Diff {
  const { nonRemoves, removes } = orderedChanges(registry, prev, next);
  // ONE classify pass feeds up/down, display items AND `full` (the old code re-ran the match +
  // canonical-emit pass inside `planKinds`, doubling the work on every diff).
  const { up, down } = planFromChanges(registry, nonRemoves, removes);
  // `full` mirrors the items' granularity: a kind with `displayItems` projects its object as per-
  // sub-object adds (displayItems(undefined, portable)); otherwise one whole-object entry.
  const full = orderedSchema(registry, next).flatMap(
    ({ engine, portable, node }) => {
      if (engine.displayItems)
        return engine.displayItems(undefined, portable).map((it) => ({
          key: it.key,
          table: it.table,
          ddl: it.op === "add" ? it.ddl : "",
        }));
      return [
        {
          key: itemKey(node),
          table: itemTable(node),
          ddl: engine.emit(portable).join("\n"),
        },
      ];
    },
  );
  return { up, down, items: diffItems(registry, nonRemoves, removes), full };
}

/** Lower-already portable schema, topologically ordered, paired with each object's engine + node. */
function orderedSchema(
  registry: KindRegistry,
  schema: PortableObject[],
): { engine: KindEngine; portable: PortableObject; node: OrderNode }[] {
  const items = schema.flatMap((portable) => {
    const engine = registry.engine(portable.kind);
    return engine
      ? [{ engine, portable, node: orderNodeOf(engine, portable) }]
      : [];
  });
  const pos = new Map(
    orderObjects(
      items.map((i) => i.node),
      (k) => registry.ordinal(k),
    ).map((n, i) => [itemKey(n), i]),
  );
  return items.sort(
    (a, b) => (pos.get(itemKey(a.node)) ?? 0) - (pos.get(itemKey(b.node)) ?? 0),
  );
}

/**
 * Fresh-apply DDL for a portable schema: every object created, ordered across kinds by the graph.
 * (The `up` of a diff from an empty state.) Lower authoring first via {@link lowerSchema}.
 */
export function emitKinds(
  registry: KindRegistry,
  schema: PortableObject[],
): string[] {
  // Skip migration-unmanaged kinds/objects (e.g. key-bearing access) — they're applied out-of-band
  // by driver commands.
  const managed = schema.filter((o) => !registry.isExcludedFromMigrations(o));
  return orderedSchema(registry, managed).flatMap(({ engine, portable }) =>
    engine.emit(portable),
  );
}

/**
 * Reverse direction, fanned out across kinds: introspect every introspectable kind off one live
 * connection and flatten into portable objects. The RESOLUTION of "per-kind vs one driver read":
 * the contract is per-kind ({@link KindEngine.introspect}), but a driver backs all of its kinds with
 * ONE shared (memoized) read of `conn` and slices out each kind's objects — so the fan-out here costs
 * a single round-trip, not N. A kind without `introspect` contributes nothing (not introspectable).
 */
export async function introspectKinds(
  registry: KindRegistry,
  conn: unknown,
): Promise<PortableObject[]> {
  const out: PortableObject[] = [];
  for (const [kind, engine] of registry.entries()) {
    if (!engine.introspect) continue;
    // Skip STATICALLY migration-unmanaged kinds so the live side never phantom-diffs against a
    // schema that (by design) excludes them. A per-object predicate can't be evaluated without the
    // object — introspection still runs, and the diff choke point filters by object afterwards.
    if (registry.skipsIntrospection(kind)) continue;
    out.push(...(await engine.introspect(conn)));
  }
  return out;
}
