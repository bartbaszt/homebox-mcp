// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { type AppConfig, type OAuthConfig, loadConfig, loadTlsConfig, validateConfigSecurity } from "./config.js";
import { HomeboxMcpError } from "./errors.js";
import { HomeboxClient } from "./homebox-client.js";
import { OAuthError, OAuthStore } from "./oauth-store.js";
import type { HomeboxSession } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { registerHomeboxResources, registerHomeboxTools } from "./tools.js";

export interface RuntimeState {
  config: AppConfig;
  homebox: HomeboxClient;
  sessions: SessionStore;
  oauth: OAuthStore;
}

export interface StartedServer {
  state: RuntimeState;
  app: express.Express;
  server: HttpServer | HttpsServer;
  url: string;
  close: () => Promise<void>;
}

interface SseSessionEntry {
  server: McpServer;
  transport: SSEServerTransport;
  principal: string;
  account: string;
  lifetimeTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
}

const sseSessionsByRuntime = new WeakMap<RuntimeState, Map<string, SseSessionEntry>>();
const MAX_SSE_SESSIONS = 256;
const MAX_SSE_SESSIONS_PER_PRINCIPAL = 8;
const MAX_SSE_SESSIONS_PER_ACCOUNT = 16;
const SSE_SESSION_MAX_LIFETIME_MS = 60 * 60_000;

export function createRuntime(config = loadConfig()): RuntimeState {
  const oauth = oauthConfig(config);
  const state: RuntimeState = {
    config,
    homebox: new HomeboxClient(
      config.homeboxBaseUrl,
      config.timeoutMs,
      config.maxUploadBytes,
      config.maxDownloadBytes,
      config.localFileRoot,
    ),
    sessions: new SessionStore(),
    oauth: new OAuthStore({ ...oauth, storagePath: config.dataDir ? join(config.dataDir, "oauth-store.json") : undefined }),
  };
  sseSessionsByRuntime.set(state, new Map());
  return state;
}

export function createMcpServer(state: RuntimeState, connectionSession?: HomeboxSession): McpServer {
  const server = new McpServer(
    { name: "homebox-mcp", version: "0.1.0" },
    {
      instructions:
        "Use the OAuth-authorized MCP connection by default. If OAuth is not configured, use homebox_login and pass sessionKey to later tools. This server targets one configured Homebox instance. Collections are Homebox groups.",
    },
  );
  registerHomeboxTools(server, { homebox: state.homebox, sessions: state.sessions, connectionSession });
  registerHomeboxResources(server, { homebox: state.homebox, sessions: state.sessions, connectionSession });
  return server;
}

