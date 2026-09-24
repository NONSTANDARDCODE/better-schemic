/**
 * Shared live-DB preload — boots ONE ephemeral SurrealDB for the whole test run and exports its URL
 * via `SURREAL_URL`/`SURREAL_USER`/`SURREAL_PASS`, so every `tryConnect()`-based live/parity suite
 * runs instead of skipping. The ORM live suites still boot their own isolated servers; this one only
 * serves the shared `tryConnect` path (parity + integration).
 *
 * No-op when `SURREAL_URL` is already set (an external DB) or the `surreal` binary is unavailable
 * (CI without the binary — the suites then skip as before).
 */
import { spawnEphemeralServer, surrealBinaryAvailable } from "../src/cli/engine";

if (!process.env.SURREAL_URL && surrealBinaryAvailable()) {
  const server = await spawnEphemeralServer();
  process.env.SURREAL_URL = server.url;
  process.env.SURREAL_USER = server.username;
  process.env.SURREAL_PASS = server.password;

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void server.stop().catch(() => {});
  };
  try {
    const { afterAll } = await import("bun:test");
    afterAll(stop);
  } catch {
    process.on("exit", stop);
  }
}
