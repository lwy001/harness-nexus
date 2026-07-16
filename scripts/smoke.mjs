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
let r = await req('POST', '/api/auth/register', {
  body: { username: 'root', password: 'hunter2hunter2' },
});
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
r = await req('POST', '/api/auth/register', {
  body: { username: 'alice', password: 'hunter2hunter2' },
});
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
r = await req('PUT', '/api/settings/registration', {
  token: adminToken,
  body: { allowRegistration: false },
});
expect('disable registration status', r.status, 200);
r = await req('GET', '/api/settings/registration');
expect('registration now closed', r.json.allowRegistration, false);

log('\n--- register when disabled (403) ---');
r = await req('POST', '/api/auth/register', {
  body: { username: 'bob', password: 'hunter2hunter2' },
});
expect('disabled register status', r.status, 403);

log('\n--- admin create user bypasses switch (201) ---');
r = await req('POST', '/api/users', {
  token: adminToken,
  body: { username: 'carol', password: 'hunter2hunter2', role: 'user' },
});
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

// ====================== Phase 2.1: credentials + mcp-servers ======================

log('\n--- [2.1] user creates a personal credential (201) ---');
r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'alice-key', secret: 'sk_test_abcdef123456', scope: 'personal' },
});
expect('personal credential created', r.status, 201);
expect('credential secret masked', r.json.credential.secretPreview.includes('…'), true);
expect('credential omits secret field', 'secret' in r.json.credential, false);

log('\n--- [2.1] user cannot create global credential (403) ---');
r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'g', secret: 'x'.repeat(12), scope: 'global' },
});
expect('non-admin global credential rejected', r.status, 403);

log('\n--- [2.1] admin creates a global credential (201) ---');
r = await req('POST', '/api/credentials', {
  token: adminToken,
  body: { name: 'shared-token', secret: 'bearer_abcdefghijklmnop', scope: 'global' },
});
expect('admin global credential created', r.status, 201);
const globalCredId = r.json.credential.id;

log('\n--- [2.1] list returns personal + global (2) ---');
r = await req('GET', '/api/credentials', { token: userToken });
expect('user lists both credentials', r.json.credentials.length, 2);

log('\n--- [2.1] user cannot delete global credential (404) ---');
r = await req('DELETE', `/api/credentials/${globalCredId}`, { token: userToken });
expect('non-admin delete global → 404', r.status, 404);

log('\n--- [2.1] admin deletes global credential (200) ---');
r = await req('DELETE', `/api/credentials/${globalCredId}`, { token: adminToken });
expect('admin delete global credential', r.status, 200);

log('\n--- [2.1] create mcp-server with a credential placeholder in headers (201) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'acme-mcp',
    transport: {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${cred:alice-key}' },
    },
    scope: 'personal',
  },
});
expect('mcp-server created with placeholder in headers', r.status, 201);
const acmeId = r.json.mcpServer.id;

log('\n--- [3.1] stdio + proxy rejected — STDIO_REQUIRES_DIRECT (409) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'stdio-nope',
    transport: { type: 'stdio', command: 'echo' },
    mode: 'proxy',
    scope: 'personal',
  },
});
expect('stdio + proxy rejected (409)', r.status, 409);
expect('error code STDIO_REQUIRES_DIRECT', r.json.error, 'STDIO_REQUIRES_DIRECT');

log('\n--- [3.1] stdio + direct accepted (201) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'local-fs',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    },
    mode: 'direct',
    scope: 'personal',
  },
});
expect('stdio + direct created', r.status, 201);
expect('mode is direct', r.json.mcpServer.mode, 'direct');

log('\n--- [2.1] non-admin cannot create global mcp-server (403) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'g',
    transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    scope: 'global',
  },
});
expect('non-admin global mcp-server rejected', r.status, 403);

log('\n--- [3.1] list mcp-servers (2 personal) ---');
r = await req('GET', '/api/mcp-servers', { token: userToken });
expect('user lists own mcp-servers', r.json.mcpServers.length, 2);

log('\n--- [2.1] delete own mcp-server (200) ---');
r = await req('DELETE', `/api/mcp-servers/${acmeId}`, { token: userToken });
expect('delete own mcp-server', r.status, 200);

// ============================ Phase 2.2: profiles + status ============================

log('\n--- [2.2] create a personal mcp-server to reference in a profile (201) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'demo-upstream',
    transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    scope: 'personal',
  },
});
expect('demo mcp-server created', r.status, 201);
const demoServerId = r.json.mcpServer.id;

log('\n--- [2.2] create profile referencing an accessible server (201) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'daily',
    description: 'my daily bundle',
    scope: 'personal',
    entries: [{ mcpServerId: demoServerId }],
  },
});
expect('profile created', r.status, 201);
expect('profile has 1 entry', r.json.profile.entries.length, 1);
const profileId = r.json.profile.id;

log('\n--- [2.2] create profile referencing a non-existent server (409) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'bad', scope: 'personal', entries: [{ mcpServerId: 'mcp_no_such' }] },
});
expect('profile with bad entry rejected', r.status, 409);

log('\n--- [2.2] non-admin cannot create global profile (403) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'g', scope: 'global', entries: [] },
});
expect('non-admin global profile rejected', r.status, 403);

log('\n--- [2.2] admin creates a global profile (201) ---');
r = await req('POST', '/api/profiles', {
  token: adminToken,
  body: { name: 'shared', scope: 'global', entries: [] },
});
expect('admin global profile created', r.status, 201);

