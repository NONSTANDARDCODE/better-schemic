/** OTEL Plugin Example — verified, compiles, runs. */
import { s, defineTable, Surreal } from "better-schemic";
import { betterSchemic } from "better-schemic/orm";
import { defineOtelInstrumentation } from "better-schemic/otel";

const schema = {
  user: defineTable("user", {
    id: s.string(),
    name: s.string(),
  }),
};

// Plugin OTEL — zero overhead quando disabled, alta performance quando ativo
const otelPlugin = defineOtelInstrumentation({
  serviceName: "my-app",
  enabled: true,
  sampleRate: 1.0,
  spanAttributes: {
    env: "development",
    team: "platform",
  },
});

export async function main() {
  const db = new Surreal();
  await db.connect("memory://");
  await db.use({ namespace: "dev", database: "main" });

  const client = betterSchemic(db, {
    schema,
    plugins: [otelPlugin],
  });

  // Cada operação ORM agora gera spans OTEL automaticamente
  const user = await client.user.findMany({ limit: 10 });
  return user;
}
