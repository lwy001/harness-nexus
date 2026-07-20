# PRD: Phase 1 — Users, roles & authentication

> Status: implemented. Technical design: `docs/design/phase-1-auth.md`.

## Problem Statement

AgentNexus is a multi-user platform that manages sensitive assets (MCP server
credentials, profiles, access tokens). Before any of that can be exposed, there
must be a way to identify who is using the instance and to gate access so that
only the right people can read or change things. A fresh self-hosted instance
needs to be usable immediately — there is no admin password in a config file and
no CLI bootstrap step; the first person to arrive should be able to take ownership.

## Solution

A lightweight two-role identity system with two authentication channels. The
first user to register becomes the bootstrap admin; registration can later be
closed so only admins can add accounts. The web UI authenticates with JWT access
tokens; CLI/automation authenticates with personal access tokens (PATs). Both
channels share the same permission guards.

## User Stories

1. As a self-hoster, I want to register the first account and become admin, so that I can manage the instance without editing config files.
2. As a self-hoster, I want registration to be open by default, so that colleagues can sign themselves up.
3. As an admin, I want to close registration after onboarding, so that no one else can self-register.
4. As an admin, I want to create accounts directly even when registration is closed, so that I can onboard new members.
5. As a user, I want to log in with a username and password, so that I can access the web UI.
6. As a user, I want my session to persist, so that I don't have to log in on every page load.
7. As a user, I want to log out, so that my session ends on a shared machine.
8. As an automation author, I want to create a personal access token, so that my scripts can call the API without a browser login.
9. As an automation author, I want my PAT shown exactly once at creation, so that I can store it in a secret manager.
10. As an automation author, I want to revoke a PAT when it leaks, so that access is cut off.
11. As an admin, I want exactly two roles (admin and user), so that the permission model stays simple and predictable.
12. As an admin, I want non-admins to be blocked from user management and settings, so that only admins can change instance-wide config.
13. As an admin, I want to be prevented from deleting the last admin or demoting myself, so that the instance is never locked out.
14. As a user, I want to be prevented from deleting my own account, so that I don't accidentally lock myself out.
15. As an admin, I want a disabled user's tokens to stop working immediately, so that offboarding is effective.
16. As a user, I want to see a login page when I'm unauthenticated, so that I know how to proceed.
17. As a user, I want non-admins who hit an admin route to see a clear 403, so that it's obvious why access was denied.
18. As a user, I want the registration page to hide itself when registration is closed, so that I'm not surprised by an error after filling the form.
19. As a user, I want my password hashed with a strong algorithm, so that a database leak doesn't expose it.
20. As a user, I want reasonable password rules (8–256 chars), so that I can use a passphrase without arbitrary complexity requirements.
21. As a developer, I want username/password rules centralized in zod schemas, so that server, SDK, and web agree.
22. As a developer, I want permission checks enforced per-route, so that I don't accidentally leave a route unprotected.

## Implementation Decisions

- **Two roles only:** `admin` and `user`. Each user has exactly one role
  (`User.role`, not an array). All authorization branches on this field.
- **Two credential channels**, both via `Authorization: Bearer <credential>`:
  - JWT access token (primary, for the web UI) — signed with `JWT_SECRET`,
    verified statelessly with `jose`. Lifetime configurable (`JWT_ACCESS_TTL`,
    default `7d`).
  - PAT — format `anpat_<base64url(32)>`, stored as sha256. Resolved via DB
    lookup; `lastUsedAt` updated fire-and-forget.
- **Bootstrap:** the first registrant becomes admin (detected via `users.count()
=== 0`). Registration is **not** auto-closed after bootstrap.
- **Registration switch:** `SystemSettings.allowRegistration` (default open).
  `POST /api/auth/register` is gated by it; `POST /api/users` (admin) bypasses.
- **Password hashing:** argon2id (`@node-rs/argon2`), OWASP-recommended params.
- **Backend guards:** an `onRequest` hook on the **root** Fastify instance
  resolves either channel into `req.user = { id, role } | null`. Per-route
  `requireAuth` / `requireAdmin` preHandlers enforce 401 (anonymous) / 403
  (non-admin). (Root, not child-plugin, registration is load-bearing in Fastify.)
- **Frontend guards:** `<RequireAuth>` redirects to `/login`; `<RequireAdmin>`
  renders a 403 view. The SDK wrapper logs out on any 401 (`withAuthGuard`).
- **Disabled users:** a fresh user lookup on each protected request rejects
  disabled accounts (JWTs are stateless, so expiry alone is insufficient).
- **API surface:** `/api/auth/{register,login,me}`, `/api/users` (admin CRUD +
  role change), `/api/pats` (own CRUD), `/api/settings/registration` (GET public,
  PUT admin).
- **Validation:** zod schemas in `packages/shared/src/schemas/auth.ts` are the
  single source of truth.

## Testing Decisions

- The primary test seam is the **HTTP API** (`scripts/smoke.mjs`), exercising the
  end-to-end auth flow against a memory-driver server: bootstrap admin, second
  user, PAT issuance/use/revoke, registration switch, last-admin protection,
  self-delete protection, validation errors, 401/403 boundaries.
- Tests assert external behavior (status codes, response shapes), not internal
  implementation.
- Vitest is not yet wired; the smoke script is the current verification gate.

## Out of Scope

- Per-resource ownership checks (arrive with Phase 2 resources/profiles).
- Token refresh / rotation / blacklisting for JWTs (logout is client-side).
- OAuth / SSO / passwordless.
- Email verification or password reset flows.
- Finer-grained permissions beyond the two roles.

## Further Notes

- `JWT_SECRET` is required (≥16 chars) — the server refuses to boot without it.
  For local dev: `JWT_SECRET="$(openssl rand -base64 48)"`.
- For an ephemeral run without SQLite: `STORAGE_DRIVER=memory`.
- Full technical design (identity model, guard internals, safety rails, API
  table) lives in `docs/design/phase-1-auth.md`.
