// The `surrealConnection` entry's display label: `ns/db @ url`, degrading to the connection name
// when the config carries neither namespace/database nor a url.
import { describe, expect, test } from "bun:test";
import { defineConfig } from "@better-schemic/core/config";
import { resolveFromConfig } from "@better-schemic/core";
import { surrealConnection } from "../../src/connection";

describe("surrealConnection label", () => {
  test("ns/db @ url when present", async () => {
    const config = defineConfig({
      connections: {
        main: surrealConnection({
          schema: "./s",
          url: "ws://localhost:8000/rpc",
          namespace: "app",
          database: "main",
        }),
      },
    });
    const r = await resolveFromConfig(config, "/proj", { name: "main" });
    expect(r.labels).toEqual(["app/main @ ws://localhost:8000/rpc"]);
  });

  test("falls back to the connection name when the config is bare", async () => {
    // A config with no namespace/database/url is not constructible through the typed factory; the
    // label's positional fallback is defensive, so exercise it with a cast.
    const config = defineConfig({
      connections: {
        bare: surrealConnection({ schema: "./s" } as never),
      },
    });
    const r = await resolveFromConfig(config, "/proj", { name: "bare" });
    expect(r.labels).toEqual(["bare"]);
  });
});
