# API Coverage

## Authentication

- `homebox_login`: `POST /api/v1/users/login`.
- `homebox_refresh_session`: `GET /api/v1/users/refresh`.
- `homebox_register_token`: register an existing Homebox token as a session.
- `homebox_logout`: remove an in-memory session.
- MCP OAuth endpoints for ChatGPT connector login: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`.

When `HOMEBOX_MCP_DATA_DIR` is configured, OAuth dynamic client registrations, authorization codes, access tokens, refresh tokens and mapped Homebox sessions are persisted to `oauth-store.json` in that directory. Raw OAuth token strings are not stored, only their hashes; mapped Homebox sessions still contain Homebox tokens and must be treated as secrets.

OAuth refresh tokens are single-use. `consumeRefreshToken` removes the old refresh token before Homebox token refresh, so concurrent refresh attempts cannot replay the same token.

When an MCP request is authenticated by OAuth, tool-level `sessionKey` and raw Homebox `token` inputs are rejected; the connection's OAuth session is used instead.

## Instance

- `homebox_status`: `GET /api/v1/status`.
- `homebox_list_currencies`: `GET /api/v1/currency` (current docs show `GET /v1/currency`).
- `homebox_api_request`: low-level escape hatch for relative `/api/v1/...` paths with GET/POST/PUT/PATCH/DELETE. Prefer typed tools; caller owns payload compatibility.

## Collections

- `homebox_list_collections`: `GET /api/v1/groups/all`.

HomeboxAiHelper verified groups as the stable collection-like concept in Homebox v0.25.0.

## Items

- `homebox_list_items`: `GET /api/v1/items` with pagination and optional collection query.
- `homebox_get_item`: `GET /api/v1/items/{id}`.
- `homebox_create_item`: `POST /api/v1/items`.
- `homebox_update_item`: GET-merge-`PUT /api/v1/items/{id}`.
- `homebox_put_item`: direct full `PUT /api/v1/items/{id}`.
- `homebox_patch_item`: `PATCH /api/v1/items/{id}`.
- `homebox_delete_item`: `DELETE /api/v1/items/{id}`.

`homebox_update_item` accepts a `patch` object and is preferred for Homebox v0.25. Supported v0.25 item fields include `name`, `description`, `quantity`, `insured`, `archived`, `assetId`, `serialNumber`, `modelNumber`, `manufacturer`, `lifetimeWarranty`, `warrantyExpires`, `warrantyDetails`, `purchaseTime`, `purchaseFrom`, `purchasePrice`, `soldTime`, `soldTo`, `soldPrice`, `soldNotes`, `notes`, `locationId`, `tagIds`, and `fields`.

Use `purchaseTime` for Homebox purchase date. Do not use `purchaseDate`.

## Workflow Tools

- `homebox_resolve_tags`: resolves tag names from `labels` or `names`; exact match first, then case-insensitive match; optional creation through `POST /api/v1/tags`.
- `homebox_resolve_location`: lookup-focused location name/path resolver. Defaults to `createMissing=false`.
- `homebox_find_or_create_location`: location name/path resolver that creates missing path segments by default.
- `homebox_create_item_full`: resolves tags/location, stores external refs as custom fields, creates item, and optionally uploads a primary photo from public URL/base64.
- `homebox_upload_primary_photo_from_file`: uploads and sets a primary item photo. Public `imageUrl`/`photoUrl` preferred; base64 fallback; local paths unsupported.
- `homebox_replace_primary_photo`: uploads a new primary item photo and optionally deletes previous primary attachments.
- `homebox_upsert_items_bulk`: creates or updates many items; dedupe defaults to `externalAssetId`, `orderId`, then `name`.
- `homebox_import_items_bulk`: import-oriented alias for bulk upsert, useful for sources such as AliExpress orders.

Workflow item fields include `name`, `description`, `quantity`, `purchaseTime`, `purchaseFrom`, `purchasePrice`, `manufacturer`, `modelNumber`, `serialNumber`, `notes`, `labels`, `externalAssetId`, `orderId`, `sourceUrls`, and `photoUrl`.

## Entities And Related Current API

Current Homebox docs show these as `/v1/...`; this server calls the deployed API under `/api/v1/...`.

- `homebox_list_entities`: `GET /api/v1/entities` with `q`, `page`, `pageSize`, `tags`, `parentIds`, and extra query parameters.
- `homebox_create_entity`: `POST /api/v1/entities`.
- `homebox_export_entities`: `GET /api/v1/entities/export`, returns CSV as base64 and text when textual.
- `homebox_import_entities`: `POST /api/v1/entities/import` with multipart field `csv` from base64.
- `homebox_list_entity_field_names`: `GET /api/v1/entities/fields`.
- `homebox_list_entity_field_values`: `GET /api/v1/entities/fields/values?field=<name>`.
- `homebox_list_entities_tree`: `GET /api/v1/entities/tree` with optional `withItems`.
- `homebox_get_entity`: `GET /api/v1/entities/{id}`.
- `homebox_put_entity`: `PUT /api/v1/entities/{id}`.
- `homebox_patch_entity`: `PATCH /api/v1/entities/{id}`.
- `homebox_delete_entity`: `DELETE /api/v1/entities/{id}`.
- `homebox_duplicate_entity`: `POST /api/v1/entities/{id}/duplicate`.
- `homebox_get_entity_path`: `GET /api/v1/entities/{id}/path`.
- `homebox_list_entity_attachments`: reads attachments from `GET /api/v1/entities/{id}`.
- `homebox_upload_entity_attachment`: `POST /api/v1/entities/{id}/attachments` with multipart field `file` from base64.
- `homebox_create_external_entity_attachment`: `POST /api/v1/entities/{id}/attachments/external`.
- `homebox_download_entity_attachment`: `GET /api/v1/entities/{id}/attachments/{attachmentId}`, returns base64.
- `homebox_update_entity_attachment`: `PUT /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_delete_entity_attachment`: `DELETE /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_list_entity_maintenance`: `GET /api/v1/entities/{id}/maintenance` with optional `status`.
- `homebox_create_entity_maintenance`: `POST /api/v1/entities/{id}/maintenance`.
- `homebox_list_entity_types`: `GET /api/v1/entity-types`.
- `homebox_create_entity_type`: `POST /api/v1/entity-types`.
- `homebox_update_entity_type`: `PUT /api/v1/entity-types/{id}`.
- `homebox_delete_entity_type`: `DELETE /api/v1/entity-types/{id}`.
- `homebox_list_entity_templates`: `GET /api/v1/templates`.
- `homebox_create_entity_template`: `POST /api/v1/templates`.
- `homebox_get_entity_template`: `GET /api/v1/templates/{id}`.
- `homebox_update_entity_template`: `PUT /api/v1/templates/{id}`.
- `homebox_delete_entity_template`: `DELETE /api/v1/templates/{id}`.
- `homebox_create_entity_from_template`: `POST /api/v1/templates/{id}/create-item`.

## Maintenance

- `homebox_list_maintenance`: `GET /api/v1/maintenance?status=<scheduled|completed|both>`. Defaults to `status=both` because Homebox v0.25.0 returns 500 without it.
- `homebox_update_maintenance_entry`: `PUT /api/v1/maintenance/{id}`.
- `homebox_delete_maintenance_entry`: `DELETE /api/v1/maintenance/{id}`.

## Notifiers

- `homebox_list_notifiers`: `GET /api/v1/notifiers`.
- `homebox_create_notifier`: `POST /api/v1/notifiers`.
- `homebox_test_notifier`: `POST /api/v1/notifiers/test?url=<url>`.
- `homebox_update_notifier`: `PUT /api/v1/notifiers/{id}`.
- `homebox_delete_notifier`: `DELETE /api/v1/notifiers/{id}`.

## Attachments

- `homebox_list_attachments`: reads attachments from `GET /api/v1/items/{id}`.
- `homebox_download_attachment`: `GET /api/v1/items/{id}/attachments/{attachmentId}` and returns base64.
- `homebox_upload_attachment`: `POST /api/v1/items/{id}/attachments` with multipart file from base64.
- `homebox_delete_attachment`: `DELETE /api/v1/items/{id}/attachments/{attachmentId}`.
- `homebox_set_primary_attachment`: `PUT /api/v1/items/{id}/attachments/{attachmentId}/primary`.

## Locations, Tags, Fields

- `homebox_list_locations`: `GET /api/v1/locations`.
- `homebox_create_location`: `POST /api/v1/locations`.
- `homebox_update_location`: `PUT /api/v1/locations/{id}`.
- `homebox_delete_location`: `DELETE /api/v1/locations/{id}`.
- `homebox_list_tags`: `GET /api/v1/tags`.
- `homebox_list_custom_fields`: `GET /api/v1/items/fields`.
- `homebox_list_custom_field_values`: `GET /api/v1/items/fields/values?field=<name>`.

## Diagnostics

- `homebox_api_surface`: probes `GET /api/v1/entities?pageSize=1` once per process. Returns `{ surface: "entities" | "items", cached: boolean }`. Tools route automatically based on the detected surface.

## Auto-Routing By Detected Surface

The client picks between the new Entity Merge API (`/api/v1/entities/...`) and legacy v0.25.0 (`/api/v1/items/...`, `/api/v1/locations/...`) on first use. Each named tool covers both versions through one call site:

- `homebox_list_items` and `homebox_list_entities` both call `/entities` on the new surface and `/items` on the legacy surface. `parentIds` is translated to `locations` on legacy.
- `homebox_get_item`, `homebox_put_item`, `homebox_patch_item`, `homebox_delete_item` delegate to the entity equivalents; bodies translate `parentId`/`locationId` and `syncChild*Locations` and drop `entityTypeId` when needed.
- `homebox_update_item` keeps the v0.25.0 GET-merge-PUT contract on legacy and uses `PATCH /entities/{id}` on the new surface.
- `homebox_list_attachments`, `homebox_upload_attachment`, `homebox_download_attachment`, `homebox_delete_attachment` route to `/entities/{id}/attachments/...` or `/items/{id}/attachments/...`.
- `homebox_set_primary_attachment` calls the legacy `.../primary` endpoint; on the new surface it routes to `PUT /entities/{id}/attachments/{att}` with `{ primary: true }`.
- `homebox_list_locations` calls `/api/v1/entities?isLocation=true` on the new surface and `/api/v1/locations` on legacy. Same routing applies to `homebox_(create|update|delete)_location`.
- `homebox_list_custom_fields(_values)` and `homebox_list_entity_field_names(_values)` route to `/items/fields(/values)` on legacy and `/entities/fields(/values)` on the new surface.
- `homebox_list_entities_tree` falls back to `/api/v1/locations/tree` on legacy.
- `homebox_export_entities` and `homebox_import_entities` fall back to `/api/v1/items/(export|import)` on legacy.
- `homebox_duplicate_entity` and `homebox_get_entity_path` fall back to `/api/v1/items/{id}/(duplicate|path)`.
- `homebox_list_entity_maintenance` and `homebox_create_entity_maintenance` fall back to `/api/v1/items/{id}/maintenance`.

Tools without a legacy equivalent return a structured `not_found` error on the `items` surface:

- `homebox_list_currencies`
- `homebox_list_entity_types`, `homebox_create_entity_type`, `homebox_update_entity_type`, `homebox_delete_entity_type`
- `homebox_create_external_entity_attachment`

## Version-Specific Gaps

Some Homebox versions expose extra endpoints. Use `homebox_api_request` for those until verified and promoted to a named tool.
