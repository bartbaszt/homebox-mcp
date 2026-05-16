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
