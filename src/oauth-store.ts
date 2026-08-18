// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HomeboxSession } from "./session-store.js";

const DEFAULT_MAX_CLIENTS = 1_000;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CLIENT_NAME_LENGTH = 200;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_GRANTS_PER_ACCOUNT = 32;
const MAX_TOKEN_RECORDS_PER_ACCOUNT = 128;
/** In-flight refresh rotations older than this are treated as abandoned (crashed request/process). */
const ROTATION_LOCK_TTL_MS = 60_000;

export interface OAuthStoreOptions {
  authCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  storagePath?: string;
  maxClients?: number;
  maxRecords?: number;
}

export interface RegisteredOAuthClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  client_name?: string;
}

export interface AuthorizationCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope?: string;
  session: HomeboxSession;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope?: string;
}

interface AuthorizationCode extends AuthorizationCodeInput {
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  resource: string;
  scope?: string;
  session: HomeboxSession;
  expiresAt: number;
}

interface StoredMapEntry<T> {
  key: string;
  value: T;
}

interface PersistedOAuthStore {
  version: 1;
  clients: RegisteredOAuthClient[];
  authorizationCodes: Array<StoredMapEntry<AuthorizationCode>>;
  accessTokens: Array<StoredMapEntry<AccessTokenRecord>>;
  refreshTokens: Array<StoredMapEntry<RefreshTokenRecord>>;
}

export interface RefreshTokenRecord {
  clientId: string;
  resource: string;
  scope?: string;
  session: HomeboxSession;
  expiresAt: number;
}

/** Opaque handle for an in-flight refresh-token rotation. */
export interface RefreshRotationHandle {
  readonly key: string;
}

export interface RefreshRotation {
  readonly record: RefreshTokenRecord;
  readonly handle: RefreshRotationHandle;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class OAuthStore {
  private readonly clients = new Map<string, RegisteredOAuthClient>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  /** Refresh-token hashes with a rotation in flight, mapped to their start time. Never persisted. */
  private readonly rotations = new Map<string, number>();
  private readonly maxClients: number;
  private readonly maxRecords: number;

  constructor(private readonly options: OAuthStoreOptions) {
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isInteger(this.maxClients) || this.maxClients <= 0 || !Number.isInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new OAuthError("server_error", "OAuth client and token capacities must be positive integers", 500);
    }
    this.loadPersisted();
  }

  registerClient(input: unknown): RegisteredOAuthClient {
    const data = objectInput(input);
    const redirectUris = data.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris must include at least one URI");
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError("invalid_client_metadata", `redirect_uris must contain at most ${MAX_REDIRECT_URIS} URIs`);
    }

    const tokenEndpointAuthMethod = stringValue(data.token_endpoint_auth_method) ?? "none";
    if (tokenEndpointAuthMethod !== "none") {
      throw new OAuthError("invalid_client_metadata", "Only token_endpoint_auth_method=none is supported");
    }
    const validatedRedirectUris = [...new Set(redirectUris.map((uri) => validateClientRedirectUri(uri)))];
    const clientName = optionalClientName(data.client_name);
    const now = Date.now();
    this.pruneExpired(now);
    const registrationKey = clientRegistrationKey(clientName, validatedRedirectUris);
    const existing = [...this.clients.values()].find((client) => clientRegistrationKey(client.client_name, client.redirect_uris) === registrationKey);
    if (existing) return existing;
    if (this.clients.size >= this.maxClients && !this.evictOldestUnusedClient()) {
      throw new OAuthError("server_error", `OAuth client capacity (${this.maxClients}) reached; reuse an existing client registration`, 503);
    }

