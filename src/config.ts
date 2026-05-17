import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import { HomeboxMcpError } from "./errors.js";

export interface AppConfig {
  homeboxBaseUrl: string;
  host: string;
  port: number;
  mcpPath: string;
  apiToken?: string;
  trustProxy?: boolean;
  oauth?: OAuthConfig;
  tlsKeyPath?: string;
  tlsCertPath?: string;
  dataDir?: string;
  timeoutMs: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
}

export interface OAuthConfig {
  enabled: boolean;
  publicUrl?: string;
  issuer?: string;
  authCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  allowInsecureHttp: boolean;
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

function readBool(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function normalizeOptionalUrl(raw: string | undefined, key: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const withScheme = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new HomeboxMcpError("config", `Invalid ${key}: ${(error as Error).message}`);
  }
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
  const oauth: OAuthConfig = {
    enabled: readBool(env, "HOMEBOX_MCP_OAUTH_ENABLED"),
    publicUrl: normalizeOptionalUrl(env.HOMEBOX_MCP_PUBLIC_URL ?? env.HOMEBOX_MCP_OAUTH_PUBLIC_URL, "HOMEBOX_MCP_PUBLIC_URL"),
    issuer: normalizeOptionalUrl(env.HOMEBOX_MCP_OAUTH_ISSUER, "HOMEBOX_MCP_OAUTH_ISSUER"),
    authCodeTtlSeconds: readInt(env, "HOMEBOX_MCP_OAUTH_AUTH_CODE_TTL_SECONDS", 300),
    accessTokenTtlSeconds: readInt(env, "HOMEBOX_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
    refreshTokenTtlSeconds: readInt(env, "HOMEBOX_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60),
    allowInsecureHttp: readBool(env, "HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP"),
  };
  if (oauth.enabled && oauth.publicUrl && !oauth.allowInsecureHttp && new URL(oauth.publicUrl).protocol !== "https:") {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_PUBLIC_URL must use HTTPS when OAuth is enabled");
  }

  const apiToken = env.HOMEBOX_MCP_API_TOKEN?.trim() || undefined;
  const host = env.HOMEBOX_MCP_HOST?.trim() || "127.0.0.1";
  const config: AppConfig = {
    homeboxBaseUrl,
    host,
    port: readInt(env, "HOMEBOX_MCP_PORT", 3000),
    mcpPath,
    apiToken,
    trustProxy: readBool(env, "HOMEBOX_MCP_TRUST_PROXY"),
    oauth,
    tlsKeyPath: env.HOMEBOX_MCP_TLS_KEY?.trim() || undefined,
    tlsCertPath: env.HOMEBOX_MCP_TLS_CERT?.trim() || undefined,
    dataDir: env.HOMEBOX_MCP_DATA_DIR?.trim() || undefined,
    timeoutMs: readInt(env, "HOMEBOX_API_TIMEOUT_MS", 30_000),
    maxUploadBytes: readInt(env, "HOMEBOX_MCP_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxDownloadBytes: readInt(env, "HOMEBOX_MCP_MAX_DOWNLOAD_BYTES", 10 * 1024 * 1024),
  };
  validateConfigSecurity(config);
  return config;
}

export function validateConfigSecurity(config: AppConfig): void {
  if (config.apiToken && isPlaceholderToken(config.apiToken)) {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_API_TOKEN must be changed from the example placeholder value");
  }
  if (!config.apiToken && !config.oauth?.enabled && !isLocalListenHost(config.host)) {
    throw new HomeboxMcpError("config", "Refusing to listen on a non-local host without HOMEBOX_MCP_API_TOKEN or HOMEBOX_MCP_OAUTH_ENABLED=true");
  }
}

function isPlaceholderToken(value: string): boolean {
  return ["change-me", "change-me-to-a-random-string", "changeme", "default", "password"].includes(value.trim().toLowerCase());
}

export function isLocalListenHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(normalized)) return true;
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "") return false;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
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