export function createHttpApp(state: RuntimeState): express.Express {
  const app = express();
  if (state.config.trustProxy) app.set("trust proxy", state.config.trustProxy);
  const bodyLimit = `${Math.ceil(state.config.maxUploadBytes * 1.5)}b`;
  const mcpJsonParser = express.json({ limit: bodyLimit });

  registerOAuthRoutes(app, state);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "homebox-mcp",
      transport: ["streamable-http", "sse"],
      mcpPath: state.config.mcpPath,
      homeboxConfigured: true,
      authRequired: Boolean(state.config.apiToken || oauthConfig(state.config).enabled),
      oauthEnabled: oauthConfig(state.config).enabled,
      oauthStorage: state.config.dataDir ? "disk" : "memory",
      license: "AGPL-3.0-or-later",
      sourceUrl: "https://github.com/bartbaszt/homebox-mcp",
    });
  });

  app.all(state.config.mcpPath, requireMcpAuth(state), mcpJsonParser, async (req, res, next) => {
    try {
      const server = createMcpServer(state, authenticatedSession(req));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void Promise.allSettled([transport.close(), server.close()]);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  const ssePath = `${state.config.mcpPath}/sse`;
  const sseMessagesPath = `${state.config.mcpPath}/messages`;
  const sseTransports = sseSessionsFor(state);

  app.get(ssePath, requireMcpAuth(state), async (req, res, next) => {
    const principal = authenticatedPrincipal(req);
    const connectionSession = authenticatedSession(req);
    const account = connectionSession?.username ? `homebox:${connectionSession.username.trim().toLocaleLowerCase()}` : principal;
    const principalSessions = [...sseTransports.values()].filter((entry) => entry.principal === principal).length;
    const accountSessions = [...sseTransports.values()].filter((entry) => entry.account === account).length;
    if (sseTransports.size >= MAX_SSE_SESSIONS || principalSessions >= MAX_SSE_SESSIONS_PER_PRINCIPAL || accountSessions >= MAX_SSE_SESSIONS_PER_ACCOUNT) {
      res.status(429).json({ ok: false, error: "SSE session capacity reached; close an existing session before reconnecting" });
      return;
    }
    const server = createMcpServer(state, connectionSession);
    const transport = new SSEServerTransport(sseMessagesPath, res);
    const entry: SseSessionEntry = { server, transport, principal, account };
    sseTransports.set(transport.sessionId, entry);
    entry.lifetimeTimer = setTimeout(() => {
      void closeSseSession(sseTransports, transport.sessionId, entry).catch(() => undefined);
    }, SSE_SESSION_MAX_LIFETIME_MS);
    entry.lifetimeTimer.unref();
    res.on("close", () => {
      void closeSseSession(sseTransports, transport.sessionId, entry).catch(() => undefined);
    });
    try {
      await server.connect(transport);
    } catch (error) {
      await closeSseSession(sseTransports, transport.sessionId, entry).catch(() => undefined);
      next(error);
    }
  });

  app.post(sseMessagesPath, requireMcpAuth(state), mcpJsonParser, async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId as string;
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId query parameter" });
        return;
      }
      const entry = sseTransports.get(sessionId);
      if (!entry) {
        res.status(404).json({ ok: false, error: "Unknown SSE sessionId" });
        return;
      }
      if (entry.principal !== authenticatedPrincipal(req)) {
        res.status(403).json({ ok: false, error: "SSE session belongs to a different authenticated principal" });
        return;
      }
      const { transport } = entry;
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const bodyErrorStatus = requestBodyErrorStatus(error);
    if (bodyErrorStatus) {
      if (req.path.startsWith("/oauth/")) {
        res.status(bodyErrorStatus).json({
          error: "invalid_request",
          error_description: bodyErrorStatus === 413 ? "Request body is too large" : "Malformed request body",
        });
        return;
      }
      res.status(bodyErrorStatus).json({ ok: false, error: bodyErrorStatus === 413 ? "Request body is too large" : "Malformed JSON request body" });
      return;
    }
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  return app;
}

export async function startServer(config = loadConfig()): Promise<StartedServer> {
  validateConfigSecurity(config);
  const state = createRuntime(config);
  const app = createHttpApp(state);
  const tls = loadTlsConfig(config);
  const oauth = oauthConfig(config);
  if (oauth.enabled && !oauth.publicUrl && !oauth.allowInsecureHttp && !tls) {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_PUBLIC_URL is required for OAuth unless direct HTTPS or HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true is configured");
  }
  const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);

  const listenHost = config.host.replace(/^\[|\]$/g, "");
  await listen(server, config.port, listenHost);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost === "::" ? "::1" : listenHost;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `${tls ? "https" : "http"}://${urlHost}:${port}${config.mcpPath}`;

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeStartedServer(state, server);
    return closePromise;
  };

  return {
    state,
    app,
    server,
    url,
    close,
  };
}

function requireMcpAuth(state: RuntimeState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = state.config;
    const oauth = oauthConfig(config);
    const provided = tokenFromRequest(req);
    if (config.apiToken && provided && safeEqual(provided, config.apiToken)) {
      (req as AuthenticatedRequest).mcpPrincipal = "api-token";
      next();
      return;
    }

    if (oauth.enabled) {
      const session = provided ? state.oauth.validateAccessToken(provided, resourceUrl(req, config)) : undefined;
      if (session) {
        const authenticatedRequest = req as AuthenticatedRequest;
        authenticatedRequest.homeboxSession = session;
        authenticatedRequest.mcpPrincipal = session.sessionKey;
        next();
        return;
      }
      sendMcpAuthChallenge(req, res, config, provided ? "Invalid or expired OAuth access token" : "OAuth login required");
      return;
    }

    if (!config.apiToken) {
      (req as AuthenticatedRequest).mcpPrincipal = "anonymous";
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "Missing or invalid MCP API token" });
  };
}

