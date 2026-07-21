# User Guide

This guide is for MCP clients and agents using Homebox MCP. Homebox MCP is an unofficial third-party server and is not affiliated with Homebox.

## Connect And Authenticate

For ChatGPT-compatible OAuth connectors, connect to the public `/mcp` URL and complete the Homebox login form once. Later tool calls can omit `sessionKey`.

Server operators should set `HOMEBOX_MCP_DATA_DIR` to persist OAuth client registrations and tokens. Without it, restarting Homebox MCP invalidates existing ChatGPT connector tokens and requires reconnecting.

For static MCP auth or local clients:

1. Call `homebox_status` to verify the target Homebox instance.
2. Call `homebox_login` with Homebox username/password.
3. Reuse returned `sessionKey` for later tool calls.
4. Call `homebox_logout` when done.

Raw Homebox tokens are accepted by most tools through `token`, but `sessionKey` or OAuth is preferred so tokens stay out of prompts.

When connected through MCP OAuth, do not pass `sessionKey` or raw `token`; those inputs are rejected and the OAuth-authorized Homebox session is used automatically.

## Choose Item Or Entity Tools

Homebox v0.26 unified items and locations into a single `/api/v1/entities/*` API. The item-named tools (`homebox_list_items`, `homebox_get_item`, `homebox_create_item`, `homebox_update_item`, `homebox_upload_attachment`) and entity-named tools (`homebox_list_entities`, `homebox_get_entity`, `homebox_create_entity`, `homebox_patch_entity`, `homebox_upload_entity_attachment`) all call `/api/v1/entities/*`. Use whichever family reads more naturally; both produce identical HTTP traffic.

Locations are entities queried with `?isLocation=true`. Use `parentId` for the parent location (not `locationId`, which is a legacy field name retained only as a workflow alias).

## Homebox UI Field Mapping

Use API field names in tool payloads.

| Homebox UI | API field |
|---|---|
| Purchase date / Data zakupu | `purchaseTime` (emitted as `purchaseDate`) |
| Purchased from / Zakupiono od | `purchaseFrom` |
| Purchase price / Cena zakupu | `purchasePrice` |
| Manufacturer / Producent | `manufacturer` |
| Model | `modelNumber` |
| Serial number / Numer seryjny | `serialNumber` |
| Notes / Notatki | `notes` |
| Location / Lokalizacja | `parentId` |
| Tags / Tagi | `tagIds` |
| Primary photo / thumbnail | primary attachment or `imageId` |

Use `purchaseTime` (alias) or `purchaseDate` for the purchase date. Workflows emit `purchaseDate` because Homebox v0.26.2 ignores `purchaseTime` on POST/PUT/PATCH. Purchase, manufacturer, model, serial, notes and custom-field updates require `homebox_update_item` GET-merge-PUT; never send them through PATCH.

`homebox_create_item_full` and `homebox_upsert_items_bulk` accept `customFields` as a simple `{ name: value }` object and translate it to Homebox `fields[]` with `type:"text"` and `textValue`. Non-string values are serialized as text because Homebox v0.26.2 returns 500 when `PUT /entities/{id}` receives `type:"number"` or `type:"boolean"` fields (POST create accepts them). Fields without `type` also return 500, so always include `type` when constructing `fields` manually.

## Safe Entity Updates

`PUT /entities/{id}` requires a full entity payload. Use `homebox_update_item` for partial updates. It reads the current entity, merges `patch`, preserves custom fields/tags and converts `parent` to `parentId`, then sends a full PUT payload.

`homebox_create_item` is intentionally strict and accepts only Homebox v0.26 POST core fields: `name`, `description`, `quantity`, `parentId`/`locationId`, `entityTypeId`, `tagIds`, `insured`, `archived`, `assetId` and `syncChildEntityLocations`/`syncChildItemsLocations`. Use `homebox_create_item_full` when purchase, manufacturer, model, serial, notes or custom fields are needed.

`homebox_patch_item` and `homebox_patch_entity` require at least one mutation and accept only `entityTypeId`, `parentId`/`locationId`, `quantity` and `tagIds`. Use `homebox_update_item` for every broader change.

Supported `homebox_update_item.patch` fields for v0.26 entities include:

```text
name, description, quantity, insured, archived, assetId, serialNumber,
modelNumber, manufacturer, lifetimeWarranty, warrantyExpires,
warrantyDetails, purchaseTime, purchaseFrom, purchasePrice,
soldTime, soldTo, soldPrice, soldNotes, notes, parentId, entityTypeId,
tagIds, fields, syncChildEntityLocations
```

`homebox_update_item` example:

```json
{
  "sessionKey": "session-123",
  "itemId": "entity-uuid",
  "patch": {
    "purchaseTime": "2026-05-17",
    "purchaseFrom": "AliExpress",
    "purchasePrice": 12.34,
    "manufacturer": "Acme",
    "modelNumber": "D-42",
    "notes": "Imported from order AE-123"
  }
}
```

Homebox `assetId` may be auto-generated. Store external order IDs such as AliExpress `AE-*` in `notes` or custom fields unless overwriting `assetId` is intentional and verified.

## Recommended Purchase Import Workflow

For one item, prefer `homebox_create_item_full`.

For many items, prefer `homebox_import_items_bulk` or `homebox_upsert_items_bulk`.

Manual workflow when needed:

