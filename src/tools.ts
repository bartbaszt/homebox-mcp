import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { HomeboxClient, JsonObject, QueryValue } from "./homebox-client.js";
import type { SessionStore } from "./session-store.js";
import { HomeboxMcpError, toSafeError } from "./errors.js";

export interface ToolState {
  homebox: HomeboxClient;
  sessions: SessionStore;
}

const authInput = {
  sessionKey: z.string().min(1).optional().describe("Session key returned by homebox_login or homebox_register_token."),
  token: z.string().min(1).optional().describe("Raw Homebox token. Prefer sessionKey so tokens stay out of prompts."),
};

const itemId = z.string().min(1).describe("Homebox item ID.");
const attachmentId = z.string().min(1).describe("Homebox attachment ID.");
const locationId = z.string().min(1).describe("Homebox location ID.");
const jsonObject = z.record(z.unknown());
const queryValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);

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
    (args) => toolResult(() => state.homebox.listCollections(tokenFrom(args, state.sessions)), "Collections loaded"),
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
        () => state.homebox.listItems(tokenFrom(args, state.sessions), args as { page?: number; pageSize?: number; collectionId?: string; query?: Record<string, QueryValue> }),
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
    (args) => toolResult(() => state.homebox.getItem(tokenFrom(args, state.sessions), args.itemId), "Item loaded"),
  );

  server.registerTool(
    "homebox_create_item",
    {
      title: "Create Homebox Item",
      description: "Create a Homebox item using /api/v1/items.",
      inputSchema: { ...authInput, body: jsonObject.describe("Homebox item create payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createItem(tokenFrom(args, state.sessions), args.body as JsonObject), "Item created"),
  );

  server.registerTool(
    "homebox_update_item",
    {
      title: "Update Homebox Item Safely",
      description: "Update an item by GET-merge-PUT. Preserves fields/tags and converts location to locationId.",
      inputSchema: { ...authInput, itemId, patch: jsonObject.describe("Partial fields to merge into current item.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateItem(tokenFrom(args, state.sessions), args.itemId, args.patch as JsonObject), "Item updated"),
  );

  server.registerTool(
    "homebox_put_item",
    {
      title: "Replace Homebox Item",
      description: "Direct PUT /api/v1/items/{id}. Caller must provide full Homebox payload; use homebox_update_item for safe partial updates.",
      inputSchema: { ...authInput, itemId, body: jsonObject.describe("Full Homebox item payload.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.putItem(tokenFrom(args, state.sessions), args.itemId, args.body as JsonObject), "Item replaced"),
  );

  server.registerTool(
    "homebox_patch_item",
    {
      title: "Patch Homebox Item",
      description: "PATCH /api/v1/items/{id}. Behavior depends on Homebox version.",
      inputSchema: { ...authInput, itemId, patch: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.patchItem(tokenFrom(args, state.sessions), args.itemId, args.patch as JsonObject), "Item patched"),
  );

  server.registerTool(
    "homebox_delete_item",
    {
      title: "Delete Homebox Item",
      description: "Delete a Homebox item by ID.",
      inputSchema: { ...authInput, itemId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteItem(tokenFrom(args, state.sessions), args.itemId), "Item deleted"),
  );

  registerAttachmentTools(server, state);
  registerLocationAndFieldTools(server, state);
  registerGenericRequestTool(server, state);
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
    (args) => toolResult(() => state.homebox.listAttachments(tokenFrom(args, state.sessions), args.itemId), "Attachments loaded"),
  );

  server.registerTool(
    "homebox_download_attachment",
    {
      title: "Download Attachment",
      description: "Download an attachment and return base64 content within configured size limit.",
      inputSchema: { ...authInput, itemId, attachmentId },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.downloadAttachment(tokenFrom(args, state.sessions), args.itemId, args.attachmentId), "Attachment downloaded"),
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
            token: tokenFrom(args, state.sessions),
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
    (args) => toolResult(() => state.homebox.deleteAttachment(tokenFrom(args, state.sessions), args.itemId, args.attachmentId), "Attachment deleted"),
  );

  server.registerTool(
    "homebox_set_primary_attachment",
    {
      title: "Set Primary Attachment",
      description: "Set an attachment as the primary attachment/photo for an item.",
      inputSchema: { ...authInput, itemId, attachmentId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.setPrimaryAttachment(tokenFrom(args, state.sessions), args.itemId, args.attachmentId), "Primary attachment set"),
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
    (args) => toolResult(() => state.homebox.listLocations(tokenFrom(args, state.sessions)), "Locations loaded"),
  );

  server.registerTool(
    "homebox_create_location",
    {
      title: "Create Location",
      description: "Create a Homebox location.",
      inputSchema: { ...authInput, body: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.createLocation(tokenFrom(args, state.sessions), args.body as JsonObject), "Location created"),
  );

  server.registerTool(
    "homebox_update_location",
    {
      title: "Update Location",
      description: "Update a Homebox location.",
      inputSchema: { ...authInput, locationId, body: jsonObject },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.updateLocation(tokenFrom(args, state.sessions), args.locationId, args.body as JsonObject), "Location updated"),
  );

  server.registerTool(
    "homebox_delete_location",
    {
      title: "Delete Location",
      description: "Delete a Homebox location.",
      inputSchema: { ...authInput, locationId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.deleteLocation(tokenFrom(args, state.sessions), args.locationId), "Location deleted"),
  );

  server.registerTool(
    "homebox_list_tags",
    {
      title: "List Tags",
      description: "List Homebox tags.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listTags(tokenFrom(args, state.sessions)), "Tags loaded"),
  );

  server.registerTool(
    "homebox_list_custom_fields",
    {
      title: "List Custom Fields",
      description: "List Homebox item custom field definitions.",
      inputSchema: { ...authInput },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCustomFields(tokenFrom(args, state.sessions)), "Custom fields loaded"),
  );

  server.registerTool(
    "homebox_list_custom_field_values",
    {
      title: "List Custom Field Values",
      description: "List distinct values for one Homebox custom field. Homebox v0.25.0 requires the field query parameter.",
      inputSchema: { ...authInput, field: z.string().min(1).describe("Custom field name, e.g. one value from homebox_list_custom_fields.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => toolResult(() => state.homebox.listCustomFieldValues(tokenFrom(args, state.sessions), args.field), "Custom field values loaded"),
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
        () => state.homebox.apiRequest(args.method, args.path, { token: tokenFrom(args, state.sessions), query: args.query, body: args.body }),
        "Homebox API request completed",
      ),
  );
}

function tokenFrom(args: { sessionKey?: string; token?: string }, sessions: SessionStore): string {
  if (args.token) return args.token;
  if (args.sessionKey) return sessions.get(args.sessionKey).token;
  throw new HomeboxMcpError("auth", "Provide sessionKey or token. Use homebox_login to create a sessionKey.");
}

async function toolResult<T>(action: () => T | Promise<T>, message: string): Promise<CallToolResult> {
  try {
    const data = await action();
    return {
      content: [{ type: "text", text: `${message}.` }],
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

function toStructuredContent(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (data === undefined) return { ok: true };
  return { data };
}
