# Homebox MCP

Unofficial third-party MCP server for Homebox. It is not affiliated with or endorsed by Homebox.

The server exposes one configured Homebox instance to external agents over MCP Streamable HTTP. It supports many Homebox users through ChatGPT-compatible OAuth connections or in-memory `sessionKey` sessions, and exposes Homebox groups as collections.

## Features

- Remote MCP endpoint over HTTP or direct HTTPS.
- MCP endpoint bearer-token guard or OAuth 2.1 authorization-code + PKCE for external access.
- ChatGPT Apps/Connectors OAuth flow with DCR, protected resource metadata and bearer tokens stored by the MCP client.
- Homebox username/password login tool; password is never stored.
- Multiple concurrent users via in-memory session keys.
- Named tools for status, auth, collections, items, attachments, locations, tags, custom fields and higher-level item workflows.
- Generic `homebox_api_request` for version-specific `/api/v1/...` endpoints.
- Safe item update helper that GET-merge-PUTs full payloads to avoid Homebox v0.25.0 partial PUT failures.
- Auto-detection of Homebox API surface (`items` vs `entities`); single tool set works on both legacy v0.25.0 and the upcoming Entity Merge API.

## Setup

```powershell
npm install
Copy-Item .env.example .env
# edit .env
npm run build
npm start
```

Required env:

```powershell
$env:HOMEBOX_BASE_URL = "https://homebox.example.com"
$env:HOMEBOX_MCP_API_TOKEN = "long-random-token" # or enable OAuth below
```

Default endpoint:

```text
http://0.0.0.0:3000/mcp
```

External agents should connect to the public address and send:

```text
Authorization: Bearer <HOMEBOX_MCP_API_TOKEN>
```

## Docker Compose Deployment

Pre-built images are published to GitHub Container Registry via CI. On the target host:

```bash
mkdir -p /srv/homebox-mcp && cd /srv/homebox-mcp
# create compose.yml and .env (see docs/DEPLOYMENT.md for templates)
docker login ghcr.io -u <github-user> --password-stdin <<< "<pat-with-read:packages>"
docker compose pull
docker compose up -d
docker compose logs -f homebox-mcp
```

Healthcheck:

```bash
curl http://127.0.0.1:3000/health
```

Full runbook including ChatGPT setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## ChatGPT Setup

In ChatGPT → Settings → Connectors (or MCP Apps):

| Field | Value |
|---|---|
| **Name** | Homebox |
| **URL** | `https://mcp.example.com/mcp` |
| **Auth** | OAuth (auto-discovered via `/.well-known/oauth-protected-resource`) |

On first connection, ChatGPT opens a login form where you enter Homebox credentials once. The password is discarded; ChatGPT stores the OAuth token pair in connector settings. Subsequent tool calls work without `sessionKey`.

## ChatGPT OAuth

For ChatGPT Apps/Connectors, enable OAuth instead of asking the model to call `homebox_login`:

```powershell
$env:HOMEBOX_MCP_OAUTH_ENABLED = "true"
$env:HOMEBOX_MCP_PUBLIC_URL = "https://mcp.example.com/mcp"
$env:HOMEBOX_MCP_TRUST_PROXY = "true" # when behind reverse proxy/tunnel
npm start
```

Production OAuth requires HTTPS. Set `HOMEBOX_MCP_PUBLIC_URL` to the exact public `/mcp` URL so ChatGPT sends the same `resource` value during authorization and token exchange. Use `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true` only for local tests.

