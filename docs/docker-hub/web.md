# Harness Nexus web

The admin UI of [Harness Nexus](https://github.com/sinrimin/harness-nexus) —
a React SPA served by nginx, with a reverse proxy that forwards `/api` and
`/mcp` to the server container. Dark/light "Signal" theme, English + 简体中文.

## Run

Pair it with [`sinrimin/harness-nexus-server`](https://hub.docker.com/r/sinrimin/harness-nexus-server)
(the compose file from that image's overview works as-is):

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

Only the web container needs a published port; it reaches the server on the
internal `server` hostname.

Pre-1.0 alphas are published as `latest` (same policy as npm). Source, docs,
and the release process: <https://github.com/sinrimin/harness-nexus>.
