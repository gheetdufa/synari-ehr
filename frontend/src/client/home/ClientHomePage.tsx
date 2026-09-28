import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarPlus, CreditCard, FileText, MessageSquare } from 'lucide-react';
import { portalHomeApi, portalHomeKeys } from '../../api/portalHome';
import { usePortalClient } from '../../auth/ClientAuth';
import { displayFirstName, formatMoney } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { PageHeader } from '../../ui/Display';
import { Spinner } from '../../ui/Spinner';
import { viewerFirstName } from '../portalViewer';
import { pendingFormCount } from './homeHelpers';
import { NextAppointmentCard } from './NextAppointmentCard';

function SummaryCard({
  to,
  icon,
  title,
  loading,
  failed,
  value,
  detail,
  highlight = false,
  cta,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  loading: boolean;
  failed: boolean;
  value: ReactNode;
  detail: ReactNode;
  highlight?: boolean;
  cta: string;
}) {
  return (
    <Card className={highlight ? 'border-primary-200 ring-1 ring-primary-100' : ''}>
      <Link
        to={to}
        className="flex h-full flex-col gap-3 rounded-xl p-5 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-lg ${
              highlight ? 'bg-primary-600 text-white' : 'bg-primary-50 text-primary-700'
            }`}
          >
            {icon}
          </span>
          <h2 className="text-sm font-semibold text-sage-900">{title}</h2>
        </div>
        <div className="flex-1">
          {loading ? (
            <Spinner className="h-5 w-5 text-primary-600" />
          ) : failed ? (
            <p className="text-sm text-sage-500">Couldn&apos;t load right now.</p>
          ) : (
            <>
              <p className="text-2xl font-semibold tabular-nums text-sage-900">{value}</p>
              <p className="text-sm text-sage-600">{detail}</p>
            </>
          )}
        </div>
        <span className="flex items-center gap-1 text-sm font-medium text-primary-700">
          {cta} <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </Link>
    </Card>
  );
}

/**
 * Client portal home: next appointment, documents to complete, balance and messages. A guardian
 * signed in for the client is greeted by name and told whose portal this is.
 */
export default function ClientHomePage() {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const { permissions } = client;

  const upcoming = useQuery({
    queryKey: portalHomeKeys.upcomingAppointments,
    queryFn: portalHomeApi.upcomingAppointments,
  });
  const forms = useQuery({ queryKey: portalHomeKeys.forms, queryFn: portalHomeApi.forms });
  const billing = useQuery({
    queryKey: portalHomeKeys.billingSummary,
    queryFn: portalHomeApi.billingSummary,
    enabled: permissions.billing,
  });
  const unread = useQuery({
    queryKey: portalHomeKeys.unreadMessages,
    queryFn: portalHomeApi.unreadMessages,
    enabled: permissions.messaging,
  });

  const refresh = (queryKey: readonly string[]) => () => void queryClient.invalidateQueries({ queryKey });
  useRealtimeEvent('appointment*', refresh(portalHomeKeys.upcomingAppointments));
  useRealtimeEvent('client_form.*', refresh(portalHomeKeys.forms));
  useRealtimeEvent('billing.changed', refresh(portalHomeKeys.billingSummary));
  useRealtimeEvent(['message.*', 'conversation.read'], refresh(portalHomeKeys.unreadMessages));

  const pending = forms.data ? pendingFormCount(forms.data) : 0;
  const balance = billing.data?.balance_cents ?? 0;
  const credit = billing.data?.credit_cents ?? 0;
  const messages = unread.data?.count ?? 0;

  return (
    <div>
      <PageHeader
        title={`Hi, ${viewerFirstName(client)}`}
        description={
          client.acting_contact
            ? `You're viewing ${displayFirstName(client)}'s portal with ${client.clinician_name}.`
            : `Welcome to your portal with ${client.clinician_name}.`
        }
        actions={
          permissions.booking && (
            <LinkButton to="/client/appointments/book" variant="secondary" icon={<CalendarPlus className="h-4 w-4" />}>
              Request an appointment
            </LinkButton>
          )
        }
      />
      <div className="space-y-6">
        <NextAppointmentCard
          upcoming={upcoming.data}
          isPending={upcoming.isPending}
          error={upcoming.error}
          onRetry={() => void upcoming.refetch()}
          timeZone={client.time_zone}
          canBook={permissions.booking}
          clinicianName={client.clinician_name}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SummaryCard
            to="/client/documents"
            icon={<FileText className="h-4 w-4" aria-hidden="true" />}
            title="Documents to complete"
            loading={forms.isPending}
            failed={forms.isError}
            highlight={pending > 0}
            value={pending}
            detail={
              pending === 0
                ? "You're all caught up."
                : `${pending === 1 ? 'form is' : 'forms are'} waiting for you.`
            }
            cta={pending > 0 ? 'Complete documents' : 'View documents'}
          />
          {permissions.billing && (
            <SummaryCard
              to="/client/billing"
              icon={<CreditCard className="h-4 w-4" aria-hidden="true" />}
              title="Balance"
              loading={billing.isPending}
              failed={billing.isError}
              highlight={balance > 0}
              value={formatMoney(balance)}
              detail={
                balance > 0
                  ? 'Currently due.'
                  : credit > 0
                    ? `You have ${formatMoney(credit)} in credit.`
                    : 'Nothing is due.'
              }
              cta={balance > 0 && billing.data?.payments_enabled ? 'Pay now' : 'View billing'}
            />
          )}
          {permissions.messaging && (
            <SummaryCard
              to="/client/messages"
              icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
              title="Messages"
              loading={unread.isPending}
              failed={unread.isError}
              highlight={messages > 0}
              value={messages}
              detail={messages === 0 ? 'No unread messages.' : `unread ${messages === 1 ? 'message' : 'messages'}.`}
              cta={messages > 0 ? 'Read messages' : 'Send a message'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
