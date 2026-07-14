import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { AgentNexusError } from '@agent-nexus/sdk';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

export function SettingsPage() {
  const { logout } = useAuth();
  const [allow, setAllow] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRegistration().then((r) => setAllow(r.allowRegistration));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await withAuthGuard(() => api.setRegistration(next), logout);
      setAllow(next);
      toast.success(next ? 'Registration opened' : 'Registration closed');
    } catch (e) {
      toast.error(e instanceof AgentNexusError ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">System settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">Instance-wide configuration.</p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Registration</CardTitle>
          <CardDescription>
            When enabled, anyone can create an account. When disabled, only admins can add users.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reg-switch" className="text-sm font-medium">
                Allow public registration
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Current state:</span>
                {allow === null ? (
                  <span className="text-muted-foreground text-xs">…</span>
                ) : (
                  <Badge variant={allow ? 'default' : 'secondary'} className="text-[10px]">
                    {allow ? 'Open' : 'Closed'}
                  </Badge>
                )}
              </div>
            </div>
            <Switch
              id="reg-switch"
              checked={allow === true}
              disabled={busy || allow === null}
              onCheckedChange={(v) => toggle(v)}
            />
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
