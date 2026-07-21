import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { toSafeError } from "../../src/errors.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { json, startMockHomebox, type MockHomeboxServer } from "../support/mock-homebox.js";

let mock: MockHomeboxServer | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  await mock?.close();
  started = undefined;
  mock = undefined;
});

describe("MCP tool contracts", () => {
  it("publishes strict v0.26 create/patch schemas and destructive annotations", async () => {
    const { client } = await connectClient();
    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const tools = listed.tools as unknown as ListedTool[];

    const create = tool(tools, "homebox_create_item");
    const createBody = nestedObjectSchema(create.inputSchema, "body");
    expect(create.inputSchema.additionalProperties).toBe(false);
    expect(createBody.additionalProperties).toBe(false);
    expect(Object.keys(createBody.properties ?? {}).sort()).toEqual([
      "archived",
      "assetId",
      "description",
      "entityTypeId",
      "insured",
      "locationId",
      "name",
      "parentId",
      "quantity",
      "syncChildEntityLocations",
      "syncChildItemsLocations",
      "tagIds",
    ]);
    expect(createBody.required).toContain("name");
    expect(createBody.properties?.quantity?.minimum).toBe(0);
    expect(createBody.properties).not.toHaveProperty("purchasePrice");
    expect(createBody.properties).not.toHaveProperty("manufacturer");
    expect(create.description).toContain("homebox_create_item_full");

    for (const name of ["homebox_patch_item", "homebox_patch_entity"]) {
      const patchTool = tool(tools, name);
      const patch = nestedObjectSchema(patchTool.inputSchema, "patch");
      expect(patchTool.inputSchema.additionalProperties).toBe(false);
      expect(patch.additionalProperties).toBe(false);
      expect(Object.keys(patch.properties ?? {}).sort()).toEqual(["entityTypeId", "locationId", "parentId", "quantity", "tagIds"]);
      expect(patch.properties?.quantity?.minimum).toBe(0);
      expect(patchTool.description).toContain("Requires at least one");
      expect(patchTool.description).toContain("must never use PATCH");
    }

    expect(tool(tools, "homebox_api_request").annotations?.destructiveHint).toBe(true);
    const ensurePhoto = tool(tools, "homebox_ensure_primary_photo");
    expect(ensurePhoto.annotations?.destructiveHint).toBe(true);
    expect(ensurePhoto.description).toContain("cleanupDuplicates=true deletes");

    const exportDownload = tool(tools, "homebox_download_group_export_artifact");
    expect(exportDownload.inputSchema.properties).toHaveProperty("exportId");
    expect(exportDownload.outputSchema?.properties).toHaveProperty("exportId");
    expect(exportDownload.outputSchema?.required).toContain("exportId");

    await client.close();
  });

  it("rejects unsupported create/patch fields and empty patches before Homebox", async () => {
    let homeboxRequests = 0;
    const { client } = await connectClient(() => { homeboxRequests += 1; });

    const invalidCalls = [
      client.callTool({
        name: "homebox_create_item",
        arguments: { token: "Bearer test-token", body: { name: "Drill", purchasePrice: 12.34 } },
      }),
      client.callTool({
        name: "homebox_patch_item",
        arguments: { token: "Bearer test-token", itemId: "entity-1", patch: { notes: "not allowed" } },
      }),
      client.callTool({
        name: "homebox_patch_item",
        arguments: { token: "Bearer test-token", itemId: "entity-1", patch: {} },
      }),
      client.callTool({
        name: "homebox_patch_entity",
        arguments: { token: "Bearer test-token", entityId: "entity-1", patch: {} },
      }),
    ];

    for (const result of await Promise.all(invalidCalls)) expect(result.isError).toBe(true);
    expect(homeboxRequests).toBe(0);

    await client.close();
  });

  it("sanitizes filesystem and unknown errors", () => {
    const path = "C:\\private\\photos\\secret.jpg";
    const missing = Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT", path });

    const safeMissing = toSafeError(missing);
    expect(safeMissing).toEqual({
      kind: "validation",
      message: "Local file was not found. Check filePath and HOMEBOX_MCP_LOCAL_FILE_ROOT.",
    });
    expect(JSON.stringify(safeMissing)).not.toContain(path);
    expect(toSafeError(new Error(`unexpected failure at ${path}`))).toEqual({
      kind: "internal",
      message: "Unexpected internal error.",
    });
  });
});

type JsonSchema = {
  additionalProperties?: boolean;
  minimum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type ListedTool = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: { destructiveHint?: boolean };
};

function tool(tools: ListedTool[], name: string): ListedTool {
  const found = tools.find((entry) => entry.name === name);
  expect(found, `Missing tool ${name}`).toBeDefined();
  return found!;
}

function nestedObjectSchema(schema: JsonSchema, property: string): JsonSchema {
  const nested = schema.properties?.[property];
  expect(nested, `Missing schema property ${property}`).toBeDefined();
  return nested!;
}

async function connectClient(onHomeboxRequest?: () => void): Promise<{ client: Client }> {
  mock = await startMockHomebox((req, res) => {
    onHomeboxRequest?.();
    json(res, 500, { error: `Unexpected Homebox request: ${req.method} ${req.path}` });
  });
  started = await startServer(testConfig(mock.url, "mcp-secret"));

  const client = new Client({ name: "homebox-tool-contract-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(started.url), {
    requestInit: { headers: { Authorization: "Bearer mcp-secret" } },
  });
  await client.connect(transport);
  return { client };
}

function testConfig(homeboxBaseUrl: string, apiToken: string): AppConfig {
  return {
    homeboxBaseUrl,
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    apiToken,
    timeoutMs: 5_000,
    maxUploadBytes: 1024 * 1024,
    maxDownloadBytes: 1024 * 1024,
  };
}
