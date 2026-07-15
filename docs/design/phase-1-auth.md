# Authentication & Authorization design (Phase 1)

> Status: implemented in Phase 1. Covers two roles, JWT access tokens, PAT, a
> toggleable registration switch, and front- and back-end permission guards.

## Identity model

### Roles

Exactly two roles. No third role will be added in Phase 1.

| Role    | Capabilities                                                          |
| ------- | --------------------------------------------------------------------- |
| `user`  | Manage own resources/profiles/PATs; read global resources/profiles.   |
| `admin` | Everything a `user` can do, plus user management and system settings. |

A user holds **exactly one role** (`User.role`, not an array). All authorization
decisions branch on this single field.

### User aggregate (`packages/core/src/domain/user.ts`)

```ts
type Role = 'admin' | 'user';

interface User {
  id: string;
  username: string;
  email?: string;
  passwordHash: string | null; // argon2id; null only for future passwordless accounts
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}
```

### System settings (`packages/core/src/domain/settings.ts`)

A single-row aggregate persisted in `system_settings`. Phase 1 uses one field.

```ts
interface SystemSettings {
  allowRegistration: boolean; // default true on first boot
  updatedAt: string;
}
```

## Two authentication channels

Both arrive via `Authorization: Bearer <credential>`. The auth plugin distinguishes
them by prefix:

1. **JWT access token** (primary, for the web UI). Issued by `POST /api/auth/login`
   and `POST /api/auth/register`. Format: a standard JWT signed with `JWT_SECRET`.
   Lifetime: 7 days (configurable via `JWT_ACCESS_TTL`). Stateless — the server
   verifies the signature and expiry, no DB lookup needed.
2. **PAT** (for CLI / automation / SDK). Format: `anpat_<base64url(32 random bytes)>`.
   Only its **sha256** is stored. Resolved via a DB lookup on each request;
   `lastUsedAt` is updated fire-and-forget.

After the `onRequest` hook, both channels produce the same shape on the request:

```ts
req.user: { id: string; role: Role } | null
```

Failed or missing auth leaves `req.user = null` (no error thrown at this stage —
route guards decide whether that's allowed).

## Permission guards (the "interceptors")

### Backend — `requireAuth` / `requireAdmin`

Decorated onto the Fastify instance. They are **preHandler** hooks attached per
route (or per router prefix), not global:

```ts
app.get('/api/auth/me', { preHandler: [app.requireAuth] }, handler);
app.post('/api/users', { preHandler: [app.requireAdmin] }, handler);
```

- `requireAuth`: `req.user === null` → `401 { error: 'UNAUTHORIZED' }`.
- `requireAdmin`: `requireAuth` first, then `req.user.role !== 'admin'` →
  `403 { error: 'FORBIDDEN' }`.

Public routes (`/healthz`, `/readyz`, `/api/auth/login`, `/api/auth/register`
when open) attach neither guard.

### Frontend — `<RequireAuth>` / `<RequireAdmin>`

React Router layout routes:

- `<RequireAuth>`: if no token/user → redirect to `/login?from=…`.
- `<RequireAdmin>`: if `user.role !== 'admin'` → render a 403 view (no redirect
  loop).

Additionally the API wrapper centralizes the **401 interceptor**: any fetch
returning 401 clears the stored token/user and redirects to `/login`.

## Registration switch & first admin

- `SystemSettings.allowRegistration` defaults to **true** on first boot.
- `POST /api/auth/register`:
  - If `allowRegistration === false` → `403 REGISTRATION_DISABLED`. (Admins use
    `POST /api/users` to add accounts, which bypasses the switch.)
  - If the `users` table is **empty**, the new user is created with role `admin`
    (the bootstrap admin). Subsequent registrations get role `user`.
- `PUT /api/settings/registration` (admin only) toggles the switch.

Rationale: the first registrant becomes admin so a fresh self-hosted instance is
usable without env vars or CLI steps. Registration is **not** auto-closed after
bootstrap — the admin decides.

## API surface (Phase 1)

All under `/api`, JSON bodies. `{ error, message }` error shape.

| Method | Path                         | Auth           | Notes                                                  |
| ------ | ---------------------------- | -------------- | ------------------------------------------------------ |
| POST   | `/api/auth/register`         | public*        | *only when `allowRegistration`; first user → admin     |
| POST   | `/api/auth/login`            | public         | returns `{ token }` JWT                                |
| GET    | `/api/auth/me`               | `requireAuth`  | current user                                           |
| POST   | `/api/users`                 | `requireAdmin` | create user, bypasses registration switch              |
| GET    | `/api/users`                 | `requireAdmin` | list users                                             |
| DELETE | `/api/users/:id`             | `requireAdmin` | no self-delete, no deleting the last admin             |
| PATCH  | `/api/users/:id/role`        | `requireAdmin` | change role; cannot demote the last admin              |
| POST   | `/api/pats`                  | `requireAuth`  | create PAT, returns plaintext once                     |
| GET    | `/api/pats`                  | `requireAuth`  | list caller's own PATs                                 |
| DELETE | `/api/pats/:id`              | `requireAuth`  | revoke own PAT                                         |
| GET    | `/api/settings/registration` | public         | `{ allowRegistration }` — login/register pages need it |
| PUT    | `/api/settings/registration` | `requireAdmin` | `{ allowRegistration }`                                |

\* `/api/settings/registration` GET is intentionally public so the register page
can show/hide itself without a login.

## Token storage & invalidation

- **JWT**: stateless. There is no built-in revocation. Logout is client-side
  (drop the token). Rotating `JWT_SECRET` invalidates all outstanding tokens.
- **PAT**: stored as sha256 hash + prefix. Revocable by `DELETE /api/pats/:id`.
- Password hashes use **argon2id** (`@node-rs/argon2`), OWASP-recommended params.

## Safety rails

- **Last-admin protection**: `DELETE /api/users/:id` and `PATCH :id/role` both
  count remaining admins and refuse to remove/demote the last one (`409
LAST_ADMIN`).
- **No self-delete**: a user cannot delete their own account (`409 NO_SELF_DELETE`).
- **Password rules**: 8–256 chars. Username `^[\w.-]{3,32}$`, unique.
- **Disabled users**: a disabled user's token is rejected at the `verifyAccessToken`
  boundary by a fresh user lookup on protected routes (kept cheap via a small
  TODO cache; for Phase 1 it's a direct DB read).

## Validation source of truth

Zod schemas in `packages/shared/src/schemas/auth.ts`. Server, SDK, and (via
inferred types) the web client share them. Password/username rules live there.
