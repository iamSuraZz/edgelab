import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Resizable horizontal panes with a draggable divider.
 *
 * Hand-rolled rather than pulled from a library because the requirement is narrow — two or three
 * columns, a remembered width, keyboard accessible — and a panel library would be a larger
 * dependency than the 80 lines it replaces.
 *
 * Sizes are kept in localStorage per `storageKey`, so the layout you arranged survives a reload
 * (spec 07 asks for exactly this).
 */

export interface SplitPaneProps {
  readonly storageKey: string;
  /** Left pane width as a percentage of the container. */
  readonly defaultRatio: number;
  readonly minRatio?: number;
  readonly maxRatio?: number;
  readonly left: React.ReactNode;
  readonly right: React.ReactNode;
  readonly className?: string;
}

export function SplitPane({
  storageKey,
  defaultRatio,
  minRatio = 0.15,
  maxRatio = 0.85,
  left,
  right,
  className,
}: SplitPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => readRatio(storageKey, defaultRatio));
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (value: number) => Math.min(maxRatio, Math.max(minRatio, value)),
    [minRatio, maxRatio],
  );

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(ratio));
  }, [storageKey, ratio]);

  // Listeners go on the WINDOW, not the divider: once dragging starts the pointer routinely
  // leaves the 4px divider, and a target-bound listener would drop the drag the moment it did.
  useEffect(() => {
    if (!dragging) return undefined;

    const onMove = (event: PointerEvent): void => {
      const box = containerRef.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0) return;
      setRatio(clamp((event.clientX - box.left) / box.width));
    };
    const onUp = (): void => {
      setDragging(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // Stops the cursor flickering to a text caret over content while dragging.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging, clamp]);

  return (
    <div ref={containerRef} className={cn('flex min-h-0 min-w-0 flex-1', className)}>
      <div className="flex min-w-0 flex-col" style={{ width: `${String(ratio * 100)}%` }}>
        {left}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        // Keyboard resizing, because a mouse-only divider is unusable for anyone who does not
        // use one — and it costs four lines.
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setRatio((r) => clamp(r - 0.02));
          if (event.key === 'ArrowRight') setRatio((r) => clamp(r + 0.02));
        }}
        className={cn(
          'group relative w-px shrink-0 cursor-col-resize bg-border transition-colors',
          'hover:bg-primary focus-visible:bg-primary focus-visible:outline-none',
          dragging && 'bg-primary',
        )}
      >
        {/* A 1px divider is impossible to hit; this widens the target without widening the line. */}
        <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">{right}</div>
    </div>
  );
}

function readRatio(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

/* --------------------------------------------------------------------- panels */

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  readonly title?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}): React.JSX.Element {
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      {title !== undefined && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3">
          <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted">
            {title}
          </h2>
          {actions !== undefined && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1 overflow-auto', bodyClassName)}>{children}</div>
    </section>
  );
}
