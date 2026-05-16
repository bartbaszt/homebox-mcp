import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { type AppConfig, loadConfig, loadTlsConfig } from "./config.js";
import { HomeboxClient } from "./homebox-client.js";
import { SessionStore } from "./session-store.js";
import { registerHomeboxTools } from "./tools.js";

export interface RuntimeState {
  config: AppConfig;
  homebox: HomeboxClient;
  sessions: SessionStore;
}

export interface StartedServer {
  state: RuntimeState;
  app: express.Express;
  server: HttpServer | HttpsServer;
  url: string;
  close: () => Promise<void>;
}

export function createRuntime(config = loadConfig()): RuntimeState {
  return {
    config,
    homebox: new HomeboxClient(config.homeboxBaseUrl, config.timeoutMs, config.maxUploadBytes, config.maxDownloadBytes),
    sessions: new SessionStore(),
  };
}

export function createMcpServer(state: RuntimeState): McpServer {
  const server = new McpServer(
    { name: "homebox-mcp", version: "0.1.0" },
    {
      instructions:
        "Use homebox_login first. Keep returned sessionKey and pass it to later tools. This server targets one configured Homebox instance. Collections are Homebox groups.",
    },
  );
  registerHomeboxTools(server, state);
  return server;
}

export function createHttpApp(state: RuntimeState): express.Express {
  const app = express();
  const bodyLimit = `${Math.ceil(state.config.maxUploadBytes * 1.5)}b`;
  app.use(express.json({ limit: bodyLimit }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "homebox-mcp",
      transport: "streamable-http",
      mcpPath: state.config.mcpPath,
      homeboxBaseUrl: state.config.homeboxBaseUrl,
      authRequired: Boolean(state.config.apiToken),
    });
  });

  app.all(state.config.mcpPath, requireMcpToken(state.config), async (req, res, next) => {
    try {
      const server = createMcpServer(state);
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

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  });

  return app;
}

export async function startServer(config = loadConfig()): Promise<StartedServer> {
  const state = createRuntime(config);
  const app = createHttpApp(state);
  const tls = loadTlsConfig(config);
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

function requireMcpToken(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.apiToken) {
      next();
      return;
    }
    const provided = tokenFromRequest(req);
    if (provided && safeEqual(provided, config.apiToken)) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "Missing or invalid MCP API token" });
  };
}

function tokenFromRequest(req: Request): string | undefined {
  const auth = req.header("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (auth) return auth;
  return req.header("x-api-key")?.trim();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
