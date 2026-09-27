import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex h-full">
      {/*
        Skip link. Five nav items sit before the content on every page, so without it a keyboard
        user tabs through the whole sidebar to reach the editor — on every navigation. Visually
        hidden until focused, which is the only time it is useful.
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-[var(--color-primary)] focus:px-3 focus:py-1.5 focus:text-sm focus:text-[var(--color-primary-foreground)]"
      >
        Skip to content
      </a>

      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* `tabIndex={-1}` so the skip link can actually move focus here; without it the browser
            scrolls to the anchor but focus stays in the nav and the next Tab goes back into it. */}
        <main
          id="main"
          tabIndex={-1}
          aria-label="Main content"
          className="flex-1 overflow-auto p-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
