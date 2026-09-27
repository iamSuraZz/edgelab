import { PagePlaceholder } from '@/components/layout/PagePlaceholder';

export function DataPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="Data"
      description="Manage M1 history per instrument — download from the provider, import files, and inspect coverage and gaps."
      plannedFor="Provider ingest, file import and a coverage map land in the data phase."
    />
  );
}
