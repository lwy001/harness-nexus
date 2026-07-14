#!/usr/bin/env node
/**
 * `agent-nexus` / `anx` — one-click install tool (Pillar #2/#3).
 *
 * Usage (intended):
 *   anx install --profile frontend-daily --target zcode
 *   anx install --profile base,frontend-daily --target claude-code --user ~/.claude
 *   anx import superpower --release ./superpower-vX.tar.gz --into my-profile
 *
 * Design: the CLI can operate standalone (reading a local profile manifest
 * and writing into an Agent tool's config directories) or against a running
 * AgentNexus server (fetching profiles via @agent-nexus/sdk). It must NOT
 * require the server to be running for the common install path.
 */
// eslint-disable-next-line no-console
console.log('agent-nexus CLI — skeleton. Subcommands: install / import / list. (TODO)');