function registerOAuthRoutes(app: express.Express, state: RuntimeState): void {
  if (!oauthConfig(state.config).enabled) return;
  const oauthJsonParser = express.json({ limit: "64kb" });
  const oauthFormParser = express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 100 });
  const registerRateLimit = rateLimit(20, 10 * 60_000);
  const authorizeRateLimit = rateLimit(10, 5 * 60_000);
  const tokenRateLimit = rateLimit(60, 5 * 60_000);

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
      resource: resourceUrl(req, state.config),
      authorization_servers: [issuerUrl(req, state.config)],
      bearer_methods_supported: ["header"],
      scopes_supported: ["homebox"],
      resource_documentation: "https://homebox.software/en/api/",
    });
  });

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (req, res) => {
    const issuer = issuerUrl(req, state.config);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["homebox"],
    });
  });

  app.post("/oauth/register", registerRateLimit, oauthJsonParser, (req, res) => {
    try {
      setNoStore(res);
      res.status(201).json(state.oauth.registerClient(req.body));
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.get("/oauth/authorize", (req, res) => {
    try {
      const auth = authorizationRequest(req.query, state.oauth, resourceUrl(req, state.config));
      res.type("html").send(renderAuthorizeForm(auth));
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/authorize", authorizeRateLimit, oauthFormParser, async (req, res) => {
    let auth: ReturnType<typeof authorizationRequest> | undefined;
    try {
      auth = authorizationRequest(req.body, state.oauth, resourceUrl(req, state.config));
      const username = formValue(req.body, "username");
      const password = formValue(req.body, "password");
      if (!username || !password) throw new OAuthError("invalid_request", "username and password are required");
      if (username.length > 320 || password.length > 4_096) throw new OAuthError("invalid_request", "username or password is too long");

      const login = await state.homebox.login(username, password, formValue(req.body, "stayLoggedIn") !== "false");
      const code = state.oauth.createAuthorizationCode({
        ...auth,
        session: {
          sessionKey: `oauth:${randomUUID()}`,
          token: login.token,
          username,
          expiresAt: login.expiresAt,
          attachmentToken: login.attachmentToken,
          createdAt: new Date().toISOString(),
        },
      });
      const redirect = new URL(auth.redirectUri);
      redirect.searchParams.set("code", code);
      const stateParam = auth.state;
      if (stateParam) redirect.searchParams.set("state", stateParam);
      res.redirect(302, redirect.toString());
    } catch (error) {
      if (auth) {
        res.status(401).type("html").send(renderAuthorizeForm(auth, "Homebox login failed. Check username and password."));
        return;
      }
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/token", tokenRateLimit, oauthFormParser, async (req, res) => {
    try {
      setNoStore(res);
      const grantType = formValue(req.body, "grant_type");
      if (grantType === "authorization_code") {
        const resource = formValue(req.body, "resource");
        assertExpectedResource(resource, resourceUrl(req, state.config));
        const code = state.oauth.exchangeAuthorizationCode({
          clientId: formValue(req.body, "client_id"),
          code: formValue(req.body, "code"),
          redirectUri: formValue(req.body, "redirect_uri"),
          codeVerifier: formValue(req.body, "code_verifier"),
          resource,
        });
        sendTokenResponse(res, state.oauth.issueTokens(code));
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = formValue(req.body, "refresh_token");
        const resource = formValue(req.body, "resource");
        if (resource) assertExpectedResource(resource, resourceUrl(req, state.config));
        const refresh = state.oauth.consumeRefreshToken({
          clientId: formValue(req.body, "client_id"),
          refreshToken,
          resource,
        });
        const refreshed = await state.homebox.refresh(refresh.session.token);
        sendTokenResponse(
          res,
          state.oauth.issueTokens({
            clientId: refresh.clientId,
            resource: refresh.resource,
            scope: refresh.scope,
            session: {
              ...refresh.session,
              token: refreshed.token,
              expiresAt: refreshed.expiresAt,
              attachmentToken: refreshed.attachmentToken ?? refresh.session.attachmentToken,
              refreshedAt: new Date().toISOString(),
            },
          }),
        );
        return;
      }

      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (error) {
      sendOAuthError(res, error);
    }
  });
}

function tokenFromRequest(req: Request): string | undefined {
  const auth = req.header("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (auth) return auth;
  return req.header("x-api-key")?.trim();
}

function authenticatedSession(req: Request): HomeboxSession | undefined {
  return (req as AuthenticatedRequest).homeboxSession;
}

function authenticatedPrincipal(req: Request): string {
  return (req as AuthenticatedRequest).mcpPrincipal ?? "anonymous";
}

type AuthenticatedRequest = Request & { homeboxSession?: HomeboxSession; mcpPrincipal?: string };

function oauthConfig(config: AppConfig): OAuthConfig {
  return (
    config.oauth ?? {
      enabled: false,
      authCodeTtlSeconds: 300,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
      allowInsecureHttp: false,
    }
  );
}

function resourceUrl(req: Request, config: AppConfig): string {
  return oauthConfig(config).publicUrl ?? `${externalOrigin(req, config)}${config.mcpPath}`;
}

function issuerUrl(req: Request, config: AppConfig): string {
  return oauthConfig(config).issuer ?? externalOrigin(req, config);
}

function protectedResourceMetadataUrl(req: Request, config: AppConfig): string {
  return `${externalOrigin(req, config)}/.well-known/oauth-protected-resource`;
}

function externalOrigin(req: Request, config: AppConfig): string {
  const publicUrl = oauthConfig(config).publicUrl;
  if (publicUrl) return new URL(publicUrl).origin;
  return `${req.protocol}://${req.get("host")}`;
}

function sendMcpAuthChallenge(req: Request, res: Response, config: AppConfig, description: string): void {
  const challenge = `Bearer resource_metadata="${quoteHeader(protectedResourceMetadataUrl(req, config))}", error="invalid_token", error_description="${quoteHeader(description)}"`;
  res.setHeader("WWW-Authenticate", challenge);
  res.status(401).json({ ok: false, error: description });
}

function authorizationRequest(source: unknown, store: OAuthStore, expectedResource: string) {
  const auth = store.validateAuthorizationRequest({
    responseType: formValue(source, "response_type"),
    clientId: formValue(source, "client_id"),
    redirectUri: formValue(source, "redirect_uri"),
    codeChallenge: formValue(source, "code_challenge"),
    codeChallengeMethod: formValue(source, "code_challenge_method"),
    resource: formValue(source, "resource"),
    scope: formValue(source, "scope"),
  });
  assertExpectedResource(auth.resource, expectedResource);
  return { ...auth, state: formValue(source, "state") };
}

function assertExpectedResource(resource: string | undefined, expectedResource: string): void {
  if (resource !== expectedResource) throw new OAuthError("invalid_target", "resource must match this MCP server");
}

function renderAuthorizeForm(auth: ReturnType<typeof authorizationRequest>, error?: string): string {
  const hidden: Record<string, string> = {
    response_type: "code",
    client_id: auth.clientId,
    redirect_uri: auth.redirectUri,
    code_challenge: auth.codeChallenge,
    code_challenge_method: auth.codeChallengeMethod,
    resource: auth.resource,
    scope: auth.scope,
  };
  if (auth.state) hidden.state = auth.state;
  const fields = Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Homebox MCP</title>
  <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}.error{color:#b00020}</style>
</head>
<body>
  <h1>Connect Homebox MCP</h1>
  <p>Sign in to the configured Homebox instance. Password is used once and is not stored by this MCP server.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${fields}
    <label>Username or email<br><input name="username" autocomplete="username" required></label>
    <label>Password<br><input name="password" type="password" autocomplete="current-password" required></label>
    <label><input name="stayLoggedIn" type="checkbox" value="true" checked> Stay logged in</label>
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}

function formValue(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sendTokenResponse(res: Response, tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope?: string }): void {
  res.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    scope: tokens.scope ?? "homebox",
  });
}

function sendOAuthError(res: Response, error: unknown): void {
  if (error instanceof OAuthError) {
    res.status(error.status).json({ error: error.error, error_description: error.message });
    return;
  }
  res.status(500).json({ error: "server_error", error_description: "OAuth request failed" });
}

function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function quoteHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function safeEqual(left: string, right: string): boolean {
  if (!right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rateLimit(limit: number, windowMs: number, maxKeys = 2_048): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const globalLimit = limit * 10;
  let globalBucket = { count: 0, resetAt: Date.now() + windowMs };
  let requestCount = 0;
  return (req, res, next): void => {
    const now = Date.now();
    if (globalBucket.resetAt <= now) globalBucket = { count: 0, resetAt: now + windowMs };
    if (++requestCount % 128 === 0 || buckets.size >= maxKeys) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = rateLimitAddress(req.ip || req.socket.remoteAddress || "unknown");
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxKeys) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (oldestKey) buckets.delete(oldestKey);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit || globalBucket.count >= globalLimit) {
      setNoStore(res);
      const resetAt = Math.max(bucket.resetAt, globalBucket.resetAt);
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1_000))));
      res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many OAuth requests; retry later" });
      return;
    }
    bucket.count += 1;
    globalBucket.count += 1;
    next();
  };
}

