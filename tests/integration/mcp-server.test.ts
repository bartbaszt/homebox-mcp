import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/config.js";
import { OAuthStore } from "../../src/oauth-store.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { SessionStore } from "../../src/session-store.js";
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

  it("requires HTTPS OAuth public and issuer URLs in loaded and direct config", async () => {
    const oauthEnv = { HOMEBOX_BASE_URL: "http://homebox.local", HOMEBOX_MCP_OAUTH_ENABLED: "true" };
    expect(() => loadConfig({ ...oauthEnv, HOMEBOX_MCP_PUBLIC_URL: "http://mcp.example.com/mcp" })).toThrow(/HOMEBOX_MCP_PUBLIC_URL.*HTTPS/);
    expect(() => loadConfig({ ...oauthEnv, HOMEBOX_MCP_OAUTH_ISSUER: "http://mcp.example.com" })).toThrow(/HOMEBOX_MCP_OAUTH_ISSUER.*HTTPS/);
    expect(
      loadConfig({
        ...oauthEnv,
        HOMEBOX_MCP_PUBLIC_URL: "http://mcp.example.com/mcp",
        HOMEBOX_MCP_OAUTH_ISSUER: "http://mcp.example.com",
        HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP: "true",
      }).oauth?.allowInsecureHttp,
    ).toBe(true);

    await expect(
      startServer({
        ...oauthTestConfig("http://127.0.0.1:1"),
        oauth: { ...oauthTestConfig("http://127.0.0.1:1").oauth!, publicUrl: "http://mcp.example.com/mcp", allowInsecureHttp: false },
      }),
    ).rejects.toThrow(/HOMEBOX_MCP_PUBLIC_URL.*HTTPS/);
    await expect(
      startServer({
        ...oauthTestConfig("http://127.0.0.1:1"),
        oauth: {
          ...oauthTestConfig("http://127.0.0.1:1").oauth!,
          publicUrl: "https://mcp.example.com/mcp",
          issuer: "http://mcp.example.com",
          allowInsecureHttp: false,
        },
      }),
    ).rejects.toThrow(/HOMEBOX_MCP_OAUTH_ISSUER.*HTTPS/);
  });

  it("restricts local file roots from sensitive paths and filesystem roots", () => {
    tempDir = mkdtempSync(join(tmpdir(), "homebox-mcp-files-"));
    const baseEnv = { HOMEBOX_BASE_URL: "http://homebox.local" };
    expect(() => loadConfig({ ...baseEnv, HOMEBOX_MCP_LOCAL_FILE_ROOT: parse(tempDir).root })).toThrow(/filesystem root/);
    expect(() =>
      loadConfig({
        ...baseEnv,
        HOMEBOX_MCP_LOCAL_FILE_ROOT: tempDir,
        HOMEBOX_MCP_DATA_DIR: join(tempDir, "private", "data"),
      }),
    ).toThrow(/HOMEBOX_MCP_DATA_DIR/);
    mkdirSync(join(tempDir, "files"));
    expect(
      loadConfig({
        ...baseEnv,
        HOMEBOX_MCP_LOCAL_FILE_ROOT: join(tempDir, "files"),
        HOMEBOX_MCP_DATA_DIR: join(tempDir, "private"),
      }).localFileRoot,
    ).toBe(join(tempDir, "files"));
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

  it("keeps large parsers route-scoped and returns parser-specific status codes", async () => {
    const config = { ...oauthTestConfig("http://127.0.0.1:1"), apiToken: "mcp-secret", maxUploadBytes: 128 };
    started = await startServer(config);
    const origin = new URL(started.url).origin;

    const malformedRegistration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformedRegistration.status).toBe(400);

    const oversizedRegistration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x".repeat(70 * 1024), redirect_uris: ["http://127.0.0.1/callback"] }),
    });
    expect(oversizedRegistration.status).toBe(413);

    const oversizedMcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { padding: "x".repeat(512) } });
    const unauthenticatedOversizedMcp = await fetch(started.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedMcpBody,
    });
    expect(unauthenticatedOversizedMcp.status).toBe(401);

    const malformedMcp = await fetch(started.url, {
      method: "POST",
      headers: { authorization: "Bearer mcp-secret", "content-type": "application/json" },
      body: "{",
    });
    expect(malformedMcp.status).toBe(400);

    const oversizedMcp = await fetch(started.url, {
      method: "POST",
      headers: { authorization: "Bearer mcp-secret", "content-type": "application/json" },
      body: oversizedMcpBody,
    });
    expect(oversizedMcp.status).toBe(413);
  });

  it("does not expose the configured Homebox URL in public health", async () => {
    await expect(startServer(testConfig("http://user:secret@internal.homebox.local"))).rejects.toThrow(/credentials/);
    started = await startServer(testConfig("http://internal.homebox.local"));
    const health = (await (await fetch(`${new URL(started.url).origin}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, homeboxConfigured: true });
    expect(JSON.stringify(health)).not.toContain("internal.homebox.local");
    expect(health).not.toHaveProperty("homeboxBaseUrl");
  });

  it("serves Homebox tools over Streamable HTTP", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/status") {
        json(res, 200, { health: true, build: { version: "0.26.1" } });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/currencies") {
        expect(req.headers.authorization).toBeUndefined();
        json(res, 200, [{ code: "USD", decimals: 2, local: "US dollar", name: "United States Dollar", symbol: "$" }]);
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        json(res, 200, { token: "Bearer user-token", expiresAt: "2030-01-01T00:00:00Z" });
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
      if (req.method === "GET" && req.path === "/api/v1/users/refresh") {
        expect(req.headers.authorization).toBe("Bearer oauth-homebox-token");
        json(res, 200, { token: "Bearer refreshed-oauth-homebox-token", expiresAt: "2031-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.headers.authorization).toBe("Bearer refreshed-oauth-homebox-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "entity-oauth", name: "OAuth Drill" }] });
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
    const grantSession = started.state.oauth.validateAccessToken(tokens.access_token, resource);
    expect(grantSession?.sessionKey).toMatch(/^oauth:[0-9a-f-]{36}$/);
    expect(grantSession?.sessionKey).not.toBe(`oauth:${registered.client_id}`);

    const refreshResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshedTokens = (await refreshResponse.json()) as { access_token: string };
    expect(started.state.oauth.validateAccessToken(refreshedTokens.access_token, resource)?.sessionKey).toBe(grantSession?.sessionKey);

    const client = new Client({ name: "homebox-mcp-oauth-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: `Bearer ${refreshedTokens.access_token}` } },
    });
    await client.connect(transport);

    const items = await client.callTool({ name: "homebox_list_items", arguments: { pageSize: 1 } });
    expect(items.structuredContent).toMatchObject({ total: 1 });

    const rejectedSessionOverride = await client.callTool({ name: "homebox_list_items", arguments: { sessionKey: "other-session", pageSize: 1 } });
    expect(rejectedSessionOverride.isError).toBe(true);
    expect(rejectedSessionOverride.structuredContent).toMatchObject({ kind: "auth" });

    await client.close();
  });

  it("binds legacy SSE message posts to the OAuth grant principal", async () => {
    const config = oauthTestConfig("http://127.0.0.1:1");
    config.oauth = { ...config.oauth!, publicUrl: "http://mcp.example.test/mcp" };
    started = await startServer(config);
    const origin = new URL(started.url).origin;
    const first = started.state.oauth.issueTokens({
      clientId: "client-1",
      resource: config.oauth.publicUrl!,
      session: { sessionKey: "oauth:grant-1", token: "Bearer first", createdAt: new Date().toISOString() },
    });
    const second = started.state.oauth.issueTokens({
      clientId: "client-1",
      resource: config.oauth.publicUrl!,
      session: { sessionKey: "oauth:grant-2", token: "Bearer second", createdAt: new Date().toISOString() },
    });

    const sse = await fetch(`${origin}/mcp/sse`, { headers: { authorization: `Bearer ${first.accessToken}` } });
    expect(sse.status).toBe(200);
    const reader = sse.body?.getReader();
    expect(reader).toBeDefined();
    const event = await reader!.read();
    const endpoint = /data: ([^\r\n]+)/.exec(new TextDecoder().decode(event.value))?.[1];
    if (!endpoint) throw new Error("SSE endpoint event was not received");

    const crossPrincipalPost = await fetch(`${origin}${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(crossPrincipalPost.status).toBe(403);
    await reader!.cancel();
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

  it("bounds dynamic OAuth client registration metadata and storage", () => {
    const store = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600, maxClients: 1 });
    const redirects = Array.from({ length: 11 }, (_, index) => `https://client.example.com/callback/${index}`);
    expect(() => store.registerClient({ redirect_uris: redirects })).toThrow(/at most 10/);
    expect(() => store.registerClient({ redirect_uris: [`https://client.example.com/${"x".repeat(2_048)}`] })).toThrow(/at most 2048/);
    expect(() => store.registerClient({ client_name: "x".repeat(201), redirect_uris: ["https://client.example.com/callback"] })).toThrow(/at most 200/);
    expect(() => store.registerClient({ client_name: "bad\0name", redirect_uris: ["https://client.example.com/callback"] })).toThrow(/control characters/);
    expect(() => store.registerClient({ redirect_uris: ["custom://localhost/callback"] })).toThrow(/HTTPS unless localhost/);
    expect(() => store.registerClient({ redirect_uris: ["https://client.example.com/callback#fragment"] })).toThrow(/fragment/);

    const first = store.registerClient({ client_name: "first", redirect_uris: ["https://client.example.com/callback"] });
    expect(store.registerClient({ client_name: "first", redirect_uris: ["https://client.example.com/callback"] }).client_id).toBe(first.client_id);
    store.issueTokens({ clientId: first.client_id, resource: "https://mcp.example.com/mcp", session: { sessionKey: "oauth:first", token: "Bearer token", createdAt: new Date().toISOString() } });
    expect(() => store.registerClient({ client_name: "second", redirect_uris: ["https://client.example.com/other"] })).toThrow(/capacity \(1\).*reuse/);

    const boundedTokens = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600, maxRecords: 1 });
    boundedTokens.issueTokens({ clientId: "client-1", resource: "https://mcp.example.com/mcp", session: { sessionKey: "oauth:one", token: "Bearer one", createdAt: new Date().toISOString() } });
    expect(() => boundedTokens.issueTokens({ clientId: "client-2", resource: "https://mcp.example.com/mcp", session: { sessionKey: "oauth:two", token: "Bearer two", createdAt: new Date().toISOString() } })).toThrow(/token capacity/);

    const accountGrants = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600 });
    const accountSession = { sessionKey: "oauth:account", token: "Bearer account", username: "user@example.com", createdAt: new Date().toISOString() };
    for (let index = 0; index < 32; index += 1) {
      accountGrants.createAuthorizationCode({ clientId: `client-${index}`, redirectUri: "https://client.example.com/callback", codeChallenge: "challenge", codeChallengeMethod: "S256", resource: "https://mcp.example.com/mcp", session: accountSession });
    }
    expect(() => accountGrants.createAuthorizationCode({ clientId: "client-33", redirectUri: "https://client.example.com/callback", codeChallenge: "challenge", codeChallengeMethod: "S256", resource: "https://mcp.example.com/mcp", session: accountSession })).toThrow(/grant capacity.*Homebox account/);
  });

  it("migrates persisted client-wide OAuth principals to grant-unique principals", () => {
    tempDir = mkdtempSync(join(tmpdir(), "homebox-mcp-oauth-principal-"));
    const storagePath = join(tempDir, "oauth-store.json");
    const resource = "https://mcp.example.com/mcp";
    const expiresAt = Date.now() + 60_000;
    const session = { sessionKey: "oauth:client-1", token: "Bearer homebox-token", username: "user@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
    const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
    writeFileSync(storagePath, JSON.stringify({
      version: 1,
      clients: [{ client_id: "client-1", client_id_issued_at: Math.floor(Date.now() / 1_000), redirect_uris: ["https://client.example.com/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }],
      authorizationCodes: [],
      accessTokens: [{ key: hash("access-token"), value: { clientId: "client-1", resource, session, expiresAt } }],
      refreshTokens: [{ key: hash("refresh-token"), value: { clientId: "client-1", resource, session, expiresAt } }],
    }));

    const store = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600, storagePath });
    const migratedAccess = store.validateAccessToken("access-token", resource);
    const migratedRefresh = store.consumeRefreshToken({ clientId: "client-1", refreshToken: "refresh-token" });

    expect(migratedAccess?.sessionKey).toMatch(/^oauth:/);
    expect(migratedAccess?.sessionKey).not.toBe("oauth:client-1");
    expect(migratedRefresh.session.sessionKey).toBe(migratedAccess?.sessionKey);
  });

  it("does not rewrite persisted OAuth state for an unknown authorization code", () => {
    tempDir = mkdtempSync(join(tmpdir(), "homebox-mcp-oauth-code-"));
    const storagePath = join(tempDir, "oauth-store.json");
    const store = new OAuthStore({ authCodeTtlSeconds: 300, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 3600, storagePath });
    store.registerClient({ redirect_uris: ["https://client.example.com/callback"] });
    const fixedTime = new Date("2001-01-01T00:00:00.000Z");
    utimesSync(storagePath, fixedTime, fixedTime);
    const before = statSync(storagePath).mtimeMs;

    expect(() => store.exchangeAuthorizationCode({ code: "code_unknown" })).toThrow(/Unknown authorization code/);
    expect(statSync(storagePath).mtimeMs).toBe(before);
  });

  it("evicts expired sessions and enforces session capacity", () => {
    const sessions = new SessionStore(1);
    sessions.set({ sessionKey: "expired", token: "Bearer expired", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(() => sessions.get("expired")).toThrow(/Session expired.*homebox_login/);
    expect(sessions.list()).toEqual([]);

    sessions.set({ sessionKey: "active", token: "Bearer active", expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(() => sessions.set({ sessionKey: "second", token: "Bearer second" })).toThrow(/Session capacity \(1\).*Log out/);
  });

  it("rejects when the configured listen address is already in use", async () => {
    started = await startServer(testConfig("http://127.0.0.1:1"));
    const port = Number(new URL(started.url).port);
    await expect(startServer({ ...testConfig("http://127.0.0.1:1"), port })).rejects.toHaveProperty("code", "EADDRINUSE");
  });

  it("persists OAuth clients and tokens across restarts", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        json(res, 200, { token: "Bearer persisted-homebox-token", expiresAt: "2030-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.headers.authorization).toBe("Bearer persisted-homebox-token");
        json(res, 200, { page: 1, pageSize: 1, total: 1, items: [{ id: "entity-persisted", name: "Persisted OAuth Drill" }] });
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
