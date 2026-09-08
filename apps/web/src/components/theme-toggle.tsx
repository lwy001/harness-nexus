import { MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';

/** Light/dark toggle button. Shown in the app header. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  const isDark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? t('app.themeToLight') : t('app.themeToDark')}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
