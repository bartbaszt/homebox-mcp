# API Coverage

## Authentication

- `homebox_login`: `POST /api/v1/users/login`.
- `homebox_refresh_session`: `GET /api/v1/users/refresh`.
- `homebox_register_token`: register an existing Homebox token as a session.
- `homebox_logout`: remove an in-memory session.

## Instance

- `homebox_status`: `GET /api/v1/status`.
- `homebox_api_request`: any relative `/api/v1/...` path with GET/POST/PUT/PATCH/DELETE.

## Collections

- `homebox_list_collections`: `GET /api/v1/groups/all`.

HomeboxAiHelper verified groups as the stable collection-like concept in Homebox v0.25.0.

## Items

- `homebox_list_items`: `GET /api/v1/items` with pagination and optional collection query.
- `homebox_get_item`: `GET /api/v1/items/{id}`.
- `homebox_create_item`: `POST /api/v1/items`.
- `homebox_update_item`: GET-merge-`PUT /api/v1/items/{id}`.
- `homebox_patch_item`: `PATCH /api/v1/items/{id}`.
- `homebox_delete_item`: `DELETE /api/v1/items/{id}`.

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

## Version-Specific Gaps

Some Homebox versions expose extra endpoints. Use `homebox_api_request` for those until verified and promoted to a named tool.
