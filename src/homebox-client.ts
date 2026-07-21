// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { lookup as dnsLookup } from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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

export interface LocalPhotoFile {
  fileName: string;
  contentType: string;
  contentLength: number;
  base64: string;
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
const BLOCKED_IPV6 = createBlockedIpv6List();
const GLOBAL_IPV6 = createGlobalIpv6List();

export class HomeboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxUploadBytes: number,
    private readonly maxDownloadBytes: number,
    private readonly localFileRoot?: string,
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

  async logout(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/users/logout", { token });
  }

  async listCollections(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/all", { token });
  }

  async getGroup(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups", { token });
  }

  async updateGroup(token: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", "/api/v1/groups", { token, body });
  }

  async createGroup(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/groups", { token, body });
  }

  async deleteGroup(token: string): Promise<unknown> {
    return this.request("DELETE", "/api/v1/groups", { token });
  }

  async listGroupInvitations(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/invitations", { token });
  }

  async createGroupInvitation(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/groups/invitations", { token, body });
  }

  async acceptGroupInvitation(token: string, invitationId: string, body?: JsonObject): Promise<unknown> {
    return this.request("POST", `/api/v1/groups/invitations/${encodeURIComponent(invitationId)}`, { token, body: body ?? {} });
  }

  async deleteGroupInvitation(token: string, invitationId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/groups/invitations/${encodeURIComponent(invitationId)}`, { token });
  }

  async listGroupMembers(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/members", { token });
  }

  async removeGroupMember(token: string, userId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/groups/members/${encodeURIComponent(userId)}`, { token });
  }

  async listGroupStatistics(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/statistics", { token });
  }

  async listLocationStatistics(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/statistics/locations", { token });
  }

  async listPurchasePriceStatistics(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/statistics/purchase-price", { token });
  }

  async listTagStatistics(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/groups/statistics/tags", { token });
  }

  async listGroupExports(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/group/exports", { token });
  }

  async startGroupExport(token: string, body?: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/group/exports", { token, body: body ?? {} });
  }

  async getGroupExport(token: string, exportId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/group/exports/${encodeURIComponent(exportId)}`, { token });
  }

  async deleteGroupExport(token: string, exportId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/group/exports/${encodeURIComponent(exportId)}`, { token });
  }

  async downloadGroupExportArtifact(token: string, exportId: string): Promise<DownloadedFile & { exportId: string }> {
    const file = await this.downloadFile(`/api/v1/group/exports/${encodeURIComponent(exportId)}/download`, token);
    return { exportId, ...file };
  }

  async importGroupZip(input: UploadCsvInput): Promise<unknown> {
    return this.request("POST", "/api/v1/group/import", {
      token: input.token,
      body: this.multipartFile("file", input.fileName, input.base64, input.contentType),
    });
  }

  async billOfMaterials(token: string): Promise<DownloadedFile> {
    return this.downloadFile("/api/v1/reporting/bill-of-materials", token);
  }

  async createMissingThumbnails(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/create-missing-thumbnails", { token });
  }

  async ensureAssetIds(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/ensure-asset-ids", { token });
  }

  async ensureImportRefs(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/ensure-import-refs", { token });
  }

  async setPrimaryPhotos(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/set-primary-photos", { token });
  }

  async wipeInventory(token: string, body?: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/wipe-inventory", { token, body: body ?? {} });
  }

  async zeroItemTimeFields(token: string): Promise<unknown> {
    return this.request("POST", "/api/v1/actions/zero-item-time-fields", { token });
  }

  async getAssetByAssetId(token: string, assetId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/assets/${encodeURIComponent(assetId)}`, { token });
  }

  async searchFromBarcode(token: string, barcode: string): Promise<unknown> {
    return this.request("GET", "/api/v1/products/search-from-barcode", { token, query: { barcode } });
  }

  async createQrCode(token: string, body?: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/qrcode", { token, body: body ?? {} });
  }

  async listApiKeys(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/users/self/api-keys", { token });
  }

  async createApiKey(token: string, body?: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/users/self/api-keys", { token, body: body ?? {} });
  }

  async deleteApiKey(token: string, apiKeyId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/users/self/api-keys/${encodeURIComponent(apiKeyId)}`, { token });
  }

  async getUserSelf(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/users/self", { token });
  }

  async updateUserSelf(token: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", "/api/v1/users/self", { token, body });
  }

  async deleteUserSelf(token: string, body?: JsonObject): Promise<unknown> {
    return this.request("DELETE", "/api/v1/users/self", { token, body: body ?? {} });
  }

  async getUserSettings(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/users/self/settings", { token });
  }

  async updateUserSettings(token: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", "/api/v1/users/self/settings", { token, body });
  }

  async changePassword(token: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", "/api/v1/users/change-password", { token, body });
  }

  async listCurrencies(token?: string): Promise<unknown> {
    return this.request("GET", "/api/v1/currencies", token ? { token } : {});
  }

  async listEntities(token: string, input: { q?: string; page?: number; pageSize?: number; tags?: string[]; parentIds?: string[]; isLocation?: boolean; filterChildren?: boolean; negateTags?: boolean; orderBy?: string; includeArchived?: boolean; fields?: string[]; query?: Record<string, QueryValue> }): Promise<unknown> {
    const query: Record<string, QueryValue> = { ...input.query };
    if (input.q !== undefined) query.q = input.q;
    if (input.page !== undefined) query.page = input.page;
    if (input.pageSize !== undefined) query.pageSize = input.pageSize;
    if (input.tags) query.tags = input.tags;
    if (input.parentIds) query.parentIds = input.parentIds;
    if (input.isLocation !== undefined) query.isLocation = input.isLocation;
    if (input.filterChildren !== undefined) query.filterChildren = input.filterChildren;
    if (input.negateTags !== undefined) query.negateTags = input.negateTags;
    if (input.orderBy !== undefined) query.orderBy = input.orderBy;
    if (input.includeArchived !== undefined) query.includeArchived = input.includeArchived;
    if (input.fields) query.fields = input.fields;
    return this.request("GET", "/api/v1/entities", { token, query });
  }

  async listItems(token: string, input: { page?: number; pageSize?: number; collectionId?: string; query?: Record<string, QueryValue> }): Promise<unknown> {
    const query: Record<string, QueryValue> = { ...input.query };
    if (input.page !== undefined) query.page = input.page;
    if (input.pageSize !== undefined) query.pageSize = input.pageSize;
    if (input.collectionId) query.groupId = input.collectionId;
    return this.request("GET", "/api/v1/entities", { token, query });
  }

  async createEntity(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/entities", { token, body });
  }

  async createItem(token: string, body: JsonObject): Promise<unknown> {
    return this.createEntity(token, normalizeEntityPayload(body));
  }

  async exportEntities(token: string): Promise<DownloadedFile> {
    return this.downloadFile("/api/v1/entities/export", token);
  }

  async importEntities(input: UploadCsvInput): Promise<unknown> {
    return this.request("POST", "/api/v1/entities/import", {
      token: input.token,
      body: this.multipartFile("csv", input.fileName, input.base64, input.contentType),
    });
  }

  async listEntityFieldNames(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/entities/fields", { token });
  }

  async listEntityFieldValues(token: string, field: string): Promise<unknown> {
    return this.request("GET", "/api/v1/entities/fields/values", { token, query: { field } });
  }

  async listEntitiesTree(token: string, withItems?: boolean): Promise<unknown> {
    return this.request("GET", "/api/v1/entities/tree", { token, query: { withItems } });
  }

  async getEntity(token: string, entityId: string): Promise<JsonObject> {
    return this.request<JsonObject>("GET", `/api/v1/entities/${encodeURIComponent(entityId)}`, { token });
  }

  async getItem(token: string, itemId: string): Promise<JsonObject> {
    return this.getEntity(token, itemId);
  }

  async putEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/entities/${encodeURIComponent(entityId)}`, { token, body: normalizeEntityPayload(body) });
  }

  async patchEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    return this.request("PATCH", `/api/v1/entities/${encodeURIComponent(entityId)}`, { token, body: normalizeEntityPatch(body) });
  }

  async deleteEntity(token: string, entityId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/entities/${encodeURIComponent(entityId)}`, { token });
  }

  async deleteItem(token: string, itemId: string): Promise<unknown> {
    return this.deleteEntity(token, itemId);
  }

  async duplicateEntity(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", `/api/v1/entities/${encodeURIComponent(entityId)}/duplicate`, { token, body });
  }

  async getEntityPath(token: string, entityId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/entities/${encodeURIComponent(entityId)}/path`, { token });
  }

  async listEntityAttachments(token: string, entityId: string): Promise<unknown> {
    const entity = await this.getEntity(token, entityId);
    return entity.attachments ?? [];
  }

  async uploadEntityAttachment(input: UploadEntityAttachmentInput): Promise<unknown> {
    const form = this.multipartFile("file", input.fileName, input.base64, input.contentType, {
      name: input.fileName,
      type: input.type,
      primary: input.primary,
    });
    return this.request("POST", `/api/v1/entities/${encodeURIComponent(input.entityId)}/attachments`, { token: input.token, body: form });
  }

  async createExternalEntityAttachment(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", `/api/v1/entities/${encodeURIComponent(entityId)}/attachments/external`, { token, body });
  }

  async downloadEntityAttachment(token: string, entityId: string, attachmentId: string): Promise<DownloadedFile & { entityId: string; attachmentId: string }> {
    const file = await this.downloadFile(`/api/v1/entities/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, token);
    return { entityId, attachmentId, ...file };
  }

  async updateEntityAttachment(token: string, entityId: string, attachmentId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/entities/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, { token, body });
  }

  async deleteEntityAttachment(token: string, entityId: string, attachmentId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/entities/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`, { token });
  }

  async listEntityMaintenance(token: string, entityId: string, status?: "scheduled" | "completed" | "both"): Promise<unknown> {
    return this.request("GET", `/api/v1/entities/${encodeURIComponent(entityId)}/maintenance`, { token, query: { status } });
  }

  async createEntityMaintenance(token: string, entityId: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", `/api/v1/entities/${encodeURIComponent(entityId)}/maintenance`, { token, body });
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

  async listLocations(token: string): Promise<unknown> {
    const pageSize = 500;
    let page = 1;
    const first = await this.request("GET", "/api/v1/entities", { token, query: { isLocation: true, page, pageSize } });
    if (Array.isArray(first)) return first;
    const firstRecord = objectRecord(first);
    if (!firstRecord || !Array.isArray(firstRecord.items)) return first;

    const items = [...firstRecord.items];
    const total = typeof firstRecord.total === "number" ? firstRecord.total : undefined;
    let lastPageSize = firstRecord.items.length;
    while ((total !== undefined ? items.length < total : lastPageSize === pageSize) && page < 10_000) {
      page += 1;
      const next = objectRecord(await this.request("GET", "/api/v1/entities", { token, query: { isLocation: true, page, pageSize } }));
      const nextItems = Array.isArray(next?.items) ? next.items : [];
      items.push(...nextItems);
      lastPageSize = nextItems.length;
      if (lastPageSize === 0) break;
    }
    return { ...firstRecord, page: 1, pageSize, total: total ?? items.length, items };
  }

  async createLocation(token: string, body: JsonObject): Promise<unknown> {
    return this.request("POST", "/api/v1/entities", { token, body: { isLocation: true, ...body } });
  }

  async updateLocation(token: string, locationId: string, body: JsonObject): Promise<unknown> {
    const current = await this.getEntity(token, locationId);
    return this.putEntity(token, locationId, mergeEntityForPut(current, body));
  }

  async deleteLocation(token: string, locationId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/entities/${encodeURIComponent(locationId)}`, { token });
  }

  async listTags(token: string): Promise<unknown> {
    return this.request("GET", "/api/v1/tags", { token });
  }

  async createTag(token: string, name: string): Promise<unknown> {
    return this.request("POST", "/api/v1/tags", { token, body: { name } });
  }

  async getTag(token: string, tagId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/tags/${encodeURIComponent(tagId)}`, { token });
  }

  async updateTag(token: string, tagId: string, body: JsonObject): Promise<unknown> {
    return this.request("PUT", `/api/v1/tags/${encodeURIComponent(tagId)}`, { token, body });
  }

  async deleteTag(token: string, tagId: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/tags/${encodeURIComponent(tagId)}`, { token });
  }

  async listCustomFields(token: string): Promise<unknown> {
    return this.listEntityFieldNames(token);
  }

  async listCustomFieldValues(token: string, field: string): Promise<unknown> {
    return this.listEntityFieldValues(token, field);
  }

  async updateItem(token: string, itemId: string, patch: JsonObject): Promise<unknown> {
    const current = await this.getEntity(token, itemId);
    const body = mergeEntityForPut(current, patch);
    return this.putEntity(token, itemId, body);
  }

  async putItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.putEntity(token, itemId, body);
  }

  async patchItem(token: string, itemId: string, body: JsonObject): Promise<unknown> {
    return this.patchEntity(token, itemId, body);
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

  async deleteAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    return this.deleteEntityAttachment(token, itemId, attachmentId);
  }

  async setPrimaryAttachment(token: string, itemId: string, attachmentId: string): Promise<unknown> {
    return this.updateEntityAttachment(token, itemId, attachmentId, { primary: true, type: "photo" });
  }

  async fetchPublicUrlFile(url: string, fileName?: string, contentType?: string): Promise<PublicUrlFile> {
    const fetched = await fetchPublicUrlLimited(url, this.timeoutMs, this.maxUploadBytes, "Public URL content exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES");
    const responseContentType = mediaType(headerValue(fetched.headers["content-type"]));
    if (responseContentType === "text/html" || responseContentType === "application/xhtml+xml") {
      throw new HomeboxMcpError("validation", `photoUrl is not a direct image URL; got ${responseContentType}. The URL must point to an image file (image/jpeg, image/png, image/webp), not a product page. Store product page URLs in sourceUrls/notes instead.`);
    }
    const detectedType = detectImageContentType(fetched.buffer);
    if (!detectedType) throw new HomeboxMcpError("validation", "photoUrl did not return a recognized image file");
    if (contentType) assertMatchingImageContentType(contentType, detectedType);
    if (responseContentType?.startsWith("image/")) assertMatchingImageContentType(responseContentType, detectedType);
    return {
      url: fetched.url.toString(),
      fileName: safeFileName(fileName ?? fileNameFromUrl(fetched.url) ?? "photo"),
      contentType: detectedType,
      contentLength: fetched.buffer.byteLength,
      base64: fetched.buffer.toString("base64"),
    };
  }

  async readLocalPhotoFile(filePath: string, fileName?: string, contentType?: string): Promise<LocalPhotoFile> {
    if (!this.localFileRoot) {
      throw new HomeboxMcpError("validation", "filePath is disabled. Configure HOMEBOX_MCP_LOCAL_FILE_ROOT to enable local photo uploads.");
    }
    const root = resolve(this.localFileRoot);
    const requestedPath = isAbsolute(filePath) ? filePath : resolve(root, filePath);
    const resolvedPath = await realpath(requestedPath);
    if (!pathIsWithin(root, resolvedPath)) {
      throw new HomeboxMcpError("validation", "filePath must resolve beneath HOMEBOX_MCP_LOCAL_FILE_ROOT");
    }

    const expected = await stat(resolvedPath);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
    try {
      const openedPath = await realpath(requestedPath);
      if (openedPath !== resolvedPath || !pathIsWithin(root, openedPath)) {
        throw new HomeboxMcpError("validation", "filePath changed while it was being opened");
      }
      const info = await handle.stat();
      if (info.dev !== expected.dev || info.ino !== expected.ino) {
        throw new HomeboxMcpError("validation", "filePath changed while it was being opened");
      }
      if (!info.isFile()) throw new HomeboxMcpError("validation", "filePath must reference a regular file");
      if (info.size > this.maxUploadBytes) {
        throw new HomeboxMcpError("validation", `Local file exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
      }
      const buffer = await readFileHandleLimited(handle, this.maxUploadBytes);
      const detectedType = detectImageContentType(buffer);
      if (!detectedType) throw new HomeboxMcpError("validation", "filePath must contain a recognized image file");
      assertMatchingImageContentType(contentType, detectedType);
      return {
        fileName: safeFileName(fileName ?? basename(resolvedPath)),
        contentType: detectedType,
        contentLength: buffer.byteLength,
        base64: buffer.toString("base64"),
      };
    } finally {
      await handle.close();
    }
  }

  validateBase64Photo(base64: string, fileName: string, contentType?: string): LocalPhotoFile {
    const compact = base64.replace(/\s/g, "");
    const maxEncodedLength = Math.ceil(this.maxUploadBytes / 3) * 4;
    if (compact.length > maxEncodedLength || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      throw new HomeboxMcpError("validation", "base64 must be valid image data within HOMEBOX_MCP_MAX_UPLOAD_BYTES");
    }
    const buffer = Buffer.from(compact, "base64");
    if (buffer.byteLength > this.maxUploadBytes) {
      throw new HomeboxMcpError("validation", `Upload exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${this.maxUploadBytes})`);
    }
    const detectedType = detectImageContentType(buffer);
    if (!detectedType) throw new HomeboxMcpError("validation", "base64 must contain a recognized JPEG, PNG or WebP image");
    assertMatchingImageContentType(contentType, detectedType);
    return {
      fileName: safeFileName(fileName),
      contentType: detectedType,
      contentLength: buffer.byteLength,
      base64: buffer.toString("base64"),
    };
  }

  async apiRequest(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request(method, this.safeApiPath(path), options);
  }

  private async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.rawRequest(method, path, options, false, async (response) => {
      if (response.status === 204) return undefined as T;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) return response.json() as Promise<T>;
      return response.text() as Promise<T>;
    });
  }

  private async rawRequest<T>(method: string, path: string, options: RequestOptions, allowRedirect: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(options.headers);
      if (options.token) headers.set("Authorization", authHeader(options.token));
      const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
      const init: RequestInit = { method: method.toUpperCase(), headers, signal: controller.signal, redirect: "manual" };
      if (options.body !== undefined) {
        if (isFormData) {
          init.body = options.body as BodyInit;
        } else {
          headers.set("Content-Type", "application/json");
          init.body = JSON.stringify(options.body);
        }
      }

      const response = await fetch(this.url(path, options.query), init);
      if (!response.ok && !(allowRedirect && isRedirectStatus(response.status))) await this.throwResponseError(response);
      return await consume(response);
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
    const rawPath = normalized.split(/[?#]/, 1)[0];
    if (normalized.includes("#") || rawPath.includes("\\") || /%(?:2e|2f|5c|25)/i.test(rawPath)) {
      throw new HomeboxMcpError("validation", "Path must not contain fragments, backslashes, encoded separators, or encoded dot segments");
    }
    const base = new URL(this.baseUrl);
    const resolved = new URL(normalized, base);
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(API_PREFIX)) {
      throw new HomeboxMcpError("validation", "Path must start with /api/v1/");
    }
    return `${resolved.pathname}${resolved.search}`;
  }

  private async downloadFile(path: string, token: string): Promise<DownloadedFile> {
    return this.rawRequest("GET", path, { token }, true, async (response) => {
      if (isRedirectStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new HomeboxMcpError("validation", "Download redirect did not include Location header");
        const target = new URL(location, response.url || this.url(path));
        const fetched = await fetchPublicUrlLimited(target.toString(), this.timeoutMs, this.maxDownloadBytes, "Download exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES");
        return downloadedFile(fetched.buffer, headerValue(fetched.headers["content-type"]));
      }

      const contentLengthHeader = response.headers.get("content-length");
      const advertisedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
      if (advertisedLength && advertisedLength > this.maxDownloadBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new HomeboxMcpError("validation", `Download exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
      }
      const buffer = await readFetchResponseLimited(response, this.maxDownloadBytes, `Download exceeds HOMEBOX_MCP_MAX_DOWNLOAD_BYTES (${this.maxDownloadBytes})`);
      return downloadedFile(buffer, response.headers.get("content-type") ?? undefined);
    });
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
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const { address } = await resolveSafeAddress(hostname);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const isTls = url.protocol === "https:";
  const createConnection = () => {
    const socket = net.createConnection({ host: address, port, signal });
    if (!isTls) return socket;
    return tls.connect({
      socket,
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_serverName, certificate) => tls.checkServerIdentity(hostname, certificate),
    });
  };
  const options: https.RequestOptions = {
    protocol: url.protocol,
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    signal,
    createConnection,
    headers: { Accept: "*/*", "User-Agent": "homebox-mcp" },
  };
  const requestFn = isTls ? https.request : http.request;

  return new Promise((resolve, reject) => {
    const req = requestFn(options, resolve);
    req.on("error", reject);
    req.end();
  });
}

