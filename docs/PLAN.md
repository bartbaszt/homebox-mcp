# Plan - Homebox MCP

## Goal

Create a remote MCP server for one Homebox instance. External agents connect over HTTP/HTTPS, authenticate to the MCP endpoint, then operate on Homebox as one of many Homebox users.

## Architecture

1. **HTTP layer**: Express server exposes `/health` and Streamable HTTP MCP at `/mcp`.
2. **MCP auth**: optional on local loopback, fail-closed on non-local listeners unless `HOMEBOX_MCP_API_TOKEN` is set or OAuth is enabled.
3. **Homebox client**: typed wrapper around `/api/v1` with normalized URL, timeout, auth header handling, and safe error messages.
4. **Session store**: in-memory map of `sessionKey -> Homebox token metadata`, supporting many users without storing passwords.
5. **OAuth persistence**: optional `HOMEBOX_MCP_DATA_DIR` writes OAuth clients/tokens/session mappings to `oauth-store.json` so ChatGPT connectors survive restarts.
6. **Tools**: named MCP tools for verified operations plus generic `homebox_api_request` for API parity.
7. **Tests**: mocked integration tests for writes and edge cases; real E2E read-only against test Homebox credentials.

## Delivery Steps

1. Bootstrap Node/TypeScript project.
2. Transfer HomeboxAiHelper rules that matter for API auth, item updates, secrets, and tests.
3. Implement Homebox API client and session store.
4. Implement Streamable HTTP MCP server with API-token guard.
5. Register Homebox tools with read-only/destructive annotations.
6. Add mocked integration tests for auth, client behavior, merge PUT, and MCP endpoint auth.
7. Add real E2E test over HTTP MCP transport using HomeboxAiHelper `.test-access`.
8. Run install, build, mocked tests, and real E2E.

## Remote Access

- Default listener: `0.0.0.0:3000`.
- MCP endpoint: `http://host:3000/mcp`.
- External agent auth: `Authorization: Bearer <HOMEBOX_MCP_API_TOKEN>` or `X-API-Key: <token>`.
- HTTPS options: direct Node TLS via `HOMEBOX_MCP_TLS_KEY` and `HOMEBOX_MCP_TLS_CERT`, or reverse proxy TLS.

## Risk Controls

- OAuth persistence is opt-in through `HOMEBOX_MCP_DATA_DIR`; the data directory contains Homebox tokens and must stay private.
- OAuth-authenticated tool calls reject caller-provided `sessionKey` and raw Homebox `token` values to prevent cross-user session use.
- Public URL downloads validate redirect targets, block private/reserved DNS resolutions, and stream bodies with hard byte limits.
- Legacy SSE keeps an in-memory sessionId-to-transport registry; Streamable HTTP remains the primary transport.
- No destructive E2E by default.
- Generic request is restricted to relative `/api/v1/...` paths.
- Item full updates are GET-merge-PUT to avoid field loss.
