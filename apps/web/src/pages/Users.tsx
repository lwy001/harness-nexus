import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { toast } from 'sonner';
import { HarnessNexusError, type PublicUser, type Role } from '@harness-nexus/sdk';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MoreHorizontalIcon, PlusIcon, ShieldCheckIcon, UserIcon, TrashIcon } from 'lucide-react';

export function UsersPage() {
  const { logout } = useAuth();
  const [users, setUsers] = useState<PublicUser[]>([]);

  async function refresh() {
    try {
      setUsers(await withAuthGuard(() => api.listUsers(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Failed to load users');
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function setRole(u: PublicUser, role: Role) {
    try {
      await withAuthGuard(() => api.updateUserRole(u.id, role), logout);
      toast.success(`${u.username} is now ${role}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Update failed');
    }
  }

  async function remove(u: PublicUser) {
    if (!confirm(`Delete user ${u.username}? This cannot be undone.`)) return;
    try {
      await withAuthGuard(() => api.deleteUser(u.id), logout);
      toast.success(`Deleted ${u.username}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Delete failed');
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Manage accounts and roles. {users.length} user{users.length === 1 ? '' : 's'}.
        </p>
      </div>

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-6 font-medium">{u.username}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="gap-1">
                      {u.role === 'admin' ? <ShieldCheckIcon /> : <UserIcon />}
                      {u.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground capitalize">{u.status}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString(undefined, {
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
                        <DropdownMenuLabel>Role</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={u.role === 'admin'}
                          onClick={() => setRole(u, 'admin')}
                        >
                          <ShieldCheckIcon /> Make admin
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={u.role === 'user'}
                          onClick={() => setRole(u, 'user')}
                        >
                          <UserIcon /> Make user
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => remove(u)}>
                          <TrashIcon /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    No users yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateUser onCreated={refresh} />
    </AppShell>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const { logout } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await withAuthGuard(() => api.createUser({ username, password, role }), logout);
      toast.success(`Created ${username}`);
      setUsername('');
      setPassword('');
      setRole('user');
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : 'Create failed');
    }
  }

  return (
    <Card className="mt-6 max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusIcon className="size-4" />
          Add user
        </CardTitle>
        <CardDescription>
          Bypasses the registration switch — admins can always add users.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="new-username">Username</Label>
            <Input
              id="new-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <div className="grid flex-1 gap-2">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="new-role" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit">Create</Button>
        </form>
      </CardContent>
    </Card>
  );
}
