# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 a minor bump may
contain breaking changes to configuration or tool contracts.

## [Unreleased]

## [0.2.0] - 2026-08-19

Security release. OAuth authorization now requires an explicit, informed consent step.

### Added

- Opt-in OAuth redirect allowlist through `HOMEBOX_MCP_OAUTH_ALLOWED_REDIRECT_ORIGINS`, enforced at
  both dynamic client registration and authorization so tightening it also invalidates clients
  already persisted in `oauth-store.json`.

### Changed

- **Breaking (OAuth clients that posted directly to `/oauth/authorize`)**: `POST /oauth/authorize`
  now requires an explicit consent decision, `action=allow`. Browser-driven connectors are
  unaffected; they press the new Authorize button.

### Security

- `/oauth/authorize` now renders an informed-consent screen before issuing an authorization code. It
  names the requesting client (marked as client-declared and unverified), the host that will receive
  the code, the requested scope, the MCP resource and the client ID. A successful Homebox login is no
  longer treated as implicit consent, which closes a consent-phishing path in which a crafted
  authorize link for an attacker-registered client obtained delegated access to the user's Homebox
  account.
- `Cancel` on the consent screen redirects back with `error=access_denied` and never uses the
  submitted Homebox credentials.
- The consent screen is served with `Content-Security-Policy` (`default-src 'none'`, hashed inline
  stylesheet, `form-action 'self' <redirect-origin>`, `base-uri 'none'`, `frame-ancestors 'none'`),
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: no-store`.

## [0.1.0] - 2026-08-18

First tagged release. Container images are now public on GHCR and versioned; `latest` follows
releases, `edge` follows `master`.

### Added

- Remote MCP server for a single Homebox instance over Streamable HTTP, with a legacy SSE transport
  for ChatGPT compatibility.
- Named tools covering the Homebox v0.26 Entity Merge API: entities, attachments, locations, tags,
  entity types, templates, custom fields, maintenance, groups and invitations, statistics, ZIP
  export/import, bill of materials, actions, API keys, user self-service, assets, barcode lookup and
  QR codes, plus the `homebox_api_request` escape hatch.
- Item workflow tools: `homebox_resolve_tags`, `homebox_resolve_location`,
  `homebox_find_or_create_location`, `homebox_create_item_full`,
  `homebox_upload_primary_photo_from_file`, `homebox_replace_primary_photo`,
  `homebox_ensure_primary_photo`, `homebox_cleanup_duplicate_photos`, `homebox_upsert_items_bulk`
  and `homebox_import_items_bulk`.
- ChatGPT-compatible OAuth with dynamic client registration, single-use refresh tokens with
  two-phase rotation, and optional on-disk persistence via `HOMEBOX_MCP_DATA_DIR`.
- In-memory `sessionKey` login flow for non-OAuth clients; passwords are never stored.
- MCP resource protocol for attachments and image content in download responses.
- Opt-in CORS allowlist through `HOMEBOX_MCP_ALLOWED_ORIGINS`.
- Opt-in local photo uploads confined to `HOMEBOX_MCP_LOCAL_FILE_ROOT`.
- Docker Compose deployment with a hardened image (read-only rootfs, dropped capabilities,
  non-root user, healthcheck) and direct HTTPS or reverse-proxy termination.
- `GET /health` now reports the running build version.

### Security

- Fails closed on non-local listeners without `HOMEBOX_MCP_API_TOKEN` or OAuth, and rejects
  placeholder tokens.
- Requires `HOMEBOX_MCP_PUBLIC_URL` whenever OAuth is enabled so access tokens bind to a stable
  resource identifier.
- SSRF-safe public URL fetching with per-redirect address validation and hard byte limits.
- Open SSE streams follow refresh-token rotation and close when the OAuth grant is revoked.

[Unreleased]: https://github.com/bartbaszt/homebox-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bartbaszt/homebox-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bartbaszt/homebox-mcp/releases/tag/v0.1.0
