import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { HomeIcon, SettingsIcon, UsersIcon, LogOutIcon } from 'lucide-react';
import { useAuth } from '@/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

/** Dashboard chrome: left sidebar nav + top header. Replaces the old inline-styled Shell. */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <div className="bg-background text-foreground flex min-h-svh">
      {/* Sidebar */}
      <aside className="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <span className="text-lg font-semibold tracking-tight">AgentNexus</span>
        </div>
        <Separator />
        <nav className="flex flex-col gap-1 p-3">
          <NavItem to="/" icon={<HomeIcon />} label="Home" end />
          {isAdmin && (
            <>
              <NavItem to="/admin/users" icon={<UsersIcon />} label="Users" />
              <NavItem to="/admin/settings" icon={<SettingsIcon />} label="Settings" />
            </>
          )}
        </nav>
        <div className="mt-auto p-3">
          <div className="text-muted-foreground px-2 pb-2 text-xs uppercase tracking-wide">
            Signed in
          </div>
          <div className="flex items-center justify-between rounded-md px-2 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user?.username}</div>
              <div className="mt-0.5">
                <Badge variant={isAdmin ? 'default' : 'secondary'} className="text-[10px]">
                  {user?.role}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header (mobile: also carries brand since sidebar is hidden) */}
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:px-6">
          <Link to="/" className="text-base font-semibold md:hidden">
            AgentNexus
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 h-6" />
            <Button variant="ghost" size="sm" onClick={logout} className="gap-1.5">
              <LogOutIcon className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
