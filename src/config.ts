// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { HomeboxMcpError } from "./errors.js";

export interface AppConfig {
  homeboxBaseUrl: string;
  host: string;
  port: number;
  mcpPath: string;
  apiToken?: string;
  trustProxy?: string[];
  oauth?: OAuthConfig;
  tlsKeyPath?: string;
  tlsCertPath?: string;
  dataDir?: string;
  localFileRoot?: string;
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
  const value = raw.trim();
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new HomeboxMcpError("config", `${key} must be a positive integer`);
  }
  return parsed;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readTrustProxy(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env.HOMEBOX_MCP_TRUST_PROXY?.trim();
  if (!raw || ["0", "false", "no", "off"].includes(raw.toLowerCase())) return undefined;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return ["loopback"];
  const proxies = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (proxies.length === 0 || proxies.length > 16) throw new HomeboxMcpError("config", "HOMEBOX_MCP_TRUST_PROXY must list at most 16 trusted proxy addresses or CIDRs");
  return proxies;
}

function normalizeOptionalUrl(raw: string | undefined, key: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const withScheme = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) throw new Error("URL credentials are not allowed");
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
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error("URL credentials are not allowed");
    return parsed.toString().replace(/\/+$/, "");
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
  validateOAuthUrls(oauth);

  const apiToken = env.HOMEBOX_MCP_API_TOKEN?.trim() || undefined;
  const host = env.HOMEBOX_MCP_HOST?.trim() || "127.0.0.1";
  const config: AppConfig = {
    homeboxBaseUrl,
    host,
    port: readInt(env, "HOMEBOX_MCP_PORT", 3000),
    mcpPath,
    apiToken,
    trustProxy: readTrustProxy(env),
    oauth,
    tlsKeyPath: env.HOMEBOX_MCP_TLS_KEY?.trim() || undefined,
    tlsCertPath: env.HOMEBOX_MCP_TLS_CERT?.trim() || undefined,
    dataDir: env.HOMEBOX_MCP_DATA_DIR?.trim() || undefined,
    localFileRoot: env.HOMEBOX_MCP_LOCAL_FILE_ROOT?.trim() || undefined,
    timeoutMs: readInt(env, "HOMEBOX_API_TIMEOUT_MS", 30_000),
    maxUploadBytes: readInt(env, "HOMEBOX_MCP_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxDownloadBytes: readInt(env, "HOMEBOX_MCP_MAX_DOWNLOAD_BYTES", 10 * 1024 * 1024),
  };
  if (config.port > 65_535) throw new HomeboxMcpError("config", "HOMEBOX_MCP_PORT must be between 1 and 65535");
  validateConfigSecurity(config);
  return config;
}

export function validateConfigSecurity(config: AppConfig): void {
  config.homeboxBaseUrl = normalizeHomeboxUrl(config.homeboxBaseUrl);
  if (config.oauth?.enabled) validateOAuthUrls(config.oauth);
  if (config.apiToken && isPlaceholderToken(config.apiToken)) {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_API_TOKEN must be changed from the example placeholder value");
  }
  if (!config.apiToken && !config.oauth?.enabled && !isLocalListenHost(config.host)) {
    throw new HomeboxMcpError("config", "Refusing to listen on a non-local host without HOMEBOX_MCP_API_TOKEN or HOMEBOX_MCP_OAUTH_ENABLED=true");
  }
  validateLocalFileRoot(config);
}

function validateOAuthUrls(oauth: OAuthConfig): void {
  if (!oauth.enabled) return;
  validateOAuthUrl(oauth.publicUrl, "HOMEBOX_MCP_PUBLIC_URL", oauth.allowInsecureHttp);
  validateOAuthUrl(oauth.issuer, "HOMEBOX_MCP_OAUTH_ISSUER", oauth.allowInsecureHttp);
}

function validateOAuthUrl(raw: string | undefined, key: string, allowInsecureHttp: boolean): void {
  if (!raw) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new HomeboxMcpError("config", `Invalid ${key}: ${(error as Error).message}`);
  }
  if (!allowInsecureHttp && url.protocol !== "https:") {
    throw new HomeboxMcpError("config", `${key} must use HTTPS when OAuth is enabled`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HomeboxMcpError("config", `${key} must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.hash) {
    throw new HomeboxMcpError("config", `${key} must not include credentials or a fragment`);
  }
}

function validateLocalFileRoot(config: AppConfig): void {
  if (!config.localFileRoot) return;
  let localRoot: string;
  try {
    localRoot = realpathSync(resolve(config.localFileRoot));
    if (!statSync(localRoot).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new HomeboxMcpError("config", `HOMEBOX_MCP_LOCAL_FILE_ROOT must reference an existing directory: ${(error as Error).message}`);
  }
  config.localFileRoot = localRoot;
  if (samePath(localRoot, parse(localRoot).root)) {
    throw new HomeboxMcpError("config", "HOMEBOX_MCP_LOCAL_FILE_ROOT must not be a filesystem root");
  }

  const sensitivePaths: Array<[string, string | undefined]> = [
    ["HOMEBOX_MCP_DATA_DIR", config.dataDir],
    ["HOMEBOX_MCP_TLS_KEY", config.tlsKeyPath],
    ["HOMEBOX_MCP_TLS_CERT", config.tlsCertPath],
  ];
  for (const [key, value] of sensitivePaths) {
    if (value && containsPath(localRoot, resolvedExistingPath(value))) {
      throw new HomeboxMcpError("config", `HOMEBOX_MCP_LOCAL_FILE_ROOT must not contain or equal ${key}`);
    }
  }
}

function resolvedExistingPath(value: string): string {
  try {
    return realpathSync(resolve(value));
  } catch {
    return resolve(value);
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(pathKey(parent), pathKey(candidate));
  return pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
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
