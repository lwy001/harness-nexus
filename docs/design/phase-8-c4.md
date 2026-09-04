# Design: Phase 8 C4 — remote deploy (jobs over the 3.3 pipeline + agent instances)

> Status: **planned** (branch `phase-8-c4`). Parent design:
> `docs/design/phase-8-client.md` § "Jobs & remote deploy (C4)". PRD:
> `docs/prd/phase-8-client.md` ("创建Agent则是可以选择一种支持的Agent+profile
> 一键部署"). C3: `docs/design/phase-8-c3.md` (shipped — inventory/import).

## Scope

C4 turns "install a profile on a machine" into a platform-issued, replayable
**job** — the create-agent half of the vision (`hnx install` stays as the
manual local path; same code, different trigger):

1. **Job model** (`core/domain/job.ts`, migration `0009`): `Job {id, machineId,
   ownerId, type: 'deploy', status: queued|dispatched|running|succeeded|failed|
   cancelled, payload, result, error, attempts, createdAt, updatedAt}` +
   `JobRepository` (findById / listByMachine / listRecoverable / save /
   deleteByMachine). `jobTypeSchema` keeps `'scan' | 'import'` reserved, but
   C3's interactive request/response flows STAY as they are — jobs exist for
   fire-and-forget work whose value is offline queue + replay (deploy); an
   interactive scan/import gains nothing from queue semantics (documented
   absorption decision, replaces the parent doc's "absorbs these flows").
2. **AgentInstance model** (same migration): `{id, machineId, ownerId, target,
   profileId, profileVersion, name, directory, jobId, createdAt, updatedAt}` —
   what C5 chats with and C6 orchestrates. Registered on deploy success;
   **upserted by (machineId, profileId)** so re-deploying = upgrading one
   instance. Machine delete cascades both tables.
3. **`JobService`** (`server/src/jobs/service.ts`, decorated `app.jobs`):
   - `createJob` → `queued`, immediate dispatch attempt when online.
   - Dispatch = emit `job:dispatch` `{job: JobView}` to `machine:<id>` on
     `/ctl` (ack = accepted, not completed) → status `dispatched`.
   - `onProgress` → `running` (phase/message are transient pushes, not
     persisted — the jobs table shows status, not a progress log).
   - `onResult` → `succeeded` (deploy + ok ⇒ register/upsert the
     AgentInstance from `result.data`) | `failed`.
   - `cancel` — **queued only** (`dispatched`/`running` are already with the
     daemon; killing a mid-apply install is not a v1 semantic →
     `409 JOB_NOT_CANCELLABLE`).
   - Recovery: machine **disconnect** ⇒ `dispatched`/`running` jobs revert to
     `queued` with `attempts+1` (plans are idempotent overwrites, so replay is
     safe) — `attempts ≥ jobMaxAttempts` (3) ⇒ `failed JOB_ABANDONED`. A
     periodic **sweep** (15s) reverts `dispatched` rows older than
     `jobAckTimeoutMs` (60s) the same way; `running` rows are never swept by
     timer (the daemon may legitimately still be working — disconnect is
     their only recovery path; documented).
   - Machine comes online ⇒ `dispatchPending` drains the queue.
   - Every transition pushes `job:update` `{job: JobView}` to the owner
     (+admins) on `/app`.
4. **REST** (`modules/jobs.ts`, machine owner-or-admin + 404-hiding):
   - `POST /api/machines/:id/jobs` `{profileId, directory?}` — profile must be
     visible and its target deployable (`DEPLOYABLE_TARGETS = hermes | codex`;
     claude-code is served by the 3.5 marketplace emitter instead →
     `409 TARGET_NOT_DEPLOYABLE`).
   - `GET /api/machines/:id/jobs` — newest first.
   - `POST /api/jobs/:id/cancel` — owner-or-admin.
   - `GET /api/machines/:id/agents` — AgentInstance rows for the machine.
5. **Deploy bundle** (`modules/client-config.ts` — machine PAT exception #2,
   identical auth/visibility treatment to `/api/client/mcp-config`):
   `GET /api/client/deploy-bundle?profile=<id>` → the `ResolvedProfile` JSON
   (`{profile, artifacts}`) the 3.3 resolver would otherwise fetch N+1. The
   job payload stays tiny; skill bundles don't fight `maxHttpBufferSize`.
6. **Daemon executor** (`cli/src/daemon/jobs.ts`, capability `'deploy'`):
   on `job:dispatch` → ack `{accepted:true}` → fetch the bundle with the
   machine PAT → set `HN_SERVER` → `planInstall` (progress `plan`) →
   `applyInstall` + ledger (progress `apply`) → `job:result` ok with
   `{name, directory, target, profileId, profileVersion}` or the error.
   `payload.directory` maps to the planner's `outDir` override.
7. **Web** (MachineDetail page grows a Deployments section): deploy form
   (profile picker filtered to deployable targets), a jobs table with live
   status via `job:update`, and the machine's agent instances. No new
   top-level route.
8. **SDK**: `createMachineJob` / `listMachineJobs` / `cancelJob` /
   `listMachineAgents` + `JobView` / `AgentInstanceView`.
9. **Config**: `JOB_ACK_TIMEOUT_MS` (60s), `JOB_SWEEP_INTERVAL_MS` (15s),
   `JOB_MAX_ATTEMPTS` (3).

## Job lifecycle (normative)

```
create ──▶ queued ──dispatch──▶ dispatched ──progress──▶ running ──result──▶ succeeded | failed
              ▲                    │                          │
              └── cancel ◀── (queued only)                    │
              ▲                                                    │
              └───── disconnect / ack-timeout sweep ◀─────────────┘
                     (attempts+1; attempts ≥ 3 ⇒ failed JOB_ABANDONED)
```

- Terminal states (`succeeded | failed | cancelled`) never transition again;
  late `job:progress`/`job:result` for a terminal job are ignored (stale
  daemon replay after recovery must not clobber a redelivered job's new
  attempt).
- A `dispatched` job that receives progress from a PREVIOUS attempt (stale
  socket delivery) is tolerated: progress for a `dispatched` job is accepted
  (it means the daemon started working — transition to running).

## Tasks (dependency order)

1. **shared** — `deployJobPayloadSchema`, `jobUpdateEventSchema`,
   `jobViewSchema.attempts` (additive optional), `agentInstanceViewSchema`.
   Unit tests.
2. **core** — `domain/job.ts` (Job + AgentInstance), ports + UnitOfWork arms.
3. **server storage** — migration `0009` (jobs + agent_instances, FKs
   cascade), repos in both drivers, machine-delete cascade.
4. **server jobs** — `JobService` + realtime wiring (`job:progress` /
   `job:result` handlers, online ⇒ `dispatchPending`, disconnect ⇒ recovery)
   + sweep lifecycle (start/stop with the app).
5. **server routes** — `modules/jobs.ts` + deploy-bundle in client-config +
   config keys.
6. **cli** — daemon job executor + capability bump.
7. **sdk + web** — methods/views + MachineDetail Deployments section.
8. **verify** — server integration with a fake daemon (offline create ⇒
   queued ⇒ connect ⇒ dispatched ⇒ progress ⇒ succeeded + AgentInstance
   upsert; failure path; queued cancel; 409 gates; disconnect recovery incl.
   attempts ⇒ JOB_ABANDONED with injected short timeouts); smoke `[8 C4]`
   with the REAL daemon dist: create profile+resources via API → create
   deploy job on a fixture-HOME machine → job succeeds → `~/.hermes` files +
   ledger + AgentInstance registered → redeploy same profile ⇒ same instance
   row upgraded, job #2 succeeded.

## Security notes

- The deploy bundle endpoint is machine-PAT reachable but bound to the
  machine owner's visibility — the same contract as `/api/client/mcp-config`
  (documented as REST exception #2). No other REST surface opens.
- Job payloads never carry secrets; the daemon fetches the bundle itself
  over TLS with its own token. `directory` is daemon-side validated by the
  planner's root resolution.
- `job:result.data` is daemon-reported and persisted verbatim — it contains
  paths/names only, and the server treats it as display data, not as an
  execution surface.
- Cancel is queued-only by design: interrupting a mid-apply install could
  leave a half-written agent home with no ledger; replay (idempotent
  overwrite) is the recovery story instead.

## Out of scope (explicit)

- Uninstall jobs (the local `hnx uninstall` remains the reversal path).
- Per-step persisted progress log / live log streaming (`job:progress`
  surfaces phase only in v1).
- Running-job timeout sweep (disconnect is the recovery path; documented).
- Deploy to `claude-code` (marketplace emitter is that target's path) and
  `zcode` (no adapter).
- Job scheduling/cron, concurrent per-machine job limits (v1 dispatches all
  queued jobs; the daemon executes serially per event loop anyway).
