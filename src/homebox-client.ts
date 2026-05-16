import { HomeboxMcpError } from "./errors.js";

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface LoginResponse {
  token: string;
  raw?: string;
  expiresAt?: string;
  attachmentToken?: string;
}

export interface RequestOptions {
  token?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface DownloadedAttachment {
  itemId: string;
  attachmentId: string;
  contentType?: string;
  contentLength: number;
  base64: string;
}

export interface UploadAttachmentInput {
  token: string;
  itemId: string;
  fileName: string;
  base64: string;
  contentType?: string;
  primary?: boolean;
}

const API_PREFIX = "/api/v1/";

export class HomeboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxUploadBytes: number,
    private readonly maxDownloadBytes: number,
  ) {}

  async status(): Promise<unknown> {
    return this.request("GET", "/api/v1/status");
  }

  async login(username: string, password: string, stayLoggedIn = true): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>("POST", "/api/v1/users/login", {
      body: { username, password, stayLoggedIn },
    });
    return normalizeTokenResponse(response, "login");
  }

  async refresh(token: string): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>("GET", "/api/v1/users/refresh", { token });
    return normalizeTokenResponse(response, "refresh");
  }

  async listCollections(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/all", { token });
  }

  async listItems(token: string, input: { page?: number; pageSize?: number; collectionId?: string; query?: Record<string, QueryValue> }): Promise<unknown> {
    const query: Record<string, QueryValue> = { ...input.query };
    if (input.page !== undefined) query.page = input.page;
    if (input.pageSize !== undefined) query.pageSize = input.pageSize;
    if (input.collectionId) query.groupId = input.collectionId;
    return this.request("GET", "/api/v1/items", { token, query });
  }

  async getItem(token: string, itemId: string): Promise<JsonObject> {
    return this.request<JsonObject>("GET", `/api/v1/items/${encodeURIComponent(itemId)}`, { token });
  }

  async createItem(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/items", { token, body });
  }

  async updateItem(token: string, itemId: string, patch: JsonObject): Promise<unknown> {
    const current = await this.getItem(token, itemId);
    const body = mergeItemForPut(current, patch);
    return this.request("PUT", `/api/v1/items/${encodeURIComponent(itemId)}`, { token, body });
  }

  async putItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/items/${encodeURIComponent(itemId)}`, { token, body });
  }

  async patchItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.request("PATCH", `/api/v1/items/${encodeURIComponent(itemId)}`, { token, body });
  }

  async deleteItem(token: string, itemId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/items/${encodeURIComponent(itemId)}`, { token });
  }

  async listAttachments(token: string, itemId: string): Promise<unknown> {
    const item = await this.getItem(token, itemId);
    return item.attachments ?? [];
  }

  async downloadAttachment(token: string, itemId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const response = await this.rawRequest("GET", `/api/v1/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}`, { token });
    const contentLengthHeader = response.headers.get("content-length");
    const advertisedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
    if (advertisedLength && advertisedLength > this.maxDownloadBytes) {
      throw new HomeboxMcpError("validation", `Attachment exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > this.maxDownloadBytes) {
      throw new HomeboxMcpError("validation", `Attachment exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
    }
    return {
      itemId,
      attachmentId,
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: buffer.byteLength,
      base64: buffer.toString("base64"),
    };
  }

  async uploadAttachment(input: UploadAttachmentInput): Promise<unknown> {
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength > this.maxUploadBytes) {
      throw new HomeboxMcpError("validation", `Upload exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
    }
    const form = new FormData();
    const blob = new Blob([bytes], { type: input.contentType ?? "application/octet-stream" });
    form.append("file", blob, input.fileName);
    form.append("name", input.fileName);
    if (input.primary !== undefined) form.append("primary", String(input.primary));

    return this.request("POST", `/api/v1/items/${encodeURIComponent(input.itemId)}/attachments`, {
      token: input.token,
      body: form,
    });
  }

  async deleteAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}`, { token });
  }

  async setPrimaryAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    return this.request("PUT", `/api/v1/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}/primary`, { token });
  }

  async listLocations(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/locations", { token });
  }

  async createLocation(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/locations", { token, body });
  }

  async updateLocation(token: string, locationId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/locations/${encodeURIComponent(locationId)}`, { token, body });
  }

  async deleteLocation(token: string, locationId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/locations/${encodeURIComponent(locationId)}`, { token });
  }

  async listTags(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/tags", { token });
  }

  async listCustomFields(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/items/fields", { token });
  }

  async listCustomFieldValues(token: string, field: string): Promise<unknown> {
    return this.request("GET", "/api/v1/items/fields/values", { token, query: { field } });
  }

  async apiRequest(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request(method, this.safeApiPath(path), options);
  }

  private async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.rawRequest(method, path, options);
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return response.json() as Promise<T>;
    return response.text() as Promise<T>;
  }

  private async rawRequest(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(options.headers);
      if (options.token) headers.set("Authorization", authHeader(options.token));
      const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
      const init: RequestInit = { method: method.toUpperCase(), headers, signal: controller.signal };
      if (options.body !== undefined) {
        if (isFormData) {
          init.body = options.body as BodyInit;
        } else {
          headers.set("Content-Type", "application/json");
          init.body = JSON.stringify(options.body);
        }
      }

      const response = await fetch(this.url(path, options.query), init);
      if (!response.ok) await this.throwResponseError(response);
      return response;
    } catch (error) {
      if (error instanceof HomeboxMcpError) throw error;
      if ((error as Error).name === "AbortError") throw new HomeboxMcpError("network", `Homebox API timed out after ${this.timeoutMs}ms`);
      throw new HomeboxMcpError("network", `Homebox API request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throwResponseError(response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new HomeboxMcpError("auth", `Homebox authorization failed (${response.status}). Login again or refresh the session.`, response.status);
    }
    if (response.status === 404) throw new HomeboxMcpError("not_found", `Homebox endpoint or resource not found (${response.status}): ${text}`, response.status);
    throw new HomeboxMcpError("homebox", `Homebox API error (${response.status}): ${text}`, response.status);
  }

  private url(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private safeApiPath(path: string): string {
    if (/^https?:\/\//i.test(path)) throw new HomeboxMcpError("validation", "Path must be relative, not an absolute URL");
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (!normalized.startsWith(API_PREFIX)) {
      throw new HomeboxMcpError("validation", "Path must start with /api/v1/");
    }
    return normalized;
  }
}

export function authHeader(token: string): string {
  const trimmed = token.trim();
  return trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}`;
}

export function mergeItemForPut(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "fields" && Array.isArray(value)) {
      merged.fields = mergeFields(Array.isArray(merged.fields) ? merged.fields : [], value as unknown[]);
    } else if (key !== "tags") {
      merged[key] = value;
    }
  }

  const location = current.location as JsonObject | undefined;
  if (merged.locationId === undefined && typeof location?.id === "string") merged.locationId = location.id;

  if (merged.tagIds === undefined && Array.isArray(current.tags)) {
    const tagIds = current.tags.map((tag) => (tag as JsonObject).id).filter((id): id is string => typeof id === "string");
    if (tagIds.length > 0) merged.tagIds = tagIds;
  }

  delete merged.location;
  delete merged.parent;
  delete merged.entityType;
  delete merged.tags;
  return merged;
}

function mergeFields(existing: unknown[], incoming: unknown[]): unknown[] {
  const keys = new Set(incoming.map(fieldKey).filter((key): key is string => Boolean(key)));
  return [
    ...existing.filter((field) => {
      const key = fieldKey(field);
      return key ? !keys.has(key) : true;
    }),
    ...incoming,
  ];
}

function fieldKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = value as JsonObject;
  return typeof field.id === "string" ? `id:${field.id}` : typeof field.name === "string" ? `name:${field.name}` : undefined;
}

function normalizeTokenResponse(response: LoginResponse, operation: string): LoginResponse {
  const token = response.token ?? response.raw;
  if (!token) throw new HomeboxMcpError("auth", `Homebox ${operation} response did not include a token`);
  return { ...response, token };
}
