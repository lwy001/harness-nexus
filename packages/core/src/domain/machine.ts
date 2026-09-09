/**
 * Phase 8 — a user's machine enrolled with this instance via the Harness
 * Nexus client (`hnx enroll`). The daemon on the machine authenticates to the
 * realtime channel (`/ctl`) with a dedicated machine PAT bound to the
 * `Machine` row. See docs/design/phase-8-client.md.
 */
export interface Machine {
  id: string;
  ownerId: string;
  /** User-assigned display name. */
  name: string;
  /** Daemon-reported metadata, refreshed on every `machine:hello`. */
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemonVersion: string | null;
  /** Feature tags the daemon advertises (e.g. future 'mcp-shim', 'deploy', 'acp'). */
  capabilities: string[];
  /**
   * Gates interactive chat sessions (C5). Off by default — talking to an
   * agent drives tool execution on the host machine.
   */
  remoteChatEnabled: boolean;
  /**
   * Phase 9 W6 — the machine's base workspace: the directory root under
   * which chat sessions pick their project cwd (the picker lists only its
   * subdirectories, routed through the daemon). Null = not configured; the
   * chat UI prompts the owner to set it before creating a session.
   */
  baseWorkspace: string | null;
  /**
   * The machine PAT issued once at enrollment. Deleting the machine (or this
   * PAT) revokes realtime access immediately.
   */
  enrollmentPatId: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  // NOTE: online/offline is NOT stored — it is derived from live socket
  // presence in the realtime layer (`MachinePresence`).
}
