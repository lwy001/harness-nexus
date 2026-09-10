import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  BoxesIcon,
  CameraIcon,
  FileCogIcon,
  GitCompareArrowsIcon,
  LaptopIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { AppShell } from '@/components/app-shell';
import { appSocket, type InventoryUpdatedEvent, type MachineStatusEvent } from '@/realtime';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
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
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { RocketIcon, SquareIcon } from 'lucide-react';
import {
  HarnessNexusError,
  RUNTIME_API_SUPPORT,
  type AgentInstanceView,
  type CredentialView,
  type ImportResult,
  type InventoryDiff,
  type JobView,
  type MachineView,
  type Profile,
  type RuntimeConfigSpec,
  type RuntimeTarget,
} from '@harness-nexus/sdk';

/** Wire shape of `job:update` (mirrors shared/realtime.ts). */
interface JobUpdateEvent {
  job: JobView;
}

/** Status → Signal-system color encoding (state colors only; --signal unused). */
const JOB_STATUS_CLASS: Record<string, string> = {
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  running: 'bg-warn',
  cancelled: 'bg-muted-foreground/40',
};

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
  /** Phase 9 W1 — null when the daemon build does not probe runtimes. */
  runtime: RuntimeInfoView | null;
}

interface RuntimeInfoView {
  target: string;
  installed: boolean;
  binPath?: string;
  version?: string;
  installMethod?: 'npm' | 'native' | 'brew' | 'unknown';
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
 * Machine detail (Phase 8 C3 + Phase 9 W1): the inventory view groups by
 * AGENT card — the installed harness runtime is the primary object, items
 * nest under it, a not-installed Agent says so instead of showing empty
 * lists, and its current state is captureable as a profile. Signal rules:
 * origin/method badges stay neutral; `--signal` is not spent here.
 */
export function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { logout } = useAuth();
  const { t } = useI18n();
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [inventory, setInventory] = useState<InventoryEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [agents, setAgents] = useState<AgentInstanceView[]>([]);

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
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.loadFailed'));
    }
  }, [id, logout, t]);

  const refreshJobs = useCallback(async () => {
    if (!id) return;
    try {
      const [jobs, agents] = await Promise.all([
        withAuthGuard(() => api.listMachineJobs(id), logout),
        withAuthGuard(() => api.listMachineAgents(id), logout),
      ]);
      setJobs(jobs);
      setAgents(agents);
    } catch {
      // job data is supplementary — a failure here doesn't blank the page
    }
  }, [id, logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

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
    const onJobUpdate = (e: JobUpdateEvent): void => {
      if (e.job.machineId !== id) return;
      setJobs((prev) => {
        const list = prev ?? [];
        return list.some((j) => j.id === e.job.id)
          ? list.map((j) => (j.id === e.job.id ? e.job : j))
          : [e.job, ...list];
      });
      if (e.job.status === 'succeeded' || e.job.status === 'failed') void refreshJobs();
    };
    socket.on('machine:status', onStatus);
    socket.on('inventory:updated', onInventory);
    socket.on('job:update', onJobUpdate);
    return () => {
      socket.off('machine:status', onStatus);
      socket.off('inventory:updated', onInventory);
      socket.off('job:update', onJobUpdate);
    };
  }, [id, refresh, refreshJobs]);

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
          runtime: r.runtime ?? null,
        })),
      );
      toast.success(t('machineDetail.scannedToast', { count: result.length }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.scanFailed'));
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
            {t('machineDetail.back')}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight text-wrap-balance">
          {machine?.name ?? t('machineDetail.fallbackTitle')}
        </h1>
        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            <span
              className={`mr-1.5 inline-block size-2 rounded-full align-middle ${
                machine?.online ? 'bg-ok' : 'bg-muted-foreground/40'
              }`}
            />
            {machine?.online ? t('machineDetail.online') : t('machineDetail.offline')}
          </span>
          {machine?.hostname ? (
            <span className="font-mono text-xs">
              {[machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          {machine?.daemonVersion ? (
            <span className="font-mono text-xs tabular-nums">
              {t('machineDetail.daemonVersion', { version: machine.daemonVersion })}
            </span>
          ) : null}
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => void scan()} disabled={scanning || machine?.online !== true}>
          <RefreshCwIcon className={scanning ? 'size-4 animate-spin' : 'size-4'} />
          {scanning ? t('machineDetail.scanning') : t('machineDetail.scanNow')}
        </Button>
        <span className="text-muted-foreground text-sm">
          {machine?.online !== true
            ? t('machineDetail.scanHintOffline')
            : t('machineDetail.scanHint')}
        </span>
        {machine !== null ? (
          <span className="ml-auto flex flex-wrap items-center gap-3">
            <BaseWorkspaceField machine={machine} onChanged={() => void refresh()} />
            <RemoteChatToggle machine={machine} onChanged={() => void refresh()} />
          </span>
        ) : null}
      </div>

      {inventory === null ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('machineDetail.loadingInventory')}
        </p>
      ) : inventory.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {t('machineDetail.emptyInventory')}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {inventory.map((entry) => (
            <TargetInventoryCard key={entry.target} entry={entry} machineId={id!} />
          ))}
          {targets.length > 0 ? <DiffAndImport machineId={id!} targets={targets} /> : null}
          <DeploymentsCard
            machineId={id!}
            online={machine?.online === true}
            jobs={jobs}
            agents={agents}
            onChanged={refreshJobs}
          />
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
  const { t } = useI18n();
  return (
    <Badge variant={origin === 'platform' ? 'secondary' : 'default'} className="text-[10px]">
      {origin === 'platform' ? 'hnx' : t('machineDetail.originLocal')}
    </Badge>
  );
}

/** The Agent's runtime status line: version (mono) + method badge, or muted absence. */
function RuntimeStatus({ runtime }: { runtime: RuntimeInfoView | null }) {
  const { t } = useI18n();
  if (runtime === null) {
    return (
      <span className="text-muted-foreground text-xs">{t('machineDetail.runtimeNotProbed')}</span>
    );
  }
  if (!runtime.installed) {
    return (
      <span className="text-muted-foreground text-sm">
        {t('machineDetail.runtimeNotInstalled')}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {runtime.version ? (
        <span className="font-mono text-xs tabular-nums">{runtime.version}</span>
      ) : null}
      {runtime.installMethod ? (
        <Badge variant="outline" className="font-mono text-[10px]">
          {runtime.installMethod}
        </Badge>
      ) : null}
      {runtime.binPath ? (
        <span className="text-muted-foreground font-mono text-xs">{runtime.binPath}</span>
      ) : null}
    </span>
  );
}

/**
 * Install / Upgrade / pin control for a runtime-managed Agent (Phase 9 W2) —
 * confirm-first; an optional version turns the action into a pin/install-at.
 * Renders nothing when the daemon doesn't probe runtimes (hermes, old hnx).
 */
function RuntimeManage({
  machineId,
  target,
  runtime,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  if (runtime === null) return null;
  const installed = runtime.installed;
  const trimmed = version.trim();

  async function manage(): Promise<void> {
    const action = trimmed !== '' ? 'pin' : installed ? 'upgrade' : 'install';
    const confirmKey =
      action === 'pin'
        ? 'machineDetail.manageConfirmPin'
        : action === 'upgrade'
          ? 'machineDetail.manageConfirmUpgrade'
          : 'machineDetail.manageConfirmInstall';
    if (
      !window.confirm(t(confirmKey, { target, ...(action === 'pin' ? { version: trimmed } : {}) }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createHarnessJob(machineId, {
            action,
            target: target as Parameters<typeof api.createHarnessJob>[1]['target'],
            ...(action === 'pin' ? { version: trimmed } : {}),
          }),
        logout,
      );
      toast.success(t('machineDetail.manageToast'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.manageFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Input
        aria-label={t('machineDetail.versionPlaceholder')}
        value={version}
        onChange={(e) => setVersion(e.target.value)}
        placeholder={t('machineDetail.versionPlaceholder')}
        className="h-8 w-36 font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <Button size="sm" onClick={() => void manage()} disabled={busy}>
        {busy
          ? t('machineDetail.managing')
          : installed
            ? t('machineDetail.upgradeButton')
            : t('machineDetail.installButton')}
      </Button>
    </span>
  );
}

/**
 * Redacted effective-config viewer (Phase 9 W4) — a live round-trip to the
 * daemon; the drawer shows display-pathed files whose secret-ish values were
 * masked daemon-side before upload. `--signal` is not spent (data, not
 * liveness); masked values render as the literal `${redacted}`.
 */
function ViewConfigButton({
  machineId,
  target,
  runtime,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{
    files: { path: string; content: string }[];
    redacted: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (runtime === null) return null;

  async function load(): Promise<void> {
    setView(null);
    setError(null);
    try {
      const res = await withAuthGuard(
        () => api.getRuntimeConfigView(machineId, target as RuntimeTarget),
        logout,
      );
      setView({ files: res.files, redacted: res.redacted });
    } catch (e) {
      setError(e instanceof HarnessNexusError ? e.message : t('machineDetail.viewFailed'));
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <FileCogIcon className="size-4" />
        {t('machineDetail.viewConfigButton')}
      </Button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="font-mono">
              {t('machineDetail.viewConfigTitle', { target })}
            </DrawerTitle>
            <DrawerDescription>{t('machineDetail.viewConfigDesc')}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="flex flex-col gap-4">
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : view === null ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                {t('machineDetail.viewLoading')}
              </p>
            ) : (
              <>
                {view.redacted.length > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t('machineDetail.viewRedacted', { count: view.redacted.length })}
                  </p>
                ) : null}
                {view.files.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    {t('machineDetail.viewNoFiles')}
                  </p>
                ) : (
                  view.files.map((f) => (
                    <div key={f.path} className="flex flex-col gap-1.5">
                      <p className="text-muted-foreground font-mono text-xs">{f.path}</p>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                        {f.content}
                      </pre>
                    </div>
                  ))
                )}
              </>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/**
 * Provider config sub-form (Phase 9 W3) — the Agent's LLM route, applied into
 * the harness's NATIVE config by an `apply-config` job (confirm-first: the
 * write ships the credential's plaintext to the machine). Renders nothing for
 * targets the daemon doesn't runtime-manage (hermes, old hnx).
 */
function ProviderConfigForm({
  machineId,
  target,
  runtime,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [providerLabel, setProviderLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiFlavor, setApiFlavor] = useState<string>('');
  const [credentialName, setCredentialName] = useState('');
  const [busy, setBusy] = useState(false);

  const managedTarget = runtime !== null ? (target as RuntimeTarget) : null;
  const apiOptions = managedTarget !== null ? RUNTIME_API_SUPPORT[managedTarget] : [];

  // Prefill from the stored spec; the api flavor also defaults to the first
  // (and for two targets the only) supported option.
  useEffect(() => {
    if (managedTarget === null) return;
    let cancelled = false;
    void (async () => {
      let existing: RuntimeConfigSpec | null = null;
      try {
        const res = await withAuthGuard(
          () => api.getRuntimeConfig(machineId, managedTarget),
          logout,
        );
        existing = res;
      } catch {
        existing = null; // 404 (nothing stored yet) or transient — empty form
      }
      let distributable: CredentialView[] = [];
      try {
        distributable = (await withAuthGuard(() => api.listCredentials(), logout)).filter(
          (c) => c.distributable,
        );
      } catch {
        distributable = [];
      }
      if (cancelled) return;
      setCreds(distributable);
      setProviderLabel(existing?.providerLabel ?? '');
      setBaseUrl(existing?.baseUrl ?? '');
      setModel(existing?.model ?? '');
      setApiFlavor(existing?.api ?? apiOptions[0] ?? '');
      setCredentialName(existing?.credentialName ?? '');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, managedTarget]);

  if (managedTarget === null) return null;

  async function apply(): Promise<void> {
    if (!window.confirm(t('machineDetail.applyConfirm', { target }))) return;
    setBusy(true);
    try {
      const spec: RuntimeConfigSpec = {
        providerLabel: providerLabel.trim(),
        api: (apiFlavor || apiOptions[0]) as RuntimeConfigSpec['api'],
        model: model.trim(),
        credentialName,
        ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
      };
      await withAuthGuard(() => api.putRuntimeConfig(machineId, managedTarget!, spec), logout);
      toast.success(t('machineDetail.applyToast'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.applyFailed'));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    providerLabel.trim() !== '' && model.trim() !== '' && credentialName !== '' && !busy;

  return (
    <div className="flex flex-col gap-3 border-t px-6 pt-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.providerTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.providerDesc')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-44 gap-2">
          <Label htmlFor={`pc-label-${target}`}>{t('machineDetail.providerLabelLabel')}</Label>
          <Input
            id={`pc-label-${target}`}
            value={providerLabel}
            onChange={(e) => setProviderLabel(e.target.value)}
            placeholder={t('machineDetail.providerLabelPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid min-w-52 gap-2">
          <Label htmlFor={`pc-url-${target}`}>{t('machineDetail.baseUrlLabel')}</Label>
          <Input
            id={`pc-url-${target}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('machineDetail.baseUrlPlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        </div>
        <div className="grid min-w-24 gap-2">
          <Label htmlFor={`pc-model-${target}`}>{t('machineDetail.modelLabel')}</Label>
          <Input
            id={`pc-model-${target}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid min-w-36 gap-2">
          <Label htmlFor={`pc-api-${target}`}>{t('machineDetail.apiLabel')}</Label>
          {apiOptions.length > 1 ? (
            <Select value={apiFlavor} onValueChange={setApiFlavor}>
              <SelectTrigger id={`pc-api-${target}`} className="font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {apiOptions.map((a) => (
                  <SelectItem key={a} value={a} className="font-mono text-xs">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px]">
              {apiOptions[0]}
            </Badge>
          )}
        </div>
        <div className="grid min-w-44 gap-2">
          <Label htmlFor={`pc-cred-${target}`}>{t('machineDetail.credentialLabel')}</Label>
          <Select value={credentialName} onValueChange={setCredentialName}>
            <SelectTrigger id={`pc-cred-${target}`} className="font-mono text-xs">
              <SelectValue placeholder={t('machineDetail.pickCredential')} />
            </SelectTrigger>
            <SelectContent>
              {(creds ?? []).map((c) => (
                <SelectItem key={c.id} value={c.name} className="font-mono text-xs">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => void apply()} disabled={!ready}>
          {busy ? t('machineDetail.applying') : t('machineDetail.applyButton')}
        </Button>
      </div>
      {creds !== null && creds.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('machineDetail.noCredentials')}</p>
      ) : null}
    </div>
  );
}

/** Capture-as-profile footer (Phase 9 W1) — confirm-first, one input + button. */
function CaptureForm({ machineId, target }: { machineId: string; target: string }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function capture(): Promise<void> {
    if (!window.confirm(t('machineDetail.captureConfirm'))) return;
    setBusy(true);
    try {
      const res = await withAuthGuard(
        () =>
          api.captureMachineInventory(machineId, {
            target: target as Parameters<typeof api.captureMachineInventory>[1]['target'],
            profileName: name.trim(),
          }),
        logout,
      );
      toast.success(t('machineDetail.capturedToast', { name: res.profile.name, target }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.captureFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3 border-t px-6 pt-4">
      <div className="grid min-w-56 gap-2">
        <Label htmlFor={`capture-${target}`}>{t('machineDetail.captureNameLabel')}</Label>
        <Input
          id={`capture-${target}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('machineDetail.captureNamePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      <Button
        variant="outline"
        onClick={() => void capture()}
        disabled={busy || name.trim() === ''}
      >
        <CameraIcon className="size-4" />
        {busy ? t('machineDetail.capturing') : t('machineDetail.captureButton')}
      </Button>
    </div>
  );
}

function TargetInventoryCard({ entry, machineId }: { entry: InventoryEntry; machineId: string }) {
  const { t, lang } = useI18n();
  const agent = entry.agents[0];
  const items = entry.agents.flatMap((a) => a.items);
  const notInstalled = entry.runtime !== null && !entry.runtime.installed;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <LaptopIcon className="size-4" />
          <span className="font-mono">{entry.target}</span>
          {agent?.profileApplied ? (
            <Badge variant="secondary" className="text-[10px]">
              {t('machineDetail.profileApplied')}
            </Badge>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-3">
            <RuntimeStatus runtime={entry.runtime} />
            <ViewConfigButton machineId={machineId} target={entry.target} runtime={entry.runtime} />
            <RuntimeManage machineId={machineId} target={entry.target} runtime={entry.runtime} />
          </span>
        </CardTitle>
        <CardDescription>
          {notInstalled ? t('machineDetail.runtimeNotInstalled') + ' · ' : ''}
          {t('machineDetail.itemsReported', {
            count: items.length,
            time: new Date(entry.reportedAt).toLocaleString(dateLocale(lang)),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 px-0">
        {/* A not-installed Agent leads with its absence; leftover items (if
            any) still render honestly below — files can outlive binaries. */}
        {notInstalled && items.length === 0 ? (
          <p className="text-muted-foreground px-6 py-6 text-center text-sm">
            {t('machineDetail.runtimeNotInstalled')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('machineDetail.kind')}</TableHead>
                <TableHead>{t('common.name')}</TableHead>
                <TableHead>{t('machineDetail.origin')}</TableHead>
                <TableHead>{t('machineDetail.summary')}</TableHead>
                <TableHead className="pr-6">{t('machineDetail.path')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                    {t('machineDetail.emptyTarget')}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
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
                        : t('machineDetail.notImportable', {
                            note: item.note ?? t('machineDetail.unknown'),
                          })}
                    </TableCell>
                    <TableCell className="text-muted-foreground pr-6 font-mono text-xs">
                      {item.path}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
        <ProviderConfigForm machineId={machineId} target={entry.target} runtime={entry.runtime} />
        <CaptureForm machineId={machineId} target={entry.target} />
      </CardContent>
    </Card>
  );
}

function DiffAndImport({ machineId, targets }: { machineId: string; targets: string[] }) {
  const { logout } = useAuth();
  const { t } = useI18n();
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
      setDiffError(e instanceof HarnessNexusError ? e.message : t('machineDetail.diffFailed'));
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
      toast.error(t('machineDetail.selectFirst'));
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
        t('machineDetail.createdToast', {
          name: res.profile.name,
          created: res.created.length,
          reused: res.reused.length,
        }),
      );
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.importFailed'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompareArrowsIcon className="size-4" />
          {t('machineDetail.diffTitle')}
        </CardTitle>
        <CardDescription>{t('machineDetail.diffDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 gap-2">
            <Label htmlFor="diff-profile">{t('machineDetail.profileLabel')}</Label>
            <Select
              value={profileId}
              onValueChange={(v) => {
                setProfileId(v);
                void runDiff(v);
              }}
            >
              <SelectTrigger id="diff-profile" className="font-mono text-xs">
                <SelectValue placeholder={t('machineDetail.pickProfile')} />
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
            {eligible.length === 0 ? t('machineDetail.noProfileMatch') : null}
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
              <SummaryStat label={t('machineDetail.statApplied')} value={diff.summary.applied} />
              <SummaryStat label={t('machineDetail.statMissing')} value={diff.summary.missing} />
              <SummaryStat
                label={t('machineDetail.statCandidates')}
                value={diff.summary.candidates}
              />
            </div>

            {diff.missingOnMachine.length > 0 ? (
              <div>
                <p className="mb-1 text-sm font-medium">{t('machineDetail.driftHeading')}</p>
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
                {t('machineDetail.candidatesHeading', { count: diff.notInProfile.length })}
              </p>
              {diff.notInProfile.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('machineDetail.nothingToImport')}
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
                          aria-label={t('machineDetail.importItemAria', { name: item.name })}
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
                              {item.note
                                ? t('machineDetail.notImportableShortNote', { note: item.note })
                                : t('machineDetail.notImportableShort')}
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
                  <Label htmlFor="import-profile-name">{t('machineDetail.newNameLabel')}</Label>
                  <Input
                    id="import-profile-name"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder={t('machineDetail.newNamePlaceholder')}
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
                  {importing
                    ? t('machineDetail.importing')
                    : t('machineDetail.importButton', { count: selected.size })}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {result ? (
          <Alert>
            <BoxesIcon className="size-4" />
            <AlertTitle>
              {t('machineDetail.importedInto')}{' '}
              <Link to="/profiles" className="underline">
                {result.profile.name}
              </Link>{' '}
              {result.failed.length > 0
                ? t('machineDetail.importStatsFailed', {
                    created: result.created.length,
                    reused: result.reused.length,
                    failed: result.failed.length,
                  })
                : t('machineDetail.importStats', {
                    created: result.created.length,
                    reused: result.reused.length,
                  })}
            </AlertTitle>
            <AlertDescription>
              {result.failed.length > 0 ? (
                <span className="block">
                  {t('machineDetail.failedList', {
                    list: result.failed.map((f) => `${f.name} (${f.error})`).join('; '),
                  })}
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

function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`size-2 rounded-full ${JOB_STATUS_CLASS[status] ?? 'bg-muted-foreground/40'}`}
      />
      <span className="font-mono text-xs tabular-nums">{status}</span>
    </span>
  );
}

/**
 * Deploy jobs + deployed agent instances (Phase 8 C4). A deploy queues when
 * the daemon is offline and replays on reconnect — the hint says so instead
 * of hiding the queue.
 */
function DeploymentsCard({
  machineId,
  online,
  jobs,
  agents,
  onChanged,
}: {
  machineId: string;
  online: boolean;
  jobs: JobView[] | null;
  agents: AgentInstanceView[];
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const all = await withAuthGuard(() => api.listProfiles(), logout);
        // Only targets with a local-write install adapter can be deployed.
        setProfiles(
          all.filter(
            (p) => p.target === 'hermes' || p.target === 'codex' || p.target === 'deepseek',
          ),
        );
      } catch {
        setProfiles([]);
      }
    })();
  }, [logout]);

  async function deploy(): Promise<void> {
    if (!profileId) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.createMachineJob(machineId, { profileId }), logout);
      toast.success(online ? t('machineDetail.dispatchToast') : t('machineDetail.queuedToast'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.deployFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: JobView): Promise<void> {
    try {
      await withAuthGuard(() => api.cancelJob(job.id), logout);
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.cancelFailed'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RocketIcon className="size-4" />
          {t('machineDetail.deployTitle')}
        </CardTitle>
        <CardDescription>{t('machineDetail.deployDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 gap-2">
            <Label htmlFor="deploy-profile">{t('machineDetail.profileLabel')}</Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger id="deploy-profile" className="font-mono text-xs">
                <SelectValue placeholder={t('machineDetail.pickProfile')} />
              </SelectTrigger>
              <SelectContent>
                {(profiles ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                    {p.name} ({p.target})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => void deploy()} disabled={busy || profileId === ''}>
            <RocketIcon className="size-4" />
            {busy
              ? t('machineDetail.creating')
              : online
                ? t('machineDetail.deploy')
                : t('machineDetail.queueDeploy')}
          </Button>
          <p className="text-muted-foreground pb-2 text-sm">
            {profiles !== null && profiles.length === 0 ? t('machineDetail.noDeployable') : null}
          </p>
        </div>

        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t('machineDetail.job')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('machineDetail.detail')}</TableHead>
                <TableHead className="pr-4 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs === null ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-6 text-center">
                    {t('machineDetail.loadingJobs')}
                  </TableCell>
                </TableRow>
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-6 text-center">
                    {t('machineDetail.noJobs')}
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {job.type}
                        </Badge>
                        <span className="text-muted-foreground font-mono text-xs">
                          {new Date(job.createdAt).toLocaleString(dateLocale(lang))}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="max-w-[24rem] truncate text-muted-foreground text-xs">
                      {job.error ??
                        (job.status === 'queued' ? t('machineDetail.waitingDaemon') : '—')}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {job.status === 'queued' ? (
                        <Button variant="ghost" size="sm" onClick={() => void cancel(job)}>
                          <SquareIcon className="size-4" />
                          {t('common.cancel')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">
            {t('machineDetail.agentsHeading', { count: agents.length })}
          </p>
          {agents.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('machineDetail.noAgents')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {agents.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{a.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {a.target}
                  </Badge>
                  {a.source === 'detected' ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {t('machineDetail.detectedSource')}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground font-mono text-xs">{a.directory}</span>
                  {a.profileVersion ? (
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      v{a.profileVersion}
                    </span>
                  ) : null}
                  <Button asChild variant="ghost" size="sm" className="ml-auto">
                    <Link to={`/chat/agents/${a.id}`}>
                      <MessageSquareIcon className="size-4" />
                      {t('machineDetail.chat')}
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Remote chat toggle — a remote-code-execution switch; confirm-first. */
function RemoteChatToggle({ machine, onChanged }: { machine: MachineView; onChanged: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  async function toggle(next: boolean): Promise<void> {
    if (next && !window.confirm(t('machineDetail.chatConfirm'))) {
      return;
    }
    try {
      await withAuthGuard(() => api.updateMachine(machine.id, { remoteChatEnabled: next }), logout);
      toast.success(next ? t('machineDetail.chatEnabled') : t('machineDetail.chatDisabled'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-sm">
      <Switch checked={machine.remoteChatEnabled} onCheckedChange={(v) => void toggle(v)} />
      {t('machineDetail.chatLabel')}
    </label>
  );
}

/**
 * Base workspace field (Phase 9 W6) — the root under which chat sessions pick
 * their project directory. Inline edit + save; empty clears it (sessions fall
 * back to the picker's set-first flow).
 */
function BaseWorkspaceField({
  machine,
  onChanged,
}: {
  machine: MachineView;
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [value, setValue] = useState(machine.baseWorkspace ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(machine.baseWorkspace ?? '');
  }, [machine.baseWorkspace]);

  async function save(): Promise<void> {
    const next = value.trim();
    if (busy) return;
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.updateMachine(machine.id, {
            baseWorkspace: next === '' ? null : next,
          }),
        logout,
      );
      toast.success(t('machineDetail.baseWorkspaceSaved'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  const dirty = value.trim() !== (machine.baseWorkspace ?? '');
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-sm">
      <span className="hidden lg:inline">{t('machineDetail.baseWorkspace')}</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="/home/user/projects"
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-56 font-mono text-xs"
        aria-label={t('machineDetail.baseWorkspace')}
      />
      <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
        {busy ? t('common.saving') : t('common.save')}
      </Button>
    </label>
  );
}
