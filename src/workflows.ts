// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { createHash } from "node:crypto";

import type { HomeboxClient, JsonObject, PublicUrlFile } from "./homebox-client.js";
import { mergeEntityForPut } from "./homebox-client.js";
import { HomeboxMcpError, toSafeError } from "./errors.js";

type FieldValue = string | number | boolean | null | Array<string | number | boolean>;
type DedupeKey = "externalAssetId" | "orderId" | "name";

export interface ResolveTagsInput {
  labels?: string[];
  createMissing?: boolean;
  dryRun?: boolean;
}

export interface ResolvedTag {
  name: string;
  id?: string;
  created: boolean;
  tag?: JsonObject;
}

export interface ResolveTagsResult {
  requested: string[];
  resolved: ResolvedTag[];
  unresolved: string[];
  toCreate: string[];
  dryRun: boolean;
}

export interface FindOrCreateLocationInput {
  locationName: string;
  parentId?: string;
  createMissing?: boolean;
  dryRun?: boolean;
}

export interface LocationResult {
  locationId?: string;
  location?: JsonObject;
  path: string[];
  created: boolean;
  matched: boolean;
  dryRun: boolean;
  toCreate: string[];
  unresolved?: string;
}

export interface ItemWorkflowInput {
  name: string;
  description?: string;
  quantity?: number;
  insured?: boolean;
  archived?: boolean;
  assetId?: string;
  serialNumber?: string;
  modelNumber?: string;
  manufacturer?: string;
  lifetimeWarranty?: boolean;
  warrantyExpires?: string;
  warrantyDetails?: string;
  purchaseTime?: string;
  purchaseDate?: string;
  purchasePrice?: number;
  currency?: string;
  purchaseFrom?: string;
  soldTime?: string;
  soldTo?: string;
  soldPrice?: number;
  soldNotes?: string;
  notes?: string;
  externalSource?: string;
  externalAssetId?: string;
  orderId?: string;
  sourceUrls?: string[];
  labels?: string[];
  locationId?: string;
  locationName?: string;
  createMissingTags?: boolean;
  createMissingLocation?: boolean;
  customFields?: Record<string, FieldValue>;
  body?: JsonObject;
  photoUrl?: string;
  photoFileName?: string;
  photoContentType?: string;
  photoIsPrimary?: boolean;
  dryRun?: boolean;
}

export interface PreparedItem {
  payload: JsonObject;
  tags: ResolveTagsResult;
  location?: LocationResult;
}

export interface CreateItemFullResult extends PreparedItem {
  dryRun: boolean;
  itemId?: string;
  item?: unknown;
  photo?: PhotoUploadResult;
}

export interface PhotoUploadInput {
  itemId: string;
  imageUrl?: string;
  fileName?: string;
  base64?: string;
  contentType?: string;
}

export interface PhotoUploadResult {
  itemId: string;
  primary: true;
  source: "url" | "base64" | "existing";
  url?: string;
  fileName?: string;
  contentType?: string;
  contentLength?: number;
  attachment: unknown;
  warnings?: string[];
}

export interface ReplacePrimaryPhotoInput extends PhotoUploadInput {
  deletePreviousPrimary?: boolean;
}

export interface ReplacePrimaryPhotoResult extends PhotoUploadResult {
  previousPrimaryAttachmentIds: string[];
  deletedPreviousPrimaryIds: string[];
}

export interface EnsurePrimaryPhotoInput extends PhotoUploadInput {
  dedupe?: boolean;
  cleanupDuplicates?: boolean;
}

export interface EnsurePrimaryPhotoResult extends PhotoUploadResult {
  reused: boolean;
  primaryAttachmentId?: string;
}

export interface CleanupDuplicatePhotosResult {
  itemId: string;
  keptPrimaryAttachmentId?: string;
  deletedAttachmentIds: string[];
  duplicateGroups: number;
  warnings: string[];
}