async function fetchPublicUrlLimited(rawUrl: string, timeoutMs: number, limit: number, limitLabel: string): Promise<{ url: URL; headers: IncomingMessage["headers"]; buffer: Buffer }> {
  let current = publicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await requestPublicUrl(current, controller.signal);
      if (isRedirectStatus(response.statusCode ?? 0)) {
        response.resume();
        const location = headerValue(response.headers.location);
        if (!location) throw new HomeboxMcpError("validation", "Public URL redirect did not include Location header");
        current = publicHttpUrl(new URL(location, current).toString());
        continue;
      }
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.resume();
        throw new HomeboxMcpError("network", `Public URL fetch failed (${response.statusCode})`);
      }
      const contentLengthHeader = headerValue(response.headers["content-length"]);
      const advertisedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
      if (advertisedLength && advertisedLength > limit) {
        response.destroy();
        throw new HomeboxMcpError("validation", `${limitLabel} (${limit})`);
      }
      const buffer = await readIncomingLimited(response, limit, `${limitLabel} (${limit})`);
      return { url: current, headers: response.headers, buffer };
    }
    throw new HomeboxMcpError("validation", "Public URL redirect limit exceeded");
  } catch (error) {
    if (error instanceof HomeboxMcpError) throw error;
    if ((error as Error).name === "AbortError") throw new HomeboxMcpError("network", `Public URL fetch timed out after ${timeoutMs}ms`);
    throw new HomeboxMcpError("network", `Public URL fetch failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveSafeAddress(hostname: string, family?: number): Promise<{ address: string; family: 4 | 6 }> {
  const familyOption = family === 4 || family === 6 ? family : 0;
  let addresses = await dnsLookup(hostname, { all: true, family: familyOption, verbatim: true });
  if (addresses.length === 0 || !addresses.some((a) => a.address)) {
    addresses = await dnsLookup(hostname, { all: true, family: familyOption });
  }
  const valid = addresses.filter((a) => typeof a.address === "string" && a.address);
  if (valid.length === 0) throw new HomeboxMcpError("validation", `Public URL host '${hostname}' did not resolve`);
  const blocked = valid.filter(({ address }) => isBlockedIp(address));
  if (blocked.length > 0) throw new HomeboxMcpError("validation", `Public URL host '${hostname}' resolves to private, loopback, link-local, multicast, or reserved address`);
  const first = valid[0];
  return { address: first.address, family: (typeof first.family === "number" ? first.family : isIP(first.address) === 6 ? 6 : 4) as 4 | 6 };
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

async function readFileHandleLimited(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw new HomeboxMcpError("validation", `Local file exceeds HOMEBOX_MCP_MAX_UPLOAD_BYTES (${limit})`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function downloadedFile(buffer: Buffer, contentType: string | undefined): DownloadedFile {
  const text = contentType && /^(text\/|application\/(json|xml|csv)|.*\+json)/i.test(contentType) ? buffer.toString("utf8") : undefined;
  return { contentType, contentLength: buffer.byteLength, base64: buffer.toString("base64"), text };
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0].trim().toLowerCase() || undefined;
}

function detectImageContentType(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function assertMatchingImageContentType(provided: string | undefined, detected: string): void {
  const normalized = mediaType(provided);
  if (!normalized) return;
  const aliases: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
  if ((aliases[normalized] ?? normalized) !== detected) {
    throw new HomeboxMcpError("validation", `Image Content-Type ${normalized} does not match detected file type ${detected}`);
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const fromRoot = relative(normalize(root), normalize(candidate));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
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

export function mergeEntityForPut(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "fields" && Array.isArray(value)) {
      merged.fields = mergeFields(Array.isArray(merged.fields) ? merged.fields : [], value as unknown[]);
    } else if (key === "purchaseTime") {
      merged.purchaseDate = value;
    } else if (key === "syncChildItemsLocations") {
      merged.syncChildEntityLocations = value;
    } else if (key !== "tags" && key !== "location" && key !== "locationId") {
      merged[key] = value;
    }
  }

  if (merged.purchaseDate === undefined && patch.purchaseTime === undefined && current.purchaseDate !== undefined) {
    merged.purchaseDate = current.purchaseDate;
  }

  const parent = current.parent as JsonObject | undefined;
  if (merged.parentId === undefined) {
    if (typeof patch.parentId === "string") merged.parentId = patch.parentId;
    else if (patch.locationId !== undefined) merged.parentId = patch.locationId;
    else if (typeof parent?.id === "string") merged.parentId = parent.id;
  }

  if (merged.tagIds === undefined && Array.isArray(current.tags)) {
    const tagIds = current.tags.map((tag) => (tag as JsonObject).id).filter((id): id is string => typeof id === "string");
    if (tagIds.length > 0) merged.tagIds = tagIds;
  }

  delete merged.parent;
  delete merged.entityType;
  delete merged.tags;
  delete merged.location;
  return merged;
}

export function normalizeEntityPayload(body: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "purchaseTime") {
      if (out.purchaseDate === undefined) out.purchaseDate = value;
    } else if (key === "locationId") {
      if (out.parentId === undefined) out.parentId = value;
    } else if (key === "syncChildItemsLocations") {
      if (out.syncChildEntityLocations === undefined) out.syncChildEntityLocations = value;
    } else if (key === "fields" && Array.isArray(value)) {
      out.fields = (value as unknown[]).map(normalizeField).filter((f): f is JsonObject => Boolean(f));
    } else if (key !== "location" && key !== "parent" && key !== "entityType" && key !== "tags") {
      out[key] = value;
    }
  }
  if (out.purchaseDate === undefined && body.purchaseTime === undefined && body.purchaseDate !== undefined) out.purchaseDate = body.purchaseDate;
  return out;
}

function normalizeField(field: unknown): JsonObject | undefined {
  if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
  const f = field as JsonObject;
  const out: JsonObject = { ...f };
  if (typeof out.type !== "string") out.type = "text";
  if (out.parent !== undefined) delete out.parent;
  if (out.entityType !== undefined) delete out.entityType;
  return out;
}

function normalizeEntityPatch(body: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "locationId") {
      if (out.parentId === undefined) out.parentId = value;
    } else if (key === "syncChildItemsLocations") {
      if (out.syncChildEntityLocations === undefined) out.syncChildEntityLocations = value;
    } else if (key === "purchaseTime" || key === "purchaseDate" || key === "purchaseFrom" || key === "purchasePrice" || key === "manufacturer" || key === "modelNumber" || key === "serialNumber" || key === "notes" || key === "fields") {
      continue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeFields(existing: unknown[], incoming: unknown[]): unknown[] {
  const used = new Set<number>();
  const merged = existing.map((current) => {
    const matchIndex = incoming.findIndex((candidate, index) => !used.has(index) && fieldsMatch(current, candidate));
    if (matchIndex < 0) return current;
    used.add(matchIndex);
    const currentRecord = objectRecord(current);
    const incomingRecord = objectRecord(incoming[matchIndex]);
    if (!currentRecord || !incomingRecord) return incoming[matchIndex];
    const replacement: JsonObject = { ...currentRecord, ...incomingRecord };
    if (incomingRecord.id !== undefined || currentRecord.id !== undefined) replacement.id = currentRecord.id ?? incomingRecord.id;
    return replacement;
  });
  return [...merged, ...incoming.filter((_, index) => !used.has(index))];
}

function fieldsMatch(left: unknown, right: unknown): boolean {
  const a = objectRecord(left);
  const b = objectRecord(right);
  if (!a || !b) return false;
  if (typeof a.id === "string" && typeof b.id === "string" && a.id === b.id) return true;
  return typeof a.name === "string" && typeof b.name === "string" && a.name.trim().toLocaleLowerCase() === b.name.trim().toLocaleLowerCase();
}

function objectRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
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
  return !GLOBAL_IPV6.check(host, "ipv6") || BLOCKED_IPV6.check(host, "ipv6") || host.toLowerCase().includes(":5efe:");
}

function createGlobalIpv6List(): net.BlockList {
  const list = new net.BlockList();
  list.addSubnet("2000::", 3, "ipv6");
  return list;
}

function createBlockedIpv6List(): net.BlockList {
  const list = new net.BlockList();
  const ranges: Array<[string, number]> = [
    ["::", 96],
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, "ipv6");
  return list;
}
