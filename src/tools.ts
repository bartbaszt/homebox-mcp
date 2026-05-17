import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { HomeboxClient, JsonObject, QueryValue } from "./homebox-client.js";
import type { HomeboxSession, SessionStore } from "./session-store.js";
import { HomeboxMcpError, toSafeError } from "./errors.js";

export interface ToolState {
  homebox: HomeboxClient;
  sessions: SessionStore;
  connectionSession?: HomeboxSession;
}

const authInput = {
  sessionKey: z.string().min(1).optional().describe("Optional session key returned by homebox_login or homebox_register_token. Not needed when MCP OAuth is connected."),
  token: z.string().min(1).optional().describe("Optional raw Homebox token. Prefer MCP OAuth or sessionKey so tokens stay out of prompts."),
};

const itemId = z.string().min(1).describe("Homebox item ID.");
const entityId = z.string().min(1).describe("Homebox entity ID.");
const entityTypeId = z.string().min(1).describe("Homebox entity type ID.");
const templateId = z.string().min(1).describe("Homebox entity template ID.");
const attachmentId = z.string().min(1).describe("Homebox attachment ID.");
const locationId = z.string().min(1).describe("Homebox location ID.");
const jsonObject = z.record(z.unknown());
const queryValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
const base64FileInput = {
  fileName: z.string().min(1),
  base64: z.string().min(1).describe("Base64 file content."),
  contentType: z.string().min(1).optional(),
};

