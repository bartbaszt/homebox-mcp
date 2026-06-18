import { afterEach, describe, expect, it } from "vitest";

import { authHeader, HomeboxClient, mergeEntityForPut } from "../../src/homebox-client.js";
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

  it("logs out the current token on the Homebox server", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "POST" && req.path === "/api/v1/users/logout") {
        expect(req.headers.authorization).toBe("Bearer token");
        res.statusCode = 204;
        res.end();
        return;
      }
      json(res, 404, { error: "not found" });
    });
    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    await expect(client.logout("token")).resolves.toEqual(undefined);
  });

  it("lists currencies from the documented currency endpoint", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/currencies") {
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
          expect(req.query.get("isLocation")).toBe("true");
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
      if (req.method === "GET" && req.path === "/api/v1/tags/tag-1") return json(res, 200, { id: "tag-1", name: "Tool" });
      if (req.method === "PUT" && req.path === "/api/v1/tags/tag-1") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/tags/tag-1") {
        res.statusCode = 204;
        res.end();
        return;
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const csvBase64 = Buffer.from("id,name\nentity-1,Drill\n", "utf8").toString("base64");
    const fileBase64 = Buffer.from("file-bytes", "utf8").toString("base64");

    await expect(client.listEntities("token", { q: "drill", page: 2, tags: ["tag-1"], isLocation: true })).resolves.toMatchObject({ total: 1 });
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
    await expect(client.getTag("token", "tag-1")).resolves.toMatchObject({ id: "tag-1" });
    await expect(client.updateTag("token", "tag-1", { name: "Tools" })).resolves.toMatchObject({ name: "Tools" });
    await expect(client.deleteTag("token", "tag-1")).resolves.toEqual(undefined);
    await expect(client.deleteEntity("token", "entity-1")).resolves.toEqual(undefined);
  });

  it("routes listLocations to /api/v1/entities?isLocation=true and createLocation injects isLocation", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.query.get("isLocation")).toBe("true");
        return json(res, 200, [{ id: "loc-1", name: "Garage" }]);
      }
      if (req.method === "POST" && req.path === "/api/v1/entities") {
        expect(req.body).toMatchObject({ name: "Shelf", isLocation: true, parentId: "loc-1" });
        return json(res, 201, { id: "loc-shelf", name: "Shelf" });
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    await expect(client.listLocations("token")).resolves.toEqual([{ id: "loc-1", name: "Garage" }]);
    await expect(client.createLocation("token", { name: "Shelf", parentId: "loc-1" })).resolves.toMatchObject({ id: "loc-shelf" });
  });

  it("calls v0.26 group, statistics, actions, reporting, barcode and user endpoints", async () => {
    mock = await startMockHomebox((req, res) => {
      expect(req.headers.authorization).toBe("Bearer token");
      if (req.method === "GET" && req.path === "/api/v1/groups") return json(res, 200, { id: "group-1", name: "Home" });
      if (req.method === "PUT" && req.path === "/api/v1/groups") return json(res, 200, req.body);
      if (req.method === "POST" && req.path === "/api/v1/groups") return json(res, 201, { id: "group-2" });
      if (req.method === "DELETE" && req.path === "/api/v1/groups") { res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && req.path === "/api/v1/groups/invitations") return json(res, 200, [{ id: "inv-1" }]);
      if (req.method === "POST" && req.path === "/api/v1/groups/invitations") return json(res, 201, { id: "inv-1" });
      if (req.method === "POST" && req.path === "/api/v1/groups/invitations/inv-1") return json(res, 200, { accepted: true });
      if (req.method === "DELETE" && req.path === "/api/v1/groups/invitations/inv-1") { res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && req.path === "/api/v1/groups/members") return json(res, 200, [{ id: "user-1" }]);
      if (req.method === "DELETE" && req.path === "/api/v1/groups/members/user-1") { res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && req.path === "/api/v1/groups/statistics") return json(res, 200, { totalItems: 5 });
      if (req.method === "GET" && req.path === "/api/v1/groups/statistics/locations") return json(res, 200, [{ id: "loc-1", count: 2 }]);
      if (req.method === "GET" && req.path === "/api/v1/groups/statistics/purchase-price") return json(res, 200, { total: 100 });
      if (req.method === "GET" && req.path === "/api/v1/groups/statistics/tags") return json(res, 200, [{ id: "tag-1", count: 3 }]);
      if (req.method === "GET" && req.path === "/api/v1/group/exports") return json(res, 200, [{ id: "exp-1" }]);
      if (req.method === "POST" && req.path === "/api/v1/group/exports") return json(res, 201, { id: "exp-1" });
      if (req.method === "GET" && req.path === "/api/v1/group/exports/exp-1") return json(res, 200, { id: "exp-1", status: "completed" });
      if (req.method === "DELETE" && req.path === "/api/v1/group/exports/exp-1") { res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && req.path === "/api/v1/group/exports/exp-1/download") {
        res.setHeader("content-type", "application/zip");
        res.end("zip-bytes");
        return;
      }
      if (req.method === "POST" && req.path === "/api/v1/group/import") {
        expect(req.bodyText).toContain('name="file"');
        res.statusCode = 204;
        return res.end();
      }
      if (req.method === "GET" && req.path === "/api/v1/reporting/bill-of-materials") {
        res.setHeader("content-type", "text/csv");
        return res.end("bom\n");
      }
      if (req.method === "POST" && req.path === "/api/v1/actions/create-missing-thumbnails") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.path === "/api/v1/actions/ensure-asset-ids") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.path === "/api/v1/actions/ensure-import-refs") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.path === "/api/v1/actions/set-primary-photos") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.path === "/api/v1/actions/wipe-inventory") return json(res, 200, { ok: true });
      if (req.method === "POST" && req.path === "/api/v1/actions/zero-item-time-fields") return json(res, 200, { ok: true });
      if (req.method === "GET" && req.path === "/api/v1/assets/asset-1") return json(res, 200, { id: "entity-1", assetId: "asset-1" });
      if (req.method === "GET" && req.path === "/api/v1/products/search-from-barcode") {
        expect(req.query.get("barcode")).toBe("5901234123457");
        return json(res, 200, { name: "Widget" });
      }
      if (req.method === "POST" && req.path === "/api/v1/qrcode") return json(res, 201, { id: "qr-1" });
      if (req.method === "GET" && req.path === "/api/v1/users/self") return json(res, 200, { id: "user-1", name: "Alice" });
      if (req.method === "PUT" && req.path === "/api/v1/users/self") return json(res, 200, req.body);
      if (req.method === "DELETE" && req.path === "/api/v1/users/self") { res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && req.path === "/api/v1/users/self/settings") return json(res, 200, { theme: "dark" });
      if (req.method === "PUT" && req.path === "/api/v1/users/self/settings") return json(res, 200, req.body);
      if (req.method === "PUT" && req.path === "/api/v1/users/change-password") return json(res, 200, { ok: true });
      if (req.method === "GET" && req.path === "/api/v1/users/self/api-keys") return json(res, 200, [{ id: "key-1" }]);
      if (req.method === "POST" && req.path === "/api/v1/users/self/api-keys") return json(res, 201, { id: "key-1", key: "hb_secret" });
      if (req.method === "DELETE" && req.path === "/api/v1/users/self/api-keys/key-1") { res.statusCode = 204; return res.end(); }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 4096);
    const zipBase64 = Buffer.from("zip-bytes", "utf8").toString("base64");

    await expect(client.getGroup("token")).resolves.toMatchObject({ id: "group-1" });
    await expect(client.updateGroup("token", { name: "Home 2" })).resolves.toMatchObject({ name: "Home 2" });
    await expect(client.createGroup("token", { name: "New" })).resolves.toMatchObject({ id: "group-2" });
    await expect(client.deleteGroup("token")).resolves.toEqual(undefined);
    await expect(client.listGroupInvitations("token")).resolves.toEqual([{ id: "inv-1" }]);
    await expect(client.createGroupInvitation("token", { email: "x@y.z" })).resolves.toMatchObject({ id: "inv-1" });
    await expect(client.acceptGroupInvitation("token", "inv-1")).resolves.toMatchObject({ accepted: true });
    await expect(client.deleteGroupInvitation("token", "inv-1")).resolves.toEqual(undefined);
    await expect(client.listGroupMembers("token")).resolves.toEqual([{ id: "user-1" }]);
    await expect(client.removeGroupMember("token", "user-1")).resolves.toEqual(undefined);
    await expect(client.listGroupStatistics("token")).resolves.toMatchObject({ totalItems: 5 });
    await expect(client.listLocationStatistics("token")).resolves.toEqual([{ id: "loc-1", count: 2 }]);
    await expect(client.listPurchasePriceStatistics("token")).resolves.toMatchObject({ total: 100 });
    await expect(client.listTagStatistics("token")).resolves.toEqual([{ id: "tag-1", count: 3 }]);
    await expect(client.listGroupExports("token")).resolves.toEqual([{ id: "exp-1" }]);
    await expect(client.startGroupExport("token")).resolves.toMatchObject({ id: "exp-1" });
    await expect(client.getGroupExport("token", "exp-1")).resolves.toMatchObject({ status: "completed" });
    await expect(client.deleteGroupExport("token", "exp-1")).resolves.toEqual(undefined);
    await expect(client.downloadGroupExportArtifact("token", "exp-1")).resolves.toMatchObject({ exportId: "exp-1", contentLength: 9 });
    await expect(client.importGroupZip({ token: "token", fileName: "export.zip", base64: zipBase64, contentType: "application/zip" })).resolves.toEqual(undefined);
    await expect(client.billOfMaterials("token")).resolves.toMatchObject({ text: "bom\n" });
    await expect(client.createMissingThumbnails("token")).resolves.toMatchObject({ ok: true });
    await expect(client.ensureAssetIds("token")).resolves.toMatchObject({ ok: true });
    await expect(client.ensureImportRefs("token")).resolves.toMatchObject({ ok: true });
    await expect(client.setPrimaryPhotos("token")).resolves.toMatchObject({ ok: true });
    await expect(client.wipeInventory("token")).resolves.toMatchObject({ ok: true });
    await expect(client.zeroItemTimeFields("token")).resolves.toMatchObject({ ok: true });
    await expect(client.getAssetByAssetId("token", "asset-1")).resolves.toMatchObject({ assetId: "asset-1" });
    await expect(client.searchFromBarcode("token", "5901234123457")).resolves.toMatchObject({ name: "Widget" });
    await expect(client.createQrCode("token", { entityId: "entity-1" })).resolves.toMatchObject({ id: "qr-1" });
    await expect(client.getUserSelf("token")).resolves.toMatchObject({ name: "Alice" });
    await expect(client.updateUserSelf("token", { name: "Alice 2" })).resolves.toMatchObject({ name: "Alice 2" });
    await expect(client.deleteUserSelf("token")).resolves.toEqual(undefined);
    await expect(client.getUserSettings("token")).resolves.toMatchObject({ theme: "dark" });
    await expect(client.updateUserSettings("token", { theme: "light" })).resolves.toMatchObject({ theme: "light" });
    await expect(client.changePassword("token", { currentPassword: "a", newPassword: "b" })).resolves.toMatchObject({ ok: true });
    await expect(client.listApiKeys("token")).resolves.toEqual([{ id: "key-1" }]);
    await expect(client.createApiKey("token", { name: "ci" })).resolves.toMatchObject({ id: "key-1" });
    await expect(client.deleteApiKey("token", "key-1")).resolves.toEqual(undefined);
  });

  it("merges full entity updates without losing fields, tags, or parentId", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") {
        json(res, 200, currentEntity());
        return;
      }
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1") {
        expect(req.headers.authorization).toBe("Bearer token");
        expect(req.body).toMatchObject({
          id: "entity-1",
          name: "Drill",
          description: "New description",
          parentId: "parent-1",
          tagIds: ["tag-1"],
        });
        const body = req.body as { fields: Array<{ name: string; textValue?: string }>; parent?: unknown; tags?: unknown; entityType?: unknown };
        expect(body.parent).toBeUndefined();
        expect(body.tags).toBeUndefined();
        expect(body.entityType).toBeUndefined();
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
    await client.updateItem("token", "entity-1", {
      description: "New description",
      fields: [{ name: "Replace", textValue: "new" }],
    });
  });

  it("setPrimaryAttachment routes to PUT /entities/{id}/attachments/{att} with {primary:true}", async () => {
    mock = await startMockHomebox((req, res) => {
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
    await expect(client.setPrimaryAttachment("token", "entity-1", "att-1")).resolves.toMatchObject({ primary: true });
  });

  it("rejects generic requests outside /api/v1", async () => {
    const client = new HomeboxClient("http://127.0.0.1", 5_000, 1024, 1024);
    await expect(client.apiRequest("GET", "https://evil.example/api/v1/items", { token: "x" })).rejects.toThrow("Path must be relative");
    await expect(client.apiRequest("GET", "/admin", { token: "x" })).rejects.toThrow("Path must start with /api/v1/");
  });

  it("pure merge helper preserves fields by name", () => {
    expect(
      mergeEntityForPut(currentEntity(), {
        fields: [{ name: "Replace", textValue: "new" }],
      }).fields,
    ).toEqual([
      { name: "Keep", textValue: "old" },
      { name: "Replace", textValue: "new" },
    ]);
  });
});

function currentEntity() {
  return {
    id: "entity-1",
    name: "Drill",
    description: "Old description",
    quantity: 1,
    insured: false,
    archived: false,
    parent: { id: "parent-1", name: "Garage" },
    tags: [{ id: "tag-1", name: "Tool" }],
    fields: [
      { name: "Keep", textValue: "old" },
      { name: "Replace", textValue: "old" },
    ],
    entityType: { id: "type-1" },
  };
}