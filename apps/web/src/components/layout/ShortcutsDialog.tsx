import { Keyboard, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * The keyboard shortcut list (spec 07).
 *
 * Every shortcut here is one the app actually binds. A list that drifts from the bindings is
 * worse than none, because it teaches a key that does nothing — so this file and the handlers
 * are the same commit whenever a shortcut changes.
 */
const SHORTCUTS: readonly {
  readonly keys: string;
  readonly what: string;
  readonly where: string;
}[] = [
  { keys: 'Ctrl/Cmd + Enter', what: 'Run the backtest', where: 'Studio' },
  { keys: 'Ctrl/Cmd + S', what: 'Save a version', where: 'Studio' },
  { keys: '←  →', what: 'Resize the focused pane divider', where: 'Studio' },
  { keys: 'Enter', what: 'Add the typed tag', where: 'Library' },
  { keys: '?', what: 'Show this list', where: 'Anywhere' },
  { keys: 'Esc', what: 'Close this list', where: 'Anywhere' },
];

export function ShortcutsDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (event.key !== '?') return;

      // Never steal the key from somewhere it is being typed. `?` is a literal character in a
      // Pine comment, a strategy name or a tag, and a global handler that swallows it makes
      // those fields quietly lossy.
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }

      opener.current = document.activeElement;
      setOpen(true);
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus into the dialog when it opens and back where it came from when it closes, so a
  // keyboard user is not dropped at the top of the document after dismissing it.
  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
      return;
    }
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          opener.current = document.activeElement;
          setOpen(true);
        }}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        data-testid="shortcuts-open"
        className="grid size-8 place-items-center rounded text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
      >
        <Keyboard className="size-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={() => {
            setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            data-testid="shortcuts-dialog"
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
          >
            <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
              <h2 id="shortcuts-title" className="text-sm font-semibold">
                Keyboard shortcuts
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => {
                  setOpen(false);
                }}
                aria-label="Close"
                data-testid="shortcuts-close"
                className="ml-auto grid size-6 place-items-center rounded text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </header>

            <table className="w-full text-xs">
              <tbody>
                {SHORTCUTS.map((s) => (
                  <tr key={s.keys} className="border-t border-[var(--color-border)]/60">
                    <td className="w-40 px-4 py-1.5">
                      <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px]">
                        {s.keys}
                      </kbd>
                    </td>
                    <td className="px-2 py-1.5">{s.what}</td>
                    <td className="px-4 py-1.5 text-right text-[var(--color-muted)]">{s.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
