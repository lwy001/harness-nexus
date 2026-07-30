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
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: demoServerId }],
  },
});
expect('profile created', r.status, 201);
expect('profile has 1 entry', r.json.profile.entries.length, 1);
expect('profile target stored', r.json.profile.target, 'claude-code');
const profileId = r.json.profile.id;

log('\n--- [2.2] create profile referencing a non-existent server (409) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'bad', target: 'claude-code', scope: 'personal', entries: [{ mcpServerId: 'mcp_no_such' }] },
});
expect('profile with bad entry rejected', r.status, 409);

log('\n--- [2.2] non-admin cannot create global profile (403) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'g', target: 'claude-code', scope: 'global', entries: [] },
});
expect('non-admin global profile rejected', r.status, 403);

log('\n--- [2.2] admin creates a global profile (201) ---');
r = await req('POST', '/api/profiles', {
  token: adminToken,
  body: { name: 'shared', target: 'zcode', scope: 'global', entries: [] },
});
expect('admin global profile created', r.status, 201);

log('\n--- [2.2] list profiles returns personal + global (2) ---');
r = await req('GET', '/api/profiles', { token: userToken });
expect('user lists 2 profiles', r.json.profiles.length, 2);

log('\n--- [2.2] get profile detail (200) ---');
r = await req('GET', `/api/profiles/${profileId}`, { token: userToken });
expect('profile detail status', r.status, 200);
expect('profile detail name', r.json.profile.name, 'daily');

// ============================ Phase 3.2: Profile.target ============================

log('\n--- [3.2] create profile WITHOUT target → 400 (required) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'no-target', scope: 'personal', entries: [] },
});
expect('profile without target rejected', r.status, 400);

log('\n--- [3.2] create profile WITH target hermes → 201, target stored ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'hermes-bundle', target: 'hermes', scope: 'personal', entries: [] },
});
expect('hermes profile created', r.status, 201);
expect('hermes profile target', r.json.profile.target, 'hermes');

log('\n--- [3.2] PATCH profile target → 409 TARGET_IMMUTABLE ---');
r = await req('PATCH', `/api/profiles/${profileId}`, {
  token: userToken,
  body: { target: 'zcode' },
});
expect('target change rejected as immutable', r.status, 409);
expect('immutable error code', r.json.error, 'TARGET_IMMUTABLE');

log('\n--- [3.2] PATCH profile name WITHOUT target still works (200) ---');
r = await req('PATCH', `/api/profiles/${profileId}`, {
  token: userToken,
  body: { name: 'daily-renamed' },
});
expect('non-target PATCH succeeds', r.status, 200);
expect('patched name applied', r.json.profile.name, 'daily-renamed');
expect('target unchanged after patch', r.json.profile.target, 'claude-code');

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

// ============================ Phase 2.4: connect/disconnect + tools ============================
// demoServerId is the 'demo-upstream' proxy server created in the 2.2 block
// above. Its URL (https://mcp.example.com/mcp) is unreachable, so connect
// resolves with status='error' + detail — this is the primary use case for the
// explicit Connect button (re-dial after fixing a broken upstream). The tools
// endpoint returns [] when not connected; refresh is refused (409 NOT_CONNECTED)
// on a down server.

log('\n--- [2.4] status entries carry toolCount (Phase 2.4 extension) ---');
r = await req('GET', '/api/mcp-servers/status', { token: userToken });
expect('status ok', r.status, 200);
const demoStatus = r.json.statuses.find((s) => s.id === demoServerId);
expect('demo status present', typeof demoStatus, 'object');
expect('status has toolCount field', typeof demoStatus.toolCount, 'number');

