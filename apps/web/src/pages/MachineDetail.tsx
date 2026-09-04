import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  BoxesIcon,
  GitCompareArrowsIcon,
  LaptopIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { appSocket, type InventoryUpdatedEvent, type MachineStatusEvent } from '@/realtime';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  HarnessNexusError,
  type ImportResult,
  type InventoryDiff,
  type MachineView,
  type Profile,
} from '@harness-nexus/sdk';

/** One row of `GET /api/machines/:id/inventory` (server view shape). */
interface InventoryEntry {
  target: string;
  daemonVersion: string | null;
  reportedAt: string;
  scannedAt: string;
  agents: {
    name: string;
    directory: string;
    profileApplied: boolean | null;
    items: InventoryItemView[];
  }[];
}

interface InventoryItemView {
  kind: string;
  name: string;
  origin: 'platform' | 'local';
  path: string;
  summary?: string;
  contentPreview?: string;
  importable: boolean;
  note?: string;
  meta?: { multi?: boolean; transport?: string; command?: string; url?: string };
}

/**
 * Machine detail (Phase 8 C3): per-target inventory with live refresh, the
 * profile diff, and the one-click import wizard. Drill-down from the Machines
 * list — no sidebar entry. Signal rules: origin/import badges stay neutral;
 * `--signal` is not spent here.
 */
