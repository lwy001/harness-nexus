// Throwaway smoke test for the Phase 1 auth flow. Run against a freshly booted
// memory-mode server. Not part of the automated test suite (yet).
const B = process.env.BASE_URL ?? 'http://127.0.0.1:7780';
const log = (...a) => console.log(...a);
const code = (r) => r.status;

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: r.status, json, text };
}

let pass = 0,
  fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
  ok ? pass++ : fail++;
};

log('--- register first user (bootstrap admin) ---');
let r = await req('POST', '/api/auth/register', { body: { username: 'root', password: 'hunter2hunter2' } });
expect('first register status', r.status, 201);
expect('first register role', r.json.user.role, 'admin');
const adminToken = r.json.token;

log('\n--- /me with admin token ---');
r = await req('GET', '/api/auth/me', { token: adminToken });
expect('me status', r.status, 200);
expect('me username', r.json.user.username, 'root');

log('\n--- /me with no token (401) ---');
r = await req('GET', '/api/auth/me');
expect('no-token status', r.status, 401);

log('\n--- admin GET /api/users (200) ---');
r = await req('GET', '/api/users', { token: adminToken });
expect('admin list users status', r.status, 200);

log('\n--- register second user (role=user) ---');
r = await req('POST', '/api/auth/register', { body: { username: 'alice', password: 'hunter2hunter2' } });
expect('second register role', r.json.user.role, 'user');
const userToken = r.json.token;

log('\n--- non-admin GET /api/users (403) ---');
r = await req('GET', '/api/users', { token: userToken });
expect('user list users status', r.status, 403);

log('\n--- create PAT ---');
r = await req('POST', '/api/pats', { token: adminToken, body: { name: 'ci' } });
expect('create pat status', r.status, 201);
const patToken = r.json.token;
const patId = r.json.pat.id;
log('    pat prefix:', r.json.pat.prefix);

log('\n--- use PAT on /me (200) ---');
r = await req('GET', '/api/auth/me', { token: patToken });
expect('pat me status', r.status, 200);
expect('pat me resolves admin', r.json.user.username, 'root');

log('\n--- revoke PAT, then it must fail (401) ---');
r = await req('DELETE', `/api/pats/${patId}`, { token: adminToken });
expect('revoke pat status', r.status, 200);
r = await req('GET', '/api/auth/me', { token: patToken });
expect('revoked pat rejected', r.status, 401);

log('\n--- disable registration ---');
r = await req('PUT', '/api/settings/registration', { token: adminToken, body: { allowRegistration: false } });
expect('disable registration status', r.status, 200);
r = await req('GET', '/api/settings/registration');
expect('registration now closed', r.json.allowRegistration, false);

log('\n--- register when disabled (403) ---');
r = await req('POST', '/api/auth/register', { body: { username: 'bob', password: 'hunter2hunter2' } });
expect('disabled register status', r.status, 403);

log('\n--- admin create user bypasses switch (201) ---');
r = await req('POST', '/api/users', { token: adminToken, body: { username: 'carol', password: 'hunter2hunter2', role: 'user' } });
expect('admin create user status', r.status, 201);

log('\n--- last-admin protection: demote self (409) ---');
const me = (await req('GET', '/api/auth/me', { token: adminToken })).json.user;
r = await req('PATCH', `/api/users/${me.id}/role`, { token: adminToken, body: { role: 'user' } });
expect('demote last admin status', r.status, 409);

log('\n--- self-delete protection (409) ---');
r = await req('DELETE', `/api/users/${me.id}`, { token: adminToken });
expect('self delete status', r.status, 409);

log('\n--- bad login (401) ---');
r = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });
expect('bad login status', r.status, 401);

log('\n--- validation: short password + bad username (400) ---');
r = await req('POST', '/api/auth/register', { body: { username: 'x', password: 'short' } });
expect('validation status', r.status, 400);

log('\n--- disabled account rejected ---');
// (skipped: requires an admin to disable a user first; covered by unit tests later)

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