function rateLimitAddress(raw: string): string {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(value);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  const address = (bracketed?.[1] ?? ipv4WithPort?.[1] ?? value).split("%", 1)[0];
  if (isIP(address) === 0) return "invalid-forwarded-address";
  if (isIP(address) !== 6) return address;
  const hextets = expandIpv6(address);
  if (hextets.length !== 8) return address;
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    return `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
  }
  return `${hextets.slice(0, 4).map((part) => part.toString(16).padStart(4, "0")).join(":")}::/64`;
}

function expandIpv6(raw: string): number[] {
  let address = raw;
  const dottedMatch = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dottedMatch) {
    const octets = dottedMatch[1].split(".").map(Number);
    address = `${address.slice(0, -dottedMatch[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [leftRaw, rightRaw] = address.split("::", 2);
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = address.includes("::") ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  return parts.length === 8 ? parts.map((part) => Number.parseInt(part, 16)) : [];
}

function requestBodyErrorStatus(error: unknown): 400 | 413 | undefined {
  if (!error || typeof error !== "object") return undefined;
  const parserError = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = parserError.status ?? parserError.statusCode;
  if (status === 413 || parserError.type === "entity.too.large" || parserError.type === "parameters.too.many") return 413;
  if (status === 400 || parserError.type === "entity.parse.failed" || parserError.type === "request.size.invalid") return 400;
  return undefined;
}

function sseSessionsFor(state: RuntimeState): Map<string, SseSessionEntry> {
  let sessions = sseSessionsByRuntime.get(state);
  if (!sessions) {
    sessions = new Map();
    sseSessionsByRuntime.set(state, sessions);
  }
  return sessions;
}

function closeSseSession(sessions: Map<string, SseSessionEntry>, sessionId: string, entry: SseSessionEntry): Promise<void> {
  if (entry.closing) return entry.closing;
  if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
  if (entry.lifetimeTimer) clearTimeout(entry.lifetimeTimer);
  entry.closing = (async () => {
    let failure: unknown;
    try {
      await entry.transport.close();
    } catch (error) {
      failure = error;
    }
    try {
      await entry.server.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  })();
  return entry.closing;
}

async function closeStartedServer(state: RuntimeState, server: HttpServer | HttpsServer): Promise<void> {
  const sessions = sseSessionsFor(state);
  const closeResults = await Promise.allSettled(
    [...sessions.entries()].map(([sessionId, entry]) => closeSseSession(sessions, sessionId, entry)),
  );
  await closeHttpServer(server);
  const failed = closeResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

function listen(server: HttpServer | HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: HttpServer | HttpsServer, deadlineMs = 5_000): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, deadlineMs);
    deadline.unref();
    server.close((error) => finish(error));
  });
}
