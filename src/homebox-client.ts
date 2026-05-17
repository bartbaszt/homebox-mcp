import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

import { HomeboxMcpError } from "./errors.js";

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;
export type ApiSurface = "items" | "entities";

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

export interface DownloadedFile {
  contentType?: string;
  contentLength: number;
  base64: string;
  text?: string;
}

export interface UploadAttachmentInput {
  token: string;
  itemId: string;
  fileName: string;
  base64: string;
  contentType?: string;
  primary?: boolean;
}

export interface PublicUrlFile {
  url: string;
  fileName: string;
  contentType?: string;
  contentLength: number;
  base64: string;
}

export interface UploadEntityAttachmentInput {
  token: string;
  entityId: string;
  fileName: string;
  base64: string;
  contentType?: string;
  type?: string;
  primary?: boolean;
}

export interface UploadCsvInput {
  token: string;
  fileName: string;
  base64: string;
  contentType?: string;
}

const API_PREFIX = "/api/v1/";

export class HomeboxClient {
  private cachedSurface: ApiSurface | undefined;
  private surfacePromise: Promise<ApiSurface> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxUploadBytes: number,
    private readonly maxDownloadBytes: number,
  ) {}

  async status(): Promise<unknown> {
    return this.request("GET", "/api/v1/status");
  }

  async getApiSurface(token: string): Promise<ApiSurface> {
    if (this.cachedSurface) return this.cachedSurface;
    if (!this.surfacePromise) {
      this.surfacePromise = this.probeApiSurface(token).then(
        (result) => {
          this.cachedSurface = result;
          return result;
        },
        (err) => {
          this.surfacePromise = undefined;
          throw err;
        },
      );
    }
    return this.surfacePromise;
  }

  currentApiSurface(): ApiSurface | undefined {
    return this.cachedSurface;
  }

  resetApiSurface(): void {
    this.cachedSurface = undefined;
    this.surfacePromise = undefined;
  }

  private async probeApiSurface(token: string): Promise<ApiSurface> {
    try {
      await this.rawRequest("GET", "/api/v1/entities", { token, query: { pageSize: 1 } });
      return "entities";
    } catch (err) {
      if (err instanceof HomeboxMcpError && err.status === 404) return "items";
      throw err;
    }
  }

  async listCurrencies(token?: string): Promise<unknown> {
    return this.request("GET", "/api/v1/currency", token ? { token } : {});
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
    const surface = await this.getApiSurface(token);
    const query: Record<string, QueryValue> = { ...input.query };
    if (input.page !== undefined) query.page = input.page;
    if (input.pageSize !== undefined) query.pageSize = input.pageSize;
    if (surface === "entities") {
      return this.request("GET", "/api/v1/entities", { token, query });
    }
    if (input.collectionId) query.groupId = input.collectionId;
    return this.request("GET", "/api/v1/items", { token, query });
  }

  async listEntities(token: string, input: { q?: string; page?: number; pageSize?: number; tags?: string[]; parentIds?: string[]; query?: Record<string, QueryValue> }): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const query: Record<string, QueryValue> = { ...input.query };
    if (input.q !== undefined) query.q = input.q;
    if (input.page !== undefined) query.page = input.page;
    if (input.pageSize !== undefined) query.pageSize = input.pageSize;
    if (input.tags) query.tags = input.tags;
    if (surface === "entities") {
      if (input.parentIds) query.parentIds = input.parentIds;
      return this.request("GET", "/api/v1/entities", { token, query });
    }
    if (input.parentIds) query.locations = input.parentIds;
    return this.request("GET", "/api/v1/items", { token, query });
  }

  async createEntity(token: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") return this.request("POST", "/api/v1/entities", { token, body });
    return this.request("POST", "/api/v1/items", { token, body: translateBodyForItems(body) });
  }

  async exportEntities(token: string): Promise<DownloadedFile> {
    const surface = await this.getApiSurface(token);
    const path = surface === "entities" ? "/api/v1/entities/export" : "/api/v1/items/export";
    return this.downloadFile(path, token);
  }

  async importEntities(input: UploadCsvInput): Promise<unknown> {
    const surface = await this.getApiSurface(input.token);
    const path = surface === "entities" ? "/api/v1/entities/import" : "/api/v1/items/import";
    return this.request("POST", path, {
      token: input.token,
      body: this.multipartFile("csv", input.fileName, input.base64, input.contentType),
    });
  }

  async listEntityFieldNames(token: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const path = surface === "entities" ? "/api/v1/entities/fields" : "/api/v1/items/fields";
    return this.request("GET", path, { token });
  }

  async listEntityFieldValues(token: string, field: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const path = surface === "entities" ? "/api/v1/entities/fields/values" : "/api/v1/items/fields/values";
    return this.request("GET", path, { token, query: { field } });
  }

  async listEntitiesTree(token: string, withItems?: boolean): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.request("GET", "/api/v1/entities/tree", { token, query: { withItems } });
    }
    return this.request("GET", "/api/v1/locations/tree", { token, query: { withItems } });
  }

  async getEntity(token: string, entityId: string): Promise<JsonObject> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request<JsonObject>("GET", `${prefix}/${encodeURIComponent(entityId)}`, { token });
  }

  async putEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    const payload = surface === "entities" ? body : translateBodyForItems(body);
    return this.request("PUT", `${prefix}/${encodeURIComponent(entityId)}`, { token, body: payload });
  }

  async patchEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    const payload = surface === "entities" ? body : translateBodyForItems(body);
    return this.request("PATCH", `${prefix}/${encodeURIComponent(entityId)}`, { token, body: payload });
  }

  async deleteEntity(token: string, entityId: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("DELETE", `${prefix}/${encodeURIComponent(entityId)}`, { token });
  }

  async duplicateEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("POST", `${prefix}/${encodeURIComponent(entityId)}/duplicate`, { token, body });
  }

  async getEntityPath(token: string, entityId: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("GET", `${prefix}/${encodeURIComponent(entityId)}/path`, { token });
  }

  async listEntityAttachments(token: string, entityId: string): Promise<unknown> {
    const entity = await this.getEntity(token, entityId);
    return entity.attachments ?? [];
  }

  async uploadEntityAttachment(input: UploadEntityAttachmentInput): Promise<unknown> {
    const surface = await this.getApiSurface(input.token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    const form = this.multipartFile("file", input.fileName, input.base64, input.contentType, {
      name: input.fileName,
      type: input.type,
      primary: input.primary,
    });
    return this.request("POST", `${prefix}/${encodeURIComponent(input.entityId)}/attachments`, { token: input.token, body: form });
  }

  async createExternalEntityAttachment(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface !== "entities") {
      throw new HomeboxMcpError("not_found", "External link attachments require the new /entities API (not present on legacy Homebox).", 404);
    }
    return this.request("POST", `/api/v1/entities/${encodeURIComponent(entityId)}/attachments/external`, { token, body });
  }

  async downloadEntityAttachment(token: string, entityId: string, attachmentId: string): Promise<DownloadedFile & { entityId: string; attachmentId: string }> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    const file = await this.downloadFile(`${prefix}/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, token);
    return { entityId, attachmentId, ...file };
  }

  async updateEntityAttachment(token: string, entityId: string, attachmentId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("PUT", `${prefix}/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, { token, body });
  }

  async deleteEntityAttachment(token: string, entityId: string, attachmentId: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("DELETE", `${prefix}/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, { token });
  }

  async listEntityMaintenance(token: string, entityId: string, status?: "scheduled" | "completed" | "both"): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("GET", `${prefix}/${encodeURIComponent(entityId)}/maintenance`, { token, query: { status } });
  }

  async createEntityMaintenance(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    const prefix = surface === "entities" ? "/api/v1/entities" : "/api/v1/items";
    return this.request("POST", `${prefix}/${encodeURIComponent(entityId)}/maintenance`, { token, body });
  }

  async listEntityTypes(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/entity-types", { token });
  }

  async createEntityType(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/entity-types", { token, body });
  }

  async updateEntityType(token: string, entityTypeId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/entity-types/${encodeURIComponent(entityTypeId)}`, { token, body });
  }

  async deleteEntityType(token: string, entityTypeId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/entity-types/${encodeURIComponent(entityTypeId)}`, { token });
  }

  async listEntityTemplates(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/templates", { token });
  }

  async createEntityTemplate(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/templates", { token, body });
  }

  async getEntityTemplate(token: string, templateId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/templates/${encodeURIComponent(templateId)}`, { token });
  }

  async updateEntityTemplate(token: string, templateId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/templates/${encodeURIComponent(templateId)}`, { token, body });
  }

  async deleteEntityTemplate(token: string, templateId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/templates/${encodeURIComponent(templateId)}`, { token });
  }

  async createEntityFromTemplate(token: string, templateId: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", `/api/v1/templates/${encodeURIComponent(templateId)}/create-item`, { token, body });
  }

  async listMaintenance(token: string, status?: "scheduled" | "completed" | "both"): Promise<unknown> {
    return this.request("GET", "/api/v1/maintenance", { token, query: { status: status ?? "both" } });
  }

  async updateMaintenanceEntry(token: string, maintenanceId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/maintenance/${encodeURIComponent(maintenanceId)}`, { token, body });
  }

  async deleteMaintenanceEntry(token: string, maintenanceId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/maintenance/${encodeURIComponent(maintenanceId)}`, { token });
  }

  async listNotifiers(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/notifiers", { token });
  }

  async createNotifier(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/notifiers", { token, body });
  }

  async testNotifier(token: string, url: string): Promise<unknown> {
    return this.request("POST", "/api/v1/notifiers/test", { token, query: { url } });
  }

  async updateNotifier(token: string, notifierId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/notifiers/${encodeURIComponent(notifierId)}`, { token, body });
  }

  async deleteNotifier(token: string, notifierId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/notifiers/${encodeURIComponent(notifierId)}`, { token });
  }

  async getItem(token: string, itemId: string): Promise<JsonObject> {
    return this.getEntity(token, itemId);
  }

  async createItem(token: string, body: JsonObject): Promise<unknown> {
    return this.createEntity(token, body);
  }

  async updateItem(token: string, itemId: string, patch: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.patchEntity(token, itemId, patch);
    }
    const current = await this.request<JsonObject>("GET", `/api/v1/items/${encodeURIComponent(itemId)}`, { token });
    const body = mergeItemForPut(current, translateBodyForItems(patch));
    return this.request("PUT", `/api/v1/items/${encodeURIComponent(itemId)}`, { token, body });
  }

  async putItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.putEntity(token, itemId, body);
  }

  async patchItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.patchEntity(token, itemId, body);
  }

  async deleteItem(token: string, itemId: string): Promise<unknown> {
    return this.deleteEntity(token, itemId);
  }

  async listAttachments(token: string, itemId: string): Promise<unknown> {
    return this.listEntityAttachments(token, itemId);
  }

  async downloadAttachment(token: string, itemId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const file = await this.downloadEntityAttachment(token, itemId, attachmentId);
    return {
      itemId,
      attachmentId,
      contentType: file.contentType,
      contentLength: file.contentLength,
      base64: file.base64,
    };
  }

  async uploadAttachment(input: UploadAttachmentInput): Promise<unknown> {
    return this.uploadEntityAttachment({
      token: input.token,
      entityId: input.itemId,
      fileName: input.fileName,
      base64: input.base64,
      contentType: input.contentType,
      primary: input.primary,
    });
  }

  async fetchPublicUrlFile(url: string, fileName?: string, contentType?: string): Promise<PublicUrlFile> {
    let current = publicHttpUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await requestPublicUrl(current, controller.signal);
        if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) throw new HomeboxMcpError("network", `Public URL fetch failed (${response.statusCode})`);
          const responseContentType = headerValue(response.headers["content-type"])?.split(";")[0].trim().toLowerCase();
          if (responseContentType === "text/html" || responseContentType === "application/xhtml+xml") {
            response.resume();
            throw new HomeboxMcpError("validation", `photoUrl is not a direct image URL; got ${responseContentType}. The URL must point to an image file (image/jpeg, image/png, image/webp), not a product page. Store product page URLs in sourceUrls/notes instead.`);
          }
          const contentLengthHeader = headerValue(response.headers["content-length"]);
          const advertisedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
          if (advertisedLength && advertisedLength > this.maxUploadBytes) {
            throw new HomeboxMcpError("validation", `Public URL content exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
          }
          const buffer = await readIncomingLimited(response, this.maxUploadBytes, `Public URL content exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
          return {
            url: current.toString(),
            fileName: safeFileName(fileName ?? fileNameFromUrl(current) ?? "photo"),
            contentType: contentType ?? headerValue(response.headers["content-type"])?.split(";")[0].trim() ?? undefined,
            contentLength: buffer.byteLength,
            base64: buffer.toString("base64"),
          };
        }
        response.resume();
        const location = headerValue(response.headers.location);
        if (!location) throw new HomeboxMcpError("validation", "Public URL redirect did not include Location header");
        current = publicHttpUrl(new URL(location, current).toString());
      }

      throw new HomeboxMcpError("validation", "Public URL redirect limit exceeded");
    } catch (error) {
      if (error instanceof HomeboxMcpError) throw error;
      if ((error as Error).name === "AbortError") throw new HomeboxMcpError("network", `Public URL fetch timed out after ${this.timeoutMs}ms`);
      throw new HomeboxMcpError("network", `Public URL fetch failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async deleteAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    return this.deleteEntityAttachment(token, itemId, attachmentId);
  }

  async setPrimaryAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.updateEntityAttachment(token, itemId, attachmentId, { primary: true });
    }
    return this.request("PUT", `/api/v1/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}/primary`, { token });
  }

  async listLocations(token: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.request("GET", "/api/v1/entities", { token, query: { isLocation: true, pageSize: 500 } });
    }
    return this.request("GET", "/api/v1/locations", { token });
  }

  async createLocation(token: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.request("POST", "/api/v1/entities", { token, body });
    }
    return this.request("POST", "/api/v1/locations", { token, body });
  }

  async updateLocation(token: string, locationId: string, body: JsonObject): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.request("PUT", `/api/v1/entities/${encodeURIComponent(locationId)}`, { token, body });
    }
    return this.request("PUT", `/api/v1/locations/${encodeURIComponent(locationId)}`, { token, body });
  }

  async deleteLocation(token: string, locationId: string): Promise<unknown> {
    const surface = await this.getApiSurface(token);
    if (surface === "entities") {
      return this.request("DELETE", `/api/v1/entities/${encodeURIComponent(locationId)}`, { token });
    }
    return this.request("DELETE", `/api/v1/locations/${encodeURIComponent(locationId)}`, { token });
  }

  async listTags(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/tags", { token });
  }

  async createTag(token: string, name: string): Promise<unknown> {
    return this.request("POST", "/api/v1/tags", { token, body: { name } });
  }

  async listCustomFields(token: string): Promise<unknown> {
    return this.listEntityFieldNames(token);
  }

  async listCustomFieldValues(token: string, field: string): Promise<unknown> {
    return this.listEntityFieldValues(token, field);
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

  private async downloadFile(path: string, token: string): Promise<DownloadedFile> {
    const response = await this.rawRequest("GET", path, { token });
    const contentLengthHeader = response.headers.get("content-length");
    const advertisedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
    if (advertisedLength && advertisedLength > this.maxDownloadBytes) {
      throw new HomeboxMcpError("validation", `Download exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
    }
    const buffer = await readFetchResponseLimited(response, this.maxDownloadBytes, `Download exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
    const contentType = response.headers.get("content-type") ?? undefined;
    const text = contentType && /^(text\/|application\/(json|xml|csv)|.*\+json)/i.test(contentType) ? buffer.toString("utf8") : undefined;
    return { contentType, contentLength: buffer.byteLength, base64: buffer.toString("base64"), text };
  }

  private multipartFile(fieldName: string, fileName: string, base64: string, contentType?: string, fields: Record<string, unknown> = {}): FormData {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength > this.maxUploadBytes) {
      throw new HomeboxMcpError("validation", `Upload exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
    }
    const form = new FormData();
    const blob = new Blob([bytes], { type: contentType ?? "application/octet-stream" });
    form.append(fieldName, blob, fileName);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    return form;
  }
}

