import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LayersIcon, PlusIcon, TrashIcon, GlobeIcon, UserIcon, TerminalIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontalIcon } from 'lucide-react';
import {
  HarnessNexusError,
  type Profile,
  type McpServer,
  type Resource,
  type ResourceKind,
  type AgentTarget,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

/** The Agent targets a profile can be shaped for (Phase 3.2 + codex + 8 T1). */
const TARGETS: AgentTarget[] = ['claude-code', 'hermes', 'codex', 'deepseek', 'zcode', 'generic'];

/** Non-mcp resource kinds a profile entry can reference (Phase 3.5). */
const RESOURCE_KINDS: ResourceKind[] = ['skill', 'rule', 'command', 'sub_agent', 'hook'];
/**
 * The kind domain a `{resourceId, kind}` entry accepts — 'mcp' is excluded
 * (MCP servers enter via the mcpServerId arm). Safe to assert: kind:'mcp'
 * resources cannot exist (`AVAILABLE_KINDS` gate on the server).
 */
type NonMcpKind = Exclude<ResourceKind, 'mcp'>;

export function ProfilesPage() {
  const { logout, user } = useAuth();
  const [items, setItems] = useState<Profile[] | null>(null);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listProfiles(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load profiles');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(p: Profile) {
    if (!confirm(`Delete profile "${p.name}"?`)) return;
    try {
      await withAuthGuard(() => api.deleteProfile(p.id), logout);
      toast.success('Profile deleted');
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Profiles</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Bundles of MCP servers and resources that agent tools install or connect through.
        </p>
      </div>

      {user && (
        <Card className="mb-6 border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TerminalIcon className="size-4" />
              Install in Claude Code
            </CardTitle>
            <CardDescription>
              Every <code className="font-mono">claude-code</code> profile below is served as a
              native Claude Code plugin. Create a marketplace token once, then on your machine:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              <code>{`claude plugin marketplace add <server>/api/marketplace/<marketplace-token>/marketplace.json
claude plugin install <profile-name>@harness-nexus-${user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}</code>
            </pre>
            <p className="text-muted-foreground mt-2 text-xs">
              The add command is shown once when you create the token —{' '}
              <a className="text-signal underline-offset-4 hover:underline" href="/tokens">
                manage tokens
              </a>
              . Install, update, and uninstall are then handled by Claude Code itself.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayersIcon className="size-4" />
            Profiles
          </CardTitle>
          <CardDescription>
            Personal profiles are yours; global ones are shared by an admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Entries</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    No profiles yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6">
                      <div className="font-medium">{p.name}</div>
                      {p.description && (
                        <div className="text-muted-foreground mt-0.5 text-xs">{p.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Neutral Badge: target encodes intent, not connection state
                          (Signal system reserves --signal for liveness). */}
                      <Badge variant="secondary" className="font-mono text-[11px]">
                        {p.target}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {p.entries.length}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={p.scope === 'global' ? 'default' : 'secondary'}
                        className="gap-1"
                      >
                        {p.scope === 'global' ? (
                          <GlobeIcon className="size-3" />
                        ) : (
                          <UserIcon className="size-3" />
                        )}
                        {p.scope}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontalIcon className="size-4" />
                            <span className="sr-only">Open menu</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={p.scope === 'global' && !isAdmin}
                            onClick={() => remove(p)}
                          >
                            <TrashIcon /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateProfile onCreated={refresh} />
    </AppShell>
  );
}

function CreateProfile({ onCreated }: { onCreated: () => void }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  const [target, setTarget] = useState<AgentTarget>('generic');
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [selectedResources, setSelectedResources] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);

  // Fetch the MCP servers + resources the caller can see, to populate the
  // entry checkboxes (independent lists → Promise.all).
  useEffect(() => {
    Promise.all([api.listMcpServers(), api.listResources()])
      .then(([s, r]) => {
        setServers(s);
        setResources(r);
      })
      .catch(() => {
        setServers([]);
        setResources([]);
      });
  }, []);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Mixed entry arms (Phase 3.5): mcpServerId for MCP, {resourceId, kind}
      // for everything else — exactly the two REST shapes.
      const entries = [
        ...[...selectedServers].map((mcpServerId) => ({ mcpServerId })),
        ...[...selectedResources].map((resourceId) => ({
          resourceId,
          kind: (resources ?? []).find((r) => r.id === resourceId)!.kind as NonMcpKind,
        })),
      ];
      await withAuthGuard(
        () =>
          api.createProfile({
            name,
            target,
            ...(description ? { description } : {}),
            scope,
            entries,
          }),
        logout,
      );
      toast.success('Profile created');
      setName('');
      setDescription('');
      setTarget('generic');
      setSelectedServers(new Set());
      setSelectedResources(new Set());
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusIcon className="size-4" />
          Add profile
        </CardTitle>
        <CardDescription>
          Choose which MCP servers this profile exposes to agent tools.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="prof-name">Name</Label>
              <Input
                id="prof-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Frontend daily"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-target">Target</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as AgentTarget)}>
                <SelectTrigger id="prof-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGETS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-desc">Description</Label>
              <Input
                id="prof-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="optional"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-scope">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="prof-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">personal</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    global {!isAdmin && '(admin)'}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">MCP servers in this profile</legend>
            {servers === null ? (
              <p className="text-muted-foreground text-sm">Loading servers…</p>
            ) : servers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No MCP servers visible to you yet. Add one first.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {servers.map((s) => (
                  <label
                    key={s.id}
                    className="border-border flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedServers.has(s.id)}
                      onChange={() => toggle(setSelectedServers, s.id)}
                      className="size-4"
                    />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {s.transport.type}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {RESOURCE_KINDS.map((kind) => {
            const of = (resources ?? []).filter((r) => r.kind === kind);
            return (
              <fieldset key={kind} className="grid gap-2">
                <legend className="text-sm font-medium">
                  {kind === 'sub_agent' ? 'sub-agents' : `${kind}s`}
                  <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                    ({of.length} visible)
                  </span>
                </legend>
                {resources === null ? (
                  <p className="text-muted-foreground text-sm">Loading…</p>
                ) : of.length === 0 ? (
                  <p className="text-muted-foreground text-sm">None — manage them in Resources.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {of.map((r) => (
                      <label
                        key={r.id}
                        className="border-border flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedResources.has(r.id)}
                          onChange={() => toggle(setSelectedResources, r.id)}
                          className="size-4"
                        />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="text-muted-foreground font-mono text-[10px]">{r.key}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            );
          })}

          <div>
            <Button
              type="submit"
              disabled={busy || (selectedServers.size === 0 && selectedResources.size === 0)}
            >
              {busy ? 'Creating…' : 'Create profile'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
