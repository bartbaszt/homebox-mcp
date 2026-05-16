# Testing

## Mocked Integration Tests

Run:

```powershell
npm test
```

Coverage:

- URL normalization.
- Login and session registration.
- Token refresh with no double `Bearer` prefix.
- Item listing and detail calls.
- Full item update via GET-merge-PUT preserving custom fields and tags.
- MCP endpoint API-token enforcement.
- Tool calls through Streamable HTTP client.

## Real E2E

Run against HomeboxAiHelper test instance:

```powershell
$env:HOMEBOX_E2E = "1"
$env:HOMEBOX_TEST_ACCESS_FILE = "C:\__program\HomeboxAiHelper\.test-access"
npm run test:e2e
```

The default E2E is read-only:

- Starts Homebox MCP HTTP server on an ephemeral local port.
- Connects through MCP Streamable HTTP.
- Verifies MCP endpoint auth failure without token.
- Logs into Homebox with credentials from `.test-access`.
- Refreshes token.
- Reads status, collections/groups, items, item detail, locations, tags, custom fields, custom field values for one existing field.
- Verifies generic `homebox_api_request`.
- Verifies bad session handling.

Destructive E2E is intentionally off by default. Enable only on disposable instances:

```powershell
$env:HOMEBOX_E2E_DESTRUCTIVE = "1"
npm run test:e2e
```