log('\n--- [2.4] connect forces a (re)dial; unreachable → status error ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/connect`, { token: userToken });
expect('connect returns 200', r.status, 200);
expect('connect returns a status object', typeof r.json.status, 'object');
expect(
  'connect result is connected or error (best-effort)',
  r.json.status.status === 'connected' || r.json.status.status === 'error',
  true,
);
expect('status has toolCount', typeof r.json.status.toolCount, 'number');

log('\n--- [2.4] tools list on a not-connected server → empty array (not error) ---');
r = await req('GET', `/api/mcp-servers/${demoServerId}/tools`, { token: userToken });
expect('tools endpoint ok', r.status, 200);
expect('tools is an array', Array.isArray(r.json.tools), true);

log('\n--- [2.4] refresh on a not-connected server → 409 NOT_CONNECTED ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/tools/refresh`, { token: userToken });
// only assert the contract when the server is actually down (error/disconnected);
// if the unreachable upstream happened to connect, refresh is valid.
if (demoStatus.status !== 'connected') {
  expect('refresh on down server → 409', r.status, 409);
  expect('error code NOT_CONNECTED', r.json.error, 'NOT_CONNECTED');
}

log('\n--- [2.4] connect on a direct server → 409 NOT_PROXY_MODE ---');
// 'local-fs' is the stdio+direct server created in the 3.1 block.
r = await req('GET', '/api/mcp-servers', { token: userToken });
const directServer = r.json.mcpServers.find((s) => s.mode === 'direct');
r = await req('POST', `/api/mcp-servers/${directServer.id}/connect`, { token: userToken });
expect('connect on direct → 409', r.status, 409);
expect('error code NOT_PROXY_MODE', r.json.error, 'NOT_PROXY_MODE');

log('\n--- [2.4] connect on unknown id → 404 (leak prevention) ---');
r = await req('POST', '/api/mcp-servers/mcp_no_such/connect', { token: userToken });
expect('connect unknown → 404', r.status, 404);
expect('error code MCP_SERVER_NOT_FOUND', r.json.error, 'MCP_SERVER_NOT_FOUND');

log('\n--- [2.4] disconnect on a pooled server (idempotent) ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/disconnect`, { token: userToken });
expect('disconnect returns 200', r.status, 200);
expect('disconnect status is disconnected', r.json.status.status, 'disconnected');

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

log('\n--- [4.2] kind mcp not available as a resource (409) ---');
// 'mcp' is a ResourceKind but MCP servers are managed separately (/api/mcp-servers),
// so it is not in the resource AVAILABLE_KINDS.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'mcp:future',
    kind: 'mcp',
    name: 'future',
    scope: 'personal',
    source: { type: 'inline', content: 'x' },
  },
});
expect('mcp kind rejected', r.status, 409);
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

log('\n--- [4.5] create a hook resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:lint-on-edit',
    kind: 'hook',
    name: 'Lint on edit',
    description: 'Runs the linter after Edit/Write',
    scope: 'personal',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: './lint.sh' }] },
          ],
        },
      }),
    },
    targets: ['claude-code', 'zcode'],
  },
});
expect('hook resource created', r.status, 201);
expect('resource kind is hook', r.json.resource.kind, 'hook');
const hookId = r.json.resource.id;

log('\n--- [4.5] hook targeting Hermes rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:hermes-nope',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    },
    targets: ['hermes'],
  },
});
expect('hermes hook target rejected', r.status, 409);
expect('error code TARGET_NO_DECLARATIVE_HOOKS', r.json.error, 'TARGET_NO_DECLARATIVE_HOOKS');

log('\n--- [4.5] hook with event unsupported by all targets rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:bad-event',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: {
      type: 'inline',
      // PreCompact is CC-only; zcode does not support it → unsupported by all
      // declared targets (zcode only).
      content: JSON.stringify({
        hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    },
    targets: ['zcode'],
  },
});
expect('unsupported event rejected', r.status, 409);
expect('error code HOOK_EVENT_UNSUPPORTED', r.json.error, 'HOOK_EVENT_UNSUPPORTED');

log('\n--- [4.5] hook with invalid JSON rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:bad-json',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline', content: 'not json{' },
    targets: ['claude-code'],
  },
});
expect('invalid hook json rejected', r.status, 400);

log('\n--- [4.5] delete hook resource (200) ---');
r = await req('DELETE', `/api/resources/${hookId}`, { token: userToken });
expect('delete hook resource', r.status, 200);

log('\n--- [4.6] create a single-file skill (inline) (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:hello',
    kind: 'skill',
    name: 'Hello skill',
    scope: 'personal',
    source: { type: 'inline', content: '---\nname: hello\ndescription: Says hello\n---\n# Hello' },
    targets: ['claude-code'],
  },
});
expect('single-file skill created', r.status, 201);
expect('resource kind is skill', r.json.resource.kind, 'skill');
const skillSingleId = r.json.resource.id;

log('\n--- [4.6] create a multi-file skill (inline-bundle) (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:gdrive',
    kind: 'skill',
    name: 'Google Drive skill',
    scope: 'personal',
    source: {
      type: 'inline-bundle',
      files: {
        'SKILL.md': '---\nname: gdrive\ndescription: Drive access\n---\n# GDrive',
        'references/search-syntax.md': '# Search syntax',
        'scripts/list.py': 'print("list")',
      },
    },
    targets: ['claude-code', 'zcode'],
  },
});
expect('multi-file skill created', r.status, 201);
expect('skill source is inline-bundle', r.json.resource.source.type, 'inline-bundle');
expect('skill bundle has 3 files', Object.keys(r.json.resource.source.files).length, 3);
const skillBundleId = r.json.resource.id;

