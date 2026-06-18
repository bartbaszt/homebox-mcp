# Homebox MCP

Unofficial third-party MCP server for Homebox. It is not affiliated with or endorsed by Homebox.

The server exposes one configured Homebox instance to external agents over MCP Streamable HTTP. It supports many Homebox users through ChatGPT-compatible OAuth connections or in-memory `sessionKey` sessions, and exposes Homebox groups as collections.

This project was built with AI assistance.

## Features

- Remote MCP endpoint over HTTP or direct HTTPS.
- MCP endpoint bearer-token guard or OAuth 2.1 authorization-code + PKCE for external access.
- ChatGPT Apps/Connectors OAuth flow with DCR, protected resource metadata and bearer tokens stored by the MCP client.
- Homebox username/password login tool; password is never stored.
- Multiple concurrent users via in-memory session keys.
- Named tools for status, auth, collections, groups, statistics, items, attachments, locations, tags, custom fields and higher-level item workflows.
- Generic `homebox_api_request` for version-specific `/api/v1/...` endpoints.
- Safe entity update helper that GET-merge-PUTs full payloads to avoid partial PUT field loss.
- Targets Homebox v0.26.x (Entity Merge API): items and locations are unified under `/api/v1/entities/*`. The legacy `/v1/items/*` and `/v1/locations/*` endpoints were removed in v0.26.0 and are not supported.
- v0.26 coverage: tag CRUD, group CRUD + invitations + members, group statistics, group ZIP export/import, bill of materials, actions, API keys, user self/settings/password, asset by asset ID, barcode lookup and QR code.

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

Default local endpoint:

```text
http://127.0.0.1:3000/mcp
```

The Node default listener is `127.0.0.1`. Docker sets `HOMEBOX_MCP_HOST=0.0.0.0`, and startup fails unless `HOMEBOX_MCP_API_TOKEN` is set or OAuth is enabled. Placeholder API tokens such as `change-me` are rejected.

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

Full user guide: [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).

Full deployment runbook including ChatGPT setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

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
$env:HOMEBOX_MCP_DATA_DIR = "C:\homebox-mcp-data" # persist OAuth clients/tokens across restarts
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
- `HOMEBOX_MCP_DATA_DIR`: optional writable directory for `oauth-store.json`. Set this for ChatGPT connectors so OAuth client registrations and tokens survive restarts.

ChatGPT connects to the public `/mcp` URL. On first auth, the browser form logs into Homebox once, the password is discarded, and ChatGPT stores the OAuth token pair in connector settings. Tool calls can then omit `sessionKey` and raw Homebox tokens.

When using MCP OAuth, tool inputs `sessionKey` and raw `token` are rejected so one OAuth connector cannot use another user's in-memory session.

OAuth client registrations, tokens and mapped Homebox sessions are in-memory unless `HOMEBOX_MCP_DATA_DIR` is set. Docker deployments should mount a private writable `/data` volume and set `HOMEBOX_MCP_DATA_DIR=/data` so restarts do not require reconnecting ChatGPT connectors.

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

- Auth: `homebox_login`, `homebox_register_token`, `homebox_refresh_session`, `homebox_logout`, `homebox_logout_homebox`.
- Instance: `homebox_status`, `homebox_list_currencies`, `homebox_api_request`.
- Collections / groups: `homebox_list_collections`, `homebox_get_group`, `homebox_update_group`, `homebox_create_group`, `homebox_delete_group`, `homebox_list_group_invitations`, `homebox_create_group_invitation`, `homebox_accept_group_invitation`, `homebox_delete_group_invitation`, `homebox_list_group_members`, `homebox_remove_group_member`.
- Statistics: `homebox_list_group_statistics`, `homebox_list_location_statistics`, `homebox_list_purchase_price_statistics`, `homebox_list_tag_statistics`.
- Group export/import: `homebox_list_group_exports`, `homebox_start_group_export`, `homebox_get_group_export`, `homebox_delete_group_export`, `homebox_download_group_export_artifact`, `homebox_import_group_zip`.
- Reporting: `homebox_bill_of_materials`.
- Actions: `homebox_action_create_missing_thumbnails`, `homebox_action_ensure_asset_ids`, `homebox_action_ensure_import_refs`, `homebox_action_set_primary_photos`, `homebox_action_wipe_inventory`, `homebox_action_zero_item_time_fields`.
- Items (entities): `homebox_list_items`, `homebox_get_item`, `homebox_create_item`, `homebox_update_item`, `homebox_put_item`, `homebox_patch_item`, `homebox_delete_item`.
- Entities: `homebox_list_entities`, `homebox_create_entity`, `homebox_export_entities`, `homebox_import_entities`, `homebox_get_entity`, `homebox_put_entity`, `homebox_patch_entity`, `homebox_delete_entity`, `homebox_duplicate_entity`, `homebox_get_entity_path`, `homebox_list_entities_tree`, `homebox_list_entity_field_names`, `homebox_list_entity_field_values`.
- Entity attachments/maintenance: `homebox_list_entity_attachments`, `homebox_upload_entity_attachment`, `homebox_create_external_entity_attachment`, `homebox_download_entity_attachment`, `homebox_update_entity_attachment`, `homebox_delete_entity_attachment`, `homebox_list_entity_maintenance`, `homebox_create_entity_maintenance`.
- Entity types/templates: `homebox_list_entity_types`, `homebox_create_entity_type`, `homebox_update_entity_type`, `homebox_delete_entity_type`, `homebox_list_entity_templates`, `homebox_create_entity_template`, `homebox_get_entity_template`, `homebox_update_entity_template`, `homebox_delete_entity_template`, `homebox_create_entity_from_template`.
- Maintenance log: `homebox_list_maintenance` (defaults to `status=both`), `homebox_update_maintenance_entry`, `homebox_delete_maintenance_entry`.
- Notifiers: `homebox_list_notifiers`, `homebox_create_notifier`, `homebox_test_notifier`, `homebox_update_notifier`, `homebox_delete_notifier`.
- Attachments: `homebox_list_attachments`, `homebox_download_attachment`, `homebox_upload_attachment`, `homebox_delete_attachment`, `homebox_set_primary_attachment`.
- Locations/tags/fields: `homebox_list_locations`, `homebox_create_location`, `homebox_update_location`, `homebox_delete_location`, `homebox_list_tags`, `homebox_get_tag`, `homebox_update_tag`, `homebox_delete_tag`, `homebox_list_custom_fields`, `homebox_list_custom_field_values` (requires `field`).
- User/API keys: `homebox_get_user_self`, `homebox_update_user_self`, `homebox_delete_user_self`, `homebox_get_user_settings`, `homebox_update_user_settings`, `homebox_change_password`, `homebox_list_api_keys`, `homebox_create_api_key`, `homebox_delete_api_key`.
- Assets/barcode/QR: `homebox_get_asset_by_asset_id`, `homebox_search_from_barcode`, `homebox_create_qr_code`.
- Workflows: `homebox_resolve_tags`, `homebox_resolve_location`, `homebox_find_or_create_location`, `homebox_create_item_full`, `homebox_upload_primary_photo_from_file`, `homebox_replace_primary_photo`, `homebox_upsert_items_bulk`, `homebox_import_items_bulk`.