1. Resolve location by name with `homebox_resolve_location` or `homebox_find_or_create_location`.
2. Resolve or create tags with `homebox_resolve_tags`.
3. Create an entity with stable fields: `name`, `description`, `quantity`, `parentId`, `tagIds`.
4. Update purchase and detail fields with `homebox_update_item` (safe GET-merge-PUT): `purchasePrice`, `purchaseTime`, `purchaseFrom`, `manufacturer`, `modelNumber`, `notes`. Never PATCH these fields.
5. Upload the primary photo.
6. Verify final fields with `homebox_get_entity`.

## Create One Full Item

`homebox_create_item_full` resolves tags and location, stores external references as custom fields, creates the item, and can upload a primary photo from a public URL.

Example:

```json
{
  "sessionKey": "session-123",
  "name": "Cordless drill",
  "description": "18V drill imported from AliExpress",
  "quantity": 1,
  "locationName": "Garage/Shelf",
  "createMissingLocation": true,
  "labels": ["Tools", "AliExpress"],
  "createMissingTags": true,
  "purchaseTime": "2026-05-17",
  "purchaseFrom": "AliExpress",
  "purchasePrice": 49.99,
  "manufacturer": "Acme",
  "modelNumber": "D-42",
  "serialNumber": "SN123",
  "notes": "Imported from order AE-123",
  "externalSource": "aliexpress",
  "externalAssetId": "AE-123:line-1",
  "orderId": "AE-123",
  "sourceUrls": ["https://example.com/order/AE-123"],
  "photoUrl": "https://example.com/photo.jpg"
}
```

Set `dryRun=true` to inspect the payload before writing.

## Bulk Import Or Upsert Items

`homebox_import_items_bulk` and `homebox_upsert_items_bulk` create or update many items in one call. They dedupe by `externalAssetId`, then `orderId`, then `name` unless `dedupeBy` is provided.

Example:

```json
{
  "sessionKey": "session-123",
  "locationName": "Garage/Shelf",
  "createMissingLocation": true,
  "createMissingTags": true,
  "dedupeBy": ["externalAssetId", "orderId", "name"],
  "items": [
    {
      "name": "USB cable",
      "quantity": 2,
      "labels": ["AliExpress", "Electronics"],
      "purchaseTime": "2026-05-17",
      "purchaseFrom": "AliExpress",
      "purchasePrice": 3.99,
      "manufacturer": "Generic",
      "modelNumber": "USB-C-1M",
      "notes": "Imported from order AE-123",
      "externalSource": "aliexpress",
      "externalAssetId": "AE-123:line-1",
      "orderId": "AE-123",
      "sourceUrls": ["https://example.com/order/AE-123"],
      "photoUrl": "https://example.com/cable.jpg"
    }
  ]
}
```

The result reports created, updated, skipped and per-item errors. Use `dryRun=true` before large imports.

## Locations And Tags

Use `homebox_resolve_location` for lookup-only resolution. It defaults to `createMissing=false`.

Use `homebox_find_or_create_location` when missing path segments should be created. It defaults to `createMissing=true`.

Both location tools accept paths like `Garage/Shelf` or `Garage > Shelf`.

Use `homebox_resolve_tags` with `labels` or `names`. It dedupes names, prefers exact case matches, falls back to case-insensitive matches, and can create missing tags.

## Photos And Attachments

Workflow photo tools prefer public `imageUrl` or `photoUrl` values. Server-local `filePath` is disabled unless the operator explicitly configures `HOMEBOX_MCP_LOCAL_FILE_ROOT`. The server confines resolved paths beneath that root, reads the file, base64-encodes it and uploads it. Never set this root to `HOMEBOX_MCP_DATA_DIR` or another directory containing OAuth data or secrets. Direct `base64` with `fileName` is the fallback.

Use full-size product images for primary photos. Do not upload externally generated thumbnails as primary photos unless the user explicitly wants the small image.

`homebox_upload_attachment` uploads base64 files as regular item attachments. If `primary=true` and `contentType` is `image/jpeg` or `image/png`, Homebox sets it as the primary item photo and may generate its own thumbnail.

Photo tools:

- `homebox_ensure_primary_photo` (preferred for agents): idempotent. Reuses an existing photo attachment by title or content hash; only uploads a new one when no match exists. Pass `cleanupDuplicates=true` to also delete other duplicate photos. Because that option deletes attachments, the tool is marked destructive.
- `homebox_replace_primary_photo`: uploads a new primary photo and deletes the previous primary by default. Use when you want a fresh attachment and removal of the old one.
- `homebox_upload_primary_photo_from_file`: always adds a new attachment. Does NOT replace or dedupe. Repeated calls produce duplicates — prefer `ensure_primary_photo` for set-primary operations.
- `homebox_cleanup_duplicate_photos`: removes duplicate photo attachments and always keeps one per title+mimeType group. `keepPrimary=true` prefers the current primary as keeper; `false` only disables that preference and still keeps one.

`homebox_create_item_full` and `homebox_upsert_items_bulk` use the idempotent ensure path internally, so retries and duplicate workflow calls will not create duplicate photo attachments.

## Low-Level API Requests

`homebox_api_request` is a low-level escape hatch supporting GET, POST, PUT, PATCH and DELETE. It can mutate or delete data and is marked destructive. Prefer typed tools.

Use it only when a typed tool does not expose the required endpoint or field. The caller is responsible for full Homebox payload compatibility. Absolute URLs are rejected; only relative `/api/v1/...` paths on the configured Homebox instance are allowed.
