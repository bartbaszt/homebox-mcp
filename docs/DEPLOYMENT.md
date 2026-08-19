# Deployment

Production deployment guide using Docker Compose with pre-built images from GHCR or local builds.

## Requirements

- Docker Engine with Compose v2 plugin.
- Network access from the container to `HOMEBOX_BASE_URL`.
- Public HTTPS address for OAuth/ChatGPT (e.g. via reverse proxy or Cloudflare Tunnel).
- `HOMEBOX_MCP_API_TOKEN` or `HOMEBOX_MCP_OAUTH_ENABLED=true` for any externally exposed deployment.

## Quick Start (GHCR Image)

On the target host:

```bash
mkdir -p /srv/homebox-mcp && cd /srv/homebox-mcp
```

Create `compose.yml`:

```yaml
name: homebox-mcp

services:
  homebox-mcp:
    # Pin an exact release (e.g. 0.1.0) for reproducible deploys. See "CI Image Registry" below.
    image: ghcr.io/bartbaszt/homebox-mcp:latest
    restart: unless-stopped
    init: true
    env_file:
      - .env
    environment:
      HOMEBOX_MCP_HOST: "0.0.0.0"
      HOMEBOX_MCP_PORT: "3000"
      HOMEBOX_MCP_PATH: "/mcp"
      HOMEBOX_MCP_DATA_DIR: "/data"
    ports:
      - "3101:3000"
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - homebox-mcp-data:/data
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

volumes:
  homebox-mcp-data:
```

Create `.env`:

```dotenv
HOMEBOX_BASE_URL=https://homebox.example.com
HOMEBOX_MCP_HOST=0.0.0.0
HOMEBOX_MCP_PORT=3000
HOMEBOX_MCP_PATH=/mcp
HOMEBOX_MCP_PUBLISH_PORT=3101

# Required for externally exposed deployments unless OAuth is enabled.
# Placeholder values such as change-me are rejected at startup.
HOMEBOX_MCP_API_TOKEN=replace-with-a-long-random-token

# Optional: enable ChatGPT-compatible OAuth
# HOMEBOX_MCP_OAUTH_ENABLED=true
# Required with OAuth; the path must match HOMEBOX_MCP_PATH.
# HOMEBOX_MCP_PUBLIC_URL=https://mcp.example.com/mcp
# HOMEBOX_MCP_OAUTH_ISSUER=https://mcp.example.com
# HOMEBOX_MCP_TRUST_PROXY=127.0.0.1,::1
# HOMEBOX_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
# HOMEBOX_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
# HOMEBOX_MCP_OAUTH_AUTH_CODE_TTL_SECONDS=300
# HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=false
# Recommended for self-hosted OAuth: allowlist the exact client redirect origins.
# Unset means dynamic client registration accepts any HTTPS redirect origin.
# HOMEBOX_MCP_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com

# Persist OAuth client registrations/tokens across container restarts
HOMEBOX_MCP_DATA_DIR=/data

# Optional local photo uploads. Requires a separate read-only volume mounted at /photos.
# Never point this at /data or any directory containing credentials.
# HOMEBOX_MCP_LOCAL_FILE_ROOT=/photos

# Exact browser origins allowed to call /mcp cross-origin. Unset means no CORS headers.
# HOMEBOX_MCP_ALLOWED_ORIGINS=https://app.example.com

HOMEBOX_API_TIMEOUT_MS=30000
HOMEBOX_MCP_MAX_UPLOAD_BYTES=10485760
HOMEBOX_MCP_MAX_DOWNLOAD_BYTES=10485760
```

The image is public, so no `docker login` is needed.

Start:

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f homebox-mcp
```

Healthcheck:

```bash
curl http://127.0.0.1:3101/health
```

## Local Build (Without GHCR)

```bash
git clone https://github.com/bartbaszt/homebox-mcp.git
cd homebox-mcp
cp .env.example .env
# edit .env
docker compose up -d --build
docker compose logs -f homebox-mcp
```

This uses the `build:` directive in the shipped `docker-compose.yml` to build locally.

To enable workflow `filePath` photo uploads, mount a dedicated directory read-only and set the opt-in root:

```yaml
environment:
  HOMEBOX_MCP_LOCAL_FILE_ROOT: /photos
volumes:
  - /srv/homebox-photos:/photos:ro
