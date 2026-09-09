/**
 * Phase 8 C5 — one browser↔agent conversation channel. Created on
 * `chat:session.open`, routed over `/app` ↔ `/ctl`, backed by one daemon-side
 * ACP subprocess and one `chan:<sessionId>` room. Rows are RETAINED AS AUDIT
 * (who opened which channel when, why it closed): no FKs and no cascade —
 * they survive machine deletion (closed with `machine-deleted` instead).
 * Conversation content is never persisted here — the row is an audit record,
 * not a transcript. See docs/design/phase-8-c5.md.
 */
export interface AcSession {
  id: string;
  agentInstanceId: string;
  machineId: string;
  ownerId: string;
  openedAt: string;
  closedAt: string | null;
  /** user | spawn-failed | spawn-timeout | connection-lost | machine-deleted | agent-exited | server-shutdown */
  closeReason: string | null;
  /**
   * Phase 9 W6 — the session's working directory (the subdirectory of the
   * machine's base workspace picked at open). Null only on pre-W6 rows;
   * drives the session list's project grouping.
   */
  cwd: string | null;
  /**
   * Phase 9 W6 — derived once from the FIRST prompt (first line, collapsed,
   * ≤80 chars) for the session list. Null until the first prompt lands.
   */
  title: string | null;
}
