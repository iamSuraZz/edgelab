import { PagePlaceholder } from '@/components/layout/PagePlaceholder';

export function SettingsPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="Settings"
      description="Account currency, default cost model, and data provider status."
      plannedFor="Configuration editing lands once the run pipeline exists. Secrets stay server-side and are never shown here."
    />
  );
}
