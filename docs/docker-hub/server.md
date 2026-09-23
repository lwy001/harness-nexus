# Harness Nexus server

The backend of [Harness Nexus](https://github.com/sinrimin/harness-nexus) — a
unified management platform for agent-tool assets (Claude Code, ZCode,
Hermes) across machines. This image carries the Fastify REST API, the MCP
proxy (consume upstream MCP servers once, re-expose one aggregated
endpoint), and SQLite storage.

## Run

```bash
docker run -d --name harness-nexus-server \
  -p 8080:8080 \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -v hnx-data:/app/data \
  sinrimin/harness-nexus-server
```

`JWT_SECRET` (≥16 chars) is required — the server refuses to boot without
it. Optional env: `PORT` (default 8080), `STORAGE_DRIVER` (`sqlite` |
`memory`), `PUBLIC_BASE_URL` (required for the marketplace emitter in prod).

## Pair with the web UI

Run [`sinrimin/harness-nexus-web`](https://hub.docker.com/r/sinrimin/harness-nexus-web)
alongside it — the web image's nginx reverse-proxies `/api` and `/mcp` to
this container:

```yaml
services:
  server:
    image: sinrimin/harness-nexus-server
    environment:
      JWT_SECRET: change-me
    volumes:
      - hnx-data:/app/data
  web:
    image: sinrimin/harness-nexus-web
    ports:
      - '80:80'
    depends_on:
      - server
volumes:
  hnx-data:
```

Pre-1.0 alphas are published as `latest` (same policy as npm). Source,
docs, and the release process: <https://github.com/sinrimin/harness-nexus>.
