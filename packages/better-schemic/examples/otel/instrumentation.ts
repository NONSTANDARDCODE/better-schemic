/**
 * OTEL tracing — one span per executor round-trip (delegates, `$raw`, `fn`, admin, live, explain).
 *
 * `@opentelemetry/api` is an optional peer dependency. The APP registers the SDK once at startup
 * (`service.name` is a resource attribute, not a span attribute):
 *
 * ```ts
 * const sdk = new NodeSDK({ resource: resourceFromAttributes({ "service.name": "my-app" }) });
 * sdk.start();
 * ```
 */
import { defineTable, Surreal, s } from "better-schemic";
import { betterSchemic } from "better-schemic/orm";
import { createOtelLogger } from "better-schemic/otel";

const schema = {
  user: defineTable("user", {
    id: s.string(),
    name: s.string(),
  }),
};

export async function main() {
  const db = new Surreal();
  await db.connect("memory://");
  await db.use({ namespace: "dev", database: "main" });

  const client = betterSchemic(db, {
    schema,
    // Zero overhead when omitted; `enabled: false` keeps the option but skips every span.
    logger: createOtelLogger({
      tracerName: "my-app",
      captureQueryText: true, // default; false keeps literal SQL out of spans
      attributes: { "deployment.environment.name": "development" },
    }),
  });

  return client.user.findMany({ limit: 10 });
}
