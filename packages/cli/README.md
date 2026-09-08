# @harness-nexus/cli

The `hnx` client for [Harness Nexus](https://github.com/sinrimin/harness-nexus) —
the data-plane half of a self-hosted control plane for coding agents. It runs
on each of your machines and does the local work: pulling profiles from your
server, installing them into agent tools, and keeping the machine connected.

> **Early stage.** Alpha software under active development — commands and
> behavior may change without notice.

## Install

Requires Node.js ≥ 20.

```sh
npm install -g @harness-nexus/cli
# or use it without installing:
npx @harness-nexus/cli --help
```

Both `hnx` and `harness-nexus` bin names are provided.

## Quick start

Point it at your Harness Nexus server (register a machine in the web UI's
Machines page first — the enrollment token is shown exactly once):

```sh
hnx enroll --server https://your-server --token <machine-token>
hnx daemon          # keep it connected (inventory, remote deploy, ACP chat)
```

Install a profile into a local agent tool (dry-run by default):

```sh
hnx install --profile <id> --server https://your-server --token <pat> \
  --target deepseek --apply
hnx uninstall --target deepseek --apply
```

Expose a profile's MCP servers to any MCP client as one local stdio server:

```sh
hnx mcp serve --profile <id> --server https://your-server
```

## Supported harnesses

One-click install + ACP chat: **Claude Code, Codex, DeepSeek Harness (dsh)**.

## Documentation

See the [repository README](https://github.com/sinrimin/harness-nexus) and
[`docs/`](https://github.com/sinrimin/harness-nexus/tree/main/docs) for
architecture, the roadmap, and per-phase design notes.

## License

MIT
