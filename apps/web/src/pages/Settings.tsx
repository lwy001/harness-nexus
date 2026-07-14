import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, withAuthGuard } from '../auth.js';
import { Shell } from '../Shell.js';
import { AgentNexusError } from '@agent-nexus/sdk';

export function SettingsPage() {
  const { logout } = useAuth();
  const [allow, setAllow] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRegistration().then((r) => setAllow(r.allowRegistration));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      await withAuthGuard(() => api.setRegistration(next), logout);
      setAllow(next);
    } catch (e) {
      setMsg(e instanceof AgentNexusError ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>System settings</h1>
      <section style={{ padding: '1rem', background: '#fff', borderRadius: 8, maxWidth: 480 }}>
        <h2 style={{ marginTop: 0 }}>Registration</h2>
        <p>
          When enabled, anyone can create an account via <code>/api/auth/register</code>. When
          disabled, only admins can add users.
        </p>
        <p>
          Current state: <strong>{allow === null ? '…' : allow ? 'Open' : 'Closed'}</strong>
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button disabled={busy || allow === true} onClick={() => toggle(true)}>
            Open registration
          </button>
          <button disabled={busy || allow === false} onClick={() => toggle(false)}>
            Close registration
          </button>
        </div>
        {msg && <p style={{ color: '#c00' }}>{msg}</p>}
      </section>
    </Shell>
  );
}