```

Without this setting, `filePath` is rejected. The root must be an existing directory and must not contain `/data`, TLS keys, OAuth data, or other secrets.

## Changing the Host Port

`HOMEBOX_MCP_PORT` is the internal container port. The `ports` mapping in `compose.yml` controls the host port.

Example — container stays on `3000`, host publishes `8080`:

```yaml
ports:
  - "8080:3000"
```

`HOMEBOX_MCP_PUBLISH_PORT` is only used by `docker-compose.yml` (development template). For production `compose.yml`, set the port directly in the `ports` mapping.

## Reverse Proxy / Tunnel

Recommended: run the container on internal HTTP and terminate TLS in a reverse proxy or tunnel (Nginx, Caddy, Cloudflare Tunnel, etc.).

The proxy must forward traffic to the container and preserve standard headers:

- `X-Forwarded-Proto`
- `X-Forwarded-Host`
- `X-Forwarded-For`

Set `HOMEBOX_MCP_TRUST_PROXY` to the exact reverse-proxy addresses or CIDRs, comma-separated, so Express trusts forwarded headers only from those peers. Value `true` is retained as shorthand for loopback proxies only. Never trust all private networks on an externally reachable listener.

### Cloudflare Tunnel Example

```json
{
  "tunnel": "YOUR_TUNNEL_ID",
  "ingress": [
    {
      "hostname": "mcp.example.com",
      "service": "http://localhost:3101"
    }
  ]
}
```

Cloudflare terminates TLS automatically. No cert files needed.

## ChatGPT Configuration

In ChatGPT → Settings → Connectors (or MCP Apps):

| Field | Value |
|---|---|
| **Name** | Homebox |
| **URL** | `https://mcp.example.com/mcp` |
| **Auth** | OAuth (auto-discovered via `/.well-known/oauth-protected-resource`) |

On first connection, ChatGPT opens a Homebox login form. The password is used once and discarded. ChatGPT stores the OAuth token pair in connector settings. Subsequent tool calls work without `sessionKey`.

### Static Token Auth (Without OAuth)

For MCP clients that don't support OAuth:

```
Authorization: Bearer <HOMEBOX_MCP_API_TOKEN>
```

Then call `homebox_login` with Homebox credentials and use the returned `sessionKey` for subsequent tool calls.

## OAuth Details

OAuth requires HTTPS. `HOMEBOX_MCP_PUBLIC_URL` is required whenever `HOMEBOX_MCP_OAUTH_ENABLED=true` and must be the exact public MCP endpoint URL including the `HOMEBOX_MCP_PATH` path (`/mcp` by default) — access tokens are bound to this value as their `resource` identifier.

The server refuses to start when the public URL is missing or when its path does not match `HOMEBOX_MCP_PATH`. Deriving the identifier from the request `Host` header is only permitted for loopback development (`HOMEBOX_MCP_HOST` loopback, `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true`, `HOMEBOX_MCP_TRUST_PROXY` unset), because a reverse proxy, tunnel or extra DNS alias changes the derived value and invalidates already issued tokens.

Upgrade note: deployments that previously set only the origin (for example `https://mcp.example.com`) must append the MCP path. The `resource` identifier changes with it, so connectors have to be re-authorized once.

Set `HOMEBOX_MCP_DATA_DIR=/data` and mount a private writable volume at `/data` so OAuth dynamic client registrations, access tokens, refresh tokens and mapped Homebox sessions survive container restarts. The persisted file is `oauth-store.json` and contains Homebox tokens; do not share or commit it.

When OAuth authenticates an MCP connection, tool-level `sessionKey` and raw `token` inputs are rejected. The OAuth-authorized Homebox session is always used for that connection.

Endpoints exposed when OAuth is enabled:

- `GET /.well-known/oauth-protected-resource` — resource metadata
- `GET /.well-known/oauth-authorization-server` — authorization server metadata
- `POST /oauth/register` — dynamic client registration (DCR)
- `GET /oauth/authorize` — consent screen and Homebox login form
- `POST /oauth/authorize` — consent decision plus credentials, returns auth code
- `POST /oauth/token` — exchange auth code or refresh token

`POST /oauth/token` with `grant_type=refresh_token` answers `503 temporarily_unavailable` plus `Retry-After` when Homebox is unreachable or fails with a 5xx. The refresh token is preserved in that case, so the client must retry instead of re-running the authorization flow. `400 invalid_grant` means the grant is gone for good and the connection has to be re-authorized.

