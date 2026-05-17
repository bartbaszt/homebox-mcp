# Testing

## Mocked Integration Tests

Run:

```powershell
npm test
```

Coverage:

- URL normalization.
- Login and session registration.
- Token refresh with no double `Bearer` prefix.
- Currency endpoint direct client/tool coverage.
- Current `/entities`, entity attachments, maintenance, entity types and templates direct endpoint mapping.
- Item listing and detail calls.
- Full item update via GET-merge-PUT preserving custom fields and tags.
- Workflow helpers for tag resolution, location creation, full item creation, bulk upsert, primary photo replacement and public URL validation.
- Workflow payload mapping uses `purchaseTime` for purchase date and rejects `purchaseDate` in generated payloads.
- MCP endpoint API-token enforcement.
- Fail-closed startup for non-local listeners without MCP auth and rejection of placeholder API tokens.
- ChatGPT-style OAuth DCR + PKCE connection flow.
- OAuth-authenticated tool calls without `homebox_login` or `sessionKey`.
- Rejection of tool-level `sessionKey` override on OAuth-authenticated MCP connections.
- OAuth client/token persistence across server restarts when `HOMEBOX_MCP_DATA_DIR` is configured.
- Atomic refresh token consumption to prevent refresh token replay.
- Tool calls through Streamable HTTP client.
- Auto-detection of API surface and routing: legacy method names hitting `/entities` when the new API is available, new method names hitting `/items` (with parameter/body translation) when only the legacy API is available.

## Real E2E

Run against HomeboxAiHelper test instance:

```powershell
$env:HOMEBOX_E2E = "1"
$env:HOMEBOX_TEST_ACCESS_FILE = "C:\__program\HomeboxAiHelper\.test-access"
npm run test:e2e
```

The default E2E is read-only:

- Starts Homebox MCP HTTP server on an ephemeral local port.
- Connects through MCP Streamable HTTP.
- Verifies MCP endpoint auth failure without token.
- Logs into Homebox with credentials from `.test-access`.
- Refreshes token.
- Reads status, collections/groups, items, item detail, locations, tags, custom fields, custom field values for one existing field.
- Reads maintenance log (default `status=both`), notifiers list, entity templates list.
- Verifies `homebox_api_surface` reports `items` on v0.25.0 and that entity-named tools (`homebox_list_entities`, `homebox_list_entity_field_names`) succeed via auto-routing to `/items` endpoints.
- Asserts endpoints that have no legacy fallback (`homebox_list_currencies`, `homebox_list_entity_types`) return `kind: not_found, status: 404` on legacy Homebox.
- Verifies generic `homebox_api_request`.
- Verifies bad session handling.

Destructive E2E is intentionally off by default. Enable only on disposable instances:

```powershell
$env:HOMEBOX_E2E_DESTRUCTIVE = "1"
npm run test:e2e
```
