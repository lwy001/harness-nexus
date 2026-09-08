import { LanguagesIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';

/** Language toggle button (en ↔ zh). Shown in the app header next to the theme toggle. */
export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  const next = lang === 'en' ? 'zh' : 'en';
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5 px-2"
      aria-label={lang === 'en' ? '切换到中文' : 'Switch to English'}
      onClick={() => setLang(next)}
    >
      <LanguagesIcon className="size-4" />
      <span className="hidden sm:inline">{lang === 'en' ? '中文' : 'English'}</span>
    </Button>
  );
}
