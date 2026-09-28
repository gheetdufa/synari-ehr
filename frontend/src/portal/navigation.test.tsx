import type { ReactNode } from 'react';
import { render, renderHook, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capability, StaffMember } from '../api/auth';
import { useCan } from '../auth/StaffAuth';
import { WithSession, testSession } from '../test/session';
import { canOpenArea, navItemsFor } from './navigation';
import { SidebarNav } from './PortalLayout';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

type Person = { staff?: Partial<StaffMember>; capabilities: Capability[] };

const EVERYTHING: Capability[] = [
  'billing_all',
  'billing_own',
  'clinical_all',
  'manage_practice',
  'manage_team',
  'schedule_all',
  'view_all_clients',
  'view_audit_log',
  'view_reports',
];

// Capabilities per role, as backend/synari/permissions.py grants them.
const PEOPLE: Record<string, Person> = {
  'owner who sees clients': { staff: { role: 'owner', is_clinician: true }, capabilities: EVERYTHING },
  'owner who runs the practice': { staff: { role: 'owner', is_clinician: false }, capabilities: EVERYTHING },
  'basic clinician': { staff: { role: 'clinician', clinician_access: 'basic' }, capabilities: [] },
  'clinician with billing': { staff: { role: 'clinician', clinician_access: 'billing' }, capabilities: ['billing_own'] },
  'practice manager': {
    staff: { role: 'practice_manager', is_clinician: false },
    capabilities: [
      'manage_team',
      'manage_practice',
      'view_all_clients',
      'schedule_all',
      'billing_all',
      'view_reports',
      'view_audit_log',
    ],
  },
  biller: {
    staff: { role: 'biller', is_clinician: false },
    capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
  },
  scheduler: { staff: { role: 'scheduler', is_clinician: false }, capabilities: ['view_all_clients', 'schedule_all'] },
};

const ALWAYS = ['Dashboard', 'Calendar', 'Clients', 'Forms', 'Settings'];

describe('navItemsFor', () => {
  it.each([
    ['owner who sees clients', ['Messages', 'Telehealth', 'Notes', 'Records', 'Billing', 'Reports']],
    ['owner who runs the practice', ['Messages', 'Telehealth', 'Notes', 'Records', 'Billing', 'Reports']],
    ['basic clinician', ['Messages', 'Telehealth', 'Notes', 'Records']],
    ['clinician with billing', ['Messages', 'Telehealth', 'Notes', 'Records', 'Billing', 'Reports']],
    ['practice manager', ['Telehealth', 'Billing', 'Reports']],
    ['biller', ['Billing', 'Reports']],
    ['scheduler', ['Telehealth']],
  ])('shows a %s only the areas their role allows', (who, extra) => {
    const labels = navItemsFor(testSession(PEOPLE[who])).map((item) => item.label);
    expect(labels.filter((label) => !ALWAYS.includes(label))).toEqual(extra);
    expect(labels).toEqual(expect.arrayContaining(ALWAYS));
  });
});

describe('canOpenArea', () => {
  it.each([
    ['owner who sees clients', true],
    ['practice manager', true],
    ['biller', true],
    ['clinician with billing', true],
    ['basic clinician', false],
    ['scheduler', false],
  ])('lets a %s open reports: %s', (who, allowed) => {
    expect(canOpenArea(testSession(PEOPLE[who]), '/portal/reports')).toBe(allowed);
  });
});

describe('useCan', () => {
  it('answers from the signed-in session', () => {
    const session = testSession(PEOPLE['clinician with billing']);
    const wrapper = ({ children }: { children: ReactNode }) => <WithSession session={session}>{children}</WithSession>;
    expect(renderHook(() => useCan('billing_own'), { wrapper }).result.current).toBe(true);
    expect(renderHook(() => useCan('billing_all'), { wrapper }).result.current).toBe(false);
  });
});

describe('SidebarNav', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ count: 3 }), { status: 200 })));

  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  function renderNav(person: Person) {
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <WithSession session={testSession(person)}>
          <MemoryRouter future={ROUTER_FUTURE}>
            <SidebarNav />
          </MemoryRouter>
        </WithSession>
      </QueryClientProvider>,
    );
  }

  it("hides clinical areas from a biller and doesn't load the unread message count", () => {
    renderNav(PEOPLE.biller);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/portal/billing');
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/portal/reports');
    expect(within(nav).queryByRole('link', { name: /Messages/ })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a clinician their unread messages', async () => {
    renderNav(PEOPLE['basic clinician']);
    const messages = screen.getByRole('link', { name: /Messages/ });
    expect(await within(messages).findByText('3')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Billing' })).not.toBeInTheDocument();
  });
});
