import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { AgentNexusError } from '@agent-nexus/sdk';

export function RegisterPage() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  // Fetch the public registration switch so the form can disable itself.
  useEffect(() => {
    api
      .getRegistration()
      .then((r) => setRegistrationOpen(r.allowRegistration))
      .catch(() => setRegistrationOpen(true));
  }, []);

  // Already signed in → go home.
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(username, password, email || undefined);
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof AgentNexusError ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  const closed = registrationOpen === false;
  return (
    <main style={pageStyle}>
      <form style={formStyle} onSubmit={onSubmit}>
        <h1 style={{ marginTop: 0 }}>Create account · AgentNexus</h1>
        {closed && (
          <div style={errStyle}>
            Registration is closed on this instance. Ask an admin for an account.
          </div>
        )}
        {error && <div style={errStyle}>{error}</div>}
        <label style={labelStyle}>
          Username
          <input
            style={inputStyle}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={closed}
            autoComplete="username"
          />
        </label>
        <label style={labelStyle}>
          Password (min 8)
          <input
            style={inputStyle}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={closed}
            autoComplete="new-password"
          />
        </label>
        <label style={labelStyle}>
          Email (optional)
          <input
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={closed}
            autoComplete="email"
          />
        </label>
        <button style={btnStyle} disabled={busy || closed}>
          {busy ? 'Creating…' : 'Register'}
        </button>
        <p style={{ fontSize: '0.9rem' }}>
          Already have an account? <Link to="/login">Sign in</Link>
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
