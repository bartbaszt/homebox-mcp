# Homebox MCP

Unofficial third-party MCP server for Homebox. It is not affiliated with or endorsed by Homebox.

The server exposes one configured Homebox instance to external agents over MCP Streamable HTTP. It supports many Homebox users through in-memory `sessionKey` sessions and exposes Homebox groups as collections.

## Features

- Remote MCP endpoint over HTTP or direct HTTPS.
- MCP endpoint bearer-token guard for external access.
- Homebox username/password login tool; password is never stored.
- Multiple concurrent users via in-memory session keys.
- Named tools for status, auth, collections, items, attachments, locations, tags and custom fields.
- Generic `homebox_api_request` for version-specific `/api/v1/...` endpoints.
- Safe item update helper that GET-merge-PUTs full payloads to avoid Homebox v0.25.0 partial PUT failures.

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
$env:HOMEBOX_MCP_API_TOKEN = "long-random-token"
```

Default endpoint:

```text
http://0.0.0.0:3000/mcp
```

External agents should connect to the public address and send:

```text
Authorization: Bearer <HOMEBOX_MCP_API_TOKEN>
```

## HTTPS

Preferred production setup: run this service on internal HTTP and terminate TLS in a reverse proxy.

Direct Node HTTPS is also supported:

```powershell
$env:HOMEBOX_MCP_TLS_KEY = "C:\certs\homebox-mcp.key"
$env:HOMEBOX_MCP_TLS_CERT = "C:\certs\homebox-mcp.crt"
npm start
```

## Basic Agent Flow

1. Call `homebox_status` to verify target instance.
2. Call `homebox_login` with Homebox username/password.
3. Store returned `sessionKey` in the agent conversation/session.
4. Pass `sessionKey` to tools like `homebox_list_items`, `homebox_get_item`, `homebox_update_item`.
5. Call `homebox_logout` when done.

## Tools

- Auth: `homebox_login`, `homebox_register_token`, `homebox_refresh_session`, `homebox_logout`, `homebox_list_sessions`.
- Instance: `homebox_status`, `homebox_api_request`.
- Collections: `homebox_list_collections`.
- Items: `homebox_list_items`, `homebox_get_item`, `homebox_create_item`, `homebox_update_item`, `homebox_put_item`, `homebox_patch_item`, `homebox_delete_item`.
- Attachments: `homebox_list_attachments`, `homebox_download_attachment`, `homebox_upload_attachment`, `homebox_delete_attachment`, `homebox_set_primary_attachment`.
- Locations/tags/fields: `homebox_list_locations`, `homebox_create_location`, `homebox_update_location`, `homebox_delete_location`, `homebox_list_tags`, `homebox_list_custom_fields`, `homebox_list_custom_field_values` (requires `field`).

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
