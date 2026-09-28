import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WithSession, testSession } from '../test/session';
import { AreaGate } from './AreaGate';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

function renderGate(area: string, session = testSession()) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE}>
      <WithSession session={session}>
        <AreaGate area={area}>
          <p>Secret area</p>
        </AreaGate>
      </WithSession>
    </MemoryRouter>,
  );
}

describe('AreaGate', () => {
  it('shows the area to roles that can open it', () => {
    renderGate('/portal/billing');
    expect(screen.getByText('Secret area')).toBeInTheDocument();
  });

  it('explains instead of opening an area the role cannot use', () => {
    const scheduler = testSession({
      staff: { role: 'scheduler', is_clinician: false },
      capabilities: ['view_all_clients', 'schedule_all'],
    });
    renderGate('/portal/notes', scheduler);
    expect(screen.queryByText('Secret area')).not.toBeInTheDocument();
    expect(screen.getByText('Not available for your role')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '/portal');
  });

  it('never blocks areas without a rule', () => {
    const scheduler = testSession({ staff: { role: 'scheduler', is_clinician: false }, capabilities: [] });
    renderGate('/portal/calendar', scheduler);
    expect(screen.getByText('Secret area')).toBeInTheDocument();
  });
});
