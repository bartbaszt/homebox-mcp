# Deployment

Instrukcja wdrożenia produkcyjnego przez Docker Compose z gotowym obrazem z GHCR.

## Wymagania

- Docker Engine z wtyczką Compose v2.
- Dostęp sieciowy z kontenera do `HOMEBOX_BASE_URL`.
- Publiczny adres HTTPS dla OAuth/ChatGPT (np. cloudflared tunnel).
- `HOMEBOX_MCP_API_TOKEN` albo `HOMEBOX_MCP_OAUTH_ENABLED=true` dla exposingu publicznego.

## Szybkie uruchomienie (GHCR)

Na serwerze docelowym:

```bash
mkdir -p /srv/homebox-mcp && cd /srv/homebox-mcp
```

Utwórz `compose.yml`:

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

Utwórz `.env` (przykład z OAuth dla ChatGPT za cloudflared):

```dotenv
HOMEBOX_BASE_URL=https://homebox.bbasztura.eu
HOMEBOX_MCP_HOST=0.0.0.0
HOMEBOX_MCP_PORT=3000
HOMEBOX_MCP_PATH=/mcp
HOMEBOX_MCP_PUBLISH_PORT=3101

HOMEBOX_MCP_API_TOKEN=T98f4q5WSHyMtkl0ig1Gj3QAwhoY2rPJIUCKXuONv6ZDRame

HOMEBOX_MCP_OAUTH_ENABLED=true
HOMEBOX_MCP_PUBLIC_URL=https://homebox-mcp.bbasztura.eu/mcp
HOMEBOX_MCP_OAUTH_ISSUER=https://homebox-mcp.bbasztura.eu
HOMEBOX_MCP_TRUST_PROXY=true
HOMEBOX_MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
HOMEBOX_MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
HOMEBOX_MCP_OAUTH_AUTH_CODE_TTL_SECONDS=300
HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=false

HOMEBOX_API_TIMEOUT_MS=30000
HOMEBOX_MCP_MAX_UPLOAD_BYTES=10485760
HOMEBOX_MCP_MAX_DOWNLOAD_BYTES=10485760
```

Logowanie do GHCR (repo prywatne, token z `read:packages` + `repo`):

```bash
echo ghp_TWÓJ_TOKEN | docker login ghcr.io -u bartbaszt --password-stdin
```

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

MCP endpoint lokalnie: `http://127.0.0.1:3101/mcp`

Publicznie (przez cloudflared): `https://homebox-mcp.bbasztura.eu/mcp`

## Cloudflared Tunnel

Przykładowa konfiguracja — tunnel kieruje ruch na `http://localhost:3101`:

```json
{
  "tunnel": "ID_TUNNELA",
  "ingress": [
    {
      "hostname": "homebox-mcp.bbasztura.eu",
      "service": "http://localhost:3101"
    }
  ]
}
```

Cloudflared automatycznie kończy TLS. `HOMEBOX_MCP_TRUST_PROXY=true` jest wymagane żeby Express ufał nagłówkom `X-Forwarded-*`.

## ChatGPT Configuration

W ChatGPT → Settings → Connectors (lub MCP Apps):

| Pole | Wartość |
|---|---|
| **Name** | Homebox |
| **URL** | `https://homebox-mcp.bbasztura.eu/mcp` |
| **Auth** | OAuth (auto-wykrywane przez `/.well-known/oauth-protected-resource`) |

Przy pierwszym połączeniu ChatGPT otwiera formularz logowania Homebox. Hasło jest jednorazowe — nie jest przechowywane. ChatGPT zapisuje parę tokenów OAuth w konfiguracji connectora. Następne wywołania narzędzi nie wymagają `sessionKey`.

### Autoryzacja statycznym tokenem (bez OAuth)

Dla klientów MCP nieobsługujących OAuth:

```
Authorization: Bearer <HOMEBOX_MCP_API_TOKEN>
```

Wtedy po połączeniu wywołaj `homebox_login` z credentialami Homebox i używaj zwróconego `sessionKey` w kolejnych wywołaniach.

## OAuth/ChatGPT — szczegóły

Zalecane wdrożenie: kontener słucha po HTTP, TLS kończy się w reverse proxy lub cloudflared.

`HOMEBOX_MCP_PUBLIC_URL` musi być dokładnym publicznym URL endpointu MCP z sufiksem `/mcp`, bo OAuth wiąże token z wartością `resource`.

Endpointy OAuth:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register` — dynamiczna rejestracja klienta (DCR)
- `GET/POST /oauth/authorize` — formularz logowania Homebox
- `POST /oauth/token` — authorization_code + refresh_token

Nie ustawiaj `HOMEBOX_MCP_OAUTH_ALLOW_INSECURE_HTTP=true` w produkcji.

## Direct HTTPS w kontenerze

Preferuj reverse proxy lub cloudflared. Jeśli musisz użyć HTTPS bezpośrednio w Node, zamontuj certyfikaty:

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

## Aktualizacja

Po nowym buildzie CI (push do `master`):

```bash
docker compose pull
docker compose up -d
docker compose logs -f homebox-mcp
```

## Zmiana portu hosta

`HOMEBOX_MCP_PORT` — port wewnątrz kontenera. Mapowanie w `compose.yml` `ports` steruje portem na hoście.

Przykład: kontener na `3000`, host publikuje `8080`:

```yaml
ports:
  - "8080:3000"
```

## Budowanie lokalne (bez GHCR)

Do develomentu lokalnego:

```bash
git clone https://github.com/bartbaszt/homebox-mcp.git
cd homebox-mcp
cp .env.example .env
# edytuj .env
docker compose up -d --build
```

Zmień w `compose.yml`:

```yaml
services:
  homebox-mcp:
    build:
      context: .
      dockerfile: Dockerfile
    # usuń: image: ghcr.io/bartbaszt/homebox-mcp:latest
```

## Rejestr obrazów CI

GitHub Actions (`.github/workflows/docker.yml`) buduje i publikuje obraz do `ghcr.io/bartbaszt/homebox-mcp` przy pushu do `master`. Tagi: `latest` + SHA commita.

## Uwagi bezpieczeństwa

- Nie commituj `.env`, tokenów, certyfikatów ani `.test-access`.
- Dla publicznego MCP wymagaj `HOMEBOX_MCP_API_TOKEN` albo OAuth.
- OAuth i mapowanie tokenów Homebox są w pamięci; restart kontenera wymaga ponownego połączenia klienta OAuth.
- Healthcheck `/health` nie ujawnia sekretów, pokazuje podstawowy status konfiguracji.
- Po wystawieniu na publiczną sieć zawsze używaj HTTPS (cloudflared/reverse proxy).