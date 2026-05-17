import { afterEach, describe, expect, it } from "vitest";

import { authHeader, HomeboxClient, mergeItemForPut } from "../../src/homebox-client.js";
import { normalizeHomeboxUrl } from "../../src/config.js";
import { HomeboxMcpError } from "../../src/errors.js";
import { json, startMockHomebox, type MockHomeboxServer } from "../support/mock-homebox.js";

let mock: MockHomeboxServer | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("Homebox client", () => {
  it("normalizes Homebox URLs", () => {
    expect(normalizeHomeboxUrl("homebox.example.com/")).toBe("https://homebox.example.com");
    expect(normalizeHomeboxUrl("http://localhost:7745/")).toBe("http://localhost:7745");
    expect(() => normalizeHomeboxUrl("")).toThrow(HomeboxMcpError);
  });

  it("does not double-prefix bearer tokens", () => {
    expect(authHeader("abc")).toBe("Bearer abc");
    expect(authHeader("Bearer abc")).toBe("Bearer abc");
  });

  it("logs in and refreshes using the returned token format", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "POST" && req.path === "/api/v1/users/login") {
        expect(req.body).toEqual({ username: "user@example.com", password: "secret", stayLoggedIn: true });
        json(res, 200, { token: "Bearer issued-token", expiresAt: "2030-01-01T00:00:00Z" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/users/refresh") {
        expect(req.headers.authorization).toBe("Bearer issued-token");
        json(res, 200, { raw: "Bearer refreshed-token" });
        return;
      }
      json(res, 404, { error: "not found" });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const login = await client.login("user@example.com", "secret");
    const refresh = await client.refresh(login.token);

    expect(login.token).toBe("Bearer issued-token");
    expect(refresh.token).toBe("Bearer refreshed-token");
  });

  it("lists currencies from the documented currency endpoint", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/currency") {
        expect(req.headers.authorization).toBeUndefined();
        json(res, 200, [{ code: "USD", decimals: 2, local: "US dollar", name: "United States Dollar", symbol: "$" }]);
        return;
      }
      json(res, 404, { error: "not found" });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);

    await expect(client.listCurrencies()).resolves.toEqual([{ code: "USD", decimals: 2, local: "US dollar", name: "United States Dollar", symbol: "$" }]);
  });

  it("calls entity and related current API endpoints", async () => {
    mock = await startMockHomebox((req, res) => {
      expect(req.headers.authorization).toBe("Bearer token");
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        if (req.query.get("q") === "drill") {
          expect(req.query.get("page")).toBe("2");
          expect(req.query.get("tags")).toBe("tag-1");
        }
        json(res, 200, { total: 1, items: [{ id: "entity-1", name: "Drill" }] });
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/entities") {
        expect(req.body).toEqual({ name: "Drill", entityTypeId: "type-1" });
        json(res, 201, { id: "entity-1", name: "Drill" });
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/export") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/csv");
        res.end("id,name\nentity-1,Drill\n");
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/entities/import") {
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        expect(req.bodyText).toContain('name="csv"');
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/fields") return json(res, 200, ["Color"]);
      if (req.method === "GET" && req.path === "/api/v1/entities/fields/values") {
        expect(req.query.get("field")).toBe("Color");
        return json(res, 200, ["Red"]);
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/tree") {
        expect(req.query.get("withItems")).toBe("true");
        return json(res, 200, [{ id: "entity-1", name: "Drill", children: [] }]);
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") return json(res, 200, { id: "entity-1", attachments: [{ id: "att-1" }] });
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1") return json(res, 200, req.body);
      if (req.method === "PATCH" && req.path === "/api/v1/entities/entity-1") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/entities/entity-1") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/entities/entity-1/duplicate") return json(res, 201, { id: "entity-2" });
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1/path") return json(res, 200, [{ id: "entity-1", name: "Drill", type: "item" }]);
      if (req.method === "POST" && req.path === "/api/v1/entities/entity-1/attachments") {
        expect(req.bodyText).toContain('name="file"');
        expect(req.bodyText).toContain('name="primary"');
        return json(res, 201, { id: "att-1" });
      }
      if (req.method === "POST" && req.path === "/api/v1/entities/entity-1/attachments/external") return json(res, 201, { id: "att-external" });
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1/attachments/att-1") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end("file-bytes");
        return;
      }
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1/attachments/att-1") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/entities/entity-1/attachments/att-1") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1/maintenance") {
        expect(req.query.get("status")).toBe("completed");
        return json(res, 200, [{ id: "maint-1" }]);
      }
      if (req.method === "POST" && req.path === "/api/v1/entities/entity-1/maintenance") return json(res, 201, req.body);
      if (req.method === "GET" && req.path === "/api/v1/entity-types") return json(res, 200, [{ id: "type-1" }]);
      if (req.method === "POST" && req.path === "/api/v1/entity-types") return json(res, 201, req.body);
      if (req.method === "PUT" && req.path === "/api/v1/entity-types/type-1") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/entity-types/type-1") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "GET" && req.path === "/api/v1/templates") return json(res, 200, [{ id: "template-1" }]);
      if (req.method === "POST" && req.path === "/api/v1/templates") return json(res, 201, req.body);
      if (req.method === "GET" && req.path === "/api/v1/templates/template-1") return json(res, 200, { id: "template-1" });
      if (req.method === "PUT" && req.path === "/api/v1/templates/template-1") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/templates/template-1") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/templates/template-1/create-item") return json(res, 201, { id: "entity-from-template" });
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const csvBase64 = Buffer.from("id,name\nentity-1,Drill\n", "utf8").toString("base64");
    const fileBase64 = Buffer.from("file-bytes", "utf8").toString("base64");

    await expect(client.listEntities("token", { q: "drill", page: 2, tags: ["tag-1"] })).resolves.toMatchObject({ total: 1 });
    await expect(client.createEntity("token", { name: "Drill", entityTypeId: "type-1" })).resolves.toMatchObject({ id: "entity-1" });
    await expect(client.exportEntities("token")).resolves.toMatchObject({ contentType: "text/csv", text: "id,name\nentity-1,Drill\n" });
    await expect(client.importEntities({ token: "token", fileName: "entities.csv", base64: csvBase64, contentType: "text/csv" })).resolves.toEqual(undefined);
    await expect(client.listEntityFieldNames("token")).resolves.toEqual(["Color"]);
    await expect(client.listEntityFieldValues("token", "Color")).resolves.toEqual(["Red"]);
    await expect(client.listEntitiesTree("token", true)).resolves.toHaveLength(1);
    await expect(client.getEntity("token", "entity-1")).resolves.toMatchObject({ id: "entity-1" });
    await expect(client.listEntityAttachments("token", "entity-1")).resolves.toEqual([{ id: "att-1" }]);
    await expect(client.putEntity("token", "entity-1", { name: "Drill" })).resolves.toMatchObject({ name: "Drill" });
    await expect(client.patchEntity("token", "entity-1", { quantity: 2 })).resolves.toMatchObject({ quantity: 2 });
    await expect(client.duplicateEntity("token", "entity-1", { copyAttachments: true })).resolves.toMatchObject({ id: "entity-2" });
    await expect(client.getEntityPath("token", "entity-1")).resolves.toEqual([{ id: "entity-1", name: "Drill", type: "item" }]);
    await expect(client.uploadEntityAttachment({ token: "token", entityId: "entity-1", fileName: "manual.txt", base64: fileBase64, primary: true })).resolves.toMatchObject({ id: "att-1" });
    await expect(client.createExternalEntityAttachment("token", "entity-1", { title: "Manual", external_id: "doc-1" })).resolves.toMatchObject({ id: "att-external" });
    await expect(client.downloadEntityAttachment("token", "entity-1", "att-1")).resolves.toMatchObject({ entityId: "entity-1", attachmentId: "att-1", base64: fileBase64 });
    await expect(client.updateEntityAttachment("token", "entity-1", "att-1", { primary: true })).resolves.toMatchObject({ primary: true });
    await expect(client.deleteEntityAttachment("token", "entity-1", "att-1")).resolves.toEqual(undefined);
    await expect(client.listEntityMaintenance("token", "entity-1", "completed")).resolves.toEqual([{ id: "maint-1" }]);
    await expect(client.createEntityMaintenance("token", "entity-1", { name: "Clean" })).resolves.toMatchObject({ name: "Clean" });
    await expect(client.listEntityTypes("token")).resolves.toEqual([{ id: "type-1" }]);
    await expect(client.createEntityType("token", { name: "Tool" })).resolves.toMatchObject({ name: "Tool" });
    await expect(client.updateEntityType("token", "type-1", { name: "Tool" })).resolves.toMatchObject({ name: "Tool" });
    await expect(client.deleteEntityType("token", "type-1")).resolves.toEqual(undefined);
    await expect(client.listEntityTemplates("token")).resolves.toEqual([{ id: "template-1" }]);
    await expect(client.createEntityTemplate("token", { name: "Default" })).resolves.toMatchObject({ name: "Default" });
    await expect(client.getEntityTemplate("token", "template-1")).resolves.toMatchObject({ id: "template-1" });
    await expect(client.updateEntityTemplate("token", "template-1", { name: "Default" })).resolves.toMatchObject({ name: "Default" });
    await expect(client.deleteEntityTemplate("token", "template-1")).resolves.toEqual(undefined);
    await expect(client.createEntityFromTemplate("token", "template-1", { name: "From template" })).resolves.toMatchObject({ id: "entity-from-template" });
    await expect(client.deleteEntity("token", "entity-1")).resolves.toEqual(undefined);
  });

  it("merges full item updates without losing fields, tags, or locationId", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/items/item-1") {
        json(res, 200, currentItem());
        return;
      }
      if (req.method === "PUT" && req.path === "/api/v1/items/item-1") {
        expect(req.headers.authorization).toBe("Bearer token");
        expect(req.body).toMatchObject({
          id: "item-1",
          name: "Drill",
          description: "New description",
          locationId: "loc-1",
          tagIds: ["tag-1"],
        });
        const body = req.body as { fields: Array<{ name: string; textValue?: string }>; location?: unknown; tags?: unknown };
        expect(body.location).toBeUndefined();
        expect(body.tags).toBeUndefined();
        expect(body.fields).toEqual([
          { name: "Keep", textValue: "old" },
          { name: "Replace", textValue: "new" },
        ]);
        json(res, 200, req.body);
        return;
      }
      json(res, 404, { error: "not found" });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    await client.updateItem("token", "item-1", {
      description: "New description",
      fields: [{ name: "Replace", textValue: "new" }],
    });
  });

  it("detects entities surface and routes legacy method names to /entities", async () => {
    const seenPaths: string[] = [];
    mock = await startMockHomebox((req, res) => {
      seenPaths.push(`${req.method} ${req.path}`);
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        return json(res, 200, { total: 0, items: [] });
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") {
        return json(res, 200, { id: "entity-1", attachments: [{ id: "att-1" }] });
      }
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1/attachments/att-1") {
        expect(req.body).toMatchObject({ primary: true });
        return json(res, 200, req.body);
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    await expect(client.getApiSurface("token")).resolves.toBe("entities");
    expect(client.currentApiSurface()).toBe("entities");

    await expect(client.listItems("token", { pageSize: 1 })).resolves.toMatchObject({ items: [] });
    await expect(client.getItem("token", "entity-1")).resolves.toMatchObject({ id: "entity-1" });
    await expect(client.setPrimaryAttachment("token", "entity-1", "att-1")).resolves.toMatchObject({ primary: true });

    expect(seenPaths.filter((p) => p.startsWith("GET /api/v1/items")).length).toBe(0);
    expect(seenPaths).toContain("GET /api/v1/entities");
    expect(seenPaths).toContain("GET /api/v1/entities/entity-1");
    expect(seenPaths).toContain("PUT /api/v1/entities/entity-1/attachments/att-1");
  });

  it("detects items surface and routes new method names to /items", async () => {
    const seenPaths: string[] = [];
    mock = await startMockHomebox((req, res) => {
      seenPaths.push(`${req.method} ${req.path}`);
      if (req.path.startsWith("/api/v1/entities") || req.path.startsWith("/api/v1/entity-types")) {
        return json(res, 404, { error: "not found", kind: "not_found" });
      }
      if (req.method === "GET" && req.path === "/api/v1/items") {
        expect(req.query.get("locations")).toBe("loc-1");
        return json(res, 200, { total: 0, items: [] });
      }
      if (req.method === "POST" && req.path === "/api/v1/items") {
        expect(req.body).toMatchObject({ name: "Drill", locationId: "loc-1" });
        const body = req.body as Record<string, unknown>;
        expect(body.parentId).toBeUndefined();
        expect(body.entityTypeId).toBeUndefined();
        return json(res, 201, { id: "item-1", name: "Drill" });
      }
      if (req.method === "PATCH" && req.path === "/api/v1/items/item-1") {
        expect(req.body).toMatchObject({ locationId: "loc-2" });
        return json(res, 200, req.body);
      }
      if (req.method === "GET" && req.path === "/api/v1/locations") return json(res, 200, [{ id: "loc-1" }]);
      if (req.method === "GET" && req.path === "/api/v1/items/fields") return json(res, 200, ["Color"]);
      if (req.method === "GET" && req.path === "/api/v1/items/item-1/maintenance") {
        expect(req.query.get("status")).toBe("both");
        return json(res, 200, []);
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    await expect(client.getApiSurface("token")).resolves.toBe("items");

    await expect(client.listEntities("token", { parentIds: ["loc-1"] })).resolves.toMatchObject({ total: 0 });
    await expect(client.createEntity("token", { name: "Drill", parentId: "loc-1", entityTypeId: "type-1" })).resolves.toMatchObject({ id: "item-1" });
    await expect(client.patchEntity("token", "item-1", { parentId: "loc-2" })).resolves.toMatchObject({ locationId: "loc-2" });
    await expect(client.listLocations("token")).resolves.toEqual([{ id: "loc-1" }]);
    await expect(client.listEntityFieldNames("token")).resolves.toEqual(["Color"]);
    await expect(client.listEntityMaintenance("token", "item-1", "both")).resolves.toEqual([]);

    expect(seenPaths.filter((p) => p.startsWith("GET /api/v1/entities") && !p.includes("?")).length).toBeGreaterThan(0);
    expect(seenPaths.filter((p) => p.startsWith("GET /api/v1/items") || p.includes("/api/v1/items/")).length).toBeGreaterThan(0);
  });

  it("rejects generic requests outside /api/v1", async () => {
    const client = new HomeboxClient("http://127.0.0.1", 5_000, 1024, 1024);
    await expect(client.apiRequest("GET", "https://evil.example/api/v1/items", { token: "x" })).rejects.toThrow("Path must be relative");
    await expect(client.apiRequest("GET", "/admin", { token: "x" })).rejects.toThrow("Path must start with /api/v1/");
  });

  it("pure merge helper preserves fields by name", () => {
    expect(
      mergeItemForPut(currentItem(), {
        fields: [{ name: "Replace", textValue: "new" }],
      }).fields,
    ).toEqual([
      { name: "Keep", textValue: "old" },
      { name: "Replace", textValue: "new" },
    ]);
  });
});

function currentItem() {
  return {
    id: "item-1",
    name: "Drill",
    description: "Old description",
    quantity: 1,
    insured: false,
    archived: false,
    location: { id: "loc-1", name: "Garage" },
    tags: [{ id: "tag-1", name: "Tool" }],
    fields: [
      { name: "Keep", textValue: "old" },
      { name: "Replace", textValue: "old" },
    ],
    parent: { id: "parent-1" },
    entityType: { id: "type-1" },
  };
}
