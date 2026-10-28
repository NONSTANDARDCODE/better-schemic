/** OTEL hooks for ORM operations — typed integration. */
import type { RuntimeOperation } from "../../surreal/orm/plugins";
import type { HookDispatcher } from "../../surreal/orm/hooks";
import type { OperationKind } from "../../surreal/orm/types/hooks";

export interface OrmOtelHookSpec {
  __otelDisabled?: boolean;
  before(op: RuntimeOperation): RuntimeOperation | Promise<RuntimeOperation>;
  after(op: RuntimeOperation, result: unknown): unknown;
  error(op: RuntimeOperation, error: Error): Error;
}

const isOp = (v: unknown): v is RuntimeOperation =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[Symbol.for("better-schemic/otel")] !== undefined;

export function withOtelOrmHooks<T extends OrmOtelHookSpec>(spec: T): T & { $disable: () => void } {
  if ((spec as OrmOtelHookSpec).__otelDisabled) return spec as T & { $disable: () => void };

  return Object.assign(spec, {
    $disable() { spec.__otelDisabled = true; },
    $enable() { delete (spec as any).__otelDisabled; },
  }) as T & { $disable: () => void };
}
