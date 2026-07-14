import type { ReactNode } from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { TriangleAlertIcon } from 'lucide-react';
import { useAuth } from './auth.js';
import { AppShell } from '@/components/app-shell.js';
import { Card, CardContent } from '@/components/ui/card.js';
import { Button } from '@/components/ui/button.js';

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
      <AppShell>
        <Card className="mx-auto mt-12 max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <TriangleAlertIcon className="text-warn size-8" />
            <h2 className="text-lg font-semibold">Admins only</h2>
            <p className="text-muted-foreground text-sm">
              You don&apos;t have permission to view this page. Ask an administrator if you need
              access.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-1">
              <Link to="/">Back to overview</Link>
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    );
  }
  return <>{children}</>;
}
