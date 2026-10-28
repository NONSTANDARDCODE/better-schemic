/** OTEL spans for CLI, DDL, introspection, live — full richness. */
import { getTracer } from "../instrumentation/tracer";

export const cliSpan = (serviceName: string, command: string) => {
  const t = getTracer(serviceName);
  return t.startSpan(`cli.${command}`, { attributes: { "db.system": "surrealdb", "service.name": serviceName } });
};

export const ddlSpan = (serviceName: string, kind: string) => {
  const t = getTracer(serviceName);
  return t.startSpan(`ddl.${kind}`, { attributes: { "db.system": "surrealdb", "db.operation.name": kind, "service.name": serviceName } });
};

export const introspectSpan = (serviceName: string) => {
  const t = getTracer(serviceName);
  return t.startSpan("introspect.info", { attributes: { "db.system": "surrealdb", "service.name": serviceName } });
};

export const liveSpan = (serviceName: string, subscription: string) => {
  const t = getTracer(serviceName);
  return t.startSpan(`live.${subscription}`, { attributes: { "db.system": "surrealdb", "service.name": serviceName } });
};