export interface BulkUpsertInput {
  locationId?: string;
  locationName?: string;
  createMissingTags?: boolean;
  createMissingLocation?: boolean;
  dedupeBy?: DedupeKey[];
  dryRun?: boolean;
  items: ItemWorkflowInput[];
}

export interface BulkUpsertResult {
  dryRun: boolean;
  created: unknown[];
  updated: unknown[];
  skipped: unknown[];
  errors: unknown[];
}

export async function resolveTags(client: HomeboxClient, token: string, input: ResolveTagsInput): Promise<ResolveTagsResult> {
  const requested = uniqueNames(input.labels ?? []);
  const result: ResolveTagsResult = { requested, resolved: [], unresolved: [], toCreate: [], dryRun: input.dryRun === true };
  if (requested.length === 0) return result;

  const tags = asRecords(await client.listTags(token));
  const exactByName = new Map<string, JsonObject>();
  const byName = new Map<string, JsonObject>();
  for (const tag of tags) {
    const name = readName(tag);
    if (!name) continue;
    exactByName.set(name, tag);
    byName.set(key(name), tag);
  }

  for (const name of requested) {
    const existing = exactByName.get(name) ?? byName.get(key(name));
    if (existing) {
      result.resolved.push({ name, id: readId(existing), created: false, tag: existing });
      continue;
    }
    if (!input.createMissing) {
      result.unresolved.push(name);
      continue;
    }
    if (input.dryRun) {
      result.toCreate.push(name);
      continue;
    }
    const created = toRecord(await client.createTag(token, name));
    if (!created) throw new HomeboxMcpError("homebox", `Homebox did not return a tag object after creating '${name}'`);
    const id = readId(created);
    if (!id) throw new HomeboxMcpError("homebox", `Homebox created tag '${name}' without an id`);
    exactByName.set(readName(created), created);
    byName.set(key(name), created);
    result.resolved.push({ name, id, created: true, tag: created });
  }

  return result;
}

export async function findOrCreateLocation(client: HomeboxClient, token: string, input: FindOrCreateLocationInput): Promise<LocationResult> {
  const path = splitLocationPath(input.locationName);
  if (path.length === 0) throw new HomeboxMcpError("validation", "locationName must not be empty");

  const createMissing = input.createMissing !== false;
  const dryRun = input.dryRun === true;
  const result: LocationResult = { path, created: false, matched: false, dryRun, toCreate: [] };
  let locations = asRecords(await client.listLocations(token));
  let parentId = input.parentId;
  let current: JsonObject | undefined;

  for (const part of path) {
    const match = locations.find((location) => key(readName(location)) === key(part) && sameParent(location, parentId));
    if (match) {
      current = match;
      parentId = readId(match);
      result.matched = true;
      continue;
    }

    if (!createMissing) {
      result.unresolved = part;
      return result;
    }
    result.toCreate.push(part);
    if (dryRun) return result;

    const body: JsonObject = { name: part, isLocation: true };
    if (parentId) body.parentId = parentId;
    const created = toRecord(await client.createLocation(token, body));
    if (!created) throw new HomeboxMcpError("homebox", `Homebox did not return a location object after creating '${part}'`);
    const id = readId(created);
    if (!id) throw new HomeboxMcpError("homebox", `Homebox created location '${part}' without an id`);
    current = created;
    parentId = id;
    locations = [...locations, created];
    result.created = true;
    result.matched = false;
  }

  result.location = current;
  result.locationId = current ? readId(current) : parentId;
  return result;
}

export async function prepareItem(client: HomeboxClient, token: string, input: ItemWorkflowInput): Promise<PreparedItem> {
  const tags = await resolveTags(client, token, { labels: input.labels, createMissing: input.createMissingTags === true, dryRun: input.dryRun === true });
  const payload = buildItemPayload(input, tags.resolved.map((tag) => tag.id).filter((id): id is string => Boolean(id)));
  let location: LocationResult | undefined;

  const locationId = input.locationId;
  if (locationId) {
    payload.parentId = locationId;
  } else if (input.locationName) {
    location = await findOrCreateLocation(client, token, {
      locationName: input.locationName,
      createMissing: input.createMissingLocation !== false,
      dryRun: input.dryRun === true,
    });
    if (location.locationId) payload.parentId = location.locationId;
  }

  return { payload, tags, location };
}