log('\n--- [4.6] bundle missing SKILL.md rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:no-md',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline-bundle', files: { 'references/x.md': '# x' } },
    targets: ['claude-code'],
  },
});
expect('bundle missing SKILL.md rejected', r.status, 409);
expect('error code SKILL_BUNDLE_MISSING_SKILL_MD', r.json.error, 'SKILL_BUNDLE_MISSING_SKILL_MD');

log('\n--- [4.6] bundle with path traversal rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:traversal',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline-bundle', files: { 'SKILL.md': 'x', '../escape.md': 'evil' } },
    targets: ['claude-code'],
  },
});
expect('bundle path traversal rejected', r.status, 400);

log('\n--- [4.6] skill with git source rejected (409 INVALID_SKILL_SOURCE) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:git-nope',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'git', url: 'https://example.com/repo' },
    targets: ['claude-code'],
  },
});
expect('skill git source rejected', r.status, 409);
expect('error code INVALID_SKILL_SOURCE', r.json.error, 'INVALID_SKILL_SOURCE');

log('\n--- [4.6] filter by kind=skill (2) ---');
r = await req('GET', '/api/resources?kind=skill', { token: userToken });
expect('skill filter returns 2', r.json.resources.length, 2);

log('\n--- [4.6] delete both skills (200) ---');
r = await req('DELETE', `/api/resources/${skillSingleId}`, { token: userToken });
expect('delete single-file skill', r.status, 200);
r = await req('DELETE', `/api/resources/${skillBundleId}`, { token: userToken });
expect('delete multi-file skill', r.status, 200);

// ---------------------------------------------------------------------------
// Phase 7.1 — plugin source + trust/provenance labels
// ---------------------------------------------------------------------------

log('\n--- [7.1] skill with plugin source accepted; trust computed (trusted) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-trusted',
    kind: 'skill',
    name: 'trusted-plugin-skill',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', sha: 'abc123def456' },
      plugin: 'skill-creator',
    },
    targets: ['claude-code'],
  },
});
expect('plugin skill created', r.status, 201);
expect('plugin source round-trips', r.json.resource.source.type, 'plugin');
expect('plugin inner source kind', r.json.resource.source.source.source, 'github');
expect('trust label = trusted', r.json.resource.labels?.trust, 'trusted');
expect('pin label = sha', r.json.resource.labels?.pin, 'abc123def456');
expect('provenance label set', typeof r.json.resource.labels?.provenance, 'string');

log('\n--- [7.1] community plugin, no pin (floating ref) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-community',
    kind: 'skill',
    name: 'community-plugin-skill',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'random/dev' },
      plugin: 'thing',
    },
    targets: ['claude-code'],
  },
});
expect('community plugin skill created', r.status, 201);
expect('trust label = community', r.json.resource.labels?.trust, 'community');
expect('no pin label when floating', r.json.resource.labels?.pin, undefined);

log('\n--- [7.1] unsafe plugin path rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-badpath',
    kind: 'skill',
    name: 'badpath',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', path: '../etc/passwd' },
      plugin: 'x',
    },
    targets: ['claude-code'],
  },
});
expect('unsafe plugin path rejected', r.status, 400);

log('\n--- [7.1] npm plugin source requires version ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-npm-no-version',
    kind: 'skill',
    name: 'npm-no-version',
    scope: 'personal',
    // version omitted at the plugin level AND the inner source level — zod
    // rejects (inner .version is required), so this is a 400 VALIDATION_ERROR
    // before our handler-level check runs.
    source: {
      type: 'plugin',
      source: { source: 'npm', package: '@org/foo' },
      plugin: 'foo',
    },
    targets: ['claude-code'],
  },
});
expect('npm plugin without version rejected', r.status, 400);

log('\n--- [7.1] cleanup plugin skills ---');
r = await req('GET', '/api/resources?kind=skill', { token: userToken });
for (const res of r.json.resources) {
  if (res.source.type === 'plugin') {
    const del = await req('DELETE', `/api/resources/${res.id}`, { token: userToken });
    expect(`delete ${res.key}`, del.status, 200);
  }
}

// ---------------------------------------------------------------------------
// Phase 7.2 — marketplace allowlist fetch
// Server must be booted with MARKETPLACE_FIXTURE_PATH=scripts/fixtures/
// marketplace.json so the catalog fetcher reads the local fixture instead of
// hitting GitHub. The fixture has 6 plugins: 4 object-sourced (git-subdir×1,
// url×2, github×1) + 2 relative-path-sourced (must be filtered out).
// ---------------------------------------------------------------------------

