import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { AgentNexusError } from '@agent-nexus/sdk';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof AgentNexusError ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={pageStyle}>
      <form style={formStyle} onSubmit={onSubmit}>
        <h1 style={{ marginTop: 0 }}>Sign in · AgentNexus</h1>
        {error && <div style={errStyle}>{error}</div>}
        <label style={labelStyle}>
          Username
          <input
            style={inputStyle}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label style={labelStyle}>
          Password
          <input
            style={inputStyle}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button style={btnStyle} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ fontSize: '0.9rem' }}>
          No account? <Link to="/register">Register</Link>
        </p>
      </form>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: '100vh',
  background: '#f5f5f5',
};
const formStyle: React.CSSProperties = {
  background: '#fff',
  padding: '2rem',
  borderRadius: 8,
  boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
  width: 320,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};
const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: '0.9rem',
};
const inputStyle: React.CSSProperties = {
  padding: '0.5rem',
  fontSize: '1rem',
  borderRadius: 4,
  border: '1px solid #ccc',
};
const btnStyle: React.CSSProperties = {
  padding: '0.6rem',
  fontSize: '1rem',
  cursor: 'pointer',
  borderRadius: 4,
  border: 'none',
  background: '#111',
  color: '#fff',
};
const errStyle: React.CSSProperties = {
  color: '#c00',
  fontSize: '0.9rem',
  background: '#fee',
  padding: '0.5rem',
  borderRadius: 4,
};
