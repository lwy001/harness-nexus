import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  StoreIcon,
  SearchIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  ExternalLinkIcon,
} from 'lucide-react';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AgentNexusError,
  marketplacePluginToResourceSource,
  resolveTrustTier,
  type AgentTarget,
  type MarketplacePlugin,
  type TrustTier,
} from '@agent-nexus/sdk';

type Scope = 'global' | 'personal';

const TARGETS: AgentTarget[] = ['claude-code', 'zcode', 'hermes', 'generic'];

/**
 * Skill hub (Phase 7.3) — browse a marketplace's plugin catalog and save an
 * entry as a `plugin`-source skill resource. The browse surface for the
 * outbound-fetch backend landed in 7.2; the plugin source variant + trust
 * model landed in 7.1. This page is the UX closed loop.
 *
 * Trust is computed client-side from the repo owner (`resolveTrustTier`); the
 * server recomputes it authoritatively at save time (`withTrustLabels`). The
 * badge uses neutral variants — `--signal` is reserved for liveness per the
 * Signal design system (AGENTS.md "Web UI design system").
 */
export function SkillHubPage() {
  const { logout } = useAuth();
  const [marketplaces, setMarketplaces] = useState<{ id: string }[] | null>(null);
  const [selectedMkt, setSelectedMkt] = useState<string>('');
  const [items, setItems] = useState<MarketplacePlugin[] | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [q, setQ] = useState<string>('');
  const [saving, setSaving] = useState<MarketplacePlugin | null>(null);

  // Load the allowlist once; auto-select the first marketplace.
  useEffect(() => {
    void (async () => {
      try {
        const list = await withAuthGuard(() => api.listMarketplaces(), logout);
        setMarketplaces(list.marketplaces);
        if (list.marketplaces.length > 0 && !selectedMkt) {
          const first = list.marketplaces[0];
          if (first) setSelectedMkt(first.id);
        }
      } catch (e) {
        toast.error(e instanceof AgentNexusError ? e.message : 'Failed to load marketplaces');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout]);

  // Refetch plugins when the marketplace or filters change.
  useEffect(() => {
    if (!selectedMkt) return;
    void (async () => {
      setItems(null);
      try {
        const filter: { category?: string; q?: string } = {};
        if (category !== 'all') filter.category = category;
        if (q.trim()) filter.q = q.trim();
        const res = await withAuthGuard(
          () => api.listMarketplacePlugins(selectedMkt, filter),
          logout,
        );
        setItems(res.plugins);
      } catch (e) {
        toast.error(e instanceof AgentNexusError ? e.message : 'Failed to load plugins');
        setItems([]);
      }
    })();
  }, [selectedMkt, category, q, logout]);

  // Categories are derived from the currently-loaded set (every plugin that
  // declares a category). Sorted for stable Select ordering.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of items ?? []) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [items]);

  return (
    <AppShell>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <StoreIcon className="size-5" />
                Skill hub
              </CardTitle>
              <CardDescription>
                Browse marketplace plugins and save them as skill resources.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedMkt}
                onValueChange={(v) => setSelectedMkt(v)}
                disabled={!marketplaces || marketplaces.length === 0}
              >
                <SelectTrigger id="filter-marketplace" className="w-[220px]">
                  <SelectValue placeholder="Marketplace" />
                </SelectTrigger>
                <SelectContent>
                  {(marketplaces ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="font-mono">{m.id}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v)}
                disabled={!selectedMkt}
              >
                <SelectTrigger id="filter-category" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search plugins…"
                  spellCheck={false}
                  className="w-[220px] pl-8"
                  aria-label="Search plugins"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Trust</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!selectedMkt ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    Select a marketplace to browse.
                  </TableCell>
                </TableRow>
              ) : items === null ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    No plugins match the current filters.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((p) => <PluginRow key={p.name} plugin={p} onSave={() => setSaving(p)} />)
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {saving ? (
        <SavePluginDialog
          plugin={saving}
          onClose={() => setSaving(null)}
          onSaved={() => {
            setSaving(null);
            toast.success('Saved as skill resource');
          }}
        />
      ) : null}
    </AppShell>
  );
}

/** One catalog row. Trust is computed client-side from the source repo. */
function PluginRow({ plugin, onSave }: { plugin: MarketplacePlugin; onSave: () => void }) {
  const tier = resolveTrustTier(plugin.source);
  const name = plugin.displayName ?? plugin.name;
  return (
    <TableRow>
      <TableCell className="pl-6">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 font-medium">{name}</div>
          <div className="text-muted-foreground line-clamp-2 max-w-xl text-xs">
            {plugin.description}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {plugin.category ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {plugin.category}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground font-mono text-[11px]">{plugin.source.source}</span>
      </TableCell>
      <TableCell>
        <TrustBadge tier={tier} />
      </TableCell>
      <TableCell className="pr-6 text-right">
        <Button variant="outline" size="sm" onClick={onSave} className="gap-1.5">
          Save as skill
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * Neutral trust badge — `default` (ink) for trusted, `secondary` for community.
 * Deliberately does NOT use `--signal`; that accent is reserved for liveness
 * per the Signal design system.
 */
function TrustBadge({ tier }: { tier: TrustTier }) {
  if (tier === 'trusted') {
    return (
      <Badge variant="default" className="gap-1 text-[10px]">
        <ShieldCheckIcon className="size-3" />
        trusted
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 text-[10px]">
      <span
        className="inline-block size-1.5 rounded-full bg-muted-foreground/60"
        aria-hidden="true"
      />
      community
    </Badge>
  );
}

/**
 * Lightweight "save this marketplace entry as a skill resource" dialog. Asks
 * only for key/scope/targets; the source + name + description come from the
 * plugin. A warn callout appears for community sources without a pin
 * (supply-chain drift risk — the install-warning UX from the PRD).
 */
function SavePluginDialog({
  plugin,
  onClose,
  onSaved,
}: {
  plugin: MarketplacePlugin;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [key, setKey] = useState<string>(`skill:${plugin.name}`);
  const [scope, setScope] = useState<Scope>('personal');
  const [targets, setTargets] = useState<AgentTarget[]>(['claude-code']);
  const [busy, setBusy] = useState(false);

  const tier = resolveTrustTier(plugin.source);
  const hasPin = ('sha' in plugin.source && Boolean(plugin.source.sha)) || Boolean(plugin.version);
  const showWarn = tier === 'community' && !hasPin;

  function toggleTarget(t: AgentTarget) {
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function onSubmit() {
    if (scope === 'global' && !isAdmin) return;
    setBusy(true);
    try {
      const source = marketplacePluginToResourceSource(plugin) as Parameters<
        typeof api.createResource
      >[0]['source'];
      await withAuthGuard(
        () =>
          api.createResource({
            key,
            kind: 'skill',
            name: plugin.displayName ?? plugin.name,
            ...(plugin.description ? { description: plugin.description } : {}),
            source,
            scope,
            targets,
          }),
        logout,
      );
      onSaved();
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Failed to save skill');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as skill resource</DialogTitle>
          <DialogDescription>
            Stores this marketplace entry as a `plugin`-source skill. Reference it from a profile
            via <span className="font-mono">skill:{plugin.name}</span>.
          </DialogDescription>
        </DialogHeader>

        {showWarn ? (
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-xs">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              <span className="font-medium text-warn">Community source, no pin.</span>{' '}
              <span className="text-muted-foreground">
                Without a SHA/version pin, this reference floats with upstream — a supply-chain
                drift risk. Pin a SHA where possible.
              </span>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="skill-key">Key</Label>
            <Input
              id="skill-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
          </div>

          <div className="grid gap-2">
            <Label>Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger id="skill-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">personal</SelectItem>
                <SelectItem value="global" disabled={!isAdmin}>
                  global {isAdmin ? '' : '(admin only)'}
                </SelectItem>
              </SelectContent>
            </Select>
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
        </div>

        <DialogFooter>
          {plugin.homepage ? (
            <a
              href={plugin.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground mr-auto inline-flex items-center gap-1 text-xs"
            >
              <ExternalLinkIcon className="size-3" />
              homepage
            </a>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || (scope === 'global' && !isAdmin)}
            onClick={onSubmit}
          >
            {busy ? 'Saving…' : 'Save skill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
