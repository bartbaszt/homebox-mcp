import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { type AppConfig, type OAuthConfig, loadConfig, loadTlsConfig } from "./config.js";
import { HomeboxMcpError } from "./errors.js";
import { HomeboxClient } from "./homebox-client.js";
import { OAuthError, OAuthStore } from "./oauth-store.js";
import type { HomeboxSession } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { registerHomeboxTools } from "./tools.js";

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

export function createRuntime(config = loadConfig()): RuntimeState {
  const oauth = oauthConfig(config);
  return {
    config,
    homebox: new HomeboxClient(config.homeboxBaseUrl, config.timeoutMs, config.maxUploadBytes, config.maxDownloadBytes),
    sessions: new SessionStore(),
    oauth: new OAuthStore(oauth),
  };
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
  return server;
}

export function createHttpApp(state: RuntimeState): express.Express {
  const app = express();
  if (state.config.trustProxy) app.set("trust proxy", true);
  const bodyLimit = `${Math.ceil(state.config.maxUploadBytes * 1.5)}b`;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  registerOAuthRoutes(app, state);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "homebox-mcp",
      transport: "streamable-http",
      mcpPath: state.config.mcpPath,
      homeboxBaseUrl: state.config.homeboxBaseUrl,
      authRequired: Boolean(state.config.apiToken || oauthConfig(state.config).enabled),
      oauthEnabled: oauthConfig(state.config).enabled,
    });
  });

  app.all(state.config.mcpPath, requireMcpAuth(state), async (req, res, next) => {
    try {
      const server = createMcpServer(state, authenticatedSession(req));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  return app;
}

export async function startServer(config = loadConfig()): Promise<StartedServer> {
  const state = createRuntime(config);
  const app = createHttpApp(state);
  const tls = loadTlsConfig(config);
  const oauth = oauthConfig(config);
  if (oauth.enabled && !oauth.publicUrl && !oauth.allowInsecureHttp && !tls) {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_PUBLIC_URL is required for OAuth unless direct HTTPS or HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true is configured");
  }
  const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const url = `${tls ? "https" : "http"}://${host}:${port}${config.mcpPath}`;

  return {
    state,
    app,
    server,
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function requireMcpAuth(state: RuntimeState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = state.config;
    const oauth = oauthConfig(config);
    const provided = tokenFromRequest(req);
    if (config.apiToken && provided && safeEqual(provided, config.apiToken)) {
      next();
      return;
    }

    if (oauth.enabled) {
      const session = provided ? state.oauth.validateAccessToken(provided, resourceUrl(req, config)) : undefined;
      if (session) {
        (req as AuthenticatedRequest).homeboxSession = session;
        next();
        return;
      }
      sendMcpAuthChallenge(req, res, config, provided ? "Invalid or expired OAuth access token" : "OAuth login required");
      return;
    }

    if (!config.apiToken) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "Missing or invalid MCP API token" });
  };
}

function registerOAuthRoutes(app: express.Express, state: RuntimeState): void {
  if (!oauthConfig(state.config).enabled) return;

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

  app.post("/oauth/register", (req, res) => {
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

  app.post("/oauth/authorize", async (req, res) => {
    let auth: ReturnType<typeof authorizationRequest> | undefined;
    try {
      auth = authorizationRequest(req.body, state.oauth, resourceUrl(req, state.config));
      const username = formValue(req.body, "username");
      const password = formValue(req.body, "password");
      if (!username || !password) throw new OAuthError("invalid_request", "username and password are required");

      const login = await state.homebox.login(username, password, formValue(req.body, "stayLoggedIn") !== "false");
      const code = state.oauth.createAuthorizationCode({
        ...auth,
        session: {
          sessionKey: `oauth:${auth.clientId}`,
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

  app.post("/oauth/token", async (req, res) => {
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
        state.oauth.revokeRefreshToken(refreshToken);
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

type AuthenticatedRequest = Request & { homeboxSession?: HomeboxSession };

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
