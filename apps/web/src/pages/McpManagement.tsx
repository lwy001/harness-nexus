import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  ServerIcon,
  PlusIcon,
  TrashIcon,
  GlobeIcon,
  UserIcon,
  MoreHorizontalIcon,
  FileJsonIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  PlugIcon,
  PlugZapIcon,
  LoaderIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
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
  HarnessNexusError,
  type McpServer,
  type McpMode,
  type McpServerStatus,
  type McpToolInfo,
  type CredentialView,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';
type TransportType = 'sse' | 'streamable-http' | 'stdio';

/** Status poll interval for the live connection state (Phase 2.4). */
const STATUS_POLL_MS = 5000;

/**
 * Status → color token map. Color encodes connection STATE ONLY (Signal design
 * system rule): `--ok` green = live, `--danger` red = failed (the management
 * page is an operator diagnostics surface, so error gets the stronger danger
 * token rather than warn — distinguishes a hard failure from the transient
 * `connecting` amber), `--warn` amber = connecting, muted = idle. `--signal`
 * (cyan) is deliberately NOT used here — it is reserved for liveness/links.
 * Hoisted to module scope (static config, per the React perf rule in AGENTS.md).
 */
const STATUS_DOT_CLASS: Record<McpServerStatus['status'], string> = {
  connected: 'bg-ok',
  error: 'bg-danger',
  connecting: 'bg-warn',
  disconnected: 'bg-muted-foreground/50',
};

/** Location/launch info shown for a row, per transport shape. */
function endpointOf(s: McpServer): string {
  if (s.transport.type === 'stdio') return s.transport.command;
  return s.transport.url;
}

