import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { HomeboxSession } from "./session-store.js";

export interface OAuthStoreOptions {
  authCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
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

export interface RefreshTokenRecord {
  clientId: string;
  resource: string;
  scope?: string;
  session: HomeboxSession;
  expiresAt: number;
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

  constructor(private readonly options: OAuthStoreOptions) {}

  registerClient(input: unknown): RegisteredOAuthClient {
    const data = objectInput(input);
    const redirectUris = data.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris must include at least one URI");
    }

    const tokenEndpointAuthMethod = stringValue(data.token_endpoint_auth_method) ?? "none";
    if (tokenEndpointAuthMethod !== "none") {
      throw new OAuthError("invalid_client_metadata", "Only token_endpoint_auth_method=none is supported");
    }

    const client: RegisteredOAuthClient = {
      client_id: `client_${randomSecret(24)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris.map((uri) => validateRedirectUri(String(uri))),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: stringValue(data.client_name),
    };
    this.clients.set(client.client_id, client);
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

    const client = this.clients.get(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown OAuth client", 401);
    if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    if (codeChallengeMethod !== "S256") throw new OAuthError("invalid_request", "Only PKCE S256 is supported");
    validateResource(resource);

    return { clientId, redirectUri, codeChallenge, codeChallengeMethod, resource, scope };
  }

  createAuthorizationCode(input: AuthorizationCodeInput): string {
    const code = `code_${randomSecret(32)}`;
    this.authorizationCodes.set(hashSecret(code), {
      ...input,
      expiresAt: Date.now() + this.options.authCodeTtlSeconds * 1000,
    });
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
    const stored = this.authorizationCodes.get(hashSecret(code));
    this.authorizationCodes.delete(hashSecret(code));
    if (!stored) throw new OAuthError("invalid_grant", "Unknown authorization code");
    if (stored.expiresAt < Date.now()) throw new OAuthError("invalid_grant", "Authorization code expired");
    if (stored.clientId !== required(input.clientId, "client_id")) throw new OAuthError("invalid_grant", "client_id mismatch");
    if (stored.redirectUri !== validateRedirectUri(required(input.redirectUri, "redirect_uri"))) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (stored.resource !== required(input.resource, "resource")) throw new OAuthError("invalid_target", "resource mismatch");
    if (!verifyPkce(stored.codeChallenge, required(input.codeVerifier, "code_verifier"))) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    return stored;
  }

  issueTokens(input: { clientId: string; resource: string; session: HomeboxSession; scope?: string }): TokenPair {
    const accessToken = `access_${randomSecret(32)}`;
    const refreshToken = `refresh_${randomSecret(32)}`;
    const now = Date.now();
    this.accessTokens.set(hashSecret(accessToken), {
      ...input,
      expiresAt: now + this.options.accessTokenTtlSeconds * 1000,
    });
    this.refreshTokens.set(hashSecret(refreshToken), {
      ...input,
      expiresAt: now + this.options.refreshTokenTtlSeconds * 1000,
    });
    return { accessToken, refreshToken, expiresIn: this.options.accessTokenTtlSeconds, scope: input.scope };
  }

  validateAccessToken(token: string, expectedResource: string): HomeboxSession | undefined {
    const key = hashSecret(token);
    const record = this.accessTokens.get(key);
    if (!record) return undefined;
    if (record.expiresAt < Date.now()) {
      this.accessTokens.delete(key);
      return undefined;
    }
    if (!safeEqual(record.resource, expectedResource)) return undefined;
    return record.session;
  }

  consumeRefreshToken(input: { clientId?: string; refreshToken?: string; resource?: string }): RefreshTokenRecord {
    const refreshToken = required(input.refreshToken, "refresh_token");
    const key = hashSecret(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record) throw new OAuthError("invalid_grant", "Unknown refresh token");
    if (record.expiresAt < Date.now()) {
      this.refreshTokens.delete(key);
      throw new OAuthError("invalid_grant", "Refresh token expired");
    }
    if (record.clientId !== required(input.clientId, "client_id")) throw new OAuthError("invalid_grant", "client_id mismatch");
    if (input.resource && record.resource !== input.resource) throw new OAuthError("invalid_target", "resource mismatch");
    return record;
  }

  revokeRefreshToken(refreshToken: string | undefined): void {
    if (refreshToken) this.refreshTokens.delete(hashSecret(refreshToken));
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new OAuthError("invalid_request", `${name} is required`);
  return value;
}

function validateRedirectUri(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return url.toString();
    throw new OAuthError("invalid_client_metadata", "redirect_uris must use HTTPS unless localhost");
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client_metadata", "redirect_uri must be a valid URI");
  }
}

function validateResource(raw: string): void {
  try {
    const url = new URL(raw);
    if (!url.protocol.startsWith("http")) throw new OAuthError("invalid_target", "resource must be an HTTP(S) URI");
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
