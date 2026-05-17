import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/config.js";
import { OAuthStore } from "../../src/oauth-store.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { json, startMockHomebox, type MockHomeboxServer } from "../support/mock-homebox.js";

let mock: MockHomeboxServer | undefined;
let started: StartedServer | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await started?.close();
  await mock?.close();
  started = undefined;
  mock = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("HTTP MCP server", () => {
  it("refuses unsafe unauthenticated public listener config", () => {
    expect(() => loadConfig({ HOMEBOX_BASE_URL: "http://homebox.local", HOMEBOX_MCP_HOST: "0.0.0.0" })).toThrow(/Refusing to listen/);
    expect(() => loadConfig({ HOMEBOX_BASE_URL: "http://homebox.local", HOMEBOX_MCP_API_TOKEN: "change-me" })).toThrow(/placeholder/);
    expect(loadConfig({ HOMEBOX_BASE_URL: "http://homebox.local" }).host).toBe("127.0.0.1");
  });

  it("refuses unsafe direct runtime config", async () => {
    await expect(startServer({ ...testConfig("http://127.0.0.1:1"), host: "0.0.0.0" })).rejects.toThrow(/Refusing to listen/);
  });

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
      if (req.method === "GET" && req.path === "/api/v1/currency") {
        expect(req.headers.authorization).toBeUndefined();
        json(res, 200, [{ code: "USD", decimals: 2, local: "US dollar", name: "United States Dollar", symbol: "$" }]);
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
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.headers.authorization).toBe("Bearer user-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "entity-1", name: "Drill" }] });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entity-types") {
        expect(req.headers.authorization).toBe("Bearer user-token");
        json(res, 200, [{ id: "type-1", name: "Item" }]);
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

    const currencies = await client.callTool({ name: "homebox_list_currencies", arguments: {} });
    expect(currencies.structuredContent).toMatchObject({ data: [{ code: "USD", decimals: 2 }] });

    const login = await client.callTool({ name: "homebox_login", arguments: { username: "user@example.com", password: "secret" } });
    const sessionKey = (login.structuredContent as { sessionKey?: unknown } | undefined)?.sessionKey;
    expect(typeof sessionKey).toBe("string");

    const items = await client.callTool({ name: "homebox_list_items", arguments: { sessionKey, pageSize: 1 } });
    expect(items.structuredContent).toMatchObject({ total: 1 });

    const entities = await client.callTool({ name: "homebox_list_entities", arguments: { sessionKey, q: "drill" } });
    expect(entities.structuredContent).toMatchObject({ total: 1 });

    const entityTypes = await client.callTool({ name: "homebox_list_entity_types", arguments: { sessionKey } });
    expect(entityTypes.structuredContent).toMatchObject({ data: [{ id: "type-1" }] });

    await client.close();
  });

  it("supports OAuth connection auth without homebox_login tool calls", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        json(res, 200, { token: "Bearer oauth-homebox-token", expiresAt: "2030-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/items") {
        expect(req.headers.authorization).toBe("Bearer oauth-homebox-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "item-oauth", name: "OAuth Drill" }] });
        return;
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });
    started = await startServer(oauthTestConfig(mock.url));
    const origin = new URL(started.url).origin;
    const redirectUri = "http://127.0.0.1/callback";
    const resource = started.url;

    const unauthorized = await fetch(started.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");

    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    await expect(metadata.json()).resolves.toMatchObject({ resource, authorization_servers: [origin] });

    const registration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as { client_id: string };

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const badAuthorize = await fetch(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${origin}/wrong-resource`,
        username: "user@example.com",
        password: "secret",
      }),
    });
    expect(badAuthorize.status).toBe(400);
    await expect(badAuthorize.json()).resolves.toMatchObject({ error: "invalid_target" });

    const authorize = await fetch(`${origin}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
        state: "state-1",
        username: "user@example.com",
        password: "secret",
      }),
    });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("state-1");
    const code = callback.searchParams.get("code") ?? "";
    expect(code).toMatch(/^code_/);

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
        resource,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type).toBe("Bearer");

    const client = new Client({ name: "homebox-mcp-oauth-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    await client.connect(transport);

    const items = await client.callTool({ name: "homebox_list_items", arguments: { pageSize: 1 } });
    expect(items.structuredContent).toMatchObject({ total: 1 });

    const rejectedSessionOverride = await client.callTool({ name: "homebox_list_items", arguments: { sessionKey: "other-session", pageSize: 1 } });
    expect(rejectedSessionOverride.isError).toBe(true);
    expect(rejectedSessionOverride.structuredContent).toMatchObject({ kind: "auth" });

    await client.close();
  });

  it("consumes OAuth refresh tokens atomically", () => {
    const store = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600 });
    const tokens = store.issueTokens({
      clientId: "client-1",
      resource: "https://mcp.example.com/mcp",
      session: { sessionKey: "oauth:client-1", token: "Bearer homebox-token", createdAt: new Date().toISOString() },
    });

    expect(store.consumeRefreshToken({ clientId: "client-1", refreshToken: tokens.refreshToken }).clientId).toBe("client-1");
    expect(() => store.consumeRefreshToken({ clientId: "client-1", refreshToken: tokens.refreshToken })).toThrow(/Unknown refresh token/);
  });

  it("persists OAuth clients and tokens across restarts", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        json(res, 200, { token: "Bearer persisted-homebox-token", expiresAt: "2030-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        json(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/items") {
        expect(req.headers.authorization).toBe("Bearer persisted-homebox-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "item-persisted", name: "Persisted OAuth Drill" }] });
        return;
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });
    tempDir = mkdtempSync(join(tmpdir(), "homebox-mcp-oauth-"));
    const config = oauthTestConfig(mock.url);
    config.dataDir = tempDir;
    config.oauth = { ...config.oauth!, publicUrl: "http://homebox-mcp.test/mcp" };
    started = await startServer(config);
    const origin = new URL(started.url).origin;
    const redirectUri = "http://127.0.0.1/callback";
    const resource = config.oauth.publicUrl;

    const registration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT persisted test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    const registered = (await registration.json()) as { client_id: string };
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorize = await fetch(`${origin}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
        username: "user@example.com",
        password: "secret",
      }),
    });
    const callback = new URL(authorize.headers.get("location") ?? "");

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        resource,
      }),
    });
    const tokens = (await tokenResponse.json()) as { access_token: string };

    await started.close();
    started = await startServer(config);
    const client = new Client({ name: "homebox-mcp-persisted-oauth-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    await client.connect(transport);

    const items = await client.callTool({ name: "homebox_list_items", arguments: { pageSize: 1 } });
    expect(items.structuredContent).toMatchObject({ total: 1 });

    await client.close();
  });

  it("requires HTTPS public URL or explicit insecure override for OAuth startup", async () => {
    await expect(
      startServer({
        ...testConfig("http://127.0.0.1:1"),
        oauth: {
          enabled: true,
          authCodeTtlSeconds: 300,
          accessTokenTtlSeconds: 3600,
          refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
          allowInsecureHttp: false,
        },
      }),
    ).rejects.toThrow(/HOMEBOX_MCP_PUBLIC_URL/);
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

function oauthTestConfig(homeboxBaseUrl: string): AppConfig {
  return {
    ...testConfig(homeboxBaseUrl),
    oauth: {
      enabled: true,
      authCodeTtlSeconds: 300,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
      allowInsecureHttp: true,
    },
  };
}
