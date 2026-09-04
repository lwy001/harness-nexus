/**
 * Phase 8 C4 — a unit of replayable work executed by a machine's daemon over
 * `/ctl` (`job:dispatch` → `job:progress` → `job:result`). C4 ships the
 * `deploy` type (remote profile install reusing the 3.3 pipeline); `scan` /
 * `import` stay interactive (C3) and remain reserved in the type union.
 * See docs/design/phase-8-c4.md.
 */
import type { AgentTarget } from './resource.js';

export type JobType = 'deploy' | 'import' | 'scan';

export type JobStatus = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  machineId: string;
  ownerId: string;
  type: JobType;
  status: JobStatus;
  /** `{profileId, directory?}` for deploys (validated in shared). */
  payload: Record<string, unknown>;
  /** Terminal data (a `DeployResultData`-shaped object for deploys). */
  result: unknown;
  error: string | null;
  /** Delivery attempts; disconnect/ack-timeout recoveries increment it. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One deployed agent on a machine — the addressable unit C5 chats with and
 * C6 orchestrates. Upserted by (machineId, profileId): re-deploying a profile
 * upgrades the same instance instead of duplicating it.
 */
export interface AgentInstance {
  id: string;
  machineId: string;
  ownerId: string;
  target: AgentTarget;
  profileId: string;
  profileVersion: string | null;
  /** Display name (the profile's name at deploy time unless overridden). */
  name: string;
  /** Install root on the machine (daemon-reported, display only). */
  directory: string;
  /** The job that produced/upgraded this instance. */
  jobId: string;
  createdAt: string;
  updatedAt: string;
}
