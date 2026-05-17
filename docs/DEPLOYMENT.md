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
    image: ghcr.io/bartbaszt/homebox-mcp:latest
    restart: unless-stopped
    init: true
    env_file:
      - .env
    environment:
      HOMEBOX_MCP_HOST: "0.0.0.0"
      HOMEBOX_MCP_PORT: "3000"
      HOMEBOX_MCP_PATH: "/mcp"
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
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Create `.env`:

```dotenv
HOMEBOX_BASE_URL=https://homebox.example.com
HOMEBOX_MCP_HOST=0.0.0.0
HOMEBOX_MCP_PORT=3000
HOMEBOX_MCP_PATH=/mcp
HOMEBOX_MCP_PUBLISH_PORT=3101

# Required for externally exposed deployments
HOMEBOX_MCP_API_TOKEN=change-me-to-a-random-string

# Optional: enable ChatGPT-compatible OAuth
# HOMEBOX_MCP_OAUTH_ENABLED=true
# HOMEBOX_MCP_PUBLIC_URL=https://mcp.example.com/mcp
# HOMEBOX_MCP_OAUTH_ISSUER=https://mcp.example.com
# HOMEBOX_MCP_TRUST_PROXY=true
# HOMEBOX_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
# HOMEBOX_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
# HOMEBOX_MCP_OAUTH_AUTH_CODE_TTL_SECONDS=300
# HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=false

HOMEBOX_API_TIMEOUT_MS=30000
HOMEBOX_MCP_MAX_UPLOAD_BYTES=10485760
HOMEBOX_MCP_MAX_DOWNLOAD_BYTES=10485760
```

Log in to GHCR (required because the repo is private):

```bash
echo YOUR_GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

The PAT needs `read:packages` and `repo` scopes.

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

Set `HOMEBOX_MCP_TRUST_PROXY=true` so Express trusts these headers.

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

OAuth requires HTTPS. Set `HOMEBOX_MCP_PUBLIC_URL` to the exact public MCP endpoint URL including the `/mcp` path — the token is bound to this `resource` value.

Endpoints exposed when OAuth is enabled:

- `GET /.well-known/oauth-protected-resource` — resource metadata
- `GET /.well-known/oauth-authorization-server` — authorization server metadata
- `POST /oauth/register` — dynamic client registration (DCR)
- `GET /oauth/authorize` — Homebox login form
- `POST /oauth/authorize` — submit credentials, returns auth code
- `POST /oauth/token` — exchange auth code or refresh token

Do not set `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true` in production.

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

After a new CI build (push to `master`):

```bash
docker compose pull
docker compose up -d
docker compose logs -f homebox-mcp
```

Clean up old images:

```bash
docker image prune
```

## CI Image Registry

GitHub Actions (`.github/workflows/docker.yml`) builds and pushes the image to `ghcr.io/bartbaszt/homebox-mcp` on every push to `master`. Tags: `latest` + commit SHA.

## Security Notes

- Never commit `.env`, tokens, certificates, or `.test-access`.
- For any publicly exposed MCP server, require `HOMEBOX_MCP_API_TOKEN` or enable OAuth.
- OAuth tokens and Homebox session mappings are in-memory only; restarting the container invalidates all active sessions and requires reconnecting.
- The `/health` endpoint does not expose secrets but shows basic configuration status.
- Always use HTTPS (reverse proxy or tunnel) when exposing the service publicly.