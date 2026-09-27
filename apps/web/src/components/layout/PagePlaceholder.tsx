interface PagePlaceholderProps {
  title: string;
  description: string;
  /** What this page will do once its phase is implemented. */
  plannedFor: string;
}

export function PagePlaceholder({
  title,
  description,
  plannedFor,
}: PagePlaceholderProps): React.JSX.Element {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{description}</p>

      <div className="mt-6 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <p className="text-sm font-medium">Not built yet</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">{plannedFor}</p>
      </div>
    </section>
  );
}
