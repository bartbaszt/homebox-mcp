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
- Homebox-side logout via `POST /users/logout`.
- Currency endpoint direct client/tool coverage.
- v0.26 `/entities`, entity attachments, maintenance, entity types and templates direct endpoint mapping.
- v0.26 group CRUD, invitations, members, statistics, group ZIP export/import, bill of materials, actions, API keys, user self/settings/password, asset by asset ID, barcode lookup and QR code endpoints.
- Location listing via `/entities?isLocation=true` and `createLocation` injecting `isLocation:true`.
- Tag CRUD (`/tags/{id}`).
- Full entity update via GET-merge-PUT preserving custom fields and tags, converting `parent` to `parentId`.
- `setPrimaryAttachment` routes to `PUT /entities/{id}/attachments/{att}` with `{primary:true}`.
- Workflow helpers for tag resolution, location creation, full entity creation, bulk upsert, primary photo replacement and public URL validation.
- Workflow payload mapping accepts `purchaseTime` as an alias and emits Homebox `purchaseDate`; direct `purchaseDate` is also accepted.
- MCP endpoint API-token enforcement.
- Fail-closed startup for non-local listeners without MCP auth and rejection of placeholder API tokens.
- ChatGPT-style OAuth DCR + PKCE connection flow.
- OAuth-authenticated tool calls without `homebox_login` or `sessionKey`.
- Rejection of tool-level `sessionKey` override on OAuth-authenticated MCP connections.
- OAuth client/token persistence across server restarts when `HOMEBOX_MCP_DATA_DIR` is configured.
- Atomic refresh token consumption to prevent refresh token replay.
- Tool calls through Streamable HTTP client.
- Tool-contract discovery checks for strict v0.26 create/patch schemas and destructive annotations.
- Runtime rejection of unsupported create fields, unsupported PATCH fields and empty PATCH mutations before any Homebox request.
- Safe filesystem/internal error mapping without absolute-path or arbitrary error-message leakage.
- Local photo root containment, size bounds, and JPEG/PNG/WebP magic-byte validation for file/base64 sources.
- SSRF rejection for private redirects, IPv4-mapped/NAT64/6to4/reserved IPv6 ranges, and canonical generic API paths.
- OAuth body limits, client/token quotas, grant-unique SSE principals, persisted legacy-principal migration, and startup/listen failures.

## Real E2E

Run against a Homebox v0.26.x test instance:

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
- Reads status, collections/groups, items (via `/entities`), item detail, locations, tags, custom fields, custom field values for one existing field.
- Reads maintenance log (default `status=both`), notifiers list, entity templates list.
- Verifies v0.26 endpoints: `homebox_list_entities`, `homebox_list_entity_field_names`, `homebox_list_currencies`, `homebox_list_entity_types` and `homebox_list_group_statistics` succeed.
- Verifies generic `homebox_api_request`.
- Verifies bad session handling.

No destructive E2E suite is currently shipped. `HOMEBOX_E2E_DESTRUCTIVE` remains reserved for a future disposable-instance suite with mandatory cleanup.
