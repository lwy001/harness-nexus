import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './auth.js';

/** App chrome: header with nav (role-aware) and a logout button. */
export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#fafafa' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1.5rem',
          background: '#111',
          color: '#fff',
        }}
      >
        <strong>AgentNexus</strong>
        <nav style={{ display: 'flex', gap: '0.75rem' }}>
          <Link style={navLink} to="/">
            Home
          </Link>
          {user?.role === 'admin' && (
            <>
              <Link style={navLink} to="/admin/users">
                Users
              </Link>
              <Link style={navLink} to="/admin/settings">
                Settings
              </Link>
            </>
          )}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ opacity: 0.85, fontSize: '0.9rem' }}>
            {user?.username} · {user?.role}
          </span>
          <button
            onClick={logout}
            style={{
              background: 'transparent',
              color: '#fff',
              border: '1px solid #555',
              borderRadius: 4,
              padding: '0.3rem 0.6rem',
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main style={{ padding: '1.5rem', maxWidth: 960 }}>{children}</main>
    </div>
  );
}

const navLink: React.CSSProperties = { color: '#fff', textDecoration: 'none' };
