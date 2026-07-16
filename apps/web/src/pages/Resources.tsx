import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BoxesIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  GlobeIcon,
  UserIcon,
  MoreHorizontalIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AgentNexusError,
  type Resource,
  type ResourceKind,
  type AgentTarget,
} from '@agent-nexus/sdk';

type Scope = 'global' | 'personal';

/** Kinds currently shipped (4.2/4.3/4.4). 4.5–4.6 add theirs here when they land. */
const KINDS: { value: ResourceKind; label: string; bodyLabel: string; bodyPlaceholder: string }[] =
  [
    {
      value: 'sub_agent',
      label: 'Sub-agent',
      bodyLabel: 'System prompt',
      bodyPlaceholder: 'You are a careful code reviewer…',
    },
    {
      value: 'rule',
      label: 'Rule',
      bodyLabel: 'Policy / guideline',
      bodyPlaceholder: 'Always run tests before marking a task done…',
    },
    {
      value: 'command',
      label: 'Command',
      bodyLabel: 'Command body',
      bodyPlaceholder: 'Explain the arguments to this command: $ARGUMENTS',
    },
  ];

const TARGETS: AgentTarget[] = ['claude-code', 'zcode', 'hermes', 'generic'];

export function ResourcesPage() {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState<Resource[] | null>(null);
  const [kindFilter, setKindFilter] = useState<ResourceKind | 'all'>('all');
  const [scopeFilter, setScopeFilter] = useState<Scope | 'all'>('all');
  // The resource being edited, or 'new' to open the create dialog, or null.
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);

  async function refresh() {
    try {
      const all = await withAuthGuard(() => api.listResources(), logout);
      setItems(all);
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Failed to load resources');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Re-fetch when a filter narrows the set server-side.
  useEffect(() => {
    void (async () => {
      try {
        const filter =
          kindFilter === 'all' && scopeFilter === 'all'
            ? undefined
            : {
                ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
                ...(scopeFilter !== 'all' ? { scope: scopeFilter } : {}),
              };
        setItems(await withAuthGuard(() => api.listResources(filter), logout));
      } catch {
        /* refresh() already toasted */
      }
    })();
  }, [kindFilter, scopeFilter, logout]);

  const filtered = useMemo(() => {
    if (!items) return null;
    return items;
  }, [items]);

  async function remove(r: Resource) {
    if (!confirm(`Delete resource "${r.name}" (${r.kind})? This cannot be undone.`)) return;
    try {
      await withAuthGuard(() => api.deleteResource(r.id), logout);
      toast.success('Resource deleted');
      await refresh();
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Resources</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Versioned assets (sub-agents, rules) that profiles reference by{' '}
          <code className="font-mono">kind:key</code>. Personal ones are yours; global ones are
          shared by an admin.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BoxesIcon className="size-4" />
                Stored resources
              </CardTitle>
              <CardDescription>Filter by kind or scope to narrow the list.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={kindFilter}
                onValueChange={(v) => setKindFilter(v as ResourceKind | 'all')}
              >
                <SelectTrigger id="filter-kind" className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v as Scope | 'all')}>
                <SelectTrigger id="filter-scope" className="w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All scopes</SelectItem>
                  <SelectItem value="personal">personal</SelectItem>
                  <SelectItem value="global">global</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => setEditing('new')} className="gap-1.5">
                <PlusIcon className="size-4" />
                <span className="hidden sm:inline">New resource</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered === null ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    No resources yet.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-6 font-medium">{r.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {r.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{r.key}</TableCell>
                    <TableCell>
                      <Badge
                        variant={r.scope === 'global' ? 'default' : 'secondary'}
                        className="gap-1"
                      >
                        {r.scope === 'global' ? (
                          <GlobeIcon className="size-3" />
                        ) : (
                          <UserIcon className="size-3" />
                        )}
                        {r.scope}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {new Date(r.updatedAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
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
                            disabled={r.scope === 'global' && !isAdmin}
                            onClick={() => setEditing(r)}
                          >
                            <PencilIcon /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={r.scope === 'global' && !isAdmin}
                            onClick={() => remove(r)}
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

      {editing !== null ? (
        <ResourceEditor
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </AppShell>
  );
}

/** Create/edit Dialog shared by all kinds. 4.2/4.3 produce inline-markdown bodies. */
function ResourceEditor({
  existing,
  onClose,
  onSaved,
}: {
  existing: Resource | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isCreate = existing === null;

  const [kind, setKind] = useState<ResourceKind>(existing?.kind ?? 'sub_agent');
  const [key, setKey] = useState(existing?.key ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [version, setVersion] = useState(existing?.version ?? '1.0.0');
  const [scope, setScope] = useState<Scope>(existing?.scope ?? 'personal');
  const [targets, setTargets] = useState<AgentTarget[]>(existing?.targets ?? []);
  const [body, setBody] = useState(
    existing?.source.type === 'inline' ? existing.source.content : '',
  );
  const [busy, setBusy] = useState(false);

  const kindMeta = KINDS.find((k) => k.value === kind)!;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const shared = {
        key,
        name,
        description: description.trim() === '' ? undefined : description,
        version,
        source: { type: 'inline' as const, content: body },
        targets,
      };
      if (isCreate) {
        await withAuthGuard(() => api.createResource({ ...shared, kind, scope }), logout);
        toast.success('Resource created');
      } else {
        await withAuthGuard(() => api.updateResource(existing!.id, shared), logout);
        toast.success('Resource saved');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  function toggleTarget(t: AgentTarget) {
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isCreate ? 'New resource' : `Edit ${existing!.name}`}</DialogTitle>
          <DialogDescription>
            {kindMeta.bodyLabel.toLowerCase()} content is stored as inline markdown and referenced
            by <code className="font-mono">{`${kind}:${key || '…'}`}</code>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-kind">Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as ResourceKind)}
                disabled={!isCreate}
              >
                <SelectTrigger id="res-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-scope">Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as Scope)}
                disabled={!isCreate || !isAdmin}
              >
                <SelectTrigger id="res-scope">
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-key">Key</Label>
              <Input
                id="res-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={`${kind}:my-asset`}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-name">Name</Label>
              <Input
                id="res-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Human-readable name"
                autoComplete="off"
                required
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-version">Version</Label>
              <Input
                id="res-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-desc">Description</Label>
              <Input
                id="res-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional summary"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Targets</Label>
            <div className="flex flex-wrap gap-2">
              {TARGETS.map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={targets.includes(t)}
                    onChange={() => toggleTarget(t)}
                    className="size-3.5"
                  />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="res-body">{kindMeta.bodyLabel}</Label>
            <Textarea
              id="res-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={kindMeta.bodyPlaceholder}
              spellCheck={false}
              className="min-h-48 font-mono text-xs"
            />
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={onSubmit}>
            {busy ? 'Saving…' : isCreate ? 'Create resource' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
