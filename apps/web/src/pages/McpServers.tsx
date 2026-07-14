import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ServerIcon,
  PlusIcon,
  TrashIcon,
  GlobeIcon,
  UserIcon,
  MoreHorizontalIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { AgentNexusError, type McpServer, type CredentialView } from '@agent-nexus/sdk';

type Scope = 'global' | 'personal';
type TransportType = 'sse' | 'streamable-http';

export function McpServersPage() {
  const { logout, user } = useAuth();
  const [items, setItems] = useState<McpServer[] | null>(null);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listMcpServers(), logout));
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Failed to load MCP servers');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(s: McpServer) {
    if (!confirm(`Delete MCP server "${s.name}"?`)) return;
    try {
      await withAuthGuard(() => api.deleteMcpServer(s.id), logout);
      toast.success('MCP server deleted');
      await refresh();
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">MCP servers</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upstream MCP servers this instance can connect to (as a client). Configured here, then
          organized into profiles for Agent tools to consume. Live aggregation lands in a later
          phase.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerIcon className="size-4" />
            Connections
          </CardTitle>
          <CardDescription>SSE and Streamable HTTP transports are supported.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead>URL</TableHead>
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
                    No MCP servers configured yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-6 font-medium">{s.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {s.transport.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground truncate font-mono text-xs max-w-[20rem]">
                      {s.transport.type === 'stdio' ? s.transport.command : s.transport.url}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={s.scope === 'global' ? 'default' : 'secondary'}
                        className="gap-1"
                      >
                        {s.scope === 'global' ? (
                          <GlobeIcon className="size-3" />
                        ) : (
                          <UserIcon className="size-3" />
                        )}
                        {s.scope}
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
                            disabled={s.scope === 'global' && !isAdmin}
                            onClick={() => remove(s)}
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

      <CreateMcpServer onCreated={refresh} />
    </AppShell>
  );
}

function CreateMcpServer({ onCreated }: { onCreated: () => void }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [type, setType] = useState<TransportType>('streamable-http');
  const [url, setUrl] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  const [credentialId, setCredentialId] = useState<string>('none');
  const [busy, setBusy] = useState(false);

  const [creds, setCreds] = useState<CredentialView[]>([]);
  useEffect(() => {
    api
      .listCredentials()
      .then(setCreds)
      .catch(() => setCreds([]));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const transport =
        credentialId === 'none'
          ? { type, url }
          : { type, url, credentialBindings: { Authorization: credentialId } };
      await withAuthGuard(
        () => api.createMcpServer({ name, transport, scope }),
        logout,
      );
      toast.success('MCP server added');
      setName('');
      setUrl('');
      setCredentialId('none');
      onCreated();
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusIcon className="size-4" />
          Add connection
        </CardTitle>
        <CardDescription>
          Optionally bind a credential to the <code className="font-mono">Authorization</code> header.
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
                placeholder="e.g. Acme docs"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-type">Transport</Label>
              <Select value={type} onValueChange={(v) => setType(v as TransportType)}>
                <SelectTrigger id="mcp-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">streamable-http</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                  <SelectItem value="stdio" disabled>
                    stdio (not yet supported)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
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
              <Label htmlFor="mcp-scope">Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as Scope)}
                disabled={!isAdmin}
              >
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
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="mcp-cred">Bind credential to Authorization header</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger id="mcp-cred">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {creds.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="text-muted-foreground">({c.scope})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add connection'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
