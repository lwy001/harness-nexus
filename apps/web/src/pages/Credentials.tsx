import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon, PlusIcon, TrashIcon, GlobeIcon, UserIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontalIcon } from 'lucide-react';
import { HarnessNexusError, type CredentialView } from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

export function CredentialsPage() {
  const { logout, user } = useAuth();
  const [items, setItems] = useState<CredentialView[] | null>(null);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listCredentials(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load credentials');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(c: CredentialView) {
    if (!confirm(`Delete credential "${c.name}"? This cannot be undone.`)) return;
    try {
      await withAuthGuard(() => api.deleteCredential(c.id), logout);
      toast.success('Credential deleted');
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Credentials</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Named secrets referenced by MCP transports via{' '}
          <code className="font-mono">{'${cred:NAME}'}</code> placeholders. Secrets are encrypted at
          rest and never returned after creation.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            Stored credentials
          </CardTitle>
          <CardDescription>
            Personal credentials are yours; global ones are shared by an admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Placeholder</TableHead>
                <TableHead>Preview</TableHead>
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
                    No credentials yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="pl-6 font-medium">{c.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {'${cred:'}
                      {c.name}
                      {'}'}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">
                      {c.secretPreview}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.scope === 'global' ? 'default' : 'secondary'}
                        className="gap-1"
                      >
                        {c.scope === 'global' ? (
                          <GlobeIcon className="size-3" />
                        ) : (
                          <UserIcon className="size-3" />
                        )}
                        {c.scope}
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
                            disabled={c.scope === 'global' && !isAdmin}
                            onClick={() => remove(c)}
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

      <CreateCredential onCreated={refresh} />
    </AppShell>
  );
}

function CreateCredential({ onCreated }: { onCreated: () => void }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  // Phase 8 C2 — only meaningful for global scope (personal is always
  // distributable); off by default: non-distributable globals are served only
  // through the platform /mcp outlet.
  const [distributable, setDistributable] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createCredential({
            name,
            secret,
            scope,
            ...(scope === 'global' ? { distributable } : {}),
          }),
        logout,
      );
      toast.success('Credential created');
      setName('');
      setSecret('');
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
          Add credential
        </CardTitle>
        <CardDescription>
          The secret is encrypted immediately and shown only as a preview afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="cred-name">Name</Label>
              <Input
                id="cred-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. context7-key"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cred-secret">Secret</Label>
              <Input
                id="cred-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Paste the token / key"
                required
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cred-scope">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="cred-scope">
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
          {scope === 'global' && isAdmin ? (
            <div className="flex items-center gap-3">
              <Switch
                id="cred-distributable"
                checked={distributable}
                onCheckedChange={setDistributable}
                aria-label="Allow the plaintext to reach client shims"
              />
              <Label htmlFor="cred-distributable" className="font-normal">
                Distributable — allow the plaintext to reach{' '}
                <code className="font-mono">hnx mcp serve</code> shims on users&apos; machines. Off
                (default): the secret never leaves the server; upstreams using it are served via the{' '}
                <code className="font-mono">/mcp</code> outlet only.
              </Label>
            </div>
          ) : null}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create credential'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