    const client: RegisteredOAuthClient = {
      client_id: `client_${randomSecret(24)}`,
      client_id_issued_at: Math.floor(now / 1000),
      redirect_uris: validatedRedirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: clientName,
    };
    this.clients.set(client.client_id, client);
    try {
      this.persist();
    } catch (error) {
      this.clients.delete(client.client_id);
      throw error;
    }
    return client;
  }

  validateAuthorizationRequest(input: {
    responseType?: string;
    clientId?: string;
    redirectUri?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    resource?: string;
    scope?: string;
  }): Required<Omit<AuthorizationCodeInput, "session">> {
    if (input.responseType !== "code") throw new OAuthError("unsupported_response_type", "response_type must be code");
    const clientId = required(input.clientId, "client_id");
    const redirectUri = validateRedirectUri(required(input.redirectUri, "redirect_uri"));
    const codeChallenge = required(input.codeChallenge, "code_challenge");
    const codeChallengeMethod = input.codeChallengeMethod ?? "plain";
    const resource = required(input.resource, "resource");
    const scope = input.scope ?? "homebox";
    if (scope !== "homebox") throw new OAuthError("invalid_scope", "Only the homebox scope is supported");

    const client = this.clients.get(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown OAuth client", 401);
    if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    if (codeChallengeMethod !== "S256") throw new OAuthError("invalid_request", "Only PKCE S256 is supported");
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new OAuthError("invalid_request", "code_challenge must be a 43-character PKCE S256 value");
    validateResource(resource);

    return { clientId, redirectUri, codeChallenge, codeChallengeMethod, resource, scope };
  }

  createAuthorizationCode(input: AuthorizationCodeInput): string {
    const code = `code_${randomSecret(32)}`;
    const codeKey = hashSecret(code);
    this.pruneExpired(Date.now());
    this.assertAccountGrantCapacity(input.session, input.clientId);
    if (this.authorizationCodes.size >= this.maxRecords) throw new OAuthError("temporarily_unavailable", "OAuth authorization-code capacity reached", 503);
    this.authorizationCodes.set(codeKey, {
      ...input,
      expiresAt: Date.now() + this.options.authCodeTtlSeconds * 1000,
    });
    try {
      this.persist();
    } catch (error) {
      this.authorizationCodes.delete(codeKey);
      throw error;
    }
    return code;
  }

  exchangeAuthorizationCode(input: {
    clientId?: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    resource?: string;
  }): AuthorizationCodeInput {
    const code = required(input.code, "code");
    const codeKey = hashSecret(code);
    const stored = this.authorizationCodes.get(codeKey);
    if (!stored) throw new OAuthError("invalid_grant", "Unknown authorization code");
    this.authorizationCodes.delete(codeKey);
    this.persist();
    if (stored.expiresAt <= Date.now()) throw new OAuthError("invalid_grant", "Authorization code expired");
    if (stored.clientId !== required(input.clientId, "client_id")) throw new OAuthError("invalid_grant", "client_id mismatch");
    if (stored.redirectUri !== validateRedirectUri(required(input.redirectUri, "redirect_uri"))) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (stored.resource !== required(input.resource, "resource")) throw new OAuthError("invalid_target", "resource mismatch");
    if (!verifyPkce(stored.codeChallenge, required(input.codeVerifier, "code_verifier"))) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    return stored;
  }

  /**
   * Issues a new access/refresh pair.
   *
   * When `options.replaces` is provided the rotated refresh token is removed in the same
   * synchronous mutation, so a rotation either fully succeeds or leaves the old token usable.
   */
  issueTokens(
    input: { clientId: string; resource: string; session: HomeboxSession; scope?: string },
    options?: { replaces?: RefreshRotationHandle },
  ): TokenPair {
    const accessToken = `access_${randomSecret(32)}`;
    const refreshToken = `refresh_${randomSecret(32)}`;
    const now = Date.now();
    this.pruneExpired(now);
    const accessKey = hashSecret(accessToken);
    const refreshKey = hashSecret(refreshToken);
    const replacedKey = options?.replaces?.key;
    const replacedRecord = replacedKey ? this.refreshTokens.get(replacedKey) : undefined;
    if (replacedKey) this.refreshTokens.delete(replacedKey);
    try {
      const account = sessionAccountKey(input.session);
      const accountTokenCount = [...this.accessTokens.values(), ...this.refreshTokens.values()].filter((record) => sessionAccountKey(record.session) === account).length;
      if (accountTokenCount + 2 > MAX_TOKEN_RECORDS_PER_ACCOUNT) {
        throw new OAuthError("temporarily_unavailable", "OAuth token capacity reached for this Homebox account", 503);
      }
      if (this.accessTokens.size >= this.maxRecords || this.refreshTokens.size >= this.maxRecords) {
        throw new OAuthError("temporarily_unavailable", "OAuth token capacity reached", 503);
      }
      this.accessTokens.set(accessKey, {
        ...input,
        expiresAt: now + this.options.accessTokenTtlSeconds * 1000,
      });
      this.refreshTokens.set(refreshKey, {
        ...input,
        expiresAt: now + this.options.refreshTokenTtlSeconds * 1000,
      });
      this.persist();
    } catch (error) {
      this.accessTokens.delete(accessKey);
      this.refreshTokens.delete(refreshKey);
      if (replacedKey && replacedRecord) this.refreshTokens.set(replacedKey, replacedRecord);
      throw error;
    } finally {
      if (replacedKey) this.rotations.delete(replacedKey);
    }
    return { accessToken, refreshToken, expiresIn: this.options.accessTokenTtlSeconds, scope: input.scope };
  }

  validateAccessToken(token: string, expectedResource: string): HomeboxSession | undefined {
    const key = hashSecret(token);
    const record = this.accessTokens.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.accessTokens.delete(key);
      this.persist();
      return undefined;
    }
    if (!safeEqual(record.resource, expectedResource)) return undefined;
    return record.session;
  }

  /**
   * True while a grant still has any live token. Used by long-lived transports to notice that the
   * connection was revoked or expired, instead of trusting the authentication done at stream open.
   */
  /** Drops every authorization code and token issued for a grant. */
  revokeGrant(sessionKey: string): void {
    this.revokeSessionTokens(sessionKey);
    this.persist();
  }

  hasActiveGrant(sessionKey: string): boolean {
    this.pruneExpired(Date.now());
    for (const record of this.accessTokens.values()) if (record.session.sessionKey === sessionKey) return true;
    for (const record of this.refreshTokens.values()) if (record.session.sessionKey === sessionKey) return true;
    return false;
  }

  /**
   * Validates a refresh token and locks it for rotation without deleting it.
   *
   * The token is only removed when `issueTokens(..., { replaces })` commits, so a failed
   * Homebox refresh (timeout, network error, 5xx) leaves the OAuth connection usable.
   * Replay during the in-flight window is rejected by the rotation lock.
   */
  beginRefreshTokenRotation(input: { clientId?: string; refreshToken?: string; resource?: string }): RefreshRotation {
    const refreshToken = required(input.refreshToken, "refresh_token");
    const key = hashSecret(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record) throw new OAuthError("invalid_grant", "Unknown refresh token");
    const now = Date.now();
    if (record.expiresAt <= now) {
      this.refreshTokens.delete(key);
      this.rotations.delete(key);
      this.persist();
      throw new OAuthError("invalid_grant", "Refresh token expired");
    }
    if (record.clientId !== required(input.clientId, "client_id")) throw new OAuthError("invalid_grant", "client_id mismatch");
    if (input.resource && record.resource !== input.resource) throw new OAuthError("invalid_target", "resource mismatch");
    const startedAt = this.rotations.get(key);
    if (startedAt !== undefined && startedAt + ROTATION_LOCK_TTL_MS > now) {
      throw new OAuthError("invalid_grant", "Refresh token rotation is already in progress");
    }
    this.rotations.set(key, now);
    return { record, handle: { key } };
  }

  /**
   * Releases a rotation lock without rotating.
   * With `revokeGrant` the whole grant is dropped, for when Homebox rejected the session itself.
   */
  abortRefreshTokenRotation(handle: RefreshRotationHandle, options?: { revokeGrant?: boolean }): void {
    this.rotations.delete(handle.key);
    if (!options?.revokeGrant) return;
    const record = this.refreshTokens.get(handle.key);
    this.refreshTokens.delete(handle.key);
    if (record) this.revokeGrant(record.session.sessionKey);
    else this.persist();
  }

  /** Idempotent rotation-lock release, safe to call from a `finally` block. */
  releaseRotation(handle: RefreshRotationHandle): void {
    this.rotations.delete(handle.key);
  }

  /** Single-shot validate-and-delete. Prefer `beginRefreshTokenRotation` when a network call follows. */
  consumeRefreshToken(input: { clientId?: string; refreshToken?: string; resource?: string }): RefreshTokenRecord {
    const rotation = this.beginRefreshTokenRotation(input);
    this.rotations.delete(rotation.handle.key);
    this.refreshTokens.delete(rotation.handle.key);
    this.persist();
    return rotation.record;
  }

  revokeRefreshToken(refreshToken: string | undefined): void {
    if (!refreshToken) return;
    const key = hashSecret(refreshToken);
    this.rotations.delete(key);
    if (this.refreshTokens.delete(key)) this.persist();
  }

  private loadPersisted(): void {
    const storagePath = this.options.storagePath;
    if (!storagePath || !existsSync(storagePath)) return;

    const raw = JSON.parse(readFileSync(storagePath, "utf8")) as PersistedOAuthStore;
    if (!raw || raw.version !== 1) throw new OAuthError("server_error", "Invalid OAuth store file", 500);
    if (arrayInput(raw.authorizationCodes).length > this.maxRecords || arrayInput(raw.accessTokens).length > this.maxRecords || arrayInput(raw.refreshTokens).length > this.maxRecords) {
      throw new OAuthError("server_error", `OAuth store exceeds token capacity (${this.maxRecords})`, 500);
    }

    const clients = arrayInput(raw.clients);
    if (clients.length > this.maxClients) {
      throw new OAuthError("server_error", `OAuth store exceeds client capacity (${this.maxClients})`, 500);
    }
    for (const client of clients) this.clients.set(client.client_id, client);
    const now = Date.now();
    const prunedCodes = loadUnexpired(this.authorizationCodes, raw.authorizationCodes, now);
    const prunedAccess = loadUnexpired(this.accessTokens, raw.accessTokens, now);
    const prunedRefresh = loadUnexpired(this.refreshTokens, raw.refreshTokens, now);
    const migrated = this.migrateLegacyPrincipals();
    const clientsBeforePrune = this.clients.size;
    this.pruneUnusedClients(now);
    const pruned = prunedCodes || prunedAccess || prunedRefresh || migrated || this.clients.size !== clientsBeforePrune;
    if (pruned) this.persist();
  }

  private persist(): void {
    this.pruneExpired(Date.now());
    const storagePath = this.options.storagePath;
    if (!storagePath) return;

    mkdirSync(dirname(storagePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${storagePath}.${process.pid}.tmp`;
    const data: PersistedOAuthStore = {
      version: 1,
      clients: [...this.clients.values()],
      authorizationCodes: mapEntries(this.authorizationCodes),
      accessTokens: mapEntries(this.accessTokens),
      refreshTokens: mapEntries(this.refreshTokens),
    };
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new OAuthError("server_error", `OAuth store exceeds ${MAX_STORE_BYTES} bytes`, 503);
    writeFileSync(tmpPath, serialized, { mode: 0o600 });
    renameSync(tmpPath, storagePath);
    try { chmodSync(storagePath, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
  }

  private pruneExpired(now: number): void {
    pruneMap(this.authorizationCodes, now);
    pruneMap(this.accessTokens, now);
    pruneMap(this.refreshTokens, now);
    this.pruneRotations(now);
    this.pruneUnusedClients(now);
  }

  private pruneRotations(now: number): void {
    for (const [key, startedAt] of this.rotations) {
      if (startedAt + ROTATION_LOCK_TTL_MS <= now || !this.refreshTokens.has(key)) this.rotations.delete(key);
    }
  }

  private revokeSessionTokens(sessionKey: string): void {
    for (const [key, record] of this.authorizationCodes) if (record.session.sessionKey === sessionKey) this.authorizationCodes.delete(key);
    for (const [key, record] of this.accessTokens) if (record.session.sessionKey === sessionKey) this.accessTokens.delete(key);
    for (const [key, record] of this.refreshTokens) {
      if (record.session.sessionKey === sessionKey) {
        this.refreshTokens.delete(key);
        this.rotations.delete(key);
      }
    }
  }

  private pruneUnusedClients(now: number): void {
    const referenced = this.referencedClientIds();
    for (const [clientId, client] of this.clients) {
      if (!referenced.has(clientId) && client.client_id_issued_at * 1_000 + UNUSED_CLIENT_TTL_MS <= now) this.clients.delete(clientId);
    }
  }

  private evictOldestUnusedClient(): boolean {
    const referenced = this.referencedClientIds();
    const candidate = [...this.clients.values()]
      .filter((client) => !referenced.has(client.client_id))
      .sort((a, b) => a.client_id_issued_at - b.client_id_issued_at)[0];
    return candidate ? this.clients.delete(candidate.client_id) : false;
  }

  private referencedClientIds(): Set<string> {
    const referenced = new Set<string>();
    for (const record of this.authorizationCodes.values()) referenced.add(record.clientId);
    for (const record of this.accessTokens.values()) referenced.add(record.clientId);
    for (const record of this.refreshTokens.values()) referenced.add(record.clientId);
    return referenced;
  }

  private assertAccountGrantCapacity(session: HomeboxSession, clientId: string): void {
    const account = sessionAccountKey(session);
    const clients = new Set<string>();
    for (const record of this.authorizationCodes.values()) if (sessionAccountKey(record.session) === account) clients.add(record.clientId);
    for (const record of this.accessTokens.values()) if (sessionAccountKey(record.session) === account) clients.add(record.clientId);
    for (const record of this.refreshTokens.values()) if (sessionAccountKey(record.session) === account) clients.add(record.clientId);
    if (!clients.has(clientId) && clients.size >= MAX_GRANTS_PER_ACCOUNT) {
      throw new OAuthError("temporarily_unavailable", "OAuth grant capacity reached for this Homebox account", 503);
    }
  }

  private migrateLegacyPrincipals(): boolean {
    const principals = new Map<string, string>();
    let migrated = false;
    const migrate = (record: { clientId: string; session: HomeboxSession }): void => {
      if (record.session.sessionKey !== `oauth:${record.clientId}`) return;
      const fingerprint = hashSecret([record.clientId, record.session.token, record.session.createdAt, record.session.username ?? ""].join("\0"));
      const sessionKey = principals.get(fingerprint) ?? `oauth:${randomSecret(16)}`;
      principals.set(fingerprint, sessionKey);
      record.session = { ...record.session, sessionKey };
      migrated = true;
    };
    for (const record of this.authorizationCodes.values()) migrate(record);
    for (const record of this.accessTokens.values()) migrate(record);
    for (const record of this.refreshTokens.values()) migrate(record);
    return migrated;
  }
}

function mapEntries<T>(map: Map<string, T>): Array<StoredMapEntry<T>> {
  return [...map.entries()].map(([key, value]) => ({ key, value }));
}

function arrayInput<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function loadUnexpired<T extends { expiresAt: number }>(target: Map<string, T>, entries: Array<StoredMapEntry<T>> | undefined, now: number): boolean {
  let pruned = false;
  for (const entry of arrayInput(entries)) {
    if (entry.value.expiresAt <= now) {
      pruned = true;
      continue;
    }
    target.set(entry.key, entry.value);
  }
  return pruned;
}

function pruneMap<T extends { expiresAt: number }>(target: Map<string, T>, now: number): void {
  for (const [key, value] of target) {
    if (value.expiresAt <= now) target.delete(key);
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalClientName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new OAuthError("invalid_client_metadata", "client_name must be a string");
  const clientName = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(clientName)) throw new OAuthError("invalid_client_metadata", "client_name must not contain control characters");
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw new OAuthError("invalid_client_metadata", `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
  }
  return clientName || undefined;
}

function clientRegistrationKey(clientName: string | undefined, redirectUris: string[]): string {
  return JSON.stringify([clientName ?? "", [...redirectUris].sort()]);
}

function sessionAccountKey(session: HomeboxSession): string {
  return session.username?.trim().toLocaleLowerCase() || hashSecret(session.token);
}

function validateClientRedirectUri(value: unknown): string {
  if (typeof value !== "string") throw new OAuthError("invalid_client_metadata", "redirect_uris entries must be strings");
  if (value.length > MAX_REDIRECT_URI_LENGTH) {
    throw new OAuthError("invalid_client_metadata", `redirect_uris entries must be at most ${MAX_REDIRECT_URI_LENGTH} characters`);
  }
  const redirectUri = validateRedirectUri(value);
  if (redirectUri.length > MAX_REDIRECT_URI_LENGTH) {
    throw new OAuthError("invalid_client_metadata", `redirect_uris entries must be at most ${MAX_REDIRECT_URI_LENGTH} characters`);
  }
  return redirectUri;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new OAuthError("invalid_request", `${name} is required`);
  return value;
}

function validateRedirectUri(raw: string): string {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (url.username || url.password || url.hash) throw new OAuthError("invalid_client_metadata", "redirect_uri must not include credentials or a fragment");
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
    throw new OAuthError("invalid_client_metadata", "redirect_uris must use HTTPS unless localhost");
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client_metadata", "redirect_uri must be a valid URI");
  }
}

function validateResource(raw: string): void {
  try {
    if (raw.length > MAX_REDIRECT_URI_LENGTH) throw new OAuthError("invalid_target", "resource URI is too long");
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new OAuthError("invalid_target", "resource must be an HTTP(S) URI");
    if (url.username || url.password) throw new OAuthError("invalid_target", "resource must not include credentials");
    if (url.hash) throw new OAuthError("invalid_target", "resource must not include a fragment");
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_target", "resource must be a valid URI");
  }
}

function verifyPkce(expectedChallenge: string, verifier: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(actual, expectedChallenge);
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
