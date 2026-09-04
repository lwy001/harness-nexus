# Design: Phase 8 C1 — daemon + machine registration

> Status: in development (branch `phase-8-c1`). Parent design:
> `docs/design/phase-8-client.md` (protocol, isolation model, decisions) —
> this doc is the concrete C1 development plan. PRD: `docs/prd/phase-8-client.md`.

## Scope

C1 delivers the client unification foundation:

- **`Machine` domain entity + storage** (both drivers, SQLite migration `0006`).
- **Machine identity**: a dedicated PAT (scopes `['machine-ctl']`) issued once
  at enrollment, rejected by the REST auth hook (blast radius = realtime only).
- **Realtime channel v0**: Socket.IO over the server's HTTP port (`@fastify/socket.io`),
  namespaces `/ctl` (daemon) and `/app` (browser), per design-doc isolation rules.
- **`hnx enroll` + `hnx daemon`** (CLI grows into the client program);
  `packages/acp-bridge` is deleted.
- **Machines web page** with honest online/offline via `/app` push.

Not in C1 (per parent plan): jobs/dispatch (C4), MCP shim (C2), inventory (C3),
chat (C5). The `job:*` dispatch envelope schemas land in `shared/realtime.ts`
now (v0 shapes) so C4 doesn't touch the protocol file's framing — but no
handler exists yet.

## Tasks (dependency order)

1. **core** — `domain/machine.ts` (`Machine`: id, ownerId, name, hostname/os/
   arch/daemonVersion/capabilities reported at hello, `remoteChatEnabled`
   default false, `enrollmentPatId`, enrolledAt, lastSeenAt; **online is
   derived from socket presence, never stored**); port `MachineRepository`
   (findById / findByEnrollmentPatId / list({ownerId?}) / save / delete) on
   `UnitOfWork.machines`.
2. **shared** — `schemas/machine.ts` (createMachineSchema, updateMachineSchema)
   and `src/realtime.ts`: handshake auth schemas + `machine:hello` payload/ack
   + `machine:status` push + v0 `job:dispatch`/`jobView` shapes. Export both
   from index. Unit tests for parse/reject.
3. **server storage** — SQLite migration `0006` (`machines` table +
   owner/pat indexes), `sqliteMachineRepository` in `repos.ts`, memory driver
   repo, both wired into the returned `UnitOfWork`.
4. **server auth** — REST hook rejects PATs whose scopes include
   `machine-ctl` (next to the existing `marketplace` rejection).
5. **server realtime** — `src/plugins/realtime.ts` + `src/realtime/presence.ts`:
   - `MachinePresence` — pure presence state machine (machineId ↔ socketId,
     `connected` / `disconnected(socketId)` / `forceOffline`), unit-testable
     without sockets.
   - plugin: register `@fastify/socket.io` (explicit `maxHttpBufferSize`,
     websocket-only transport), decorate `app.presence`.
   - `/ctl` auth middleware: machine PAT (hash lookup, `machine-ctl` scope,
     expiry, user active) + `machineId` must match `enrollmentPatId`'s
     machine. Join `machine:<id>`; presence up; broadcast `machine:status`
     online to `user:<owner>` + `admins` on `/app`; save `lastSeenAt`.
   - `machine:hello` handler: zod-parse, persist daemon metadata, ack
     `{ proto: 1, machineId }`.
   - disconnect: presence down → broadcast offline + save `lastSeenAt`.
   - `/app` auth middleware: JWT or api-PAT (machine/marketplace rejected);
     join `user:<id>` (+ `admins` for admins). No handlers in C1 (push only).
6. **server routes** — `modules/machines.ts`: `POST /api/machines` (enroll:
   creates Machine + machine PAT, raw token returned once),
   `GET` (own; admin all; `online` from presence), `GET /:id` (owner-or-admin,
   404 else), `PATCH /:id` (name / remoteChatEnabled), `DELETE /:id`
   (revoke PAT + force socket offline). `machineView` in `serialize.ts`.
7. **sdk-ts** — `MachineView` + createMachine / listMachines / getMachine /
   updateMachine / deleteMachine.
8. **cli** — `hnx enroll --server <url> --token <userPAT> [--name]`
   (writes `~/.hnx/config.json` 0600: server, machineToken, machineId) and
   `hnx daemon` (reads config, socket.io-client to `/ctl`, `machine:hello` on
   every (re)connect with os/arch/hostname/version/capabilities, graceful
   SIGINT). `packages/acp-bridge` deleted.
9. **web** — `realtime.ts` (`/app` socket singleton, token re-read on
   reconnect), Machines page (list + online dot via push, enroll dialog with
   once-only token reveal + ready-to-paste `hnx enroll` command, remote-chat
   confirm toggle, revoke confirm), route + `navItems()` entry.
10. **verify** — `pnpm -r typecheck` + builds; vitest (realtime schemas,
    presence, machines REST via `app.inject`, machine-token REST rejection);
    smoke block: enroll → daemon connect (socket.io-client) → online →
    disconnect → offline → revoke → reconnect rejected.

## REST surface (C1)

| Method   | Path                | Who                    | Notes                                              |
| -------- | ------------------- | ---------------------- | -------------------------------------------------- |
| `POST`   | `/api/machines`     | authenticated user     | body `{ name }` → `201 { machine, token }` (once)  |
| `GET`    | `/api/machines`     | own; admin sees all    | `{ machines: MachineView[] }` incl. derived online |
| `GET`    | `/api/machines/:id` | owner or admin (404)   | `MachineView`                                      |
| `PATCH`  | `/api/machines/:id` | owner or admin         | `{ name? , remoteChatEnabled? }`                   |
| `DELETE` | `/api/machines/:id` | owner or admin         | revokes enrollment PAT + drops the live socket     |

Errors: `404 MACHINE_NOT_FOUND` (existence-hiding), `400 VALIDATION_ERROR`.

## Realtime events live in C1

`/ctl`: `machine:hello` (C→S, ack) — the only registered handler; anything
else gets no handler (sender ack-times-out).
`/app`: `machine:status` push only.

## Security notes

- Enrollment PAT revocation = deleting the machine (or the PAT) — the `/ctl`
  middleware re-verifies the PAT record on every (re)connect, and
  `DELETE /api/machines/:id` force-disconnects the live socket.
- `machine-ctl` PATs are rejected by the REST API hook (unit-tested).
- Raw machine tokens appear only in the enroll response (and the CLI config
  file, 0600). Log serializer keeps masking `Authorization`.
