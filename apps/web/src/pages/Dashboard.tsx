import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { UsersIcon, SettingsIcon, KeyRoundIcon, ServerIcon, LayersIcon, ArrowRightIcon } from 'lucide-react';
import { useAuth, withAuthGuard } from '@/auth';
import { api } from '@/api';
import {
  AgentNexusError,
  type CredentialView,
  type McpServer,
  type McpServerStatus,
  type Profile,
} from '@agent-nexus/sdk';
import { AppShell } from '@/components/app-shell';
import { MeshTopology } from '@/components/mesh-topology';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function DashboardPage() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [statuses, setStatuses] = useState<McpServerStatus[] | null>(null);
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);

  // Parallel fetch — the lists are independent, so don't serialize them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, st, c, p] = await Promise.all([
          withAuthGuard(() => api.listMcpServers(), logout),
          withAuthGuard(() => api.listMcpServerStatuses().catch(() => [] as McpServerStatus[]), logout),
          withAuthGuard(() => api.listCredentials(), logout),
          withAuthGuard(() => api.listProfiles(), logout),
        ]);
        if (cancelled) return;
        setServers(s);
        setStatuses(st);
        setCreds(c);
        setProfiles(p);
      } catch (e) {
        if (cancelled) return;
        toast.error(e instanceof AgentNexusError ? e.message : 'Failed to load overview');
        setServers([]);
        setStatuses([]);
        setCreds([]);
        setProfiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logout]);

  if (!user) return null;

  const serverCount = servers?.length ?? 0;
  const credCount = creds?.length ?? 0;
  const profileCount = profiles?.length ?? 0;

  return (
    <AppShell>
      {/* Hero — the signature. The mesh is the most characteristic thing in
          this product's world, so it leads instead of a "Welcome" headline. */}
      <section className="mb-8">
        <div className="mb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Upstream MCP servers aggregated into one connection for your agent tools.
          </p>
        </div>
        <MeshTopology
          servers={servers ?? []}
          loading={servers === null}
          statuses={statuses ?? undefined}
        />
      </section>

      {/* Compact summary — replaces the old dead-link cards with live counts. */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryLink
          to="/mcp-servers"
          icon={<ServerIcon className="size-4" />}
          label="MCP servers"
          count={serverCount}
          loading={servers === null}
          hint="Upstream connections (SSE · HTTP)"
        />
        <SummaryLink
          to="/profiles"
          icon={<LayersIcon className="size-4" />}
          label="Profiles"
          count={profileCount}
          loading={profiles === null}
          hint="Bundles of servers for agent tools"
        />
        <SummaryLink
          to="/credentials"
          icon={<KeyRoundIcon className="size-4" />}
          label="Credentials"
          count={credCount}
          loading={creds === null}
          hint="Encrypted secrets for upstreams"
        />
        {isAdmin ? (
          <>
            <SummaryLink
              to="/admin/users"
              icon={<UsersIcon className="size-4" />}
              label="Users"
              hint="Accounts and roles"
              actionLabel="Manage"
            />
            <SummaryLink
              to="/admin/settings"
              icon={<SettingsIcon className="size-4" />}
              label="Settings"
              hint="Registration switch"
              actionLabel="Open"
            />
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                Account
                <Badge variant="secondary" className="text-[10px]">
                  {user.role}
                </Badge>
              </CardTitle>
              <CardDescription>Your profile and access level</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground flex flex-col gap-1 text-sm">
              <div className="min-w-0">
                <span>Username </span>
                <span className="text-foreground font-medium">{user.username}</span>
              </div>
              {user.email && (
                <div className="min-w-0">
                  <span>Email </span>
                  <span className="text-foreground font-medium">{user.email}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      <p className="text-muted-foreground mt-6 text-xs">
        Agent tools connect via a PAT and a profile: <code className="font-mono">/mcp?profile=&lt;id&gt;</code>.
        callable-function scripts (wrapping vendor APIs as MCP tools) arrive in a later phase.
      </p>
    </AppShell>
  );
}

function SummaryLink({
  to,
  icon,
  label,
  count,
  loading,
  hint,
  actionLabel,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
  loading?: boolean;
  hint: string;
  actionLabel?: string;
}) {
  return (
    <Link to={to} className="group">
      <Card className="transition-colors group-hover:border-signal/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="text-muted-foreground">{icon}</span>
            {label}
            <ArrowRightIcon className="text-muted-foreground/50 ml-auto size-4 transition-transform group-hover:translate-x-0.5" />
          </CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
        <CardContent>
          {count !== undefined ? (
            <div className="flex items-baseline gap-2">
              <span className="text-foreground text-2xl font-semibold tabular-nums">
                {loading ? '—' : count}
              </span>
              <span className="text-muted-foreground text-xs">
                {count === 1 ? 'item' : 'items'}
              </span>
            </div>
          ) : (
            <span className="text-signal text-sm font-medium">{actionLabel}</span>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