The MCP server then exposes:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register` for dynamic client registration.
- `GET/POST /oauth/authorize` with a Homebox login form.
- `POST /oauth/token` for authorization-code and refresh-token grants.

Optional OAuth env:

- `HOMEBOX_MCP_OAUTH_ISSUER`: external issuer origin if different from `HOMEBOX_MCP_PUBLIC_URL` origin.
- `HOMEBOX_MCP_OAUTH_AUTH_CODE_TTL_SECONDS`: authorization code lifetime, default `300`.
- `HOMEBOX_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`: access token lifetime, default `3600`.
- `HOMEBOX_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS`: refresh token lifetime, default `2592000`.
- `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP`: local/test escape hatch; do not use in production.

ChatGPT connects to the public `/mcp` URL. On first auth, the browser form logs into Homebox once, the password is discarded, and ChatGPT stores the OAuth token pair in connector settings. Tool calls can then omit `sessionKey` and raw Homebox tokens.

OAuth tokens and mapped Homebox sessions are in-memory. Restarting this server invalidates existing connector tokens and requires reconnecting.

## HTTPS

Preferred production setup: run this service on internal HTTP and terminate TLS in a reverse proxy.

Direct Node HTTPS is also supported:

```powershell
$env:HOMEBOX_MCP_TLS_KEY = "C:\certs\homebox-mcp.key"
$env:HOMEBOX_MCP_TLS_CERT = "C:\certs\homebox-mcp.crt"
npm start
```

## Basic Agent Flow

With OAuth-enabled ChatGPT connectors:

1. Connect the ChatGPT app to the public `/mcp` URL.
2. Complete the OAuth login form with Homebox credentials.
3. Call tools directly; `sessionKey` is not required.

With static MCP auth or local agents:

1. Call `homebox_status` to verify target instance.
2. Call `homebox_login` with Homebox username/password.
3. Store returned `sessionKey` in the agent conversation/session.
4. Pass `sessionKey` to tools like `homebox_list_items`, `homebox_get_item`, `homebox_update_item`.
5. Call `homebox_logout` when done.

## Tools

- Auth: `homebox_login`, `homebox_register_token`, `homebox_refresh_session`, `homebox_logout`, `homebox_list_sessions`.
- Instance: `homebox_status`, `homebox_list_currencies`, `homebox_api_request`.
- Collections: `homebox_list_collections`.
- Items: `homebox_list_items`, `homebox_get_item`, `homebox_create_item`, `homebox_update_item`, `homebox_put_item`, `homebox_patch_item`, `homebox_delete_item`.
- Entities: `homebox_list_entities`, `homebox_create_entity`, `homebox_export_entities`, `homebox_import_entities`, `homebox_get_entity`, `homebox_put_entity`, `homebox_patch_entity`, `homebox_delete_entity`, `homebox_duplicate_entity`, `homebox_get_entity_path`, `homebox_list_entities_tree`, `homebox_list_entity_field_names`, `homebox_list_entity_field_values`.
- Entity attachments/maintenance: `homebox_list_entity_attachments`, `homebox_upload_entity_attachment`, `homebox_create_external_entity_attachment`, `homebox_download_entity_attachment`, `homebox_update_entity_attachment`, `homebox_delete_entity_attachment`, `homebox_list_entity_maintenance`, `homebox_create_entity_maintenance`.
- Entity types/templates: `homebox_list_entity_types`, `homebox_create_entity_type`, `homebox_update_entity_type`, `homebox_delete_entity_type`, `homebox_list_entity_templates`, `homebox_create_entity_template`, `homebox_get_entity_template`, `homebox_update_entity_template`, `homebox_delete_entity_template`, `homebox_create_entity_from_template`.
- Maintenance log: `homebox_list_maintenance` (defaults to `status=both`), `homebox_update_maintenance_entry`, `homebox_delete_maintenance_entry`.
- Notifiers: `homebox_list_notifiers`, `homebox_create_notifier`, `homebox_test_notifier`, `homebox_update_notifier`, `homebox_delete_notifier`.
- Attachments: `homebox_list_attachments`, `homebox_download_attachment`, `homebox_upload_attachment`, `homebox_delete_attachment`, `homebox_set_primary_attachment`.
- Locations/tags/fields: `homebox_list_locations`, `homebox_create_location`, `homebox_update_location`, `homebox_delete_location`, `homebox_list_tags`, `homebox_list_custom_fields`, `homebox_list_custom_field_values` (requires `field`).
- Workflows: `homebox_resolve_tags`, `homebox_find_or_create_location`, `homebox_create_item_full`, `homebox_upload_primary_photo_from_file`, `homebox_replace_primary_photo`, `homebox_upsert_items_bulk`.
- Diagnostics: `homebox_api_surface` reports the detected Homebox API version (`items` for legacy v0.25.0, `entities` for the new Entity Merge API).

Workflow photo tools prefer public `imageUrl`/`photoUrl` values. Local paths such as `/mnt/data/...` are not supported; direct `base64` is only a fallback.

## Multi-Version Compatibility

The client probes `GET /api/v1/entities?pageSize=1` on first authenticated tool call. If the endpoint responds, the server is treated as the new Entity Merge API (`entities` surface). If it returns 404, the server falls back to legacy v0.25.0 (`items` surface). The detected surface is cached for the lifetime of the MCP process.

Tool routing in both directions:

| Tool family                                     | `entities` surface         | `items` surface             |
| ----------------------------------------------- | -------------------------- | --------------------------- |
| Inventory CRUD (`homebox_*_item`, `homebox_*_entity`) | `/api/v1/entities/*` | `/api/v1/items/*`           |
| Attachments (`homebox_*_attachment`, `homebox_*_entity_attachment`) | `/api/v1/entities/{id}/attachments/*` | `/api/v1/items/{id}/attachments/*` |
| `homebox_set_primary_attachment`                | `PUT .../attachments/{id}` with `{primary: true}` | `PUT .../attachments/{id}/primary` |
| `homebox_list_locations`                        | `/api/v1/entities?isLocation=true` | `/api/v1/locations`          |
| `homebox_list_custom_fields(_values)` / `homebox_list_entity_field_names(_values)` | `/api/v1/entities/fields(/values)` | `/api/v1/items/fields(/values)` |
| `homebox_list_entities_tree`                    | `/api/v1/entities/tree`    | `/api/v1/locations/tree`     |
| `homebox_export_entities` / `homebox_import_entities` | `/api/v1/entities/(export|import)` | `/api/v1/items/(export|import)` |
| `homebox_list_entity_maintenance`               | `/api/v1/entities/{id}/maintenance` | `/api/v1/items/{id}/maintenance` |

Body translation: `parentId` <-> `locationId`, `syncChildEntityLocations` <-> `syncChildItemsLocations`, `entityTypeId` is stripped when routing to legacy items.

Tools without legacy equivalents return a structured `not_found` error on `items` surface: `homebox_list_currencies`, `homebox_list_entity_types` (and friends), `homebox_create_external_entity_attachment`.

## Tests

```powershell
npm run build
npm test
```

Real read-only E2E with HomeboxAiHelper credentials:

```powershell
$env:HOMEBOX_E2E = "1"
$env:HOMEBOX_TEST_ACCESS_FILE = "C:\__program\HomeboxAiHelper\.test-access"
npm run test:e2e
```

Do not commit `.env`, `.test-access`, tokens, credentials, or captured request bodies containing secrets.
