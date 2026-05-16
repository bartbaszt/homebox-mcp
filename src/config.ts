import { readFileSync } from "node:fs";

import { HomeboxMcpError } from "./errors.js";

export interface AppConfig {
  homeboxBaseUrl: string;
  host: string;
  port: number;
  mcpPath: string;
  apiToken?: string;
  tlsKeyPath?: string;
  tlsCertPath?: string;
  timeoutMs: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
}

export interface TlsConfig {
  key: Buffer;
  cert: Buffer;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HomeboxMcpError("config", `${key} must be a positive integer`);
  }
  return parsed;
}

export function normalizeHomeboxUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) throw new HomeboxMcpError("config", "HOMEBOX_BASE_URL is required");
  if (!url.startsWith("http://") && !url.startsWith("https://")) url = `https://${url}`;
  try {
    return new URL(url).toString().replace(/\/+$/, "");
  } catch (error) {
    throw new HomeboxMcpError("config", `Invalid Homebox URL: ${(error as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const homeboxBaseUrl = normalizeHomeboxUrl(env.HOMEBOX_BASE_URL ?? env.HOMEBOX_URL ?? "");
  const mcpPath = env.HOMEBOX_MCP_PATH?.trim() || "/mcp";
  if (!mcpPath.startsWith("/")) throw new HomeboxMcpError("config", "HOMEBOX_MCP_PATH must start with '/'");

  return {
    homeboxBaseUrl,
    host: env.HOMEBOX_MCP_HOST?.trim() || "0.0.0.0",
    port: readInt(env, "HOMEBOX_MCP_PORT", 3000),
    mcpPath,
    apiToken: env.HOMEBOX_MCP_API_TOKEN?.trim() || undefined,
    tlsKeyPath: env.HOMEBOX_MCP_TLS_KEY?.trim() || undefined,
    tlsCertPath: env.HOMEBOX_MCP_TLS_CERT?.trim() || undefined,
    timeoutMs: readInt(env, "HOMEBOX_API_TIMEOUT_MS", 30_000),
    maxUploadBytes: readInt(env, "HOMEBOX_MCP_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxDownloadBytes: readInt(env, "HOMEBOX_MCP_MAX_DOWNLOAD_BYTES", 10 * 1024 * 1024),
  };
}

export function loadTlsConfig(config: AppConfig): TlsConfig | undefined {
  if (!config.tlsKeyPath && !config.tlsCertPath) return undefined;
  if (!config.tlsKeyPath || !config.tlsCertPath) {
    throw new HomeboxMcpError("config", "Both HOMEBOX_MCP_TLS_KEY and HOMEBOX_MCP_TLS_CERT are required for HTTPS");
  }
  return {
    key: readFileSync(config.tlsKeyPath),
    cert: readFileSync(config.tlsCertPath),
  };
}
