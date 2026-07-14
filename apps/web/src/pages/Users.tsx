import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, withAuthGuard } from '../auth.js';
import { Shell } from '../Shell.js';
import { AgentNexusError, type PublicUser, type Role } from '@agent-nexus/sdk';

export function UsersPage() {
  const { logout } = useAuth();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setUsers(await withAuthGuard(() => api.listUsers(), logout));
    } catch (e) {
      setError(e instanceof AgentNexusError ? e.message : 'Failed to load users');
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function setRole(u: PublicUser, role: Role) {
    setError(null);
    try {
      await withAuthGuard(() => api.updateUserRole(u.id, role), logout);
      await refresh();
    } catch (e) {
      setError(e instanceof AgentNexusError ? e.message : 'Update failed');
    }
  }

  async function remove(u: PublicUser) {
    if (!confirm(`Delete user ${u.username}?`)) return;
    setError(null);
    try {
      await withAuthGuard(() => api.deleteUser(u.id), logout);
      await refresh();
    } catch (e) {
      setError(e instanceof AgentNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <Shell>
      <h1>Users</h1>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <table style={{ borderCollapse: 'collapse', background: '#fff', width: '100%' }}>
        <thead>
          <tr>
            {['Username', 'Role', 'Status', 'Created', 'Actions'].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={td}>{u.username}</td>
              <td style={td}>{u.role}</td>
              <td style={td}>{u.status}</td>
              <td style={td}>{new Date(u.createdAt).toLocaleString()}</td>
              <td style={td}>
                <button
                  disabled={u.role === 'admin'}
                  onClick={() => setRole(u, 'admin')}
                  style={miniBtn}
                >
                  Make admin
                </button>
                <button
                  disabled={u.role === 'user'}
                  onClick={() => setRole(u, 'user')}
                  style={miniBtn}
                >
                  Make user
                </button>
                <button onClick={() => remove(u)} style={{ ...miniBtn, color: '#c00' }}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CreateUser onCreated={refresh} />
    </Shell>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const { logout } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await withAuthGuard(() => api.createUser({ username, password, role }), logout);
      setUsername('');
      setPassword('');
      setRole('user');
      onCreated();
    } catch (e) {
      setMsg(e instanceof AgentNexusError ? e.message : 'Create failed');
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        marginTop: '1.5rem',
        display: 'flex',
        gap: '0.5rem',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
      }}
    >
      <h3 style={{ width: '100%', marginBottom: 0 }}>Add user (bypasses registration switch)</h3>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} style={input} />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={input}
        />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={input}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <button type="submit">Create</button>
      {msg && <span style={{ color: '#c00', width: '100%' }}>{msg}</span>}
    </form>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem',
  borderBottom: '2px solid #ddd',
  background: '#f0f0f0',
};
const td: React.CSSProperties = { padding: '0.5rem', borderBottom: '1px solid #eee' };
const miniBtn: React.CSSProperties = {
  marginRight: 4,
  padding: '0.2rem 0.4rem',
  cursor: 'pointer',
  fontSize: '0.85rem',
};
const input: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '0.3rem',
  fontSize: '0.9rem',
};