export async function createItemFull(client: HomeboxClient, token: string, input: ItemWorkflowInput): Promise<CreateItemFullResult> {
  const prepared = await prepareItem(client, token, input);
  if (input.dryRun) return { ...prepared, dryRun: true };

  const item = await createEntityWithExtras(client, token, prepared.payload);
  const itemId = readId(toRecord(item));
  const photo = itemId && input.photoUrl && input.photoIsPrimary !== false
    ? await ensurePrimaryPhoto(client, token, { itemId, imageUrl: input.photoUrl, fileName: input.photoFileName, contentType: input.photoContentType })
    : undefined;

  return { ...prepared, dryRun: false, itemId, item, photo };
}

async function createEntityWithExtras(client: HomeboxClient, token: string, payload: JsonObject): Promise<unknown> {
  const { core, extra } = splitCreatePayload(payload);
  const item = await client.createItem(token, core);
  const itemId = readId(toRecord(item));
  if (!itemId || Object.keys(extra).length === 0) return item;
  const current = await client.getEntity(token, itemId);
  const merged = mergeEntityForPut(current, extra);
  return client.putEntity(token, itemId, merged);
}

function splitCreatePayload(payload: JsonObject): { core: JsonObject; extra: JsonObject } {
  const coreKeys = new Set(["name", "description", "quantity", "parentId", "entityTypeId", "tagIds", "insured", "archived", "assetId", "syncChildEntityLocations"]);
  const core: JsonObject = {};
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (coreKeys.has(key)) core[key] = value;
    else extra[key] = value;
  }
  if (typeof payload.name === "string") core.name = payload.name;
  return { core, extra };
}

export async function uploadPrimaryPhoto(client: HomeboxClient, token: string, input: PhotoUploadInput): Promise<PhotoUploadResult> {
  const warnings: string[] = [];
  const attachments = asRecords(await client.listAttachments(token, input.itemId));
  const photoCount = attachments.filter(isPhotoAttachment).length;
  if (photoCount >= 3) warnings.push(`item already has ${photoCount} photo attachments; consider homebox_cleanup_duplicate_photos or homebox_ensure_primary_photo to avoid duplicates`);

  if (input.imageUrl) {
    const file = await client.fetchPublicUrlFile(input.imageUrl, input.fileName, input.contentType);
    assertImage(file);
    const attachment = await client.uploadAttachment({ token, itemId: input.itemId, fileName: file.fileName, base64: file.base64, contentType: file.contentType, primary: true });
    return { itemId: input.itemId, primary: true, source: "url", url: file.url, fileName: file.fileName, contentType: file.contentType, contentLength: file.contentLength, attachment, warnings };
  }

  if (!input.base64 || !input.fileName) throw new HomeboxMcpError("validation", "Provide imageUrl, or base64 with fileName. Local file paths are not supported.");
  assertImage({ contentType: input.contentType, fileName: input.fileName } as PublicUrlFile);
  const attachment = await client.uploadAttachment({ token, itemId: input.itemId, fileName: input.fileName, base64: input.base64, contentType: input.contentType, primary: true });
  return { itemId: input.itemId, primary: true, source: "base64", fileName: input.fileName, contentType: input.contentType, attachment, warnings };
}

