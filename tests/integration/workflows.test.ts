import { afterEach, describe, expect, it } from "vitest";

import { HomeboxClient, publicHttpUrl } from "../../src/homebox-client.js";
import { createItemFull, findOrCreateLocation, replacePrimaryPhoto, resolveTags, upsertItemsBulk } from "../../src/workflows.js";
import { json, startMockHomebox, type MockHomeboxServer } from "../support/mock-homebox.js";

let mock: MockHomeboxServer | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("Homebox workflows", () => {
  it("resolves existing tags and creates missing tags", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/tags") return json(res, 200, [{ id: "tag-lower", name: "tool" }, { id: "tag-1", name: "Tool" }]);
      if (req.method === "POST" && req.path === "/api/v1/tags") {
        expect(req.body).toEqual({ name: "Kitchen" });
        return json(res, 201, { id: "tag-2", name: "Kitchen" });
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const result = await resolveTags(client, "token", { labels: ["Tool", "Kitchen", "tool"], createMissing: true });

    expect(result.requested).toEqual(["Tool", "Kitchen"]);
    expect(result.resolved.map((tag) => tag.id)).toEqual(["tag-1", "tag-2"]);
    expect(result.unresolved).toEqual([]);
  });

  it("finds existing location path segments and creates missing location entities", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.query.get("isLocation")).toBe("true");
        return json(res, 200, [{ id: "loc-garage", name: "Garage", parentId: undefined }]);
      }
      if (req.method === "POST" && req.path === "/api/v1/entities") {
        expect(req.body).toMatchObject({ name: "Shelf", isLocation: true, parentId: "loc-garage" });
        return json(res, 201, { id: "loc-shelf", name: "Shelf", parentId: "loc-garage" });
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const result = await findOrCreateLocation(client, "token", { locationName: "Garage/Shelf", createMissing: true });

    expect(result.locationId).toBe("loc-shelf");
    expect(result.created).toBe(true);
    expect(result.path).toEqual(["Garage", "Shelf"]);
  });

  it("creates full entities with resolved tags, location and external ref fields", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/tags") return json(res, 200, [{ id: "tag-1", name: "Tool" }]);
      if (req.method === "GET" && req.path === "/api/v1/entities") {
        expect(req.query.get("isLocation")).toBe("true");
        return json(res, 200, [{ id: "loc-1", name: "Garage" }]);
      }
      if (req.method === "POST" && req.path === "/api/v1/entities") {
        expect(req.body).toMatchObject({
          name: "Drill",
          description: "Cordless",
          quantity: 2,
          parentId: "loc-1",
          tagIds: ["tag-1"],
        });
        const body = req.body as Record<string, unknown>;
        expect(body.purchaseTime).toBeUndefined();
        expect(body.purchaseDate).toBeUndefined();
        expect(body.fields).toBeUndefined();
        return json(res, 201, { id: "entity-1", name: "Drill" });
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") {
        return json(res, 200, { id: "entity-1", name: "Drill", parent: { id: "loc-1", name: "Garage" }, tags: [{ id: "tag-1", name: "Tool" }], fields: [] });
      }
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1") {
        expect(req.body).toMatchObject({
          name: "Drill",
          purchaseDate: "2026-05-17",
          purchaseFrom: "AliExpress",
          manufacturer: "Acme",
          modelNumber: "D-42",
          notes: "Imported order",
          parentId: "loc-1",
          tagIds: ["tag-1"],
        });
        expect(req.body).not.toHaveProperty("purchaseTime");
        const body = req.body as { fields?: Array<{ type: string; name: string; textValue: string }> };
        expect(body.fields).toEqual([
          { type: "text", name: "External Asset ID", textValue: "asset-1" },
          { type: "text", name: "Order ID", textValue: "order-1" },
          { type: "text", name: "Source URL", textValue: "https://example.com/order/1" },
        ]);
        return json(res, 200, req.body);
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const result = await createItemFull(client, "token", {
      name: "Drill",
      description: "Cordless",
      quantity: 2,
      purchaseTime: "2026-05-17",
      purchaseFrom: "AliExpress",
      manufacturer: "Acme",
      modelNumber: "D-42",
      notes: "Imported order",
      locationName: "Garage",
      labels: ["Tool"],
      externalAssetId: "asset-1",
      orderId: "order-1",
      sourceUrls: ["https://example.com/order/1"],
    });

    expect(result.itemId).toBe("entity-1");
    expect(result.tags.resolved).toHaveLength(1);
    expect(result.location?.locationId).toBe("loc-1");
  });

  it("bulk-upserts by external asset id using safe GET-merge-PUT", async () => {
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/entities" && req.query.get("q") === "asset-1") {
        return json(res, 200, { items: [{ id: "entity-1", name: "Old", fields: [{ name: "External Asset ID", textValue: "asset-1" }] }] });
      }
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") {
        return json(res, 200, { id: "entity-1", name: "Old", fields: [{ name: "External Asset ID", textValue: "asset-1" }], parent: { id: "loc-1" }, tags: [{ id: "tag-1" }] });
      }
      if (req.method === "PUT" && req.path === "/api/v1/entities/entity-1") {
        expect(req.body).toMatchObject({ id: "entity-1", name: "New", description: "Updated", parentId: "loc-1" });
        return json(res, 200, req.body);
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const result = await upsertItemsBulk(client, "token", { items: [{ name: "New", description: "Updated", externalAssetId: "asset-1" }] });

    expect(result.errors).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.created).toEqual([]);
  });

  it("replaces primary photo without local file paths", async () => {
    const base64 = Buffer.from("image-bytes", "utf8").toString("base64");
    mock = await startMockHomebox((req, res) => {
      if (req.method === "GET" && req.path === "/api/v1/entities/entity-1") {
        return json(res, 200, { id: "entity-1", attachments: [{ id: "att-old", primary: true }] });
      }
      if (req.method === "POST" && req.path === "/api/v1/entities/entity-1/attachments") {
        expect(req.bodyText).toContain('name="file"');
        expect(req.bodyText).toContain('name="primary"');
        return json(res, 201, { id: "att-new", primary: true });
      }
      if (req.method === "DELETE" && req.path === "/api/v1/entities/entity-1/attachments/att-old") {
        res.statusCode = 204;
        res.end();
        return;
      }
      json(res, 404, { error: `${req.method} ${req.path}` });
    });

    const client = new HomeboxClient(mock.url, 5_000, 1024, 1024);
    const result = await replacePrimaryPhoto(client, "token", { itemId: "entity-1", fileName: "photo.jpg", base64, contentType: "image/jpeg", deletePreviousPrimary: true });

    expect(result.previousPrimaryAttachmentIds).toEqual(["att-old"]);
    expect(result.deletedPreviousPrimaryIds).toEqual(["att-old"]);
    expect(result.source).toBe("base64");
  });

  it("rejects non-public URL targets for photo uploads", () => {
    expect(() => publicHttpUrl("http://127.0.0.1/photo.jpg")).toThrow(/private|loopback/);
    expect(() => publicHttpUrl("file:///tmp/photo.jpg")).toThrow(/http or https/);
  });
});