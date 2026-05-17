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

Call `homebox_api_surface` when unsure.

Use item tools when it returns `items`, which is legacy Homebox v0.25 behavior:

- `homebox_list_items`
- `homebox_get_item`
- `homebox_create_item`
- `homebox_update_item`
- `homebox_upload_attachment`

Use entity tools when it returns `entities`, which is the newer Entity Merge API:

- `homebox_list_entities`
- `homebox_get_entity`
- `homebox_create_entity`
- `homebox_patch_entity`
- `homebox_upload_entity_attachment`

Most item/entity tool families auto-route internally, but choosing the matching family keeps prompts and field names clearer.

## Homebox UI Field Mapping

Use API field names in tool payloads.

| Homebox UI | API field |
|---|---|
| Purchase date / Data zakupu | `purchaseTime` |
| Purchased from / Zakupiono od | `purchaseFrom` |
| Purchase price / Cena zakupu | `purchasePrice` |
| Manufacturer / Producent | `manufacturer` |
| Model | `modelNumber` |
| Serial number / Numer seryjny | `serialNumber` |
| Notes / Notatki | `notes` |
| Location / Lokalizacja | `locationId` |
| Tags / Tagi | `tagIds` |
| Primary photo / thumbnail | primary attachment or `imageId` |

Use `purchaseTime` for purchase date. Do not use `purchaseDate`.

## Safe Homebox v0.25 Updates

Homebox v0.25 can fail partial `PUT /items/{id}` with `500 Unknown Error`. Use `homebox_update_item` for partial updates. It reads the current item, merges `patch`, preserves custom fields/tags/location, then sends a full PUT payload.

Supported `patch` fields for v0.25 items include:

```text
name, description, quantity, insured, archived, assetId, serialNumber,
modelNumber, manufacturer, lifetimeWarranty, warrantyExpires,
warrantyDetails, purchaseTime, purchaseFrom, purchasePrice,
soldTime, soldTo, soldPrice, soldNotes, notes, locationId, tagIds, fields
```

Example:

```json
{
  "sessionKey": "session-123",
  "itemId": "item-uuid",
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

Homebox v0.25 may ignore some fields during item creation. If purchase or manufacturer/model fields matter, verify with `homebox_get_item` and patch missing fields.

Homebox `assetId` may be auto-generated. Store external order IDs such as AliExpress `AE-*` in `notes` or custom fields unless overwriting `assetId` is intentional and verified.

Large mixed update patches may cause Homebox 500. Prefer smaller patches when updating legacy v0.25 items.

## Recommended Purchase Import Workflow

For one item, prefer `homebox_create_item_full`.

For many items, prefer `homebox_import_items_bulk` or `homebox_upsert_items_bulk`.

Manual workflow when needed:

1. Resolve location by name with `homebox_resolve_location` or `homebox_find_or_create_location`.
2. Resolve or create tags with `homebox_resolve_tags`.
3. Create an item with stable fields: `name`, `description`, `quantity`, `locationId`, `tagIds`.
4. Patch purchase and detail fields: `purchasePrice`, `purchaseTime`, `purchaseFrom`, `manufacturer`, `modelNumber`, `notes`.
5. Upload the primary photo.
6. Verify final fields with `homebox_get_item`.

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

Workflow photo tools prefer public `imageUrl` or `photoUrl` values. Local file paths such as `/mnt/data/...` are not supported. Direct `base64` with `fileName` is the fallback.

Use full-size product images for primary photos. Do not upload externally generated thumbnails as primary photos unless the user explicitly wants the small image.

`homebox_upload_attachment` uploads base64 files as regular item attachments. If `primary=true` and `contentType` is `image/jpeg` or `image/png`, Homebox sets it as the primary item photo and may generate its own thumbnail.

## Low-Level API Requests

`homebox_api_request` is a low-level escape hatch. Prefer typed tools.

Use it only when a typed tool does not expose the required endpoint or field. The caller is responsible for full Homebox payload compatibility. Absolute URLs are rejected; only relative `/api/v1/...` paths on the configured Homebox instance are allowed.
