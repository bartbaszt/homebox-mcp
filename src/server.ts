// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { type AppConfig, type OAuthConfig, loadConfig, loadTlsConfig, validateConfigSecurity } from "./config.js";
import { HomeboxMcpError } from "./errors.js";
import { HomeboxClient } from "./homebox-client.js";
import { OAuthError, OAuthStore } from "./oauth-store.js";
import type { ConnectionSessionRef, HomeboxSession } from "./session-store.js";
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
  sessionRef?: ConnectionSessionRef;
  lifetimeTimer?: NodeJS.Timeout;
  grantTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
}

const sseSessionsByRuntime = new WeakMap<RuntimeState, Map<string, SseSessionEntry>>();
const MAX_SSE_SESSIONS = 256;
const MAX_SSE_SESSIONS_PER_PRINCIPAL = 8;
const MAX_SSE_SESSIONS_PER_ACCOUNT = 16;
const SSE_SESSION_MAX_LIFETIME_MS = 60 * 60_000;
/** How often an open SSE stream verifies that its OAuth grant still exists. */
const SSE_GRANT_RECHECK_MS = 60_000;

/**
 * Single source of truth for the reported build version.
 *
 * `APP_VERSION` is baked into the container image by CI so a running deployment can be matched to a
 * release tag. Outside Docker it falls back to `package.json`, which sits one level above both
 * `src/server.ts` and the flat `dist/server.js` build output.
 */
function resolveServerVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    // Fall through to the development placeholder.
  }
  return "0.0.0-dev";
}

export const SERVER_VERSION = resolveServerVersion();

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