Workflow photo tools prefer public `imageUrl`/`photoUrl` values. Local paths such as `/mnt/data/...` are not supported; direct `base64` is only a fallback.

Homebox UI field mapping for item/entity tools:

| Homebox UI | API field |
|---|---|
| Purchase date / Data zakupu | `purchaseTime` |
| Purchased from / Zakupiono od | `purchaseFrom` |
| Purchase price / Cena zakupu | `purchasePrice` |
| Manufacturer / Producent | `manufacturer` |
| Model | `modelNumber` |
| Serial number / Numer seryjny | `serialNumber` |
| Notes / Notatki | `notes` |
| Location / Lokalizacja | `parentId` |
| Tags / Tagi | `tagIds` |
| Primary photo / thumbnail | primary attachment / `imageId` |

Use `purchaseTime` for purchase date. Do not use `purchaseDate`. Use `parentId` for the parent location.

Recommended purchase/import workflow:

1. Resolve location by name with `homebox_resolve_location` or `homebox_find_or_create_location`.
2. Resolve or create tags with `homebox_resolve_tags`.
3. Create an entity with stable fields: `name`, `description`, `quantity`, `parentId`, `tagIds`.
4. Patch `purchasePrice`, `purchaseTime`, `purchaseFrom`, `manufacturer`, `modelNumber`, `notes`.
5. Upload the primary photo.
6. Verify final fields with `homebox_get_entity`.

For bulk imports, prefer `homebox_import_items_bulk` or `homebox_upsert_items_bulk` over manual orchestration.

## Homebox v0.26 Compatibility

This server targets Homebox v0.26.x (Entity Merge API). Items and locations are unified under `/api/v1/entities/*`. Item-named tools and entity-named tools both route to `/entities/*`:

| Tool family                                     | Endpoint                       |
| ----------------------------------------------- | ------------------------------ |
| Inventory CRUD (`homebox_*_item`, `homebox_*_entity`) | `/api/v1/entities/*`       |
| Attachments (`homebox_*_attachment`, `homebox_*_entity_attachment`) | `/api/v1/entities/{id}/attachments/*` |
| `homebox_set_primary_attachment`                | `PUT /entities/{id}/attachments/{id}` with `{primary: true}` |
| `homebox_list_locations`                        | `/api/v1/entities?isLocation=true` |
| `homebox_(create|update|delete)_location`        | `/api/v1/entities/{id}`        |
| `homebox_list_custom_fields(_values)` / `homebox_list_entity_field_names(_values)` | `/api/v1/entities/fields(/values)` |
| `homebox_list_entities_tree`                    | `/api/v1/entities/tree`        |
| `homebox_export_entities` / `homebox_import_entities` | `/api/v1/entities/(export|import)` |
| `homebox_list_entity_maintenance`               | `/api/v1/entities/{id}/maintenance` |

Update rules:

- `homebox_update_item` reads the current entity, merges `patch`, preserves fields/tags and converts `parent` to `parentId`, then PUTs a full payload because partial PUT can drop fields.
- Homebox `assetId` may be auto-generated. External order IDs such as AliExpress `AE-*` should usually be stored in `notes` or custom fields unless overwriting `assetId` is known to work.

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

## License

This project is licensed under the GNU Affero General Public License v3.0 or later.

You may use, modify, host, and redistribute this software, including commercially, provided that you comply with the AGPL. In particular, if you modify this project and make it available to users over a network, you must offer those users access to the corresponding source code of your modified version.

See [LICENSE](LICENSE) for details.