log('\n--- [2.2] list profiles returns personal + global (2) ---');
r = await req('GET', '/api/profiles', { token: userToken });
expect('user lists 2 profiles', r.json.profiles.length, 2);

log('\n--- [2.2] get profile detail (200) ---');
r = await req('GET', `/api/profiles/${profileId}`, { token: userToken });
expect('profile detail status', r.status, 200);
expect('profile detail name', r.json.profile.name, 'daily');

log('\n--- [2.2] mcp-servers status endpoint (200) ---');
r = await req('GET', '/api/mcp-servers/status', { token: userToken });
expect('status endpoint status', r.status, 200);
expect('statuses is an array', Array.isArray(r.json.statuses), true);

log('\n--- [2.2] create a fresh PAT for /mcp proxy tests ---');
r = await req('POST', '/api/pats', { token: userToken, body: { name: 'mcp-proxy' } });
expect('fresh pat created', r.status, 201);
const mcpPat = r.json.token;

log('\n--- [2.2] /mcp without profile param (400) ---');
r = await req('POST', '/mcp', { token: mcpPat });
expect('mcp without profile rejected', r.status, 400);

log('\n--- [2.2] /mcp without auth (401) ---');
r = await req('POST', `/mcp?profile=${profileId}`);
expect('mcp without auth rejected', r.status, 401);

log('\n--- [2.2] delete profile (200) ---');
r = await req('DELETE', `/api/profiles/${profileId}`, { token: userToken });
expect('delete profile', r.status, 200);

// ============================ Phase 4.2: resources ============================

log('\n--- [4.2] user creates a personal sub_agent resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'sub_agent:reviewer',
    kind: 'sub_agent',
    name: 'Code reviewer',
    description: 'Reviews PRs carefully',
    scope: 'personal',
    source: { type: 'inline', content: 'You are a careful code reviewer.' },
    targets: ['claude-code', 'zcode'],
  },
});
expect('personal sub_agent created', r.status, 201);
expect('resource kind is sub_agent', r.json.resource.kind, 'sub_agent');
expect('resource source is inline', r.json.resource.source.type, 'inline');
const subAgentId = r.json.resource.id;

log('\n--- [4.2] admin creates a global rule resource (201) ---');
r = await req('POST', '/api/resources', {
  token: adminToken,
  body: {
    key: 'rule:tests-first',
    kind: 'rule',
    name: 'Tests before done',
    scope: 'global',
    source: { type: 'inline', content: 'Always run tests before marking done.' },
  },
});
expect('global rule created', r.status, 201);
const ruleId = r.json.resource.id;

log('\n--- [4.2] list returns personal + global (2) ---');
r = await req('GET', '/api/resources', { token: userToken });
expect('user lists both resources', r.json.resources.length, 2);

log('\n--- [4.2] non-admin cannot create global resource (403) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'rule:global-nope',
    kind: 'rule',
    name: 'g',
    scope: 'global',
    source: { type: 'inline', content: 'x' },
  },
});
expect('non-admin global resource rejected', r.status, 403);

log('\n--- [4.2] duplicate key in same scope (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'sub_agent:reviewer',
    kind: 'sub_agent',
    name: 'dup',
    scope: 'personal',
    source: { type: 'inline', content: 'x' },
  },
});
expect('duplicate key rejected', r.status, 409);
expect('error code RESOURCE_KEY_TAKEN', r.json.error, 'RESOURCE_KEY_TAKEN');

log('\n--- [4.2] kind skill not available yet (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:future',
    kind: 'skill',
    name: 'future',
    scope: 'personal',
    source: { type: 'inline', content: 'x' },
  },
});
expect('skill kind rejected', r.status, 409);
expect('error code KIND_NOT_AVAILABLE', r.json.error, 'KIND_NOT_AVAILABLE');

log('\n--- [4.2] PATCH update own resource (200) ---');
r = await req('PATCH', `/api/resources/${subAgentId}`, {
  token: userToken,
  body: { name: 'Senior code reviewer' },
});
expect('patch own resource', r.status, 200);
expect('name updated', r.json.resource.name, 'Senior code reviewer');

log('\n--- [4.2] non-admin cannot mutate global resource (404) ---');
r = await req('PATCH', `/api/resources/${ruleId}`, {
  token: userToken,
  body: { name: 'hacked' },
});
expect('non-admin patch global → 404', r.status, 404);

log('\n--- [4.2] filter by kind=sub_agent (1) ---');
r = await req('GET', '/api/resources?kind=sub_agent', { token: userToken });
expect('kind filter returns 1', r.json.resources.length, 1);

log('\n--- [4.2] delete own resource (200) ---');
r = await req('DELETE', `/api/resources/${subAgentId}`, { token: userToken });
expect('delete own resource', r.status, 200);

log('\n--- [4.4] create a command resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'command:explain-args',
    kind: 'command',
    name: 'Explain arguments',
    description: 'Echoes back the arguments passed',
    scope: 'personal',
    source: { type: 'inline', content: 'Explain these arguments: $ARGUMENTS' },
    targets: ['claude-code', 'zcode'],
  },
});
expect('command resource created', r.status, 201);
expect('resource kind is command', r.json.resource.kind, 'command');
const commandId = r.json.resource.id;

log('\n--- [4.4] filter by kind=command (1) ---');
r = await req('GET', '/api/resources?kind=command', { token: userToken });
expect('command filter returns 1', r.json.resources.length, 1);

log('\n--- [4.4] delete command resource (200) ---');
r = await req('DELETE', `/api/resources/${commandId}`, { token: userToken });
expect('delete command resource', r.status, 200);

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