export function registerHomeboxTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_status",
    {
      title: "Get Homebox Status",
      description: "Read Homebox instance status from /api/v1/status. Does not require a Homebox user session.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    () => toolResult(() => state.homebox.status(), "Homebox status loaded"),
  );

  server.registerTool(
    "homebox_list_currencies",
    {
      title: "List Homebox Currencies",
      description: "List available Homebox currencies via /api/v1/currency. Current Homebox docs describe this as GET /v1/currency.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCurrencies(optionalTokenFrom(args, state)), "Currencies loaded"),
  );

  server.registerTool(
    "homebox_api_surface",
    {
      title: "Detect Homebox API Surface",
      description: "Probe the connected Homebox instance to detect which API version is available: 'entities' (new Entity Merge API) or 'items' (legacy v0.25.0). Result is cached per server process.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      toolResult(async () => {
        const token = tokenFrom(args, state);
        const surface = await state.homebox.getApiSurface(token);
        return { surface, cached: state.homebox.currentApiSurface() === surface };
      }, "API surface detected"),
  );

  server.registerTool(
    "homebox_login",
    {
      title: "Login To Homebox",
      description: "Authenticate a Homebox user. Password is discarded; returned sessionKey is kept only in memory.",
      inputSchema: {
        username: z.string().min(1).describe("Homebox username or email."),
        password: z.string().min(1).describe("Homebox password. Never stored."),
        stayLoggedIn: z.boolean().optional().default(true),
        sessionKey: z.string().min(1).optional().describe("Optional caller-chosen session key to overwrite or create."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ username, password, stayLoggedIn, sessionKey }) =>
      toolResult(async () => {
        const login = await state.homebox.login(username, password, stayLoggedIn ?? true);
        return state.sessions.set({
          sessionKey,
          token: login.token,
          username,
          expiresAt: login.expiresAt,
          attachmentToken: login.attachmentToken,
        });
      }, "Login successful. Use sessionKey for later tools."),
  );

  server.registerTool(
    "homebox_register_token",
    {
      title: "Register Existing Homebox Token",
      description: "Store an existing Homebox token in memory and return a sessionKey.",
      inputSchema: {
        token: z.string().min(1).describe("Homebox bearer token."),
        username: z.string().min(1).optional(),
        expiresAt: z.string().min(1).optional(),
        sessionKey: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ token, username, expiresAt, sessionKey }) =>
      toolResult(() => state.sessions.set({ sessionKey, token, username, expiresAt }), "Token registered. Use sessionKey for later tools."),
  );

  server.registerTool(
    "homebox_refresh_session",
    {
      title: "Refresh Homebox Session",
      description: "Refresh a Homebox session token through /api/v1/users/refresh.",
      inputSchema: { sessionKey: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ sessionKey }) =>
      toolResult(async () => {
        const session = state.sessions.get(sessionKey);
        const refreshed = await state.homebox.refresh(session.token);
        return state.sessions.updateToken(sessionKey, refreshed.token, refreshed.expiresAt, refreshed.attachmentToken);
      }, "Session refreshed"),
  );

  server.registerTool(
    "homebox_logout",
    {
      title: "Logout Homebox Session",
      description: "Remove an in-memory Homebox session from this MCP server.",
      inputSchema: { sessionKey: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ sessionKey }) => toolResult(() => ({ removed: state.sessions.delete(sessionKey) }), "Session removed"),
  );

  server.registerTool(
    "homebox_list_sessions",
    {
      title: "List In-Memory Sessions",
      description: "List non-secret metadata for sessions currently held by this MCP process.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => toolResult(() => ({ sessions: state.sessions.list() }), "Sessions loaded"),
  );

  server.registerTool(
    "homebox_list_collections",
    {
      title: "List Homebox Collections",
      description: "List Homebox groups via /api/v1/groups/all. Groups are exposed as MCP collections.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCollections(tokenFrom(args, state)), "Collections loaded"),
  );

  server.registerTool(
    "homebox_list_items",
    {
      title: "List Homebox Items",
      description: "List Homebox items with pagination and optional collection/group filter.",
      inputSchema: {
        ...authInput,
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
        collectionId: z.string().min(1).optional().describe("Homebox group ID. Sent as groupId query parameter."),
        query: z.record(queryValue).optional().describe("Additional Homebox query parameters."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () => state.homebox.listItems(tokenFrom(args, state), args as { page?: number; pageSize?: number; collectionId?: string; query?: Record<string, QueryValue> }),
        "Items loaded",
      ),
  );

  server.registerTool(
    "homebox_get_item",
    {
      title: "Get Homebox Item",
      description: "Get full Homebox item detail by ID.",
      inputSchema: { ...authInput, itemId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.getItem(tokenFrom(args, state), args.itemId), "Item loaded"),
  );

  server.registerTool(
    "homebox_create_item",
    {
      title: "Create Homebox Item",
      description: "Create a Homebox item using /api/v1/items.",
      inputSchema: { ...authInput, body: jsonObject.describe("Homebox item create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createItem(tokenFrom(args, state), args.body as JsonObject), "Item created"),
  );

  server.registerTool(
    "homebox_update_item",
    {
      title: "Update Homebox Item Safely",
      description: "Update an item by GET-merge-PUT. Preserves fields/tags and converts location to locationId.",
      inputSchema: { ...authInput, itemId, patch: jsonObject.describe("Partial fields to merge into current item.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateItem(tokenFrom(args, state), args.itemId, args.patch as JsonObject), "Item updated"),
  );

  server.registerTool(
    "homebox_put_item",
    {
      title: "Replace Homebox Item",
      description: "Direct PUT /api/v1/items/{id}. Caller must provide full Homebox payload; use homebox_update_item for safe partial updates.",
      inputSchema: { ...authInput, itemId, body: jsonObject.describe("Full Homebox item payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.putItem(tokenFrom(args, state), args.itemId, args.body as JsonObject), "Item replaced"),
  );

  server.registerTool(
    "homebox_patch_item",
    {
      title: "Patch Homebox Item",
      description: "PATCH /api/v1/items/{id}. Behavior depends on Homebox version.",
      inputSchema: { ...authInput, itemId, patch: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.patchItem(tokenFrom(args, state), args.itemId, args.patch as JsonObject), "Item patched"),
  );

  server.registerTool(
    "homebox_delete_item",
    {
      title: "Delete Homebox Item",
      description: "Delete a Homebox item by ID.",
      inputSchema: { ...authInput, itemId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteItem(tokenFrom(args, state), args.itemId), "Item deleted"),
  );

  registerEntityTools(server, state);
  registerAttachmentTools(server, state);
  registerLocationAndFieldTools(server, state);
  registerMaintenanceTools(server, state);
  registerNotifierTools(server, state);
  registerGenericRequestTool(server, state);
}

function registerMaintenanceTools(server: McpServer, state: ToolState): void {
  const maintenanceId = z.string().min(1).describe("Homebox maintenance entry ID.");

  server.registerTool(
    "homebox_list_maintenance",
    {
      title: "List Maintenance",
      description: "Query maintenance log across all items via GET /api/v1/maintenance. Defaults to status=both when not provided to avoid v0.25.0 500 error.",
      inputSchema: { ...authInput, status: z.enum(["scheduled", "completed", "both"]).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listMaintenance(tokenFrom(args, state), args.status), "Maintenance loaded"),
  );

  server.registerTool(
    "homebox_update_maintenance_entry",
    {
      title: "Update Maintenance Entry",
      description: "Update maintenance entry via PUT /api/v1/maintenance/{id}. Payload: name, description, scheduledDate, completedDate, cost.",
      inputSchema: { ...authInput, maintenanceId, body: jsonObject.describe("Maintenance entry update payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateMaintenanceEntry(tokenFrom(args, state), args.maintenanceId, args.body as JsonObject), "Maintenance entry updated"),
  );

  server.registerTool(
    "homebox_delete_maintenance_entry",
    {
      title: "Delete Maintenance Entry",
      description: "Delete maintenance entry via DELETE /api/v1/maintenance/{id}.",
      inputSchema: { ...authInput, maintenanceId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteMaintenanceEntry(tokenFrom(args, state), args.maintenanceId), "Maintenance entry deleted"),
  );
}

function registerNotifierTools(server: McpServer, state: ToolState): void {
  const notifierId = z.string().min(1).describe("Homebox notifier ID.");

  server.registerTool(
    "homebox_list_notifiers",
    {
      title: "List Notifiers",
      description: "List notifiers via GET /api/v1/notifiers.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listNotifiers(tokenFrom(args, state)), "Notifiers loaded"),
  );

  server.registerTool(
    "homebox_create_notifier",
    {
      title: "Create Notifier",
      description: "Create notifier via POST /api/v1/notifiers. Payload: name, url, isActive.",
      inputSchema: { ...authInput, body: jsonObject.describe("Notifier create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createNotifier(tokenFrom(args, state), args.body as JsonObject), "Notifier created"),
  );

  server.registerTool(
    "homebox_test_notifier",
    {
      title: "Test Notifier URL",
      description: "Test notifier URL via POST /api/v1/notifiers/test?url=<url>.",
      inputSchema: { ...authInput, url: z.string().url().describe("Notifier URL to test.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.testNotifier(tokenFrom(args, state), args.url), "Notifier test sent"),
  );

  server.registerTool(
    "homebox_update_notifier",
    {
      title: "Update Notifier",
      description: "Update notifier via PUT /api/v1/notifiers/{id}.",
      inputSchema: { ...authInput, notifierId, body: jsonObject.describe("Notifier update payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateNotifier(tokenFrom(args, state), args.notifierId, args.body as JsonObject), "Notifier updated"),
  );

  server.registerTool(
    "homebox_delete_notifier",
    {
      title: "Delete Notifier",
      description: "Delete notifier via DELETE /api/v1/notifiers/{id}.",
      inputSchema: { ...authInput, notifierId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteNotifier(tokenFrom(args, state), args.notifierId), "Notifier deleted"),
  );
}

function registerEntityTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_entities",
    {
      title: "List Entities",
      description: "Query entities via /api/v1/entities. Current Homebox docs describe this as GET /v1/entities.",
      inputSchema: {
        ...authInput,
        q: z.string().min(1).optional().describe("Search string."),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
        tags: z.array(z.string().min(1)).optional().describe("Tag IDs."),
        parentIds: z.array(z.string().min(1)).optional().describe("Parent entity IDs."),
        query: z.record(queryValue).optional().describe("Additional Homebox query parameters."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () => state.homebox.listEntities(tokenFrom(args, state), args as { q?: string; page?: number; pageSize?: number; tags?: string[]; parentIds?: string[]; query?: Record<string, QueryValue> }),
        "Entities loaded",
      ),
  );

  server.registerTool(
    "homebox_create_entity",
    {
      title: "Create Entity",
      description: "Create an entity via POST /api/v1/entities.",
      inputSchema: { ...authInput, body: jsonObject.describe("Entity create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createEntity(tokenFrom(args, state), args.body as JsonObject), "Entity created"),
  );

  server.registerTool(
    "homebox_export_entities",
    {
      title: "Export Entities",
      description: "Export entities CSV via GET /api/v1/entities/export. Returns base64 and text when response is textual.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.exportEntities(tokenFrom(args, state)), "Entities exported"),
  );

  server.registerTool(
    "homebox_import_entities",
    {
      title: "Import Entities",
      description: "Import entities CSV via POST /api/v1/entities/import using multipart field csv.",
      inputSchema: { ...authInput, ...base64FileInput },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () =>
          state.homebox.importEntities({
            token: tokenFrom(args, state),
            fileName: args.fileName,
            base64: args.base64,
            contentType: args.contentType,
          }),
        "Entities imported",
      ),
  );

  server.registerTool(
    "homebox_list_entity_field_names",
    {
      title: "List Entity Field Names",
      description: "List entity custom field names via GET /api/v1/entities/fields.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityFieldNames(tokenFrom(args, state)), "Entity field names loaded"),
  );

  server.registerTool(
    "homebox_list_entity_field_values",
    {
      title: "List Entity Field Values",
      description: "List distinct values for one entity custom field via GET /api/v1/entities/fields/values?field=<name>.",
      inputSchema: { ...authInput, field: z.string().min(1).describe("Entity custom field name.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityFieldValues(tokenFrom(args, state), args.field), "Entity field values loaded"),
  );

  server.registerTool(
    "homebox_list_entities_tree",
    {
      title: "List Entity Tree",
      description: "Read location/entity tree via GET /api/v1/entities/tree.",
      inputSchema: { ...authInput, withItems: z.boolean().optional().describe("Include items in response tree.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntitiesTree(tokenFrom(args, state), args.withItems), "Entity tree loaded"),
  );

  server.registerTool(
    "homebox_get_entity",
    {
      title: "Get Entity",
      description: "Get entity detail via GET /api/v1/entities/{id}.",
      inputSchema: { ...authInput, entityId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.getEntity(tokenFrom(args, state), args.entityId), "Entity loaded"),
  );

  server.registerTool(
    "homebox_put_entity",
    {
      title: "Replace Entity",
      description: "Direct PUT /api/v1/entities/{id}. Caller must provide Homebox entity payload.",
      inputSchema: { ...authInput, entityId, body: jsonObject.describe("Entity update payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.putEntity(tokenFrom(args, state), args.entityId, args.body as JsonObject), "Entity replaced"),
  );

  server.registerTool(
    "homebox_patch_entity",
    {
      title: "Patch Entity",
      description: "PATCH /api/v1/entities/{id}. Current docs support entityTypeId, parentId, quantity and tagIds.",
      inputSchema: { ...authInput, entityId, patch: jsonObject.describe("Entity patch payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.patchEntity(tokenFrom(args, state), args.entityId, args.patch as JsonObject), "Entity patched"),
  );

  server.registerTool(
    "homebox_delete_entity",
    {
      title: "Delete Entity",
      description: "Delete entity via DELETE /api/v1/entities/{id}.",
      inputSchema: { ...authInput, entityId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteEntity(tokenFrom(args, state), args.entityId), "Entity deleted"),
  );

  server.registerTool(
    "homebox_duplicate_entity",
    {
      title: "Duplicate Entity",
      description: "Duplicate entity via POST /api/v1/entities/{id}/duplicate.",
      inputSchema: { ...authInput, entityId, body: jsonObject.describe("Duplicate options: copyAttachments, copyCustomFields, copyMaintenance, copyPrefix.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.duplicateEntity(tokenFrom(args, state), args.entityId, args.body as JsonObject), "Entity duplicated"),
  );

  server.registerTool(
    "homebox_get_entity_path",
    {
      title: "Get Entity Path",
      description: "Get full path for entity via GET /api/v1/entities/{id}/path.",
      inputSchema: { ...authInput, entityId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.getEntityPath(tokenFrom(args, state), args.entityId), "Entity path loaded"),
  );

  registerEntityAttachmentTools(server, state);
  registerEntityMaintenanceTools(server, state);
  registerEntityTypeTools(server, state);
  registerEntityTemplateTools(server, state);
}

function registerEntityAttachmentTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_entity_attachments",
    {
      title: "List Entity Attachments",
      description: "List attachments by reading GET /api/v1/entities/{id}.",
      inputSchema: { ...authInput, entityId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityAttachments(tokenFrom(args, state), args.entityId), "Entity attachments loaded"),
  );

  server.registerTool(
    "homebox_upload_entity_attachment",
    {
      title: "Upload Entity Attachment",
      description: "Upload file attachment via POST /api/v1/entities/{id}/attachments using multipart field file.",
      inputSchema: { ...authInput, entityId, ...base64FileInput, type: z.string().min(1).optional(), primary: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () =>
          state.homebox.uploadEntityAttachment({
            token: tokenFrom(args, state),
            entityId: args.entityId,
            fileName: args.fileName,
            base64: args.base64,
            contentType: args.contentType,
            type: args.type,
            primary: args.primary,
          }),
        "Entity attachment uploaded",
      ),
  );

  server.registerTool(
    "homebox_create_external_entity_attachment",
    {
      title: "Create External Entity Attachment",
      description: "Link external document or URL via POST /api/v1/entities/{id}/attachments/external.",
      inputSchema: { ...authInput, entityId, body: jsonObject.describe("External reference payload: attachment_type, external_id, source_type, title.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createExternalEntityAttachment(tokenFrom(args, state), args.entityId, args.body as JsonObject), "External entity attachment created"),
  );

  server.registerTool(
    "homebox_download_entity_attachment",
    {
      title: "Download Entity Attachment",
      description: "Download entity attachment via GET /api/v1/entities/{id}/attachments/{attachmentId}; returns base64 within configured size limit. For image content types, returns image content viewable by multimodal models.",
      inputSchema: { ...authInput, entityId, attachmentId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.downloadEntityAttachment(tokenFrom(args, state), args.entityId, args.attachmentId), "Entity attachment downloaded"),
  );

  server.registerTool(
    "homebox_update_entity_attachment",
    {
      title: "Update Entity Attachment",
      description: "Update entity attachment metadata via PUT /api/v1/entities/{id}/attachments/{attachmentId}.",
      inputSchema: { ...authInput, entityId, attachmentId, body: jsonObject.describe("Attachment update payload: primary, title, type.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateEntityAttachment(tokenFrom(args, state), args.entityId, args.attachmentId, args.body as JsonObject), "Entity attachment updated"),
  );

  server.registerTool(
    "homebox_delete_entity_attachment",
    {
      title: "Delete Entity Attachment",
      description: "Delete entity attachment via DELETE /api/v1/entities/{id}/attachments/{attachmentId}.",
      inputSchema: { ...authInput, entityId, attachmentId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteEntityAttachment(tokenFrom(args, state), args.entityId, args.attachmentId), "Entity attachment deleted"),
  );
}

function registerEntityMaintenanceTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_entity_maintenance",
    {
      title: "List Entity Maintenance",
      description: "List maintenance log for one entity via GET /api/v1/entities/{id}/maintenance.",
      inputSchema: { ...authInput, entityId, status: z.enum(["scheduled", "completed", "both"]).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityMaintenance(tokenFrom(args, state), args.entityId, args.status), "Entity maintenance loaded"),
  );

  server.registerTool(
    "homebox_create_entity_maintenance",
    {
      title: "Create Entity Maintenance",
      description: "Create maintenance entry via POST /api/v1/entities/{id}/maintenance.",
      inputSchema: { ...authInput, entityId, body: jsonObject.describe("Maintenance create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createEntityMaintenance(tokenFrom(args, state), args.entityId, args.body as JsonObject), "Entity maintenance created"),
  );
}

function registerEntityTypeTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_entity_types",
    {
      title: "List Entity Types",
      description: "List entity types via GET /api/v1/entity-types.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityTypes(tokenFrom(args, state)), "Entity types loaded"),
  );

  server.registerTool(
    "homebox_create_entity_type",
    {
      title: "Create Entity Type",
      description: "Create entity type via POST /api/v1/entity-types.",
      inputSchema: { ...authInput, body: jsonObject.describe("Entity type create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createEntityType(tokenFrom(args, state), args.body as JsonObject), "Entity type created"),
  );

  server.registerTool(
    "homebox_update_entity_type",
    {
      title: "Update Entity Type",
      description: "Update entity type via PUT /api/v1/entity-types/{id}.",
      inputSchema: { ...authInput, entityTypeId, body: jsonObject.describe("Entity type update payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateEntityType(tokenFrom(args, state), args.entityTypeId, args.body as JsonObject), "Entity type updated"),
  );

  server.registerTool(
    "homebox_delete_entity_type",
    {
      title: "Delete Entity Type",
      description: "Delete entity type via DELETE /api/v1/entity-types/{id}.",
      inputSchema: { ...authInput, entityTypeId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteEntityType(tokenFrom(args, state), args.entityTypeId), "Entity type deleted"),
  );
}

function registerEntityTemplateTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_entity_templates",
    {
      title: "List Entity Templates",
      description: "List entity templates via GET /api/v1/templates.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listEntityTemplates(tokenFrom(args, state)), "Entity templates loaded"),
  );

  server.registerTool(
    "homebox_create_entity_template",
    {
      title: "Create Entity Template",
      description: "Create entity template via POST /api/v1/templates.",
      inputSchema: { ...authInput, body: jsonObject.describe("Entity template create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createEntityTemplate(tokenFrom(args, state), args.body as JsonObject), "Entity template created"),
  );

  server.registerTool(
    "homebox_get_entity_template",
    {
      title: "Get Entity Template",
      description: "Get entity template via GET /api/v1/templates/{id}.",
      inputSchema: { ...authInput, templateId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.getEntityTemplate(tokenFrom(args, state), args.templateId), "Entity template loaded"),
  );

  server.registerTool(
    "homebox_update_entity_template",
    {
      title: "Update Entity Template",
      description: "Update entity template via PUT /api/v1/templates/{id}.",
      inputSchema: { ...authInput, templateId, body: jsonObject.describe("Entity template update payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateEntityTemplate(tokenFrom(args, state), args.templateId, args.body as JsonObject), "Entity template updated"),
  );

  server.registerTool(
    "homebox_delete_entity_template",
    {
      title: "Delete Entity Template",
      description: "Delete entity template via DELETE /api/v1/templates/{id}.",
      inputSchema: { ...authInput, templateId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteEntityTemplate(tokenFrom(args, state), args.templateId), "Entity template deleted"),
  );

  server.registerTool(
    "homebox_create_entity_from_template",
    {
      title: "Create Entity From Template",
      description: "Create entity from template via POST /api/v1/templates/{id}/create-item.",
      inputSchema: { ...authInput, templateId, body: jsonObject.describe("Create-from-template payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createEntityFromTemplate(tokenFrom(args, state), args.templateId, args.body as JsonObject), "Entity created from template"),
  );
}

function registerAttachmentTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_attachments",
    {
      title: "List Item Attachments",
      description: "List attachments for a Homebox item by reading item detail.",
      inputSchema: { ...authInput, itemId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listAttachments(tokenFrom(args, state), args.itemId), "Attachments loaded"),
  );

  server.registerTool(
    "homebox_download_attachment",
    {
      title: "Download Attachment",
      description: "Download an attachment and return base64 content within configured size limit. For image attachments, returns image content viewable by multimodal models.",
      inputSchema: { ...authInput, itemId, attachmentId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.downloadAttachment(tokenFrom(args, state), args.itemId, args.attachmentId), "Attachment downloaded"),
  );

  server.registerTool(
    "homebox_upload_attachment",
    {
      title: "Upload Attachment",
      description: "Upload a base64 file as a Homebox item attachment.",
      inputSchema: {
        ...authInput,
        itemId,
        fileName: z.string().min(1),
        base64: z.string().min(1).describe("Base64 file content."),
        contentType: z.string().min(1).optional(),
        primary: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () =>
          state.homebox.uploadAttachment({
            token: tokenFrom(args, state),
            itemId: args.itemId,
            fileName: args.fileName,
            base64: args.base64,
            contentType: args.contentType,
            primary: args.primary,
          }),
        "Attachment uploaded",
      ),
  );

  server.registerTool(
    "homebox_delete_attachment",
    {
      title: "Delete Attachment",
      description: "Delete a Homebox item attachment.",
      inputSchema: { ...authInput, itemId, attachmentId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteAttachment(tokenFrom(args, state), args.itemId, args.attachmentId), "Attachment deleted"),
  );

  server.registerTool(
    "homebox_set_primary_attachment",
    {
      title: "Set Primary Attachment",
      description: "Set an attachment as the primary attachment/photo for an item.",
      inputSchema: { ...authInput, itemId, attachmentId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.setPrimaryAttachment(tokenFrom(args, state), args.itemId, args.attachmentId), "Primary attachment set"),
  );
}

function registerLocationAndFieldTools(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_list_locations",
    {
      title: "List Locations",
      description: "List Homebox locations.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listLocations(tokenFrom(args, state)), "Locations loaded"),
  );

  server.registerTool(
    "homebox_create_location",
    {
      title: "Create Location",
      description: "Create a Homebox location.",
      inputSchema: { ...authInput, body: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createLocation(tokenFrom(args, state), args.body as JsonObject), "Location created"),
  );

  server.registerTool(
    "homebox_update_location",
    {
      title: "Update Location",
      description: "Update a Homebox location.",
      inputSchema: { ...authInput, locationId, body: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateLocation(tokenFrom(args, state), args.locationId, args.body as JsonObject), "Location updated"),
  );

  server.registerTool(
    "homebox_delete_location",
    {
      title: "Delete Location",
      description: "Delete a Homebox location.",
      inputSchema: { ...authInput, locationId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteLocation(tokenFrom(args, state), args.locationId), "Location deleted"),
  );

  server.registerTool(
    "homebox_list_tags",
    {
      title: "List Tags",
      description: "List Homebox tags.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listTags(tokenFrom(args, state)), "Tags loaded"),
  );

  server.registerTool(
    "homebox_list_custom_fields",
    {
      title: "List Custom Fields",
      description: "List Homebox item custom field definitions.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCustomFields(tokenFrom(args, state)), "Custom fields loaded"),
  );

  server.registerTool(
    "homebox_list_custom_field_values",
    {
      title: "List Custom Field Values",
      description: "List distinct values for one Homebox custom field. Homebox v0.25.0 requires the field query parameter.",
      inputSchema: { ...authInput, field: z.string().min(1).describe("Custom field name, e.g. one value from homebox_list_custom_fields.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCustomFieldValues(tokenFrom(args, state), args.field), "Custom field values loaded"),
  );
}

function registerGenericRequestTool(server: McpServer, state: ToolState): void {
  server.registerTool(
    "homebox_api_request",
    {
      title: "Homebox API Request",
      description: "Call a relative /api/v1/... endpoint on the configured Homebox instance. Use for version-specific API coverage.",
      inputSchema: {
        ...authInput,
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().min(1).describe("Relative path. Must start with /api/v1/. Absolute URLs are rejected."),
        query: z.record(queryValue).optional(),
        body: z.unknown().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      toolResult(
        () => state.homebox.apiRequest(args.method, args.path, { token: tokenFrom(args, state), query: args.query, body: args.body }),
        "Homebox API request completed",
      ),
  );
}

function tokenFrom(args: { sessionKey?: string; token?: string }, state: ToolState): string {
  if (args.token) return args.token;
  if (args.sessionKey) return state.sessions.get(args.sessionKey).token;
  if (state.connectionSession) return state.connectionSession.token;
  throw new HomeboxMcpError("auth", "Provide sessionKey/token or connect to this MCP server with OAuth.");
}

function optionalTokenFrom(args: { sessionKey?: string; token?: string }, state: ToolState): string | undefined {
  if (args.token) return args.token;
  if (args.sessionKey) return state.sessions.get(args.sessionKey).token;
  return state.connectionSession?.token;
}

export type DownloadResult = { contentType?: string; contentLength: number; base64: string; text?: string; itemId?: string; attachmentId?: string; entityId?: string };

async function toolResult<T>(action: () => T | Promise<T>, message: string): Promise<CallToolResult> {
  try {
    const data = await action();
    const content = downloadImageContent(data);
    return {
      content: content ?? [{ type: "text", text: `${message}.` }],
      structuredContent: toStructuredContent(data),
    };
  } catch (error) {
    const safe = toSafeError(error);
    return {
      isError: true,
      content: [{ type: "text", text: `${safe.kind}: ${safe.message}` }],
      structuredContent: safe,
    };
  }
}

function downloadImageContent(data: unknown): CallToolResult["content"] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as DownloadResult;
  if (typeof d.base64 !== "string" || !d.contentType?.startsWith("image/")) return undefined;
  return [
    { type: "image", data: d.base64, mimeType: d.contentType },
    { type: "text", text: `Attachment downloaded (${d.contentType}, ${d.contentLength} bytes).` },
  ];
}

export function registerHomeboxResources(server: McpServer, state: ToolState): void {
  const attachmentTemplate = new ResourceTemplate("homebox://attachments/{entityId}/{attachmentId}", {
    list: undefined,
    complete: {
      entityId: async (value) => {
        const token = state.connectionSession?.token;
        if (!token) return [];
        try {
          const entities = await state.homebox.listEntities(token, { q: value, pageSize: 10 });
          const items = (entities as { items?: Array<{ id: string; name: string }> }).items ?? [];
          return items.map((e) => e.id);
        } catch { return []; }
      },
      attachmentId: async () => [],
    },
  });

  server.registerResource(
    "homebox-attachment",
    attachmentTemplate,
    { description: "Download a Homebox entity attachment. Returns image content for images, base64 blob for other file types. Requires OAuth or connection-authenticated session." },
    async (uri, variables) => {
      const token = state.connectionSession?.token;
      if (!token) throw new HomeboxMcpError("auth", "No authenticated session for resource read. Use homebox_download_attachment or homebox_download_entity_attachment tool instead.");
      const { entityId, attachmentId } = variables as Record<string, string>;
      const file = await state.homebox.downloadEntityAttachment(token, entityId, attachmentId);
      if (file.contentType?.startsWith("image/")) {
        return { contents: [{ uri: uri.href, mimeType: file.contentType, blob: file.base64 }] };
      }
      if (file.text !== undefined) {
        return { contents: [{ uri: uri.href, mimeType: file.contentType ?? "text/plain", text: file.text }] };
      }
      return { contents: [{ uri: uri.href, mimeType: file.contentType ?? "application/octet-stream", blob: file.base64 }] };
    },
  );
}

function toStructuredContent(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (data === undefined) return { ok: true };
  return { data };
}
