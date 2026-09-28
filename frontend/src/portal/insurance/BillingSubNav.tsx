import { NavLink } from 'react-router-dom';
import { useCan } from '../../auth/StaffAuth';

const LINK =
  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400';

function SubNavLink({ to, end, children }: { to: string; end?: boolean; children: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `${LINK} ${isActive ? 'bg-white text-primary-800 shadow-sm ring-1 ring-sage-100' : 'text-sage-600 hover:text-sage-900'}`
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * Switches between client billing, insurance claims and insurance payments. Insurance payments
 * cover many clients at once, so they're only for people with practice-wide billing.
 */
export function BillingSubNav() {
  const billsEveryone = useCan('billing_all');
  return (
    <nav aria-label="Billing sections" className="mb-5 -mx-1 overflow-x-auto px-1">
      <div className="inline-flex gap-1 rounded-lg bg-sage-100/70 p-1">
        <SubNavLink to="/portal/billing" end>
          Invoices & payments
        </SubNavLink>
        <SubNavLink to="/portal/billing/claims">Claims</SubNavLink>
        {billsEveryone && <SubNavLink to="/portal/billing/remittances">Insurance payments</SubNavLink>}
      </div>
    </nav>
  );
}
