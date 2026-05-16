import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { type AppConfig } from "../../src/config.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { json, startMockHomebox, type MockHomeboxServer } from "../support/mock-homebox.js";

let mock: MockHomeboxServer | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  await mock?.close();
  started = undefined;
  mock = undefined;
});

describe("HTTP MCP server", () => {
  it("requires MCP API token when configured", async () => {
    mock = await startMockHomebox((_req, res) => json(res, 200, { ok: true }));
    started = await startServer(testConfig(mock.url, "mcp-secret"));

    const response = await fetch(started.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(401);
  });

  it("serves Homebox tools over Streamable HTTP", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/status") {
        json(res, 200, { health: true, build: { version: "0.25.0" } });
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        json(res, 200, { token: "Bearer user-token", expiresAt: "2030-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/items") {
        expect(req.headers.authorization).toBe("Bearer user-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "item-1", name: "Drill" }] });
        return;
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });
    started = await startServer(testConfig(mock.url, "mcp-secret"));

    const client = new Client({ name: "homebox-mcp-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: "Bearer mcp-secret" } },
    });
    await client.connect(transport);

    const status = await client.callTool({ name: "homebox_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ health: true });

    const login = await client.callTool({ name: "homebox_login", arguments: { username: "user@example.com", password: "secret" } });
    const sessionKey = (login.structuredContent as { sessionKey?: unknown } | undefined)?.sessionKey;
    expect(typeof sessionKey).toBe("string");

    const items = await client.callTool({ name: "homebox_list_items", arguments: { sessionKey, pageSize: 1 } });
    expect(items.structuredContent).toMatchObject({ total: 1 });

    await client.close();
  });
});

function testConfig(homeboxBaseUrl: string, apiToken?: string): AppConfig {
  return {
    homeboxBaseUrl,
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    apiToken,
    timeoutMs: 5_000,
    maxUploadBytes: 1024 * 1024,
    maxDownloadBytes: 1024 * 1024,
  };
}
