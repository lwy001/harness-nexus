import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.js';

/**
 * Front-end permission interceptors (see docs/auth.md).
 *
 * `<RequireAuth>` — redirects to /login (remembering where we came from) when
 * there is no authenticated user. While the initial /me lookup is in flight it
 * renders nothing to avoid a login flash.
 *
 * `<RequireAdmin>` — renders a 403 view when the current user is not an admin.
 * Sits inside <RequireAuth>, so it can assume a user exists.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <h2>403 — Admins only</h2>
        <p>You don't have permission to view this page.</p>
      </main>
    );
  }
  return <>{children}</>;
}
