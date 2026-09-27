import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShortcutsDialog } from '@/components/layout/ShortcutsDialog';
import { useThemeStore } from '@/stores/theme';

export function TopBar(): React.JSX.Element {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const isDark = theme === 'dark';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
      <div className="text-sm text-[var(--color-muted)]">Pine Script backtesting</div>

      <div className="flex items-center gap-1">
        <ShortcutsDialog />

        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {isDark ? (
            <Sun className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </header>
  );
}