export function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { logout } = useAuth();
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [inventory, setInventory] = useState<InventoryEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [m, inv] = await Promise.all([
        withAuthGuard(() => api.getMachine(id), logout),
        withAuthGuard(() => api.getMachineInventory(id), logout),
      ]);
      setMachine(m);
      setInventory(inv);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load machine');
    }
  }, [id, logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates: presence patches the header; a fresh snapshot refetches.
  useEffect(() => {
    const socket = appSocket();
    const onStatus = (e: MachineStatusEvent): void => {
      setMachine((prev) =>
        prev && prev.id === e.machineId
          ? {
              ...prev,
              online: e.online,
              lastSeenAt: e.lastSeenAt,
              ...(e.daemonVersion !== undefined ? { daemonVersion: e.daemonVersion } : {}),
            }
          : prev,
      );
    };
    const onInventory = (e: InventoryUpdatedEvent): void => {
      if (e.machineId === id) void refresh();
    };
    socket.on('machine:status', onStatus);
    socket.on('inventory:updated', onInventory);
    return () => {
      socket.off('machine:status', onStatus);
      socket.off('inventory:updated', onInventory);
    };
  }, [id, refresh]);

  async function scan(): Promise<void> {
    if (!id) return;
    setScanning(true);
    try {
      const result = await withAuthGuard(() => api.scanMachineInventory(id), logout);
      setInventory(
        result.map((r) => ({
          target: r.target,
          daemonVersion: machine?.daemonVersion ?? null,
          reportedAt: r.reportedAt,
          scannedAt: r.reportedAt,
          agents: r.agents,
        })),
      );
      toast.success(`Scanned ${result.length} target(s)`);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  const targets = useMemo(() => inventory?.map((i) => i.target) ?? [], [inventory]);

  return (
    <AppShell>
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/machines">
            <ArrowLeftIcon className="size-4" />
            Machines
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight text-wrap-balance">
          {machine?.name ?? 'Machine'}
        </h1>
        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            <span
              className={`mr-1.5 inline-block size-2 rounded-full align-middle ${
                machine?.online ? 'bg-ok' : 'bg-muted-foreground/40'
              }`}
            />
            {machine?.online ? 'Online' : 'Offline'}
          </span>
          {machine?.hostname ? (
            <span className="font-mono text-xs">
              {[machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          {machine?.daemonVersion ? (
            <span className="font-mono text-xs tabular-nums">daemon {machine.daemonVersion}</span>
          ) : null}
        </p>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <Button onClick={() => void scan()} disabled={scanning || machine?.online !== true}>
          <RefreshCwIcon className={scanning ? 'size-4 animate-spin' : 'size-4'} />
          {scanning ? 'Scanning…' : 'Scan now'}
        </Button>
        <span className="text-muted-foreground text-sm">
          Requires the daemon online{machine?.online !== true ? ' — machine is offline' : ''}.
        </span>
      </div>

      {inventory === null ? (
        <p className="text-muted-foreground py-8 text-center text-sm">Loading inventory…</p>
      ) : inventory.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No inventory yet — run a scan while the daemon is online.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {inventory.map((entry) => (
            <TargetInventoryCard key={entry.target} entry={entry} />
          ))}
          {targets.length > 0 ? <DiffAndImport machineId={id!} targets={targets} /> : null}
        </div>
      )}
    </AppShell>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {kind}
    </Badge>
  );
}

function OriginBadge({ origin }: { origin: 'platform' | 'local' }) {
  return (
    <Badge variant={origin === 'platform' ? 'secondary' : 'default'} className="text-[10px]">
      {origin === 'platform' ? 'hnx' : 'local'}
    </Badge>
  );
}

function TargetInventoryCard({ entry }: { entry: InventoryEntry }) {
  const agent = entry.agents[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LaptopIcon className="size-4" />
          <span className="font-mono">{agent?.directory ?? entry.target}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {entry.target}
          </Badge>
          {agent?.profileApplied ? (
            <Badge variant="secondary" className="text-[10px]">
              profile applied
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {entry.agents.reduce((n, a) => n + a.items.length, 0)} items · reported{' '}
          {new Date(entry.reportedAt).toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Kind</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="pr-6">Path</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.agents.flatMap((a) => a.items).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                  Nothing discovered on this target.
                </TableCell>
              </TableRow>
            ) : (
              entry.agents.flatMap((a) =>
                a.items.map((item) => (
                  <TableRow key={`${item.kind}:${item.name}`}>
                    <TableCell className="pl-6">
                      <KindBadge kind={item.kind} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{item.name}</TableCell>
                    <TableCell>
                      <OriginBadge origin={item.origin} />
                    </TableCell>
                    <TableCell className="max-w-[28rem] truncate text-muted-foreground text-xs">
                      {item.importable
                        ? (item.summary ?? item.contentPreview ?? '—')
                        : `not importable (${item.note ?? 'unknown'})`}
                    </TableCell>
                    <TableCell className="text-muted-foreground pr-6 font-mono text-xs">
                      {item.path}
                    </TableCell>
                  </TableRow>
                )),
              )
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DiffAndImport({ machineId, targets }: { machineId: string; targets: string[] }) {
  const { logout } = useAuth();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [diff, setDiff] = useState<InventoryDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profileName, setProfileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setProfiles(await withAuthGuard(() => api.listProfiles(), logout));
      } catch {
        setProfiles([]);
      }
    })();
  }, [logout]);

  const eligible = useMemo(
    () => (profiles ?? []).filter((p) => targets.includes(p.target)),
    [profiles, targets],
  );

  async function runDiff(id: string): Promise<void> {
    setDiff(null);
    setDiffError(null);
    setSelected(new Set());
    setResult(null);
    try {
      setDiff(await withAuthGuard(() => api.diffMachineInventory(machineId, id), logout));
    } catch (e) {
      setDiffError(e instanceof HarnessNexusError ? e.message : 'Diff failed');
    }
  }

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runImport(): Promise<void> {
    if (!diff) return;
    const items = diff.notInProfile
      .filter((i) => i.importable && selected.has(`${i.kind}:${i.name}`))
      .map((i) => ({ kind: i.kind, name: i.name }));
    if (items.length === 0) {
      toast.error('Select at least one importable item');
      return;
    }
    setImporting(true);
    try {
      const res = await withAuthGuard(
        () =>
          api.importMachineInventory(machineId, {
            target: diff.target,
            profileName: profileName.trim(),
            items,
          }),
        logout,
      );
      setResult(res);
      toast.success(
        `Profile "${res.profile.name}" created (${res.created.length} new, ${res.reused.length} reused)`,
      );
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompareArrowsIcon className="size-4" />
          Compare with a profile & import
        </CardTitle>
        <CardDescription>
          Local artifacts no profile claims are import candidates — pull them into the platform as a
          new personal profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 gap-2">
            <Label htmlFor="diff-profile">Profile</Label>
            <Select
              value={profileId}
              onValueChange={(v) => {
                setProfileId(v);
                void runDiff(v);
              }}
            >
              <SelectTrigger id="diff-profile" className="font-mono text-xs">
                <SelectValue placeholder="Pick a profile…" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                    {p.name} ({p.target})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-muted-foreground pb-2 text-sm">
            {eligible.length === 0 ? 'No profiles match this machine’s targets yet.' : null}
          </p>
        </div>

        {diffError ? (
          <Alert variant="destructive">
            <AlertDescription>{diffError}</AlertDescription>
          </Alert>
        ) : null}

        {diff ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <SummaryStat label="Applied" value={diff.summary.applied} />
              <SummaryStat label="Missing on machine" value={diff.summary.missing} />
              <SummaryStat label="Import candidates" value={diff.summary.candidates} />
            </div>

            {diff.missingOnMachine.length > 0 ? (
              <div>
                <p className="mb-1 text-sm font-medium">Missing on machine (drift)</p>
                <ul className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                  {diff.missingOnMachine.map((e) => (
                    <li key={`${e.kind}:${e.name}`} className="border rounded-md px-2 py-1">
                      <span className="font-mono">
                        {e.kind}:{e.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="mb-1 text-sm font-medium">
                Import candidates ({diff.notInProfile.length}) — not claimed by any profile
              </p>
              {diff.notInProfile.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing to import — every local artifact is already in the profile.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {diff.notInProfile.map((item) => {
                    const key = `${item.kind}:${item.name}`;
                    return (
                      <li key={key} className="flex items-center gap-2">
                        <Checkbox
                          id={`imp-${key}`}
                          checked={selected.has(key)}
                          onCheckedChange={() => toggle(key)}
                          disabled={!item.importable}
                          aria-label={`Import ${item.name}`}
                        />
                        <label
                          htmlFor={`imp-${key}`}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm"
                        >
                          <KindBadge kind={item.kind} />
                          <span className="font-mono text-xs">{item.name}</span>
                          <span className="text-muted-foreground truncate text-xs">
                            {item.summary ?? item.path}
                          </span>
                          {!item.importable ? (
                            <span className="text-muted-foreground text-xs">
                              (not importable{item.note ? `: ${item.note}` : ''})
                            </span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {diff.notInProfile.some((i) => i.importable) ? (
              <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                <div className="grid min-w-64 gap-2">
                  <Label htmlFor="import-profile-name">New profile name</Label>
                  <Input
                    id="import-profile-name"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="e.g. My laptop setup"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>
                <Button
                  onClick={() => void runImport()}
                  disabled={importing || profileName.trim().length === 0 || selected.size === 0}
                >
                  <UploadIcon className="size-4" />
                  {importing ? 'Importing…' : `Import ${selected.size} item(s)`}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {result ? (
          <Alert>
            <BoxesIcon className="size-4" />
            <AlertTitle>
              Imported into{' '}
              <Link to="/profiles" className="underline">
                {result.profile.name}
              </Link>{' '}
              — {result.created.length} created, {result.reused.length} reused
              {result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.
            </AlertTitle>
            <AlertDescription>
              {result.failed.length > 0 ? (
                <span className="block">
                  Failed: {result.failed.map((f) => `${f.name} (${f.error})`).join('; ')}
                </span>
              ) : null}
              {result.warnings.length > 0 ? (
                <span className="block">
                  {result.warnings.map((w, i) => (
                    <span key={i} className="block">
                      · {w}
                    </span>
                  ))}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="font-mono text-xl tabular-nums">{value}</p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  );
}
