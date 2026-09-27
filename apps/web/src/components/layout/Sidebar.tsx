import { NavLink } from 'react-router-dom';
import { Database, FlaskConical, Library, ListChecks, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Order matches the spec: Studio, Data, Library, Runs, Settings. */
const NAV_ITEMS: readonly NavItem[] = [
  { to: '/studio', label: 'Studio', icon: FlaskConical },
  { to: '/data', label: 'Data', icon: Database },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/runs', label: 'Runs', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="grid h-7 w-7 place-items-center rounded bg-[var(--color-primary)] text-sm font-bold text-[var(--color-primary-foreground)]">
          E
        </span>
        <span className="text-sm font-semibold tracking-tight">EdgeLab</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-2" aria-label="Main">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-[var(--color-surface-hover)] font-medium text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]',
              )
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
        Scaffold — no features yet
      </div>
    </aside>
  );
}
