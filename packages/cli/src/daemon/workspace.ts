import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceDirectory } from '@harness-nexus/shared';

/**
 * Workspace directory listing (Phase 9 W6) — one level of subdirectories for
 * the chat session picker. The server has ALREADY validated containment
 * against the machine's baseWorkspace before emitting `workspace:list`; this
 * module keeps the listing itself honest and bounded: directories only
 * (symlinks are excluded — `Dirent.isDirectory()` is false for them), hidden
 * `.*` entries skipped, name-sorted, capped at 512.
 */

const MAX_DIRECTORIES = 512;

export async function listDirectories(path: string): Promise<WorkspaceDirectory[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const out: WorkspaceDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // skips files AND symlinks-to-dirs
    if (entry.name.startsWith('.')) continue;
    out.push({ name: entry.name, path: join(path, entry.name) });
    if (out.length >= MAX_DIRECTORIES) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