export function authHeader(token: string): string {
  const trimmed = token.trim();
  return trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}`;
}

async function requestPublicUrl(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const options: HttpRequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    signal,
    lookup: safeLookup,
    headers: { Accept: "*/*", "User-Agent": "homebox-mcp" },
  };

  return new Promise((resolve, reject) => {
    const req = requestFn(options, resolve);
    req.on("error", reject);
    req.end();
  });
}

const safeLookup: HttpRequestOptions["lookup"] = (hostname, options, callback) => {
  void resolveSafeAddress(hostname, Number(options.family) || undefined)
    .then(({ address, family }) => callback(null, address, family))
    .catch((error) => callback(error as Error, "", 0));
};

async function resolveSafeAddress(hostname: string, family?: number): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await dnsLookup(hostname, { all: true, family: family === 4 || family === 6 ? family : 0, verbatim: true });
  if (addresses.length === 0) throw new HomeboxMcpError("validation", `Public URL host '${hostname}' did not resolve`);
  const blocked = addresses.filter(({ address }) => isBlockedIp(address));
  if (blocked.length > 0) throw new HomeboxMcpError("validation", `Public URL host '${hostname}' resolves to private, loopback, link-local, multicast, or reserved address`);
  const first = addresses[0];
  return { address: first.address, family: first.family as 4 | 6 };
}

async function readFetchResponseLimited(response: Response, limit: number, message: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new HomeboxMcpError("validation", message);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readIncomingLimited(response: IncomingMessage, limit: number, message: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > limit) {
      response.destroy();
      throw new HomeboxMcpError("validation", message);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function headerValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === undefined ? undefined : String(value);
}

export function publicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new HomeboxMcpError("validation", `Invalid public URL: ${(error as Error).message}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HomeboxMcpError("validation", "Public URL must use http or https");
  if (url.username || url.password) throw new HomeboxMcpError("validation", "Public URL must not include credentials");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new HomeboxMcpError("validation", "Public URL must not target localhost");
  if (isBlockedIp(host)) throw new HomeboxMcpError("validation", "Public URL must not target private, loopback, link-local, multicast, or reserved addresses");
  return url;
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

