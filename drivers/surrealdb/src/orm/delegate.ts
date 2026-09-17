/**
 * The per-model delegate — what `client.<key>` resolves to. M0.5 ships the metadata seam every later
 * milestone hangs off (`$model` for schema introspection; reads land in M1, writes in M2, plugin
 * state in M6). One delegate instance is created per schema key at bootstrap and shared by
 * `client.<key>` and `client.repository(name)`.
 */
import type { ModelMeta } from "./meta";

/** What kind of model a delegate wraps. */
export type ModelKind = "table" | "relation" | "schemaless";

/** Runtime identity/introspection of a delegate's model. */
export interface ModelInfo {
  /** The schema key (`client.<key>`). */
  readonly key: string;
  /** The physical table/edge name. */
  readonly name: string;
  readonly kind: ModelKind;
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string;
  /** Is `field` part of the model? (Always true for schemaless models.) */
  hasField(field: string): boolean;
}

/**
 * A model delegate. M1+ attaches the operation methods (`findMany`, `create`, …) to this same
 * object; the metadata members below are stable across milestones.
 */
export interface Delegate {
  readonly $model: ModelInfo;
}

/** Build a delegate (and its `$model`) for one indexed model. */
export function createDelegate(meta: ModelMeta): Delegate {
  return { $model: modelInfo(meta) };
}

function modelInfo(meta: ModelMeta): ModelInfo {
  if ("schemaless" in meta)
    return {
      key: meta.key,
      name: meta.name,
      kind: "schemaless",
      hasField: () => true,
    };
  return {
    key: meta.key,
    name: meta.name,
    kind: meta.kind,
    ...(meta.singletonId !== undefined
      ? { singletonId: meta.singletonId }
      : {}),
    hasField: (field) => meta.columns.has(field),
  };
}
