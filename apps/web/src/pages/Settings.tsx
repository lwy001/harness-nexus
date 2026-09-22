import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { AppShell } from '@/components/app-shell';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

/** Issue #3 — the pre-warm rows, in PREWARM_ADAPTER_TARGETS order. */
const PREWARM_ROWS = ['claude-code', 'codex', 'deepseek'] as const;

type PrewarmMap = { 'claude-code': boolean; codex: boolean; deepseek: boolean };

export function SettingsPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [allow, setAllow] = useState<boolean | null>(null);
  const [prewarm, setPrewarm] = useState<PrewarmMap | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRegistration().then((r) => setAllow(r.allowRegistration));
    api
      .getChatPrewarm()
      .then((r) => setPrewarm(r.chatPrewarm))
      .catch(() => setPrewarm(null));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await withAuthGuard(() => api.setRegistration(next), logout);
      setAllow(next);
      toast.success(next ? t('settings.registrationOpened') : t('settings.registrationClosed'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function togglePrewarm(target: (typeof PREWARM_ROWS)[number], next: boolean) {
    if (prewarm === null) return;
    const previous = prewarm;
    setPrewarm((prev) => (prev === null ? prev : { ...prev, [target]: next }));
    try {
      await withAuthGuard(
        () =>
          api.setChatPrewarm({
            'claude-code': target === 'claude-code' ? next : previous['claude-code'],
            codex: target === 'codex' ? next : previous.codex,
            deepseek: target === 'deepseek' ? next : previous.deepseek,
          }),
        logout,
      );
      toast.success(t('settings.prewarmUpdated'));
    } catch (e) {
      setPrewarm(previous); // roll back the optimistic row
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('settings.subtitle')}</p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">{t('settings.registration')}</CardTitle>
          <CardDescription>{t('settings.registrationDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reg-switch" className="text-sm font-medium">
                {t('settings.allowPublicRegistration')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">{t('settings.currentState')}</span>
                {allow === null ? (
                  <span className="text-muted-foreground text-xs">…</span>
                ) : (
                  <Badge variant={allow ? 'default' : 'secondary'} className="text-[10px]">
                    {allow ? t('settings.open') : t('settings.closed')}
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

      <Card className="mt-6 max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">{t('settings.prewarm')}</CardTitle>
          <CardDescription>{t('settings.prewarmDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {PREWARM_ROWS.map((target) => (
            <div
              key={target}
              className="flex items-center justify-between rounded-lg border p-4"
            >
              <div className="flex flex-col gap-1">
                {/* Target names are wire values — mono badge, English in both locales. */}
                <Badge variant="secondary" className="nums w-fit font-mono text-[10px]">
                  {target}
                </Badge>
              </div>
              <Switch
                id={`prewarm-${target}`}
                checked={prewarm?.[target] === true}
                disabled={prewarm === null}
                onCheckedChange={(v) => void togglePrewarm(target, v)}
              />
            </div>
          ))}
          <p className="text-muted-foreground text-xs">{t('settings.prewarmHint')}</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
