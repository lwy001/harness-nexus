import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LayersIcon, PlusIcon, TrashIcon, GlobeIcon, UserIcon, TerminalIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, type TranslationKey } from '@/i18n';
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
const RESOURCE_KINDS: NonMcpKind[] = ['skill', 'rule', 'command', 'sub_agent', 'hook'];
/**
 * The kind domain a `{resourceId, kind}` entry accepts — 'mcp' is excluded
 * (MCP servers enter via the mcpServerId arm). Safe to assert: kind:'mcp'
 * resources cannot exist (`AVAILABLE_KINDS` gate on the server).
 */
type NonMcpKind = Exclude<ResourceKind, 'mcp'>;

/** Fieldset legend per entry kind (values rendered verbatim — never derived). */
const KIND_LEGEND: Record<NonMcpKind, TranslationKey> = {
  skill: 'profiles.kindSkills',
  rule: 'profiles.kindRules',
  command: 'profiles.kindCommands',
  sub_agent: 'profiles.kindSubAgents',
  hook: 'profiles.kindHooks',
};

export function ProfilesPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<Profile[] | null>(null);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listProfiles(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('profiles.loadFailed'));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(p: Profile) {
    if (!confirm(t('profiles.confirmDelete', { name: p.name }))) return;
    try {
      await withAuthGuard(() => api.deleteProfile(p.id), logout);
      toast.success(t('profiles.deleted'));
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('profiles.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('profiles.subtitle')}</p>
      </div>

      {user && (
        <Card className="mb-6 border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TerminalIcon className="size-4" />
              {t('profiles.installTitle')}
            </CardTitle>
            <CardDescription>
              {t('profiles.installDescBefore')} <code className="font-mono">claude-code</code>{' '}
              {t('profiles.installDescAfter')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              <code>{`claude plugin marketplace add <server>/api/marketplace/<marketplace-token>/marketplace.json
claude plugin install <profile-name>@harness-nexus-${user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}</code>
            </pre>
            <p className="text-muted-foreground mt-2 text-xs">
              {t('profiles.installNoteBefore')}
              <a className="text-signal underline-offset-4 hover:underline" href="/tokens">
                {t('profiles.manageTokens')}
              </a>
              {t('profiles.installNoteAfter')}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayersIcon className="size-4" />
            {t('profiles.title')}
          </CardTitle>
          <CardDescription>{t('profiles.cardDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('common.name')}</TableHead>
                <TableHead>{t('profiles.target')}</TableHead>
                <TableHead>{t('profiles.entries')}</TableHead>
                <TableHead>{t('common.scope')}</TableHead>
                <TableHead className="pr-6 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    {t('profiles.noProfiles')}
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
                        {p.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontalIcon className="size-4" />
                            <span className="sr-only">{t('common.openMenu')}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={p.scope === 'global' && !isAdmin}
                            onClick={() => remove(p)}
                          >
                            <TrashIcon /> {t('common.delete')}
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
  const { t } = useI18n();
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
      toast.success(t('profiles.created'));
      setName('');
      setDescription('');
      setTarget('generic');
      setSelectedServers(new Set());
      setSelectedResources(new Set());
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusIcon className="size-4" />
          {t('profiles.addTitle')}
        </CardTitle>
        <CardDescription>{t('profiles.addDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="prof-name">{t('common.name')}</Label>
              <Input
                id="prof-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('profiles.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-target">{t('profiles.target')}</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as AgentTarget)}>
                <SelectTrigger id="prof-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGETS.map((target) => (
                    <SelectItem key={target} value={target}>
                      {target}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-desc">{t('common.description')}</Label>
              <Input
                id="prof-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('profiles.optional')}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-scope">{t('common.scope')}</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="prof-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {!isAdmin && t('profiles.adminSuffix')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{t('profiles.serversLegend')}</legend>
            {servers === null ? (
              <p className="text-muted-foreground text-sm">{t('profiles.loadingServers')}</p>
            ) : servers.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('profiles.noServers')}</p>
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
                  {t(KIND_LEGEND[kind])}
                  <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                    {t('profiles.visibleCount', { count: of.length })}
                  </span>
                </legend>
                {resources === null ? (
                  <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
                ) : of.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('profiles.noneInResources')}</p>
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
              {busy ? t('profiles.creating') : t('profiles.createProfile')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
