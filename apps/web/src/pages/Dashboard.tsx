import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { UsersIcon, SettingsIcon, ArrowRightIcon, KeyRoundIcon, BoxesIcon } from 'lucide-react';
import { useAuth } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function DashboardPage() {
  const { user } = useAuth();
  if (!user) return null;
  const isAdmin = user.role === 'admin';

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.username}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your unified Agent-tool management platform.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Account
              <Badge variant="secondary" className="text-[10px]">
                {user.role}
              </Badge>
            </CardTitle>
            <CardDescription>Your profile and access level</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            <div className="flex flex-col gap-1">
              <div>
                Username: <span className="text-foreground font-medium">{user.username}</span>
              </div>
              {user.email && (
                <div>
                  Email: <span className="text-foreground font-medium">{user.email}</span>
                </div>
              )}
              <div>
                Status:{' '}
                <span className="text-foreground font-medium capitalize">{user.status}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <QuickLink
          to="/"
          icon={<KeyRoundIcon />}
          title="Access tokens"
          desc="Manage PATs for CLI and automation"
          disabled
        />
        <QuickLink
          to="/"
          icon={<BoxesIcon />}
          title="Resources & profiles"
          desc="Skills, hooks, sub-agents, rules"
          disabled
        />

        {isAdmin && (
          <>
            <QuickLink
              to="/admin/users"
              icon={<UsersIcon />}
              title="User management"
              desc="Add, remove, and manage user roles"
            />
            <QuickLink
              to="/admin/settings"
              icon={<SettingsIcon />}
              title="System settings"
              desc="Control the registration switch"
            />
          </>
        )}
      </div>

      {!isAdmin && (
        <p className="text-muted-foreground mt-6 text-xs">
          Some modules (resources, profiles, MCP servers) are not built yet — they'll appear here in
          later phases.
        </p>
      )}
    </AppShell>
  );
}

function QuickLink({
  to,
  icon,
  title,
  desc,
  disabled,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  const content = (
    <Card className={disabled ? 'opacity-60' : 'transition-colors hover:border-primary/40'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="text-muted-foreground">{icon}</span>
          {title}
          {!disabled && <ArrowRightIcon className="ml-auto size-4 opacity-50" />}
        </CardTitle>
        <CardDescription>{desc}</CardDescription>
      </CardHeader>
    </Card>
  );
  return disabled ? content : <Link to={to}>{content}</Link>;
}
