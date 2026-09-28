import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { PortalClient } from '../api/auth';
import ClientLayout from './ClientLayout';

const mocks = vi.hoisted(() => ({ client: null as PortalClient | null }));

vi.mock('../auth/ClientAuth', () => ({
  usePortalClient: () => mocks.client,
  useClientAuth: () => ({ logout: () => Promise.resolve() }),
}));
vi.mock('../lib/realtime', () => ({
  RealtimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRealtimeEvent: () => undefined,
}));
vi.mock('../lib/usePublicConfig', () => ({ usePublicConfig: () => ({}) }));
vi.mock('../shared/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('../auth/IdleTimeout', () => ({
  IdleTimeout: ({ limitMinutes }: { limitMinutes: number }) => <p>Signs out after {limitMinutes} idle minutes</p>,
}));

function portalClient(changes: Partial<PortalClient> = {}): PortalClient {
  return {
    id: 3,
    first_name: 'Alexandra',
    last_name: 'Rivera',
    preferred_name: 'Alex',
    email: null,
    clinician_name: 'Dana Lee, LCSW',
    practice_name: 'Calm Harbor Therapy',
    time_zone: 'America/Chicago',
    permissions: { messaging: false, booking: true, billing: false },
    acting_contact: null,
    idle_timeout_minutes: 30,
    ...changes,
  };
}

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/client']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/client" element={<ClientLayout />}>
            <Route index element={<p>Home page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientLayout', () => {
  it('shows the practice and clinician with no banner when the client signed in', () => {
    mocks.client = portalClient();
    renderLayout();
    expect(screen.getByText('Calm Harbor Therapy')).toBeInTheDocument();
    expect(screen.getByText('Client portal · Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();
  });

  it('links to My records for every client', () => {
    mocks.client = portalClient();
    renderLayout();
    expect(screen.getByRole('link', { name: 'My records' })).toHaveAttribute('href', '/client/records');
  });

  it("signs out after the server's idle limit for the portal", () => {
    mocks.client = portalClient({ idle_timeout_minutes: 20 });
    renderLayout();
    expect(screen.getByText('Signs out after 20 idle minutes')).toBeInTheDocument();
  });

  it('names the guardian who signed in and whose portal it is', () => {
    mocks.client = portalClient({ acting_contact: { id: 31, name: 'Pat Rivera' } });
    renderLayout();
    expect(screen.getByText('Signed in as Pat Rivera for Alex')).toBeInTheDocument();
  });
});
