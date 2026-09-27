import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { DataPage } from '@/pages/Data';
import { LibraryPage } from '@/pages/Library';
import { RunReportPage } from '@/pages/RunReport';
import { RunsPage } from '@/pages/Runs';
import { SettingsPage } from '@/pages/Settings';
import { StudioPage } from '@/pages/Studio';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Backtest results are immutable once computed, so refetching on focus is waste.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/studio" replace />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/runs" element={<RunsPage />} />
          {/* Every run has its own URL (spec 07); the report reuses the Studio results pane. */}
          <Route path="/runs/:runId" element={<RunReportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/studio" replace />} />
        </Route>
      </Routes>
    </QueryClientProvider>
  );
}
