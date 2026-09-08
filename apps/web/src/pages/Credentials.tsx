import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon, PlusIcon, TrashIcon, GlobeIcon, UserIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
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
  const { t } = useI18n();
  const [items, setItems] = useState<CredentialView[] | null>(null);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listCredentials(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('credentials.loadFailed'));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(c: CredentialView) {
    if (!confirm(t('credentials.confirmDelete', { name: c.name }))) return;
    try {
      await withAuthGuard(() => api.deleteCredential(c.id), logout);
      toast.success(t('credentials.deletedToast'));
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('credentials.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('credentials.subtitle1')} <code className="font-mono">{'${cred:NAME}'}</code>{' '}
          {t('credentials.subtitle2')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            {t('credentials.storedTitle')}
          </CardTitle>
          <CardDescription>{t('credentials.storedDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('common.name')}</TableHead>
                <TableHead>{t('credentials.placeholderHeader')}</TableHead>
                <TableHead>{t('credentials.previewHeader')}</TableHead>
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
                    {t('credentials.empty')}
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
                        {c.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
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
                            disabled={c.scope === 'global' && !isAdmin}
                            onClick={() => remove(c)}
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

      <CreateCredential onCreated={refresh} />
    </AppShell>
  );
}

function CreateCredential({ onCreated }: { onCreated: () => void }) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
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
      toast.success(t('credentials.createdToast'));
      setName('');
      setSecret('');
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
          {t('credentials.addTitle')}
        </CardTitle>
        <CardDescription>{t('credentials.addDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="cred-name">{t('common.name')}</Label>
              <Input
                id="cred-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('credentials.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cred-secret">{t('credentials.secret')}</Label>
              <Input
                id="cred-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t('credentials.secretPlaceholder')}
                required
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cred-scope">{t('common.scope')}</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="cred-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {!isAdmin && t('credentials.adminSuffix')}
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
                aria-label={t('credentials.distributableAria')}
              />
              <Label htmlFor="cred-distributable" className="font-normal">
                {t('credentials.distributableLabel1')}{' '}
                <code className="font-mono">hnx mcp serve</code>{' '}
                {t('credentials.distributableLabel2')} <code className="font-mono">/mcp</code>{' '}
                {t('credentials.distributableLabel3')}
              </Label>
            </div>
          ) : null}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? t('credentials.creating') : t('credentials.createButton')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