function fileNameFromUrl(url: URL): string | undefined {
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").trim();
  return name || undefined;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "photo";
}

function isBlockedIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isBlockedIpv4(normalized);
  if (ipVersion === 6) return isBlockedIpv6(normalized);
  return false;
}

function isBlockedIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b, c, d] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function isBlockedIpv6(host: string): boolean {
  if (host.startsWith("::ffff:")) return isBlockedIpv4(host.slice(7));
  const first = Number.parseInt(host.split(":", 1)[0] || "0", 16);
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("2001:db8") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    (first >= 0xff00 && first <= 0xffff)
  );
}

export function translateBodyForItems(body: JsonObject): JsonObject {
  const out: JsonObject = { ...body };
  if (typeof out.parentId === "string" || out.parentId === null) {
    if (out.locationId === undefined) out.locationId = out.parentId;
  }
  delete out.parentId;
  if (typeof out.syncChildEntityLocations === "boolean") {
    if (out.syncChildItemsLocations === undefined) out.syncChildItemsLocations = out.syncChildEntityLocations;
  }
  delete out.syncChildEntityLocations;
  delete out.entityTypeId;
  return out;
}

export function translateBodyForEntities(body: JsonObject): JsonObject {
  const out: JsonObject = { ...body };
  if (typeof out.locationId === "string" || out.locationId === null) {
    if (out.parentId === undefined) out.parentId = out.locationId;
  }
  delete out.locationId;
  if (typeof out.syncChildItemsLocations === "boolean") {
    if (out.syncChildEntityLocations === undefined) out.syncChildEntityLocations = out.syncChildItemsLocations;
  }
  delete out.syncChildItemsLocations;
  return out;
}
