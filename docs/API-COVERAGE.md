# API Coverage

Targets **Homebox v0.26.x** (Entity Merge API). The legacy `/v1/items/*` and `/v1/locations/*` endpoints were removed in v0.26.0; this server only uses the unified `/api/v1/entities/*` API.

## Authentication

- `homebox_login`: `POST /api/v1/users/login`.
- `homebox_refresh_session`: `GET /api/v1/users/refresh`.
- `homebox_logout_homebox`: `POST /api/v1/users/logout` (logs out token on Homebox; use `homebox_logout` to drop the local MCP session).
- `homebox_register_token`: register an existing Homebox token as a session.
- `homebox_logout`: remove an in-memory session.
- MCP OAuth endpoints for ChatGPT connector login: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`.

When `HOMEBOX_MCP_DATA_DIR` is configured, OAuth dynamic client registrations, authorization codes, access tokens, refresh tokens and mapped Homebox sessions are persisted to `oauth-store.json` in that directory. Raw OAuth token strings are not stored, only their hashes; mapped Homebox sessions still contain Homebox tokens and must be treated as secrets.

OAuth refresh tokens are single-use. `consumeRefreshToken` removes the old refresh token before Homebox token refresh, so concurrent refresh attempts cannot replay the same token.

When an MCP request is authenticated by OAuth, tool-level `sessionKey` and raw Homebox `token` inputs are rejected; the connection's OAuth session is used instead.

## Instance

- `homebox_status`: `GET /api/v1/status`.
- `homebox_list_currencies`: `GET /api/v1/currencies`.
- `homebox_api_request`: low-level escape hatch for relative `/api/v1/...` paths with GET/POST/PUT/PATCH/DELETE. Prefer typed tools; caller owns payload compatibility.

## Collections / Groups (v0.26)

- `homebox_list_collections`: `GET /api/v1/groups/all`.
- `homebox_get_group`: `GET /api/v1/groups`.
- `homebox_update_group`: `PUT /api/v1/groups`.
- `homebox_create_group`: `POST /api/v1/groups`.
- `homebox_delete_group`: `DELETE /api/v1/groups`.
- `homebox_list_group_invitations`: `GET /api/v1/groups/invitations`.
- `homebox_create_group_invitation`: `POST /api/v1/groups/invitations`.
- `homebox_accept_group_invitation`: `POST /api/v1/groups/invitations/{id}`.
- `homebox_delete_group_invitation`: `DELETE /api/v1/groups/invitations/{id}`.
- `homebox_list_group_members`: `GET /api/v1/groups/members`.
- `homebox_remove_group_member`: `DELETE /api/v1/groups/members/{userId}`.

## Statistics (v0.26)

- `homebox_list_group_statistics`: `GET /api/v1/groups/statistics`.
- `homebox_list_location_statistics`: `GET /api/v1/groups/statistics/locations`.
- `homebox_list_purchase_price_statistics`: `GET /api/v1/groups/statistics/purchase-price`.
- `homebox_list_tag_statistics`: `GET /api/v1/groups/statistics/tags`.

## Group Export / Import ZIP (v0.26)

- `homebox_list_group_exports`: `GET /api/v1/group/exports`.
- `homebox_start_group_export`: `POST /api/v1/group/exports`.
- `homebox_get_group_export`: `GET /api/v1/group/exports/{id}`.
- `homebox_delete_group_export`: `DELETE /api/v1/group/exports/{id}`.
- `homebox_download_group_export_artifact`: `GET /api/v1/group/exports/{id}/download` (returns base64 ZIP).
- `homebox_import_group_zip`: `POST /api/v1/group/import` with multipart `file` from base64. Receiving collection must be empty.

## Reporting (v0.26)

- `homebox_bill_of_materials`: `GET /api/v1/reporting/bill-of-materials` (returns base64 and text).

## Actions (v0.26)

- `homebox_action_create_missing_thumbnails`: `POST /api/v1/actions/create-missing-thumbnails`.
- `homebox_action_ensure_asset_ids`: `POST /api/v1/actions/ensure-asset-ids`.
- `homebox_action_ensure_import_refs`: `POST /api/v1/actions/ensure-import-refs`.
- `homebox_action_set_primary_photos`: `POST /api/v1/actions/set-primary-photos`.
- `homebox_action_wipe_inventory`: `POST /api/v1/actions/wipe-inventory` (destructive; optional body: wipeLabels, wipeLocations, wipeMaintenance).
- `homebox_action_zero_item_time_fields`: `POST /api/v1/actions/zero-item-time-fields`.

## Items / Entities

Items and locations are unified as entities. Item tools (`homebox_list_items`, `homebox_get_item`, `homebox_create_item`, `homebox_update_item`, `homebox_put_item`, `homebox_patch_item`, `homebox_delete_item`) all route to `/api/v1/entities/*`.

- `homebox_list_items`: `GET /api/v1/entities` with pagination and optional `groupId`.
- `homebox_get_item`: `GET /api/v1/entities/{id}`.
- `homebox_create_item`: `POST /api/v1/entities`.
- `homebox_update_item`: GET-merge-`PUT /api/v1/entities/{id}`. Preserves fields/tags, converts `parent` to `parentId`.
- `homebox_put_item`: direct full `PUT /api/v1/entities/{id}`.
- `homebox_patch_item`: `PATCH /api/v1/entities/{id}` (supports `entityTypeId`, `parentId`, `quantity`, `tagIds`).
- `homebox_delete_item`: `DELETE /api/v1/entities/{id}`.

`homebox_update_item` accepts a `patch` object. Supported v0.26 fields include `name`, `description`, `quantity`, `insured`, `archived`, `assetId`, `serialNumber`, `modelNumber`, `manufacturer`, `lifetimeWarranty`, `warrantyExpires`, `warrantyDetails`, `purchaseTime` (emitted as `purchaseDate`), `purchaseFrom`, `purchasePrice`, `soldTime`, `soldTo`, `soldPrice`, `soldNotes`, `notes`, `parentId`, `entityTypeId`, `tagIds`, `fields`, `syncChildEntityLocations`.

Use `purchaseTime` (alias) or `purchaseDate` for the purchase date; workflows emit `purchaseDate` because Homebox v0.26.2 ignores `purchaseTime` on POST/PUT/PATCH. Custom fields must include `type` plus the matching value key (`textValue`/`numberValue`/`booleanValue`); without `type`, PUT returns 500. Workflows emit `type:"text"` and serialize non-string values as text. Use `parentId` for parent location.

## Entities

- `homebox_list_entities`: `GET /api/v1/entities` with `q`, `page`, `pageSize`, `tags`, `parentIds`, `isLocation`, `filterChildren`, `negateTags`, `orderBy`, `includeArchived`, `fields` and extra query parameters.
- `homebox_create_entity`: `POST /api/v1/entities`.
- `homebox_export_entities`: `GET /api/v1/entities/export`, returns CSV as base64 and text.
- `homebox_import_entities`: `POST /api/v1/entities/import` with multipart `csv` from base64.
- `homebox_list_entity_field_names`: `GET /api/v1/entities/fields`.
- `homebox_list_entity_field_values`: `GET /api/v1/entities/fields/values?field=<name>`.
- `homebox_list_entities_tree`: `GET /api/v1/entities/tree` with optional `withItems`.
- `homebox_get_entity`: `GET /api/v1/entities/{id}`.
- `homebox_put_entity`: `PUT /api/v1/entities/{id}`.
- `homebox_patch_entity`: `PATCH /api/v1/entities/{id}`.
- `homebox_delete_entity`: `DELETE /api/v1/entities/{id}`.
- `homebox_duplicate_entity`: `POST /api/v1/entities/{id}/duplicate`.
- `homebox_get_entity_path`: `GET /api/v1/entities/{id}/path`.

## Entity Attachments

- `homebox_list_entity_attachments`: reads attachments from `GET /api/v1/entities/{id}`.
- `homebox_upload_entity_attachment`: `POST /api/v1/entities/{id}/attachments` with multipart `file` from base64.
- `homebox_create_external_entity_attachment`: `POST /api/v1/entities/{id}/attachments/external` (HTTP(S) link attachments, no blob storage).
- `homebox_download_entity_attachment`: `GET /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_update_entity_attachment`: `PUT /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_delete_entity_attachment`: `DELETE /api/v1/entities/{id}/attachments/{attachmentId}`.

## Entity Maintenance

- `homebox_list_entity_maintenance`: `GET /api/v1/entities/{id}/maintenance` with optional `status`.
- `homebox_create_entity_maintenance`: `POST /api/v1/entities/{id}/maintenance`.

## Entity Types (v0.26)

- `homebox_list_entity_types`: `GET /api/v1/entity-types`.
- `homebox_create_entity_type`: `POST /api/v1/entity-types` (body: name, isLocation, icon, defaultTemplateId).
- `homebox_update_entity_type`: `PUT /api/v1/entity-types/{id}`.
- `homebox_delete_entity_type`: `DELETE /api/v1/entity-types/{id}` (fails if entities still use it).

## Entity Templates

- `homebox_list_entity_templates`: `GET /api/v1/templates`.
- `homebox_create_entity_template`: `POST /api/v1/templates`.
- `homebox_get_entity_template`: `GET /api/v1/templates/{id}`.
- `homebox_update_entity_template`: `PUT /api/v1/templates/{id}`.
- `homebox_delete_entity_template`: `DELETE /api/v1/templates/{id}`.
- `homebox_create_entity_from_template`: `POST /api/v1/templates/{id}/create-item`.

## Workflow Tools

- `homebox_resolve_tags`: resolves tag names from `labels` or `names`; exact match first, then case-insensitive match; optional creation via `POST /api/v1/tags`.
- `homebox_resolve_location`: lookup-focused location name/path resolver. Defaults to `createMissing=false`.
- `homebox_find_or_create_location`: location name/path resolver that creates missing path segments by default. Locations are entities with `isLocation=true`.
- `homebox_create_item_full`: resolves tags/location, stores external refs as custom fields, creates entity, optionally uploads a primary photo from public URL/base64. Photo upload uses the idempotent ensure path (reuses existing attachment by title or content hash) so retries do not create duplicate photos.
- `homebox_upload_primary_photo_from_file`: uploads a new attachment and sets it as the primary entity photo. Always adds a new attachment — does NOT replace existing primary. Public `imageUrl`/`photoUrl` preferred; base64 fallback; local paths unsupported. Use `homebox_ensure_primary_photo` for idempotent set-primary, `homebox_replace_primary_photo` to delete previous primary.
- `homebox_replace_primary_photo`: uploads a new primary entity photo and deletes previous primary attachments by default (`deletePreviousPrimary` defaults to `true`).
- `homebox_ensure_primary_photo`: idempotent primary photo setter. Reuses an existing photo attachment by title (fileName) or content hash and only updates its primary flag; uploads a new attachment only when no match exists. Optional `cleanupDuplicates` removes other duplicate photo attachments.
- `homebox_cleanup_duplicate_photos`: removes duplicate photo attachments for an entity, grouping by title+mimeType and keeping one per group (preferring the current primary).
- `homebox_upsert_items_bulk`: creates or updates many entities; dedupe defaults to `externalAssetId`, `orderId`, then `name`. Photo uploads use the idempotent ensure path.
- `homebox_import_items_bulk`: import-oriented alias for bulk upsert, useful for sources such as AliExpress orders.

Workflow entity fields include `name`, `description`, `quantity`, `purchaseTime`, `purchaseFrom`, `purchasePrice`, `manufacturer`, `modelNumber`, `serialNumber`, `notes`, `labels`, `externalAssetId`, `orderId`, `sourceUrls`, `photoUrl` and `parentId` (via `locationId`/`locationName`).

## Locations, Tags, Fields

Locations are entities queried via `/api/v1/entities?isLocation=true`.

- `homebox_list_locations`: `GET /api/v1/entities?isLocation=true`.
- `homebox_create_location`: `POST /api/v1/entities` with `isLocation=true`.
- `homebox_update_location`: `PUT /api/v1/entities/{id}`.
- `homebox_delete_location`: `DELETE /api/v1/entities/{id}`.
- `homebox_list_tags`: `GET /api/v1/tags`.
- `homebox_get_tag`: `GET /api/v1/tags/{id}` (v0.26).
- `homebox_update_tag`: `PUT /api/v1/tags/{id}` (v0.26; body may include name, color, icon, parentId).
- `homebox_delete_tag`: `DELETE /api/v1/tags/{id}` (v0.26).
- `homebox_list_custom_fields`: `GET /api/v1/entities/fields`.
- `homebox_list_custom_field_values`: `GET /api/v1/entities/fields/values?field=<name>`.

## Attachments (legacy item-named)

- `homebox_list_attachments`: reads attachments from `GET /api/v1/entities/{id}`.
- `homebox_download_attachment`: `GET /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_upload_attachment`: `POST /api/v1/entities/{id}/attachments` with multipart file from base64.
- `homebox_delete_attachment`: `DELETE /api/v1/entities/{id}/attachments/{attachmentId}`.
- `homebox_set_primary_attachment`: `PUT /api/v1/entities/{id}/attachments/{attachmentId}` with `{ primary: true }`.

## Maintenance

- `homebox_list_maintenance`: `GET /api/v1/maintenance?status=<scheduled|completed|both>`. Defaults to `status=both`.
- `homebox_update_maintenance_entry`: `PUT /api/v1/maintenance/{id}`.
- `homebox_delete_maintenance_entry`: `DELETE /api/v1/maintenance/{id}`.

## Notifiers

- `homebox_list_notifiers`: `GET /api/v1/notifiers`.
- `homebox_create_notifier`: `POST /api/v1/notifiers`.
- `homebox_test_notifier`: `POST /api/v1/notifiers/test?url=<url>`.
- `homebox_update_notifier`: `PUT /api/v1/notifiers/{id}`.
- `homebox_delete_notifier`: `DELETE /api/v1/notifiers/{id}`.

## User (v0.26)

- `homebox_get_user_self`: `GET /api/v1/users/self`.
- `homebox_update_user_self`: `PUT /api/v1/users/self`.
- `homebox_delete_user_self`: `DELETE /api/v1/users/self` (destructive).
- `homebox_get_user_settings`: `GET /api/v1/users/self/settings`.
- `homebox_update_user_settings`: `PUT /api/v1/users/self/settings`.
- `homebox_change_password`: `PUT /api/v1/users/change-password`.

## API Keys (v0.26)

Static API keys take on the access level of the creating user and are prefixed with `hb_`. Treat as secrets.

- `homebox_list_api_keys`: `GET /api/v1/users/self/api-keys`.
- `homebox_create_api_key`: `POST /api/v1/users/self/api-keys`.
- `homebox_delete_api_key`: `DELETE /api/v1/users/self/api-keys/{id}`.

## Assets, Barcode, QR (v0.26)

- `homebox_get_asset_by_asset_id`: `GET /api/v1/assets/{assetId}` (asset ID, not entity UUID).
- `homebox_search_from_barcode`: `GET /api/v1/products/search-from-barcode?barcode=<barcode>` (uses configured barcode providers).
- `homebox_create_qr_code`: `POST /api/v1/qrcode`.

## Version-Specific Gaps

Some Homebox versions expose extra endpoints. Use `homebox_api_request` for those until verified and promoted to a named tool.