export function createMcpServer(state: RuntimeState, connectionSession?: ConnectionSessionRef): McpServer {
  const server = new McpServer(
    { name: "homebox-mcp", version: SERVER_VERSION },
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

  // Registered before every route so CORS preflights are answered without hitting MCP auth.
  app.use(corsHeaders(state.config));

  registerOAuthRoutes(app, state);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "homebox-mcp",
      version: SERVER_VERSION,
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
      const server = createMcpServer(state, connectionSessionRef(req));
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
    const sessionRef = connectionSession ? { current: connectionSession } : undefined;
    const server = createMcpServer(state, sessionRef);
    const transport = new SSEServerTransport(sseMessagesPath, res);
    const entry: SseSessionEntry = { server, transport, principal, account, sessionRef };
    sseTransports.set(transport.sessionId, entry);
    entry.lifetimeTimer = setTimeout(() => {
      void closeSseSession(sseTransports, transport.sessionId, entry).catch(() => undefined);
    }, SSE_SESSION_MAX_LIFETIME_MS);
    entry.lifetimeTimer.unref();
    if (sessionRef) {
      // The stream outlives a single access token, so drop it as soon as the whole grant is gone.
      entry.grantTimer = setInterval(() => {
        if (state.oauth.hasActiveGrant(sessionRef.current.sessionKey)) return;
        void closeSseSession(sseTransports, transport.sessionId, entry).catch(() => undefined);
      }, SSE_GRANT_RECHECK_MS);
      entry.grantTimer.unref();
    }
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
      // Adopt the freshly authenticated session so tool calls follow refresh-token rotation.
      const currentSession = authenticatedSession(req);
      if (entry.sessionRef && currentSession) entry.sessionRef.current = currentSession;
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

const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID";
const CORS_EXPOSED_HEADERS = "Mcp-Session-Id, WWW-Authenticate";
const CORS_MAX_AGE_SECONDS = 600;

/**
 * Emits CORS headers for browser MCP clients whose origin is explicitly allowlisted.
 * Requests from any other origin are left untouched, so the browser keeps blocking them.
 */
function corsHeaders(config: AppConfig): RequestHandler {
  const allowed = new Set(config.allowedOrigins ?? []);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowed.size === 0) {
      next();
      return;
    }
    res.vary("Origin");
    const origin = normalizeRequestOrigin(req.header("origin"));
    if (!origin || !allowed.has(origin)) {
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
    if (req.method !== "OPTIONS") {
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
    res.status(204).end();
  };
}

function normalizeRequestOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
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
      sendAuthorizePage(res, auth, { clientName: state.oauth.clientDescriptor(auth.clientId)?.clientName });
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  app.post("/oauth/authorize", authorizeRateLimit, oauthFormParser, async (req, res) => {
    let auth: ReturnType<typeof authorizationRequest> | undefined;
    try {
      auth = authorizationRequest(req.body, state.oauth, resourceUrl(req, state.config));
      const clientName = state.oauth.clientDescriptor(auth.clientId)?.clientName;
      const decision = formValue(req.body, "action");

      // The user explicitly declined, so no credential is touched and no code is minted.
      if (decision === "deny") {
        sendAuthorizeRedirect(res, auth, { error: "access_denied", error_description: "The user declined the authorization request" });
        return;
      }
      // A missing decision means the consent screen was bypassed. Re-render it instead of
      // treating a successful Homebox login as implicit consent for an unseen client.
      if (decision !== "allow") {
        sendAuthorizePage(res, auth, { clientName, error: "Choose Authorize to grant access or Cancel to decline.", status: 400 });
        return;
      }

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
      sendAuthorizeRedirect(res, auth, { code });
    } catch (error) {
      if (auth) {
        sendAuthorizePage(res, auth, {
          clientName: state.oauth.clientDescriptor(auth.clientId)?.clientName,
          error: "Homebox login failed. Check username and password.",
          status: 401,
        });
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
        const rotation = state.oauth.beginRefreshTokenRotation({
          clientId: formValue(req.body, "client_id"),
          refreshToken,
          resource,
        });
        const refresh = rotation.record;
        try {
          const refreshed = await state.homebox.refresh(refresh.session.token);
          sendTokenResponse(
            res,
            state.oauth.issueTokens(
              {
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
              },
              { replaces: rotation.handle },
            ),
          );
        } catch (error) {
          state.oauth.abortRefreshTokenRotation(rotation.handle, { revokeGrant: isDeadHomeboxSession(error) });
          throw refreshFailureToOAuthError(error);
        } finally {
          state.oauth.releaseRotation(rotation.handle);
        }
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

function connectionSessionRef(req: Request): ConnectionSessionRef | undefined {
  const session = authenticatedSession(req);
  return session ? { current: session } : undefined;
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

type AuthorizationRequestContext = ReturnType<typeof authorizationRequest>;

interface AuthorizePageOptions {
  /** Self-declared client name. Rendered as untrusted, because dynamic registration accepts any value. */
  clientName?: string;
  error?: string;
  status?: number;
}

const AUTHORIZE_PAGE_STYLES = `body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}h1{font-size:1.4rem}dl{margin:1.25rem 0;padding:.75rem 1rem;border:1px solid #d0d0d8;border-radius:.5rem}dt{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:#55555f}dd{margin:.15rem 0 .9rem}dd:last-of-type{margin-bottom:.15rem}.host{font-size:1.05rem}.uri{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;word-break:break-all;color:#40404a}.unverified{color:#55555f;font-size:.8rem}.warn{border-left:.25rem solid #b06000;background:#fff8ef;padding:.6rem .8rem;border-radius:.25rem}label{display:block;margin:.75rem 0}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.4rem}.note{color:#55555f;font-size:.8rem}.actions{display:flex;gap:.75rem;margin-top:1.25rem}button{padding:.55rem 1.1rem;font-size:1rem;border-radius:.35rem;border:1px solid #2b2b33;background:#2b2b33;color:#fff;cursor:pointer}button.secondary{background:#fff;color:#2b2b33}.error{color:#b00020;font-weight:600}`;
/** CSP hash for the inline stylesheet, so the page needs no `style-src 'unsafe-inline'`. */
const AUTHORIZE_STYLE_HASH = `'sha256-${createHash("sha256").update(AUTHORIZE_PAGE_STYLES).digest("base64")}'`;
const CSP_SOURCE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

function sendAuthorizePage(res: Response, auth: AuthorizationRequestContext, options: AuthorizePageOptions = {}): void {
  setAuthorizePageHeaders(res, auth.redirectUri);
  res.status(options.status ?? 200).type("html").send(renderAuthorizeForm(auth, options));
}

/**
 * Hardens the consent screen.
 *
 * `form-action` names the validated redirect origin as well as `'self'`, because submitting the
 * consent form ends in a cross-origin 302 to that origin and some browsers enforce `form-action`
 * against post-submit redirects. `'self'` alone would break the flow there.
 */
function setAuthorizePageHeaders(res: Response, redirectUri: string): void {
  setNoStore(res);
  const formAction = ["'self'", cspSource(redirectUri)].filter(Boolean).join(" ");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src ${AUTHORIZE_STYLE_HASH}; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function cspSource(uri: string): string | undefined {
  try {
    const origin = new URL(uri).origin;
    return CSP_SOURCE_PATTERN.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** Sends the user back to the client with either an authorization code or an OAuth error. */
function sendAuthorizeRedirect(res: Response, auth: AuthorizationRequestContext, params: Record<string, string>): void {
  setNoStore(res);
  res.setHeader("Referrer-Policy", "no-referrer");
  const redirect = new URL(auth.redirectUri);
  for (const [name, value] of Object.entries(params)) redirect.searchParams.set(name, value);
  if (auth.state) redirect.searchParams.set("state", auth.state);
  res.redirect(302, redirect.toString());
}

function renderAuthorizeForm(auth: AuthorizationRequestContext, options: AuthorizePageOptions = {}): string {
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
  const redirectHost = redirectDisplayHost(auth.redirectUri);
  const clientLabel = options.clientName?.trim()
    ? `<strong>${escapeHtml(options.clientName.trim())}</strong> <span class="unverified">(name reported by the application, not verified)</span>`
    : `<strong>Unnamed application</strong> <span class="unverified">(the application did not provide a name)</span>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Authorize access to Homebox</title>
  <style>${AUTHORIZE_PAGE_STYLES}</style>
</head>
<body>
  <main>
  <h1>Authorize access to Homebox</h1>
  <p>An application is asking for access to your Homebox account through this MCP server.</p>
  <dl>
    <dt>Application</dt>
    <dd>${clientLabel}</dd>
    <dt>Authorization code will be sent to</dt>
    <dd><strong class="host">${escapeHtml(redirectHost)}</strong><br><span class="uri">${escapeHtml(auth.redirectUri)}</span></dd>
    <dt>Requested access</dt>
    <dd>Full read and write access to your Homebox account, including items, locations, attachments and account settings (scope: <code>${escapeHtml(auth.scope)}</code>)</dd>
    <dt>MCP server</dt>
    <dd class="uri">${escapeHtml(auth.resource)}</dd>
    <dt>Client ID</dt>
    <dd class="uri">${escapeHtml(auth.clientId)}</dd>
  </dl>
  <p class="warn">Only the destination host above is verified. Authorize only if you started this from that application. If you reached this page from a link you did not expect, choose Cancel.</p>
  ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${fields}
    <label>Username or email<br><input name="username" type="text" autocomplete="username" required></label>
    <label>Password<br><input name="password" type="password" autocomplete="current-password" required></label>
    <label><input name="stayLoggedIn" type="checkbox" value="true" checked> Stay logged in</label>
    <p class="note">Your password is sent once to the configured Homebox instance and is not stored by this MCP server.</p>
    <div class="actions">
      <button type="submit" name="action" value="allow">Authorize</button>
      <button type="submit" name="action" value="deny" class="secondary" formnovalidate>Cancel</button>
    </div>
  </form>
  </main>
</body>
</html>`;
}

function redirectDisplayHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return redirectUri;
  }
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
  setNoStore(res);
  if (error instanceof OAuthError) {
    if (error.status === 503) res.setHeader("Retry-After", "5");
    res.status(error.status).json({ error: error.error, error_description: error.message });
    return;
  }
  res.status(500).json({ error: "server_error", error_description: "OAuth request failed" });
}

/** True when Homebox itself rejected the mapped session, so the grant can never be refreshed again. */
function isDeadHomeboxSession(error: unknown): boolean {
  return error instanceof HomeboxMcpError && error.kind === "auth";
}

/**
 * Maps a Homebox refresh failure onto an OAuth error.
 * Transient failures stay retryable (503) because the refresh token survives the failed rotation.
 */
function refreshFailureToOAuthError(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  if (error instanceof HomeboxMcpError) {
    if (error.kind === "auth") return new OAuthError("invalid_grant", "Homebox session is no longer valid. Re-authorize the connection.");
    if (error.kind === "network" || (error.kind === "homebox" && (error.status ?? 500) >= 500)) {
      return new OAuthError("temporarily_unavailable", "Homebox could not refresh the session right now. Retry shortly.", 503);
    }
  }
  return new OAuthError("server_error", "Refresh token rotation failed", 500);
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
  if (entry.grantTimer) clearInterval(entry.grantTimer);
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
