import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { HomeIcon, SettingsIcon, UsersIcon, LogOutIcon, KeyRoundIcon, ServerIcon, LayersIcon } from 'lucide-react';
import { useAuth } from '@/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { Brand } from '@/components/brand-mark';
import { MobileNav } from '@/components/mobile-nav';
import { cn } from '@/lib/utils';

/** Dashboard chrome: left sidebar nav + top header. The mobile drawer mirrors the same nav. */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  const items = navItems(isAdmin);

  return (
    <div className="bg-background text-foreground flex min-h-svh">
      {/* Skip link — first focusable element, jumps to main content. */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* Sidebar (desktop) */}
      <aside className="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center px-5">
          <Link to="/" aria-label="AgentNexus home">
            <Brand size={22} />
          </Link>
        </div>
        <Separator />
        <nav className="flex flex-col gap-1 p-3" aria-label="Primary">
          {items.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
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
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-6">
          {/* Mobile: drawer trigger + brand (sidebar is hidden below md) */}
          <MobileNav>
            {items.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </MobileNav>
          <Link to="/" className="md:hidden" aria-label="AgentNexus home">
            <Brand size={20} />
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

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

type NavItemProps = {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
};

function NavItem({ to, icon, label, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
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

/** Single source of truth for the nav — shared by desktop sidebar and mobile drawer. */
function navItems(isAdmin: boolean): NavItemProps[] {
  const items: NavItemProps[] = [
    { to: '/', icon: <HomeIcon className="size-4" />, label: 'Home', end: true },
    { to: '/mcp-servers', icon: <ServerIcon className="size-4" />, label: 'MCP management' },
    { to: '/profiles', icon: <LayersIcon className="size-4" />, label: 'Profiles' },
    { to: '/credentials', icon: <KeyRoundIcon className="size-4" />, label: 'Credentials' },
  ];
  if (isAdmin) {
    items.push(
      { to: '/admin/users', icon: <UsersIcon className="size-4" />, label: 'Users' },
      { to: '/admin/settings', icon: <SettingsIcon className="size-4" />, label: 'Settings' },
    );
  }
  return items;
}
