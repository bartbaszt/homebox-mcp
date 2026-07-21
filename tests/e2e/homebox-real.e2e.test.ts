import { existsSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppConfig } from "../../src/config.js";
import { startServer, type StartedServer } from "../../src/server.js";

interface TestAccess {
  url: string;
  login: string;
  password: string;
}

const shouldRun = process.env.HOMEBOX_E2E === "1";
const accessFile = process.env.HOMEBOX_TEST_ACCESS_FILE ?? "C:\\__program\\HomeboxAiHelper\\.test-access";

describe.skipIf(!shouldRun)("real Homebox E2E over HTTP MCP", () => {
  let started: StartedServer;
  let client: Client;
  let access: TestAccess;

  beforeAll(async () => {
    if (!existsSync(accessFile)) throw new Error(`Missing HOMEBOX_TEST_ACCESS_FILE: ${accessFile}`);
    access = parseTestAccess(accessFile);
    started = await startServer(testConfig(access.url));
    client = new Client({ name: "homebox-mcp-real-e2e", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: "Bearer e2e-mcp-token" } },
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await started?.close();
  });

  it("rejects unauthenticated external MCP requests", async () => {
    const response = await fetch(started.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("confirms real status, login, authorization and read-only API queries", async () => {
    const status = await call(client, "homebox_status", {});
    expect(status).toMatchObject({ health: true });

    const login = await call(client, "homebox_login", {
      username: access.login,
      password: access.password,
    });
    const sessionKey = String(login.sessionKey);
    expect(sessionKey.length).toBeGreaterThan(10);

    const refreshed = await call(client, "homebox_refresh_session", { sessionKey });
    expect(refreshed.sessionKey).toBe(sessionKey);

    const collections = await call(client, "homebox_list_collections", { sessionKey });
    expect(asArray(collections).length).toBeGreaterThanOrEqual(1);

    const items = await call(client, "homebox_list_items", { sessionKey, pageSize: 5 });
    expect(items).toHaveProperty("items");
    expect(Array.isArray(items.items)).toBe(true);

    const itemList = items.items as Array<{ id: string }>;
    if (itemList.length > 0) {
      const item = await call(client, "homebox_get_item", { sessionKey, itemId: itemList[0].id });
      expect(item.id).toBe(itemList[0].id);

      const attachments = await call(client, "homebox_list_attachments", { sessionKey, itemId: itemList[0].id });
      expect(Array.isArray(asArray(attachments))).toBe(true);
    }

    const locations = await call(client, "homebox_list_locations", { sessionKey });
    expect(Array.isArray(asArray(locations))).toBe(true);

    const tags = await call(client, "homebox_list_tags", { sessionKey });
    expect(Array.isArray(asArray(tags))).toBe(true);

    const fields = await call(client, "homebox_list_custom_fields", { sessionKey });
    const fieldNames = asArray(fields);
    expect(Array.isArray(fieldNames)).toBe(true);

    if (fieldNames.length > 0) {
      const fieldValues = await call(client, "homebox_list_custom_field_values", { sessionKey, field: String(fieldNames[0]) });
      expect(Array.isArray(asArray(fieldValues))).toBe(true);
    }

    const genericStatus = await call(client, "homebox_api_request", { sessionKey, method: "GET", path: "/api/v1/status" });
    expect(genericStatus).toMatchObject({ health: true });

    const badSession = await client.callTool({ name: "homebox_list_items", arguments: { sessionKey: "missing-session" } });
    expect(badSession.isError).toBe(true);

    const logout = await call(client, "homebox_logout", { sessionKey });
    expect(logout.removed).toBe(true);
  });

  it("confirms maintenance, notifiers and templates endpoints", async () => {
    const login = await call(client, "homebox_login", {
      username: access.login,
      password: access.password,
    });
    const sessionKey = String(login.sessionKey);

    const maintenance = await call(client, "homebox_list_maintenance", { sessionKey });
    expect(Array.isArray(asArray(maintenance))).toBe(true);

    const maintenanceCompleted = await call(client, "homebox_list_maintenance", { sessionKey, status: "completed" });
    expect(Array.isArray(asArray(maintenanceCompleted))).toBe(true);

    const notifiers = await call(client, "homebox_list_notifiers", { sessionKey });
    expect(Array.isArray(asArray(notifiers))).toBe(true);

    const templates = await call(client, "homebox_list_entity_templates", { sessionKey });
    expect(Array.isArray(asArray(templates))).toBe(true);

    await call(client, "homebox_logout", { sessionKey });
  });

  it("confirms v0.26 entity, entity-type and currency endpoints", async () => {
    const login = await call(client, "homebox_login", {
      username: access.login,
      password: access.password,
    });
    const sessionKey = String(login.sessionKey);

    const entities = await call(client, "homebox_list_entities", { sessionKey, pageSize: 5 });
    expect(entities).toHaveProperty("items");
    expect(Array.isArray(entities.items)).toBe(true);

    const fieldNames = await call(client, "homebox_list_entity_field_names", { sessionKey });
    expect(Array.isArray(asArray(fieldNames))).toBe(true);

    const currencies = await call(client, "homebox_list_currencies", { sessionKey });
    expect(Array.isArray(asArray(currencies))).toBe(true);

    const entityTypes = await call(client, "homebox_list_entity_types", { sessionKey });
    expect(Array.isArray(asArray(entityTypes))).toBe(true);

    const groupStats = await call(client, "homebox_list_group_statistics", { sessionKey });
    expect(groupStats).toBeDefined();

    await call(client, "homebox_logout", { sessionKey });
  });
});

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) {
    const text = result.content.map((content) => (content.type === "text" ? content.text : "")).join("\n");
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent ?? {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.items)) return record.items;
  }
  throw new Error("Expected an array or an object containing data/items array");
}

function parseTestAccess(filePath: string): TestAccess {
  const values: Partial<TestAccess> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^(url|login|password):\s*(.*)$/.exec(line.trim());
    if (match) values[match[1] as keyof TestAccess] = match[2];
  }
  if (!values.url || !values.login || !values.password) throw new Error(`Invalid test access file: ${filePath}`);
  return values as TestAccess;
}

function testConfig(homeboxBaseUrl: string): AppConfig {
  return {
    homeboxBaseUrl,
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    apiToken: "e2e-mcp-token",
    timeoutMs: 30_000,
    maxUploadBytes: 10 * 1024 * 1024,
    maxDownloadBytes: 10 * 1024 * 1024,
  };
}