export async function replacePrimaryPhoto(client: HomeboxClient, token: string, input: ReplacePrimaryPhotoInput): Promise<ReplacePrimaryPhotoResult> {
  const deletePrevious = input.deletePreviousPrimary !== false;
  const attachments = asRecords(await client.listAttachments(token, input.itemId));
  const previousPrimaryAttachmentIds = attachments.filter(isPrimaryAttachment).map(readId).filter((id): id is string => Boolean(id));
  const uploaded = await uploadPrimaryPhoto(client, token, { ...input });
  const uploadedId = readId(toRecord(uploaded.attachment));
  const deletedPreviousPrimaryIds: string[] = [];

  if (deletePrevious) {
    for (const id of previousPrimaryAttachmentIds) {
      if (id === uploadedId) continue;
      await client.deleteAttachment(token, input.itemId, id);
      deletedPreviousPrimaryIds.push(id);
    }
  }

  return { ...uploaded, previousPrimaryAttachmentIds, deletedPreviousPrimaryIds };
}

export async function ensurePrimaryPhoto(client: HomeboxClient, token: string, input: EnsurePrimaryPhotoInput): Promise<EnsurePrimaryPhotoResult> {
  const dedupe = input.dedupe !== false;
  const attachments = asRecords(await client.listAttachments(token, input.itemId));
  const warnings: string[] = [];

  let resolvedFile: { fileName: string; contentType?: string; base64: string; contentLength?: number; url?: string };
  if (input.imageUrl) {
    const file = await client.fetchPublicUrlFile(input.imageUrl, input.fileName, input.contentType);
    assertImage(file);
    resolvedFile = { fileName: file.fileName, contentType: file.contentType, base64: file.base64, contentLength: file.contentLength, url: file.url };
  } else if (input.base64 && input.fileName) {
    assertImage({ contentType: input.contentType, fileName: input.fileName } as PublicUrlFile);
    resolvedFile = { fileName: input.fileName, contentType: input.contentType, base64: input.base64 };
  } else {
    throw new HomeboxMcpError("validation", "Provide imageUrl, or base64 with fileName. Local file paths are not supported.");
  }

  const incomingHash = sha256Hex(resolvedFile.base64);
  let existingId: string | undefined;
  if (dedupe) {
    for (const att of attachments) {
      if (!isPhotoAttachment(att)) continue;
      const title = readString(att.title);
      const matchedByTitle = title && title === resolvedFile.fileName;
      if (matchedByTitle) {
        existingId = readId(att);
        warnings.push(`reused existing attachment by title: ${title}`);
        break;
      }
    }
    if (!existingId) {
      for (const att of attachments) {
        if (!isPhotoAttachment(att)) continue;
        const attId = readId(att);
        if (!attId) continue;
        const downloaded = await client.downloadAttachment(token, input.itemId, attId).catch(() => undefined);
        const dlBase64 = (downloaded as { base64?: string } | undefined)?.base64;
        if (!dlBase64) continue;
        if (sha256Hex(dlBase64) === incomingHash) {
          existingId = attId;
          warnings.push(`reused existing attachment by content hash: ${att.title ?? attId}`);
          break;
        }
      }
    }
  }

  let resultAttachment: unknown;
  let primaryAttachmentId: string | undefined;
  if (existingId) {
    await client.updateEntityAttachment(token, input.itemId, existingId, { primary: true, type: "photo" });
    resultAttachment = attachments.find((a) => readId(a) === existingId);
    primaryAttachmentId = existingId;
    if (input.cleanupDuplicates) await cleanupDuplicatePhotos(client, token, { itemId: input.itemId });
    return { itemId: input.itemId, primary: true, source: "existing", url: resolvedFile.url, fileName: resolvedFile.fileName, contentType: resolvedFile.contentType, contentLength: resolvedFile.contentLength, attachment: resultAttachment, warnings, reused: true, primaryAttachmentId };
  }

  const attachment = await client.uploadAttachment({ token, itemId: input.itemId, fileName: resolvedFile.fileName, base64: resolvedFile.base64, contentType: resolvedFile.contentType, primary: true });
  resultAttachment = attachment;
  primaryAttachmentId = readId(toRecord(attachment));
  if (input.cleanupDuplicates) await cleanupDuplicatePhotos(client, token, { itemId: input.itemId });
  return { itemId: input.itemId, primary: true, source: input.imageUrl ? "url" : "base64", url: resolvedFile.url, fileName: resolvedFile.fileName, contentType: resolvedFile.contentType, contentLength: resolvedFile.contentLength, attachment: resultAttachment, warnings, reused: false, primaryAttachmentId };
}

