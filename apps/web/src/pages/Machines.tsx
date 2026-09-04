import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CheckIcon,
  CopyIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { appSocket, type MachineStatusEvent } from '@/realtime';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { HarnessNexusError, type MachineView } from '@harness-nexus/sdk';

/**
 * Machines (Phase 8 C1). Enrollment creates the machine + its machine token
 * (shown once, with a ready-to-paste `hnx daemon` command). Online status is
 * live socket presence pushed over the /app channel — honest by construction:
 * the row shows offline the moment the daemon disconnects.
 */
export function MachinesPage() {
  const { logout } = useAuth();
  const [items, setItems] = useState<MachineView[] | null>(null);
  const [reveal, setReveal] = useState<{ machine: MachineView; token: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await withAuthGuard(() => api.listMachines(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load machines');
    }
  }, [logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live presence: patch rows in place on machine:status pushes.
  useEffect(() => {
    const socket = appSocket();
    const onStatus = (e: MachineStatusEvent): void => {
      setItems(
        (prev) =>
          prev?.map((m) =>
            m.id === e.machineId
              ? {
                  ...m,
                  online: e.online,
                  lastSeenAt: e.lastSeenAt,
                  ...(e.daemonVersion !== undefined ? { daemonVersion: e.daemonVersion } : {}),
                }
              : m,
          ) ?? prev,
      );
    };
    socket.on('machine:status', onStatus);
    return () => {
      socket.off('machine:status', onStatus);
    };
  }, []);

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Machines</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Computers enrolled with this instance via the Harness Nexus client. A machine is online
          exactly while its <code className="font-mono">hnx daemon</code> is connected — status is
          never faked.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LaptopIcon className="size-4" />
            Enrolled machines
          </CardTitle>
          <CardDescription>
            Machines are personal; admins can see every user's machines.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Daemon</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Remote chat</TableHead>
                <TableHead>Last seen</TableHead>
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
                    No machines enrolled yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((m) => <MachineRow key={m.id} machine={m} onRevoke={refresh} />)
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <EnrollCard onEnrolled={refresh} onReveal={setReveal} />
      <RevealDialog reveal={reveal} onClose={() => setReveal(null)} />
    </AppShell>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`size-2 rounded-full ${online ? 'bg-ok' : 'bg-muted-foreground/40'}`} />
      <span className="tabular-nums">{online ? 'Online' : 'Offline'}</span>
    </span>
  );
}

function MachineRow({ machine, onRevoke }: { machine: MachineView; onRevoke: () => void }) {
  const { logout } = useAuth();
  const [remoteChat, setRemoteChat] = useState(machine.remoteChatEnabled);

  useEffect(() => {
    setRemoteChat(machine.remoteChatEnabled);
  }, [machine.remoteChatEnabled]);

  async function toggleRemoteChat(next: boolean): Promise<void> {
    const consent = next
      ? confirm(
          `Enable remote chat on "${machine.name}"?\n\nChatting with an agent on this machine drives tool execution there (equivalent to running commands yourself).`,
        )
      : confirm(`Disable remote chat on "${machine.name}"?`);
    if (!consent) return;
    setRemoteChat(next);
    try {
      await withAuthGuard(() => api.updateMachine(machine.id, { remoteChatEnabled: next }), logout);
      toast.success(next ? 'Remote chat enabled' : 'Remote chat disabled');
    } catch (e) {
      setRemoteChat(!next);
      toast.error(e instanceof HarnessNexusError ? e.message : 'Update failed');
    }
  }

  async function revoke(): Promise<void> {
    if (
      !confirm(
        `Remove machine "${machine.name}"?\n\nIts machine token is revoked immediately and the daemon disconnects.`,
      )
    )
      return;
    try {
      await withAuthGuard(() => api.deleteMachine(machine.id), logout);
      toast.success('Machine removed');
      onRevoke();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Remove failed');
    }
  }

  const host = [machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ');

  return (
    <TableRow>
      <TableCell className="pl-6 font-medium">
        <Link to={`/machines/${machine.id}`} className="hover:underline">
          {machine.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">{host || '—'}</TableCell>
      <TableCell>
        {machine.daemonVersion ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs tabular-nums">{machine.daemonVersion}</span>
            {machine.capabilities.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-[10px]">
                {c}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">never connected</span>
        )}
      </TableCell>
      <TableCell>
        <OnlineDot online={machine.online} />
      </TableCell>
      <TableCell>
        <Switch
          checked={remoteChat}
          onCheckedChange={(v) => void toggleRemoteChat(v)}
          aria-label={`Toggle remote chat for ${machine.name}`}
        />
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString() : '—'}
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
            <DropdownMenuItem variant="destructive" onClick={() => void revoke()}>
              <TrashIcon /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function EnrollCard({
  onEnrolled,
  onReveal,
}: {
  onEnrolled: () => void;
  onReveal: (r: { machine: MachineView; token: string }) => void;
}) {
  const { logout } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await withAuthGuard(() => api.createMachine({ name }), logout);
      toast.success('Machine enrolled');
      onReveal(res);
      setName('');
      onEnrolled();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Enroll failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusIcon className="size-4" />
          Enroll a machine
        </CardTitle>
        <CardDescription>
          Creates the machine and its dedicated machine token (shown once). Or enroll straight from
          the machine with{' '}
          <code className="font-mono">
            hnx enroll --server &lt;url&gt; --token &lt;your-pat&gt;
          </code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="machine-name">Name</Label>
            <Input
              id="machine-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. work-laptop"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Enrolling…' : 'Enroll machine'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** One-shot reveal: the machine token + the ready-to-paste daemon command. */
function RevealDialog({
  reveal,
  onClose,
}: {
  reveal: { machine: MachineView; token: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'token' | 'command' | null>(null);

  useEffect(() => {
    setCopied(null);
  }, [reveal]);

  if (reveal === null) return null;
  const command = `hnx daemon --server ${window.location.origin} --token ${reveal.token} --machine-id ${reveal.machine.id}`;

  function copy(kind: 'token' | 'command', text: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      toast.success(kind === 'token' ? 'Token copied' : 'Command copied');
    });
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Machine enrolled — copy the command now</DialogTitle>
          <DialogDescription>
            The machine token is shown only once. Run this on <strong>{reveal.machine.name}</strong>{' '}
            to bring it online:
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            Closing this dialog hides the token permanently. Removing the machine revokes it.
          </AlertDescription>
        </Alert>

        <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
          <code className="text-foreground min-w-0 flex-1 break-all font-mono text-xs">
            {command}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => copy('command', command)}
          >
            {copied === 'command' ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {copied === 'command' ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
          <code className="text-foreground min-w-0 flex-1 break-all font-mono text-sm">
            {reveal.token}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => copy('token', reveal.token)}
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
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