export function McpManagementPage() {
  const { logout, user } = useAuth();
  const [items, setItems] = useState<McpServer[] | null>(null);
  const [statuses, setStatuses] = useState<Map<string, McpServerStatus>>(new Map());
  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    try {
      setItems(await withAuthGuard(() => api.listMcpServers(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load MCP servers');
    }
  }, [logout]);

  const refreshStatuses = useCallback(async () => {
    try {
      const res = await withAuthGuard(() => api.listMcpServerStatuses(), logout);
      setStatuses(new Map(res.map((s) => [s.id, s])));
    } catch {
      // Swallow poll errors — the next interval retries; a transient failure
      // shouldn't toast on the management page.
    }
  }, [logout]);

  // Load servers + statuses together on mount, then poll statuses on an interval.
  // The interval is cleared on unmount (no leak). Functional setState / no stale
  // captures: the poll callback only overwrites `statuses`.
  useEffect(() => {
    void (async () => {
      await Promise.all([refresh(), refreshStatuses()]);
    })();
    const timer = setInterval(() => {
      void refreshStatuses();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshStatuses]);

  async function remove(s: McpServer) {
    if (!confirm(`Delete MCP server "${s.name}"?`)) return;
    try {
      await withAuthGuard(() => api.deleteMcpServer(s.id), logout);
      toast.success('MCP server deleted');
      await refresh();
      await refreshStatuses();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">MCP management</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          MCP servers this instance knows about. <span className="font-medium">Proxy</span> servers
          are dialed by Harness Nexus and may be re-exposed to Agent tools;
          <span className="font-medium"> direct</span> servers are dialed by the tool itself
          (including stdio). Organize them into profiles for install.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerIcon className="size-4" />
            Servers
          </CardTitle>
          <CardDescription>
            Proxy: SSE / Streamable HTTP — connect to inspect tools. Direct: SSE / Streamable HTTP /
            stdio (dialed by the tool itself).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6 w-[34%]">Name</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    No MCP servers configured yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((s) => (
                  <ServerRow
                    key={s.id}
                    server={s}
                    status={statuses.get(s.id)}
                    isAdmin={isAdmin}
                    onRemoved={remove}
                    onStatusChange={refreshStatuses}
                    logout={logout}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateMcpServer onCreated={refresh} />
    </AppShell>
  );
}

/**
 * One server row. Proxy rows are wrapped in a Collapsible: the row itself is the
 * trigger (Name cell carries a chevron when connected), and the tool-inspection
 * panel expands below it. Direct rows render as a plain, non-expandable row with
 * a neutral status hint (Harness Nexus never dials them).
 *
 * Defined at module scope (React perf rule — never nest component definitions).
 */
function ServerRow({
  server,
  status,
  isAdmin,
  onRemoved,
  onStatusChange,
  logout,
}: {
  server: McpServer;
  status: McpServerStatus | undefined;
  isAdmin: boolean;
  onRemoved: (s: McpServer) => void;
  onStatusChange: () => Promise<void>;
  logout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);

  const isProxy = server.mode === 'proxy';
  const connState = status?.status;
  const isConnected = connState === 'connected';
  const isConnecting = connState === 'connecting' || pendingConnect;
  const toolCount = status?.toolCount ?? 0;

  async function connect() {
    setPendingConnect(true);
    try {
      await withAuthGuard(() => api.connectMcpServer(server.id), logout);
      await onStatusChange(); // pick up the new state immediately
      toast.success(`Connecting to "${server.name}"…`);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Connect failed');
    } finally {
      setPendingConnect(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect "${server.name}"? It will stay configured but go offline.`)) return;
    try {
      await withAuthGuard(() => api.disconnectMcpServer(server.id), logout);
      await onStatusChange();
      toast.success(`"${server.name}" disconnected`);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Disconnect failed');
    }
  }

  // Common cells shared by both proxy and direct rows (mode/transport/endpoint/scope).
  const modeCell = (
    <Badge
      variant={server.mode === 'proxy' ? 'default' : 'secondary'}
      className="font-mono text-[10px]"
    >
      {server.mode}
    </Badge>
  );
  const transportCell = (
    <Badge variant="secondary" className="font-mono text-[10px]">
      {server.transport.type}
    </Badge>
  );
  const scopeCell = (
    <Badge variant={server.scope === 'global' ? 'default' : 'secondary'} className="gap-1">
      {server.scope === 'global' ? (
        <GlobeIcon className="size-3" />
      ) : (
        <UserIcon className="size-3" />
      )}
      {server.scope}
    </Badge>
  );
  const actionsCell = (
    <TableCell className="pr-6 text-right">
      <div className="flex items-center justify-end gap-1">
        {isProxy && isConnected ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8"
            onClick={disconnect}
          >
            <PlugZapIcon className="size-4" />
            Disconnect
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isProxy && isConnected ? (
              <DropdownMenuItem onClick={disconnect}>
                <PlugZapIcon /> Disconnect
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={server.scope === 'global' && !isAdmin}
              onClick={() => onRemoved(server)}
            >
              <TrashIcon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TableCell>
  );

  // ---- direct row: plain, non-expandable, neutral status ----
  if (!isProxy) {
    return (
      <TableRow>
        <TableCell className="pl-6 font-medium">{server.name}</TableCell>
        <TableCell>{modeCell}</TableCell>
        <TableCell>
          <Badge variant="outline" className="font-mono text-[10px]">
            dialed by tool
          </Badge>
        </TableCell>
        <TableCell>{transportCell}</TableCell>
        <TableCell>{scopeCell}</TableCell>
        {actionsCell}
      </TableRow>
    );
  }

  // ---- proxy row: expandable when connected ----
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <>
        <TableRow data-state={open ? 'open' : 'closed'}>
          <TableCell className="pl-6 font-medium">
            <div className="flex items-center gap-2">
              {/* The trigger is the chevron + name; only meaningful when connected. */}
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-30"
                  disabled={!isConnected}
                  aria-label={open ? 'Collapse tools' : 'Expand tools'}
                >
                  <ChevronRightIcon
                    className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                </button>
              </CollapsibleTrigger>
              <span>{server.name}</span>
            </div>
          </TableCell>
          <TableCell>{modeCell}</TableCell>
          <TableCell>
            <StatusBadge status={connState} detail={status?.detail} toolCount={toolCount} />
          </TableCell>
          <TableCell>{transportCell}</TableCell>
          <TableCell>{scopeCell}</TableCell>
          <TableCell className="pr-6 text-right">
            <div className="flex items-center justify-end gap-1">
              {isConnected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8"
                  onClick={disconnect}
                >
                  <PlugZapIcon className="size-4" />
                  Disconnect
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={isConnecting}
                  onClick={connect}
                >
                  {isConnecting ? (
                    <LoaderIcon className="size-4 animate-spin" />
                  ) : (
                    <PlugIcon className="size-4" />
                  )}
                  {isConnecting ? 'Connecting…' : connState === 'error' ? 'Reconnect' : 'Connect'}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8">
                    <MoreHorizontalIcon className="size-4" />
                    <span className="sr-only">Open menu</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isConnected ? (
                    <DropdownMenuItem onClick={disconnect}>
                      <PlugZapIcon /> Disconnect
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={server.scope === 'global' && !isAdmin}
                    onClick={() => onRemoved(server)}
                  >
                    <TrashIcon /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={6} className="bg-muted/30 px-6 py-4">
              <ToolList serverId={server.id} serverName={server.name} logout={logout} />
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </>
    </Collapsible>
  );
}

/**
 * Live connection status badge — a colored dot (state-encoded, see
 * STATUS_DOT_CLASS) + a label, plus a tool-count badge when connected. Uses
 * neutral Badge variants; color comes from the dot only (Signal system).
 */
function StatusBadge({
  status,
  detail,
  toolCount,
}: {
  status: McpServerStatus['status'] | undefined;
  detail: string | undefined;
  toolCount: number;
}) {
  const resolved: McpServerStatus['status'] = status ?? 'disconnected';
  const dotClass = STATUS_DOT_CLASS[resolved];
  const label = resolved;
  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="gap-1.5 font-mono text-[10px]">
        <span className={`inline-block size-2 rounded-full ${dotClass}`} aria-hidden="true" />
        {label}
      </Badge>
      {resolved === 'connected' ? (
        <Badge variant="outline" className="nums font-mono text-[10px]">
          {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
        </Badge>
      ) : null}
      {resolved === 'error' && detail ? (
        <span className="text-muted-foreground truncate text-xs" title={detail}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The expandable tool-inspection panel for a connected proxy server. Lazily
 * fetches the tool list when first opened, then caches locally; the Refresh
 * button re-pulls from the upstream. Each tool can expand to show its
 * inputSchema parameters.
 */
function ToolList({
  serverId,
  serverName,
  logout,
}: {
  serverId: string;
  serverName: string;
  logout: () => void;
}) {
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      return await withAuthGuard(() => api.listMcpServerTools(serverId), logout);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load tools');
      return null;
    }
  }, [serverId, logout]);

  // Fetch once on mount (the panel only renders when the row is expanded).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t = await load();
      if (!cancelled) setTools(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const t = await withAuthGuard(() => api.refreshMcpServerTools(serverId), logout);
      setTools(t);
      toast.success(`Refreshed tools for "${serverName}"`);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          Tools{tools ? ` (${tools.length})` : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCwIcon className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      {tools === null ? (
        <p className="text-muted-foreground text-xs">Loading tools…</p>
      ) : tools.length === 0 ? (
        <p className="text-muted-foreground text-xs">No tools exposed by this server.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tools.map((t) => (
            <ToolRow key={t.name} tool={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One tool row with an expandable parameter detail. */
function ToolRow({ tool }: { tool: McpToolInfo }) {
  const [open, setOpen] = useState(false);
  const params = extractParams(tool.inputSchema);
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-left"
            >
              <ChevronRightIcon
                className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <code className="text-foreground text-xs font-medium">{tool.name}</code>
            </button>
          </CollapsibleTrigger>
          {tool.description ? (
            <span className="text-muted-foreground truncate text-xs" title={tool.description}>
              — {tool.description}
            </span>
          ) : null}
        </div>
        <CollapsibleContent>
          <div className="ml-5 mt-1">
            {params.length === 0 ? (
              <p className="text-muted-foreground text-xs">No parameters.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {params.map((p) => (
                  <li key={p.name} className="nums text-xs">
                    <code className="text-foreground">{p.name}</code>
                    <span className="text-muted-foreground"> : {p.type}</span>
                    {p.required ? (
                      <span className="text-warn ml-2 font-medium">required</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * Pull a flat { name, type, required } list out of a JSON-Schema inputSchema.
 * MCP tools follow JSON-Schema: `properties` maps name→{ type }, `required`
 * lists the mandatory names. Returns [] if the shape isn't recognized.
 */
function extractParams(
  schema: Record<string, unknown>,
): { name: string; type: string; required: boolean }[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return [];
  const requiredList = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const requiredSet = new Set(requiredList.map(String));
  return Object.entries(properties).map(([name, def]) => ({
    name,
    type:
      typeof def === 'object' && def !== null && 'type' in def
        ? String((def as { type: unknown }).type)
        : 'any',
    required: requiredSet.has(name),
  }));
}

const DEFAULT_HEADERS_JSON = '{"Authorization": "Bearer ${cred:token}"}';
const DEFAULT_ENV_JSON = '{}';

/** Parse a JSON object string into Record<string,string>; returns {} on empty/invalid. */
function parseStringRecord(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return undefined;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  } catch {
    return undefined;
  }
}

function CreateMcpServer({ onCreated }: { onCreated: () => void }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [mode, setMode] = useState<McpMode>('proxy');
  const [type, setType] = useState<TransportType>('streamable-http');
  const [url, setUrl] = useState('');
  // stdio fields
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState(''); // space-joined for the input; split on submit
  const [envJson, setEnvJson] = useState(DEFAULT_ENV_JSON);
  // http fields
  const [headersJson, setHeadersJson] = useState(DEFAULT_HEADERS_JSON);
  const [scope, setScope] = useState<Scope>('personal');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [creds, setCreds] = useState<CredentialView[]>([]);
  useEffect(() => {
    api
      .listCredentials()
      .then(setCreds)
      .catch(() => setCreds([]));
  }, []);

  const isStdio = type === 'stdio';

  // stdio can only run in direct mode. Picking stdio forces direct.
  function onTypeChange(next: TransportType) {
    setType(next);
    if (next === 'stdio' && mode !== 'direct') setMode('direct');
  }

  function onModeChange(next: McpMode) {
    // stdio cannot run in proxy mode; don't let the user get there.
    if (next === 'proxy' && isStdio) return;
    setMode(next);
  }

  function applyImport(entry: Record<string, unknown>, entryName: string) {
    setName(entryName);
    const hasCommand = typeof entry.command === 'string';
    if (hasCommand) {
      // stdio / direct
      setMode('direct');
      setType('stdio');
      setCommand(String(entry.command));
      setArgs(Array.isArray(entry.args) ? (entry.args as string[]).join(' ') : '');
      if (entry.env && typeof entry.env === 'object') {
        setEnvJson(JSON.stringify(entry.env, null, 2));
      }
    } else {
      // http — infer proxy by default
      const u = typeof entry.serverUrl === 'string' ? entry.serverUrl : entry.url;
      setMode('proxy');
      setType('streamable-http');
      if (u) setUrl(String(u));
      if (entry.headers && typeof entry.headers === 'object') {
        setHeadersJson(JSON.stringify(entry.headers, null, 2));
      }
    }
    setImportOpen(false);
    toast.success(`Imported "${entryName}" — review and click Add server`);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (isStdio) {
        const splitArgs = args.trim() ? args.trim().split(/\s+/) : undefined;
        const env = parseStringRecord(envJson);
        await withAuthGuard(
          () =>
            api.createMcpServer({
              name,
              mode: 'direct',
              scope,
              transport: {
                type: 'stdio',
                command,
                ...(splitArgs ? { args: splitArgs } : {}),
                ...(env ? { env } : {}),
              },
            }),
          logout,
        );
      } else {
        const headers = parseStringRecord(headersJson);
        await withAuthGuard(
          () =>
            api.createMcpServer({
              name,
              mode,
              scope,
              transport: { type, url, ...(headers ? { headers } : {}) },
            }),
          logout,
        );
      }
      toast.success('MCP server added');
      setName('');
      setUrl('');
      setCommand('');
      setArgs('');
      setEnvJson(DEFAULT_ENV_JSON);
      setHeadersJson(DEFAULT_HEADERS_JSON);
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
          Add server
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setImportOpen(true)}
          >
            <FileJsonIcon className="size-4" />
            Import JSON
          </Button>
        </CardTitle>
        <CardDescription>
          {mode === 'proxy'
            ? 'Proxy: Harness Nexus dials this server. SSE / Streamable HTTP only.'
            : 'Direct: the Agent tool dials this server itself. SSE / Streamable HTTP / stdio.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. context7"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-mode">Mode</Label>
              <Select value={mode} onValueChange={(v) => onModeChange(v as McpMode)}>
                <SelectTrigger id="mcp-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="proxy">proxy</SelectItem>
                  <SelectItem value="direct">direct</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-type">Transport</Label>
              <Select value={type} onValueChange={(v) => onTypeChange(v as TransportType)}>
                <SelectTrigger id="mcp-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">streamable-http</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                  {/* stdio is only valid in direct mode; gate it here too. */}
                  <SelectItem value="stdio" disabled={mode !== 'direct'}>
                    stdio{mode !== 'direct' ? ' (requires direct)' : ''}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-scope">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="mcp-scope">
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

          {isStdio ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="e.g. npx"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-args">Args (space-separated)</Label>
                  <Input
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="e.g. -y @upstash/context7-mcp --api-key $&#123;cred:context7-key&#125;"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-env">Env (JSON, optional)</Label>
                <Textarea
                  id="mcp-env"
                  value={envJson}
                  onChange={(e) => setEnvJson(e.target.value)}
                  className="font-mono text-xs"
                  rows={3}
                  spellCheck={false}
                  placeholder='{"API_KEY": "${cred:context7-key}"}'
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-headers">Custom headers (JSON)</Label>
                <Textarea
                  id="mcp-headers"
                  value={headersJson}
                  onChange={(e) => setHeadersJson(e.target.value)}
                  className="font-mono text-xs"
                  rows={3}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          <PlaceholderChips creds={creds} />

          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add server'}
            </Button>
          </div>
        </form>
      </CardContent>

      <ImportJsonDialog open={importOpen} onOpenChange={setImportOpen} onImport={applyImport} />
    </Card>
  );
}

/** Shows available credential placeholders as copyable monospace chips. */
function PlaceholderChips({ creds }: { creds: CredentialView[] }) {
  if (creds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">Available placeholders:</span>
      {creds.map((c) => (
        <button
          key={c.id}
          type="button"
          className="bg-muted font-mono text-muted-foreground hover:bg-accent rounded px-2 py-0.5 text-[11px] transition-colors"
          onClick={() => {
            void navigator.clipboard.writeText(`\${cred:${c.name}}`);
            toast.success(`Copied placeholder for ${c.name}`);
          }}
          title={`Copy \${cred:${c.name}}`}
        >
          {'${cred:'}
          {c.name}
          {'}'}
        </button>
      ))}
    </div>
  );
}

/** Modal that parses a single-entry `{ mcpServers: { name: {...} } }` blob. */
function ImportJsonDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (entry: Record<string, unknown>, name: string) => void;
}) {
  const [text, setText] = useState('');

  function onParse() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error('Invalid JSON');
      return;
    }
    const root = parsed as { mcpServers?: Record<string, unknown> } | null;
    if (!root || typeof root !== 'object' || !root.mcpServers) {
      toast.error('Expected { "mcpServers": { ... } }');
      return;
    }
    const entries = Object.entries(root.mcpServers);
    if (entries.length === 0) {
      toast.error('No server entries found in mcpServers');
      return;
    }
    if (entries.length > 1) {
      toast.error(
        `Multiple entries found (${entries.length}). Only one server at a time is supported.`,
      );
      return;
    }
    const first = entries[0];
    if (!first) {
      toast.error('No server entries found in mcpServers');
      return;
    }
    const [entryName, raw] = first;
    if (typeof raw !== 'object' || raw === null) {
      toast.error(`Entry "${entryName}" is not an object`);
      return;
    }
    onImport(raw as Record<string, unknown>, entryName);
    setText('');
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-black/50 fixed inset-0 z-40" />
        <DialogPrimitive.Content className="bg-background fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border p-6 shadow-lg">
          <DialogPrimitive.Title className="text-lg font-semibold">
            Import MCP server JSON
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-muted-foreground mt-1 text-sm">
            Paste a single-entry{' '}
            <code className="font-mono">{'{ "mcpServers": { "name": {...} } }'}</code> blob. Mode is
            inferred (<code className="font-mono">command</code> → direct,{' '}
            <code className="font-mono">serverUrl</code> → proxy).
          </DialogPrimitive.Description>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-4 font-mono text-xs"
            rows={10}
            spellCheck={false}
            placeholder={
              '{\n  "mcpServers": {\n    "context7": {\n      "serverUrl": "https://mcp.context7.com/mcp",\n      "headers": { "CONTEXT7_API_KEY": "${cred:context7-key}" }\n    }\n  }\n}'
            }
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button type="button" onClick={onParse}>
              Parse
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
