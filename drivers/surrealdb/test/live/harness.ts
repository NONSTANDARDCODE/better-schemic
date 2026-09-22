/**
 * Shared live-test harness — boot an ephemeral SurrealDB, connect + sign in as root, select the
 * namespace/database and apply the suite's DDL. Keeps the connect boilerplate in ONE place (the
 * live suites each used to repeat it) and exposes `connectRoot` for a suite's extra connections.
 */
import { Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
} from "../../src/cli/engine";

export interface LiveServer {
  readonly server: EphemeralServer;
  readonly db: Surreal;
  /** Close the connection and stop the server. */
  stop(): Promise<void>;
}

/** Connect to an already-running `server` as root and select `namespace`/`database`. */
export async function connectRoot(
  server: EphemeralServer,
  namespace: string,
  database: string,
): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(server.url, { reconnect: false });
  await db.signin({ username: server.username, password: server.password });
  await db.use({ namespace, database });
  return db;
}

/** Boot a server, connect as root and apply `ddl` (skipped when `ddl` is blank). */
export async function startLiveServer(options: {
  readonly namespace: string;
  readonly database: string;
  readonly ddl: string;
}): Promise<LiveServer> {
  const server = await spawnEphemeralServer();
  const db = await connectRoot(server, options.namespace, options.database);
  if (options.ddl.trim().length > 0) await db.query(options.ddl);
  return {
    server,
    db,
    stop: async () => {
      await db.close().catch(() => {});
      await server.stop();
    },
  };
}
