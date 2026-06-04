import { createBrowserRouter, RouterProvider, NavLink, Outlet } from 'react-router';
import { useState, useEffect } from 'react';
import {
  Button, Sheet, SheetContent, SheetHeader, SheetTitle, useIsMobile,
} from '@databricks/appkit-ui/react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { Menu, LayoutDashboard, List, Activity, DollarSign } from 'lucide-react';
import { DashboardPage } from './pages/DashboardPage';
import { EventsPage } from './pages/EventsPage';
import { CostsPage } from './pages/CostsPage';

const navCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

const mobileNavCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

function NavLinks({ linkClass, onClick }: { linkClass: typeof navCls; onClick?: () => void }) {
  return (
    <nav className="hidden md:flex gap-1">
      <NavLink to="/" end className={linkClass} onClick={onClick}>
        <LayoutDashboard className="h-4 w-4" /> Dashboard
      </NavLink>
      <NavLink to="/events" className={linkClass} onClick={onClick}>
        <List className="h-4 w-4" /> Events
      </NavLink>
      <NavLink to="/costs" className={linkClass} onClick={onClick}>
        <DollarSign className="h-4 w-4" /> Costs
      </NavLink>
    </nav>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!isMobile) setOpen(false); }, [isMobile]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-4">
        <Activity className="h-5 w-5 text-primary flex-shrink-0" />
        <span className="text-lg font-semibold text-foreground">Databricks Apps Admin</span>
        <NavLinks linkClass={navCls} />
        <div className="ml-auto md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <Button variant="ghost" size="icon" onClick={() => setOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Navigation</span>
            </Button>
            <SheetContent side="left">
              <SheetHeader><SheetTitle>Navigation</SheetTitle></SheetHeader>
              <div className="flex flex-col gap-1 mt-4">
                <NavLink to="/" end className={mobileNavCls} onClick={() => setOpen(false)}>
                  <LayoutDashboard className="h-4 w-4" /> Dashboard
                </NavLink>
                <NavLink to="/events" className={mobileNavCls} onClick={() => setOpen(false)}>
                  <List className="h-4 w-4" /> Events
                </NavLink>
                <NavLink to="/costs" className={mobileNavCls} onClick={() => setOpen(false)}>
                  <DollarSign className="h-4 w-4" /> Costs
                </NavLink>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <main className="flex-1 p-4 md:p-6 max-w-screen-2xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  );
}

type ScheduleRow = {
  app_name: string; always_on: boolean; idle_threshold_minutes: number;
  force_stop_hour: number; notes: string; updated_at: string;
};

type StopRow = { app_name: string; stop_count: number };

function DashboardWrapper() {
  const { data: schedule, loading: schedLoading } = useAnalyticsQuery('app_schedule', {});
  const { data: stops }                            = useAnalyticsQuery('stops_last_24h', {});
  if (schedLoading) {
    return <div className="text-center text-muted-foreground py-16">Loading schedule…</div>;
  }
  return (
    <DashboardPage
      schedule={(schedule ?? []) as ScheduleRow[]}
      stopsLast24h={(stops ?? []) as StopRow[]}
    />
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/',       element: <DashboardWrapper /> },
      { path: '/events', element: <EventsPage /> },
      { path: '/costs',  element: <CostsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
