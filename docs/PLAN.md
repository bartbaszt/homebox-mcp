# Plan - Homebox MCP

## Goal

Create a remote MCP server for one Homebox instance. External agents connect over HTTP/HTTPS, authenticate to the MCP endpoint, then operate on Homebox as one of many Homebox users.

## Architecture

1. **HTTP layer**: Express server exposes `/health` and Streamable HTTP MCP at `/mcp`.
2. **MCP auth**: optional in local dev, mandatory for exposed deployments through `HOMEBOX_MCP_API_TOKEN`.
3. **Homebox client**: typed wrapper around `/api/v1` with normalized URL, timeout, auth header handling, and safe error messages.
4. **Session store**: in-memory map of `sessionKey -> Homebox token metadata`, supporting many users without storing passwords.
5. **Tools**: named MCP tools for verified operations plus generic `homebox_api_request` for API parity.
6. **Tests**: mocked integration tests for writes and edge cases; real E2E read-only against test Homebox credentials.

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

- No persistent token database in starter version.
- No destructive E2E by default.
- Generic request is restricted to relative `/api/v1/...` paths.
- Item full updates are GET-merge-PUT to avoid field loss.