export async function cleanupDuplicatePhotos(client: HomeboxClient, token: string, input: { itemId: string; keepPrimary?: boolean }): Promise<CleanupDuplicatePhotosResult> {
  const keepPrimary = input.keepPrimary !== false;
  const attachments = asRecords(await client.listAttachments(token, input.itemId));
  const photos = attachments.filter(isPhotoAttachment);
  const warnings: string[] = [];
  const deletedAttachmentIds: string[] = [];

  const groups = new Map<string, Array<{ id?: string; title?: string }>>();
  for (const att of photos) {
    const id = readId(att);
    const title = readString(att.title);
    const key = `${title ?? ""}|${readString(att.mimeType) ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push({ id, title });
    groups.set(key, list);
  }

  let duplicateGroups = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    duplicateGroups += 1;
    const primaryIds = photos.filter((p) => isPrimaryAttachment(p)).map(readId).filter((id): id is string => Boolean(id));
    const sorted = [...list].sort((a, b) => {
      const aPrimary = primaryIds.includes(a.id ?? "");
      const bPrimary = primaryIds.includes(b.id ?? "");
      if (aPrimary && !bPrimary) return -1;
      if (!aPrimary && bPrimary) return 1;
      return 0;
    });
    const keeper = sorted[0];
    for (const entry of sorted.slice(keepPrimary ? 1 : 0)) {
      if (!entry.id) continue;
      if (keepPrimary && primaryIds.includes(entry.id) && entry.id === keeper.id) continue;
      await client.deleteAttachment(token, input.itemId, entry.id);
      deletedAttachmentIds.push(entry.id);
    }
  }
  if (duplicateGroups > 0) warnings.push(`found ${duplicateGroups} duplicate photo group(s); deleted ${deletedAttachmentIds.length} duplicate attachment(s)`);
  const keptPrimary = photos.find(isPrimaryAttachment);
  const keptPrimaryAttachmentId = keptPrimary ? readId(keptPrimary) : undefined;

  return { itemId: input.itemId, keptPrimaryAttachmentId, deletedAttachmentIds, duplicateGroups, warnings };
}

export async function upsertItemsBulk(client: HomeboxClient, token: string, input: BulkUpsertInput): Promise<BulkUpsertResult> {
  const dryRun = input.dryRun === true;
  const result: BulkUpsertResult = { dryRun, created: [], updated: [], skipped: [], errors: [] };
  const dedupeBy: DedupeKey[] = input.dedupeBy?.length ? input.dedupeBy : ["externalAssetId", "orderId", "name"];

  for (const [index, item] of input.items.entries()) {
    const fullItem: ItemWorkflowInput = {
      ...item,
      locationId: item.locationId ?? input.locationId,
      locationName: item.locationName ?? input.locationName,
      createMissingTags: item.createMissingTags ?? input.createMissingTags,
      createMissingLocation: item.createMissingLocation ?? input.createMissingLocation,
      dryRun,
    };
    try {
      const existing = await findExistingItem(client, token, fullItem, dedupeBy);
      const prepared = await prepareItem(client, token, fullItem);
      if (dryRun) {
        (existing ? result.updated : result.created).push({ index, matchedBy: existing?.matchedBy, itemId: existing?.itemId, payload: prepared.payload, tags: prepared.tags, location: prepared.location });
        continue;
      }

      if (existing) {
        const updated = await client.updateItem(token, existing.itemId, prepared.payload);
        const photo = fullItem.photoUrl && fullItem.photoIsPrimary !== false
          ? await ensurePrimaryPhoto(client, token, { itemId: existing.itemId, imageUrl: fullItem.photoUrl, fileName: fullItem.photoFileName, contentType: fullItem.photoContentType })
          : undefined;
        result.updated.push({ index, itemId: existing.itemId, matchedBy: existing.matchedBy, item: updated, photo });
      } else {
        const item = await createEntityWithExtras(client, token, prepared.payload);
        const itemId = readId(toRecord(item));
        const photo = itemId && fullItem.photoUrl && fullItem.photoIsPrimary !== false
          ? await ensurePrimaryPhoto(client, token, { itemId, imageUrl: fullItem.photoUrl, fileName: fullItem.photoFileName, contentType: fullItem.photoContentType })
          : undefined;
        result.created.push({ index, itemId, item, photo });
      }
    } catch (error) {
      result.errors.push({ index, name: item.name, error: toSafeError(error) });
    }
  }

  return result;
}

function buildItemPayload(input: ItemWorkflowInput, tagIds: string[]): JsonObject {
  const body: JsonObject = { ...(input.body ?? {}) };
  setDefined(body, "name", input.name);
  setDefined(body, "description", input.description);
  setDefined(body, "quantity", input.quantity);
  setDefined(body, "insured", input.insured);
  setDefined(body, "archived", input.archived);
  setDefined(body, "assetId", input.assetId);
  setDefined(body, "serialNumber", input.serialNumber);
  setDefined(body, "modelNumber", input.modelNumber);
  setDefined(body, "manufacturer", input.manufacturer);
  setDefined(body, "lifetimeWarranty", input.lifetimeWarranty);
  setDefined(body, "warrantyExpires", input.warrantyExpires);
  setDefined(body, "warrantyDetails", input.warrantyDetails);
  setDefined(body, "purchaseDate", input.purchaseDate ?? input.purchaseTime);
  setDefined(body, "purchasePrice", input.purchasePrice);
  setDefined(body, "currency", input.currency);
  setDefined(body, "purchaseFrom", input.purchaseFrom);
  setDefined(body, "soldTime", input.soldTime);
  setDefined(body, "soldTo", input.soldTo);
  setDefined(body, "soldPrice", input.soldPrice);
  setDefined(body, "soldNotes", input.soldNotes);
  setDefined(body, "notes", input.notes);
  if (tagIds.length > 0) body.tagIds = tagIds;

  const fields = workflowFields(input);
  if (fields.length > 0) body.fields = mergeFields(Array.isArray(body.fields) ? body.fields : [], fields);
  return body;
}

async function findExistingItem(client: HomeboxClient, token: string, input: ItemWorkflowInput, dedupeBy: DedupeKey[]): Promise<{ itemId: string; item: JsonObject; matchedBy: DedupeKey } | undefined> {
  for (const matchedBy of dedupeBy) {
    const value = dedupeValue(input, matchedBy);
    if (!value) continue;
    const response = await client.listItems(token, { pageSize: 100, query: { q: value } });
    const match = asRecords(response).find((item) => itemMatches(item, matchedBy, value));
    const itemId = match ? readId(match) : undefined;
    if (match && itemId) return { itemId, item: match, matchedBy };
  }
  return undefined;
}

function itemMatches(item: JsonObject, keyName: DedupeKey, expected: string): boolean {
  if (keyName === "name") return key(readName(item)) === key(expected);
  return fieldValues(item).some((field) => key(field.name) === key(externalFieldName(keyName)) && key(field.value) === key(expected));
}

function fieldValues(item: JsonObject): Array<{ name: string; value: string }> {
  if (!Array.isArray(item.fields)) return [];
  return item.fields.flatMap((field) => {
    const record = toRecord(field);
    if (!record) return [];
    const name = readString(record.name) ?? readString(record.fieldName);
    const value = readString(record.textValue) ?? readString(record.value) ?? readString(record.numberValue) ?? readString(record.boolValue);
    return name && value ? [{ name, value }] : [];
  });
}

function workflowFields(input: ItemWorkflowInput): JsonObject[] {
  const fields = [
    textField("External Source", input.externalSource),
    textField("External Asset ID", input.externalAssetId),
    textField("Order ID", input.orderId),
    textField("Source URL", input.sourceUrls?.join("\n")),
    textField("Photo URL", input.photoUrl),
  ].filter((field): field is JsonObject => Boolean(field));

  for (const [name, value] of Object.entries(input.customFields ?? {})) {
    const field = customField(name, value);
    if (field) fields.push(field);
  }
  return fields;
}

function mergeFields(existing: unknown[], incoming: JsonObject[]): unknown[] {
  const names = new Set(incoming.map((field) => key(readName(field))).filter(Boolean));
  return [...existing.filter((field) => !names.has(key(readName(toRecord(field) ?? {})))), ...incoming];
}

function textField(name: string, value: unknown): JsonObject | undefined {
  const textValue = valueToText(value);
  return textValue === undefined ? undefined : { type: "text", name, textValue };
}

function customField(name: string, value: FieldValue): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  const text = valueToText(value);
  return text ? { type: "text", name, textValue: text } : undefined;
}

function valueToText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = Array.isArray(value) ? value.join("\n") : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

function dedupeValue(input: ItemWorkflowInput, keyName: DedupeKey): string | undefined {
  if (keyName === "externalAssetId") return clean(input.externalAssetId);
  if (keyName === "orderId") return clean(input.orderId);
  return clean(input.name);
}

function externalFieldName(keyName: DedupeKey): string {
  if (keyName === "externalAssetId") return "External Asset ID";
  if (keyName === "orderId") return "Order ID";
  return "Name";
}

const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff"]);

function assertImage(file: PublicUrlFile): void {
  const ct = file.contentType?.toLowerCase().split(";")[0].trim();
  if (!ct) return;
  if (ct === "text/html" || ct === "application/xhtml+xml") {
    throw new HomeboxMcpError("validation", `photoUrl is not a direct image URL; got ${ct}. The URL must point to an image file (image/jpeg, image/png, image/webp), not a product page. Store product page URLs in sourceUrls/notes instead.`);
  }
  if (!IMAGE_CONTENT_TYPES.has(ct) && !ct.startsWith("image/")) {
    throw new HomeboxMcpError("validation", `photoUrl returned unsupported Content-Type ${ct}. Must be image/jpeg, image/png or image/webp.`);
  }
}

function isPrimaryAttachment(attachment: JsonObject): boolean {
  return attachment.primary === true || attachment.isPrimary === true;
}

function isPhotoAttachment(attachment: JsonObject): boolean {
  const type = readString(attachment.type);
  const mimeType = readString(attachment.mimeType);
  return type === "photo" || Boolean(mimeType?.startsWith("image/"));
}

function sha256Hex(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

function sameParent(location: JsonObject, parentId?: string): boolean {
  if (!parentId) return true;
  return readString(location.parentId) === parentId || readString(toRecord(location.parent)?.id) === parentId;
}

function splitLocationPath(value: string): string[] {
  return value.split(/[/>]/g).map((part) => part.trim()).filter(Boolean);
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = clean(value);
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    out.push(name);
  }
  return out;
}

function asRecords(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(toRecord).filter((record): record is JsonObject => Boolean(record));
  const record = toRecord(value);
  if (!record) return [];
  for (const keyName of ["items", "data", "locations", "tags", "attachments"]) {
    const nested = record[keyName];
    if (Array.isArray(nested)) return nested.map(toRecord).filter((item): item is JsonObject => Boolean(item));
  }
  return [];
}

function toRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function readId(value: JsonObject | undefined): string | undefined {
  return readString(value?.id) ?? readString(value?._id) ?? readString(value?.uuid);
}

function readName(value: JsonObject | undefined): string {
  return readString(value?.name) ?? readString(value?.title) ?? "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function setDefined(target: JsonObject, name: string, value: unknown): void {
  if (value !== undefined) target[name] = value;
}

function key(value: string | undefined): string {
  return clean(value)?.toLocaleLowerCase() ?? "";
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