log('\n--- [7.2] list configured marketplaces ---');
r = await req('GET', '/api/skills/marketplaces', { token: userToken });
expect('marketplaces list ok', r.status, 200);
expect(
  'default marketplace present',
  r.json.marketplaces.some((m) => m.id === 'claude-plugins-official'),
  true,
);

log('\n--- [7.2] fetch catalog; relative-path sources filtered out ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins', {
  token: userToken,
});
expect('catalog fetch ok', r.status, 200);
expect('4 plugins after filtering 2 relative-path', r.json.plugins.length, 4);
const sourceKinds = r.json.plugins.map((p) => p.source.source).sort();
expect(
  'source kinds are object kinds only',
  JSON.stringify(sourceKinds),
  JSON.stringify(['git-subdir', 'github', 'url', 'url']),
);

log('\n--- [7.2] filter by category=security ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins?category=security', {
  token: userToken,
});
expect('security filter ok', r.status, 200);
expect('2 security plugins', r.json.plugins.length, 2);
expect(
  'all returned are security',
  r.json.plugins.every((p) => p.category === 'security'),
  true,
);

log('\n--- [7.2] free-text search q=artifact ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins?q=artifact', {
  token: userToken,
});
expect('search ok', r.status, 200);
expect('search matches 1 (jfrog description)', r.json.plugins.length, 1);
expect('matched plugin is jfrog', r.json.plugins[0].name, 'jfrog');

log('\n--- [7.2] non-allowlisted marketplace id → 404 ---');
r = await req('GET', '/api/skills/marketplaces/evil-untrusted/plugins', { token: userToken });
expect('non-allowlisted 404', r.status, 404);
expect('error code MARKETPLACE_NOT_ALLOWED', r.json.error, 'MARKETPLACE_NOT_ALLOWED');

log('\n--- [7.2] second catalog read hits cache (same result set) ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins', {
  token: userToken,
});
expect('cached read ok', r.status, 200);
expect('cached result still 4 plugins', r.json.plugins.length, 4);

log('\n--- [7.2] unauthenticated request → 401 ---');
r = await req('GET', '/api/skills/marketplaces');
expect('no-token 401', r.status, 401);

// ---------------------------------------------------------------------------
// Phase 7.4 — multi-source search
// Server booted with SKILL_DISABLED_SOURCES=github,well-known,url so the search
// router only runs the marketplace source (against the 7.2 fixture). This
// verifies the /api/skills/search endpoint, the dispatch/merge/dedupe pipeline,
// and trust ranking, without hitting GitHub. The per-adapter fetch logic is
// covered by typecheck + manual verification (like 7.3's UI).
// ---------------------------------------------------------------------------

log('\n--- [7.4] search requires ?q= (400) ---');
r = await req('GET', '/api/skills/search', { token: userToken });
expect('search without q → 400', r.status, 400);

log('\n--- [7.4] search dispatches to marketplace source ---');
r = await req('GET', '/api/skills/search?q=artifact', { token: userToken });
expect('search ok', r.status, 200);
expect('returns array', Array.isArray(r.json.results), true);
// marketplace source finds the jfrog plugin (description mentions 'artifact').
expect(
  'marketplace result present',
  r.json.results.some((m) => m.source === 'marketplace' && m.name === 'jfrog'),
  true,
);
// every result carries an identifier + trustLevel (merge contract).
expect(
  'all results have identifier',
  r.json.results.every((m) => typeof m.identifier === 'string'),
  true,
);
expect(
  'all results have trustLevel',
  r.json.results.every(
    (m) => m.trustLevel === 'trusted' || m.trustLevel === 'community' || m.trustLevel === 'builtin',
  ),
  true,
);

log('\n--- [7.4] search result carries precomputed pluginSource in extra ---');
const jfrog = r.json.results.find((m) => m.name === 'jfrog');
expect('jfrog has extra.pluginSource', typeof jfrog.extra?.pluginSource, 'object');
expect('pluginSource is the plugin variant', jfrog.extra.pluginSource?.type, 'plugin');

log('\n--- [7.4] timedOut/errored arrays are present (may be empty) ---');
expect('timedOut is array', Array.isArray(r.json.timedOut), true);
expect('errored is array', Array.isArray(r.json.errored), true);

log('\n--- [7.4] trust ranking — anthropics/skills entry → trusted ---');
// The fixture's 42crunch (git-subdir, 42Crunch-AI owner) is community; if the
// fixture had an anthropics/skills entry it would surface as trusted. Assert
// the tier contract by checking community tiers round-trip correctly.
r = await req('GET', '/api/skills/search?q=42crunch', { token: userToken });
expect('search finds 42crunch', r.status, 200);
const crunch = r.json.results.find((m) => m.name.includes('42crunch'));
expect('42crunch is community trust', crunch.trustLevel, 'community');

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
