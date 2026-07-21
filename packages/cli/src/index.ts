#!/usr/bin/env node
/**
 * `harness-nexus` / `hnx` — one-click install tool (Pillar #2/#3).
 *
 * Usage (intended):
 *   hnx install --profile frontend-daily --target zcode
 *   hnx install --profile base,frontend-daily --target claude-code --user ~/.claude
 *   hnx import superpower --release ./superpower-vX.tar.gz --into my-profile
 *
 * Design: the CLI can operate standalone (reading a local profile manifest
 * and writing into an Agent tool's config directories) or against a running
 * Harness Nexus server (fetching profiles via @harness-nexus/sdk). It must NOT
 * require the server to be running for the common install path.
 */
// eslint-disable-next-line no-console
console.log('harness-nexus CLI — skeleton. Subcommands: install / import / list. (TODO)');
