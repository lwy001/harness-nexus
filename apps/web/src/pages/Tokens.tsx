import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  KeyRoundIcon,
  PlusIcon,
  TrashIcon,
  CopyIcon,
  CheckIcon,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { HarnessNexusError, type PatView } from '@harness-nexus/sdk';

export function TokensPage() {
  const { logout } = useAuth();
  const [items, setItems] = useState<PatView[] | null>(null);

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listPats(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load tokens');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(p: PatView) {
    if (!confirm(`Revoke token "${p.name}"? Anything using it stops working immediately.`)) return;
    try {
      await withAuthGuard(() => api.revokePat(p.id), logout);
      toast.success('Token revoked');
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Revoke failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Access tokens</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Personal access tokens (<code className="font-mono">hnpat_…</code>) authenticate the CLI
          or automation against this server as you. A <strong>marketplace</strong> token authorizes
          only your Claude Code plugin-marketplace URL. The full token is shown{' '}
          <strong>only once</strong> at creation — copy it then.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            Your tokens
          </CardTitle>
          <CardDescription>
            Tokens are personal; another user can never see or revoke yours.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    No tokens yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6 font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{p.prefix}…</TableCell>
                    <TableCell>
                      {p.scopes.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {p.scopes.map((s) => (
                            <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {p.expiresAt ? (
                        new Date(p.expiresAt).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {p.lastUsedAt ? (
                        new Date(p.lastUsedAt).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {new Date(p.createdAt).toLocaleDateString(undefined, {
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
                          <DropdownMenuItem variant="destructive" onClick={() => revoke(p)}>
                            <TrashIcon /> Revoke
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

      <CreateToken onCreated={refresh} />
    </AppShell>
  );
}

/** Renders the create form and the one-shot token reveal dialog. */
function CreateToken({ onCreated }: { onCreated: () => void }) {
  const { logout } = useAuth();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'api' | 'marketplace'>('api');
  const [expiresLocal, setExpiresLocal] = useState(''); // datetime-local string, "" = never
  const [busy, setBusy] = useState(false);
  // The raw token lives only here, never in the list. Cleared on dialog close.
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  // For marketplace tokens: the one-shot `claude plugin marketplace add` command.
  const [createdAddCommand, setCreatedAddCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState<'token' | 'command' | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const expiresAt = expiresLocal === '' ? undefined : new Date(expiresLocal).toISOString();
      const { token, addCommand } = await withAuthGuard(
        () => api.createPat({ name, ...(kind !== 'api' ? { kind } : {}), expiresAt }),
        logout,
      );
      toast.success('Token created');
      setCreatedToken(token);
      setCreatedAddCommand(addCommand ?? null);
      setCopied(null);
      setName('');
      setExpiresLocal('');
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  function copy(kind: 'token' | 'command', text: string | null) {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      toast.success(kind === 'token' ? 'Token copied' : 'Command copied');
    });
  }

  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlusIcon className="size-4" />
            New token
          </CardTitle>
          <CardDescription>
            Leave expiry blank for a token that never expires. The full value is returned only once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-2">
                <Label htmlFor="pat-name">Name</Label>
                <Input
                  id="pat-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. ci-pipeline"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pat-kind">Purpose</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as 'api' | 'marketplace')}>
                  <SelectTrigger id="pat-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api">API / CLI</SelectItem>
                    <SelectItem value="marketplace">Claude Code marketplace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pat-expires">Expires (optional)</Label>
                <Input
                  id="pat-expires"
                  type="datetime-local"
                  value={expiresLocal}
                  onChange={(e) => setExpiresLocal(e.target.value)}
                />
              </div>
            </div>
            {kind === 'marketplace' && (
              <p className="text-muted-foreground text-sm">
                A marketplace token only authorizes your plugin-marketplace URL (it cannot call the
                API). Claude Code installs your <code className="font-mono">claude-code</code>{' '}
                profiles from it — the add command is shown once after creation.
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create token'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={createdToken !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreatedToken(null);
            setCreatedAddCommand(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Token created — copy it now</DialogTitle>
            <DialogDescription>
              This is the only time the full token is shown. Store it somewhere safe; it can't be
              recovered later.
            </DialogDescription>
          </DialogHeader>

          <Alert variant="destructive">
            <AlertDescription>
              Closing this dialog hides the token permanently. You can still revoke it from the list
              above.
            </AlertDescription>
          </Alert>

          {createdAddCommand && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Install your marketplace in Claude Code:</p>
              <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
                <code className="text-foreground min-w-0 flex-1 break-all font-mono text-xs">
                  {createdAddCommand}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => copy('command', createdAddCommand)}
                >
                  {copied === 'command' ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {copied === 'command' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          )}

          <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
            <code className="text-foreground min-w-0 flex-1 break-all font-mono text-sm">
              {createdToken}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() => copy('token', createdToken)}
            >
              {copied === 'token' ? (
                <CheckIcon className="size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
              {copied === 'token' ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                setCreatedToken(null);
                setCreatedAddCommand(null);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