Do not set `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true` in production.

### Consent And Redirect Allowlist

Dynamic client registration accepts any HTTPS redirect origin by default, which is what browser connectors require. Two controls keep that from becoming silent delegated access:

1. **Consent screen (always on).** `/oauth/authorize` shows the client name (declared by the client, marked unverified), the host that will receive the authorization code, the requested scope, the MCP `resource` and the client ID. A code is only issued for `action=allow`; `action=deny` redirects back with `error=access_denied` without using the submitted credentials, and a missing decision re-renders the screen. The page carries `Content-Security-Policy` (`default-src 'none'`, hashed inline stylesheet, `form-action 'self' <redirect-origin>`, `base-uri 'none'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. The redirect origin has to appear in `form-action` because the successful submit ends in a cross-origin 302 and some browsers enforce `form-action` against post-submit redirects.
2. **Redirect allowlist (recommended, opt-in).** `HOMEBOX_MCP_OAUTH_ALLOWED_REDIRECT_ORIGINS` restricts which redirect origins may register and authorize at all:

```dotenv
HOMEBOX_MCP_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com
```

At most 16 bare origins, comma-separated, no path/query/fragment/credentials, `*` rejected. Requires `HOMEBOX_MCP_OAUTH_ENABLED=true`. A loopback entry without a port (`http://127.0.0.1`) matches any port, per RFC 8252 section 7.3. Unlisted origins get `400 invalid_redirect_uri` at `POST /oauth/register`; the same check runs at `/oauth/authorize`, so tightening the value also invalidates clients already persisted in `oauth-store.json`.

## Direct HTTPS in Container

Prefer a reverse proxy or tunnel. If you must run HTTPS directly in Node, mount certificates:

```yaml
services:
  homebox-mcp:
    volumes:
      - /opt/homebox-mcp/certs:/certs:ro
```

```dotenv
HOMEBOX_MCP_TLS_KEY=/certs/homebox-mcp.key
HOMEBOX_MCP_TLS_CERT=/certs/homebox-mcp.crt
```

## Updates

After a new release (or a new `master` build when tracking `edge`):

```bash
docker compose pull
docker compose up -d
docker compose logs -f homebox-mcp
curl -s http://127.0.0.1:3101/health   # confirm the reported version
```

Clean up old images:

```bash
docker image prune
```

## CI Image Registry

GitHub Actions (`.github/workflows/docker.yml`) builds and pushes public images to `ghcr.io/bartbaszt/homebox-mcp`. No registry login is required to pull.

| Tag | Built from | Notes |
|---|---|---|
| `X.Y.Z` | git tag `vX.Y.Z` | immutable, recommended for production |
| `X.Y` | git tag `vX.Y.Z` | moves forward on patch releases only |
| `latest` | newest git tag `vX.Y.Z` | releases only, never unreleased `master` |
| `edge` | every push to `master` | unreleased, may break |
| `sha-<commit>` | every build | pin for debugging |

Versioning is SemVer. Pre-1.0 a minor bump (`0.1.x` to `0.2.0`) may change configuration or tool contracts, so `X.Y` is the safest floating tag. Release tags must match `package.json`; CI fails the build otherwise.

The deployed build is reported as `version` by `GET /health`, baked into the image through the `APP_VERSION` build argument and the `org.opencontainers.image.version` label.

Release flow:

```bash
npm version minor        # or patch; creates the commit and the vX.Y.Z tag
git push --follow-tags
gh release create vX.Y.Z --title vX.Y.Z --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)
```

## Security Notes

- Never commit `.env`, tokens, certificates, or `.test-access`.
- For any publicly exposed MCP server, require `HOMEBOX_MCP_API_TOKEN` or enable OAuth.
- The server refuses to listen on non-local hosts without `HOMEBOX_MCP_API_TOKEN` or OAuth enabled, and rejects placeholder API tokens such as `change-me`.
- OAuth tokens and Homebox session mappings are persisted only when `HOMEBOX_MCP_DATA_DIR` is set. The data directory contains secrets and must not be committed or exposed.
- The `/health` endpoint does not expose secrets but shows basic configuration status.
- Always use HTTPS (reverse proxy or tunnel) when exposing the service publicly.
