import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CreditCard, FilePlus2, FileText, Lock, Star, Trash2, Undo2, Wallet } from 'lucide-react';
import {
  PAYMENT_METHOD_LABELS,
  billingApi,
  billingKeys,
  cardLabel,
  type ClientBillingSummary,
  type Invoice,
  type SavedCard,
} from '../../api/billing';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi, type ClientDetail, type ClientRef } from '../../api/clients';
import { practiceApi, practiceKeys } from '../../api/practice';
import { useCan } from '../../auth/StaffAuth';
import { formatDate, formatMoney, formatPlainDate, fullName } from '../../lib/format';
import { Button, LinkButton } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, EmptyState, ErrorState } from '../../ui/Display';
import { Switch } from '../../ui/Form';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { BillingDialogs, type BillingDialog } from './BillingDialogs';
import { CardSummary, InvoiceStatusBadge, PaymentStatusBadge, PdfButton, StatCard } from './components/BillingDisplay';
import { StripeSetupNotice } from './components/StripeSetupNotice';
import { useBillingRealtime, useInvalidateBilling, usePracticeDay } from './hooks';

function clientRef(client: ClientDetail): ClientRef {
  return {
    id: client.id,
    first_name: client.first_name,
    last_name: client.last_name,
    preferred_name: client.preferred_name,
  };
}

/** 403/404 from billing means this client's billing is outside the viewer's role. */
function isOutOfReach(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/** Billing in a client's chart: balance, open invoices, cards, AutoPay and recent payments. */
export default function ClientBillingTab({ clientId }: { clientId: number }) {
  const [dialog, setDialog] = useState<BillingDialog | null>(null);
  useBillingRealtime();

  const summary = useQuery({
    queryKey: billingKeys.clientSummary(clientId),
    queryFn: () => billingApi.clientSummary(clientId),
  });
  const client = useQuery({ queryKey: clientKeys.detail(clientId), queryFn: () => clientsApi.get(clientId) });

  if (summary.isLoading || client.isLoading) return <SectionSpinner />;
  if (isOutOfReach(summary.error)) {
    return (
      <Card>
        <EmptyState
          icon={<Lock />}
          title="Billing isn't available to your role"
          description="This client's invoices, payments and cards are handled by your practice's billing team."
        />
      </Card>
    );
  }
  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;
  if (client.isError) return <ErrorState error={client.error} onRetry={() => client.refetch()} />;
  if (!summary.data || !client.data) return null;

  const data = summary.data;
  const ref = clientRef(client.data);
  const canCharge = data.payments_enabled && data.saved_cards.length > 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Balance"
          value={formatMoney(data.balance_cents)}
          hint={`${data.open_invoices.length} open ${data.open_invoices.length === 1 ? 'invoice' : 'invoices'}`}
          tone={data.balance_cents > 0 ? 'attention' : 'default'}
        />
        <StatCard label="Credit" value={formatMoney(data.credit_cents)} hint="Paid but not yet applied to an invoice" />
        <StatCard
          label="AutoPay"
          value={data.payments_enabled ? (data.autopay_enabled ? 'On' : 'Off') : 'Unavailable'}
          hint={
            data.payments_enabled
              ? data.autopay_enabled
                ? 'Default card is charged nightly'
                : 'Charges are made only when you choose'
              : 'Needs online payments'
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button icon={<Wallet className="h-4 w-4" />} onClick={() => setDialog({ kind: 'recordPayment', client: ref })}>
          Record payment
        </Button>
        {canCharge && (
          <Button
            variant="secondary"
            icon={<CreditCard className="h-4 w-4" />}
            onClick={() => setDialog({ kind: 'charge', client: ref, cards: data.saved_cards, balanceCents: data.balance_cents })}
          >
            Charge card
          </Button>
        )}
        <Button variant="secondary" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'newInvoice', client: ref })}>
          New invoice
        </Button>
        <Button variant="secondary" icon={<FileText className="h-4 w-4" />} onClick={() => setDialog({ kind: 'superbill', client: ref })}>
          Generate superbill
        </Button>
      </div>

      <OpenInvoices invoices={data.open_invoices} onOpen={setDialog} client={ref} />

      {data.payments_enabled ? (
        <PaymentMethods summary={data} client={client.data} />
      ) : (
        <StripeSetupNotice />
      )}

      <RecentPayments summary={data} onOpen={setDialog} />

      <BillingDialogs dialog={dialog} onChange={setDialog} />
    </div>
  );
}

function OpenInvoices({
  invoices,
  client,
  onOpen,
}: {
  invoices: Invoice[];
  client: ClientRef;
  onOpen: (dialog: BillingDialog) => void;
}) {
  const { today } = usePracticeDay();
  return (
    <Card>
      <CardHeader
        title="Open invoices"
        actions={
          <LinkButton to="/portal/billing?tab=invoices" variant="ghost" size="sm">
            All invoices
          </LinkButton>
        }
      />
      {invoices.length === 0 ? (
        <EmptyState title="Nothing owed" description={`${fullName(client)} has no open invoices.`} />
      ) : (
        <ul className="divide-y divide-sage-100">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <button
                type="button"
                onClick={() => onOpen({ kind: 'invoice', invoiceId: invoice.id })}
                className="min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-primary-700 hover:underline">{invoice.number}</span>
                  <InvoiceStatusBadge invoice={invoice} today={today} />
                </span>
                <span className="block text-sm text-sage-600">
                  Issued {formatPlainDate(invoice.issued_on)} · due {formatPlainDate(invoice.due_on)}
                </span>
                {invoice.bill_to_name && (
                  <span className="block text-sm text-sage-600">Billed to {invoice.bill_to_name}</span>
                )}
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-2 text-right text-sm">
                  <span className="block font-semibold tabular-nums text-sage-900">{formatMoney(invoice.balance_cents)}</span>
                  {invoice.paid_cents > 0 && (
                    <span className="block text-xs text-sage-500">of {formatMoney(invoice.total_cents)}</span>
                  )}
                </span>
                <PdfButton
                  download={() => billingApi.downloadInvoicePdf(invoice.id)}
                  accessibleLabel={`Download ${invoice.number} as PDF`}
                />
                <Button size="sm" variant="secondary" onClick={() => onOpen({ kind: 'recordPayment', client, invoiceId: invoice.id })}>
                  Record payment
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PaymentMethods({ summary, client }: { summary: ClientBillingSummary; client: ClientDetail }) {
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { today, timeZone } = usePracticeDay();
  const [removing, setRemoving] = useState<SavedCard | null>(null);
  const [confirmAutopay, setConfirmAutopay] = useState(false);
  const practice = useQuery({ queryKey: practiceKeys.settings, queryFn: practiceApi.settings });
  const defaultCard = summary.saved_cards.find((card) => card.is_default);
  const ref = clientRef(client);
  const failedCharges = summary.recent_payments.filter((payment) => payment.status === 'failed' && payment.method === 'card');

  const canManagePractice = useCan('manage_practice');

  const makeDefault = useMutation({
    mutationFn: (card: SavedCard) => billingApi.makeDefaultCard(card.id),
    onSuccess: async (card) => {
      toast.success(`${cardLabel(card)} is now the default card.`);
      await invalidate(client.id);
    },
    onError: (error) => toast.error(error),
  });

  const removeCard = useMutation({
    mutationFn: (card: SavedCard) => billingApi.removeCard(card.id),
    onSuccess: async (_result, card) => {
      toast.success(`Removed ${cardLabel(card)}.`);
      setRemoving(null);
      await invalidate(client.id);
    },
    onError: (error) => toast.error(error),
  });

  const autopay = useMutation({
    mutationFn: (enabled: boolean) => clientsApi.update(client.id, { autopay_enabled: enabled }),
    onSuccess: async (updated) => {
      toast.success(updated.autopay_enabled ? 'AutoPay is on.' : 'AutoPay is off.');
      setConfirmAutopay(false);
      await invalidate(client.id);
    },
    onError: () => setConfirmAutopay(false),
  });

  const portalNote = !client.portal_enabled
    ? 'Turn on portal access for this client so they can add a card.'
    : !client.portal_billing
      ? 'Turn on portal billing for this client so they can add a card.'
      : 'Ask them to add one from the Billing page of their client portal.';

  return (
    <Card>
      <CardHeader
        title="Payment methods"
        description="Clients add and manage cards themselves in the client portal. Card numbers are stored by Stripe, never in Synari."
      />
      <CardBody className="space-y-5">
        {summary.saved_cards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-sage-200 px-4 py-3 text-sm text-sage-600">
            {fullName(client)} hasn't saved a card yet. {portalNote}
          </p>
        ) : (
          <ul className="space-y-3">
            {summary.saved_cards.map((card) => (
              <li key={card.id} className="rounded-lg border border-sage-100 px-3 py-2.5">
                <CardSummary card={card} today={today}>
                  {!card.is_default && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Star className="h-4 w-4" />}
                      loading={makeDefault.isPending && makeDefault.variables?.id === card.id}
                      disabled={makeDefault.isPending}
                      aria-label={`Make ${cardLabel(card)} the default card`}
                      onClick={() => makeDefault.mutate(card)}
                    >
                      Make default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 className="h-4 w-4" />}
                    aria-label={`Remove ${cardLabel(card)}`}
                    onClick={() => setRemoving(card)}
                  >
                    Remove
                  </Button>
                </CardSummary>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-sage-100 pt-4">
          <Switch
            label="AutoPay"
            description={
              defaultCard
                ? `Charge ${cardLabel(defaultCard)} for the full balance each night after invoices are created. Three declines in a row turn AutoPay off.`
                : 'Needs a saved card. Charges the default card for the full balance each night after invoices are created.'
            }
            checked={summary.autopay_enabled}
            disabled={autopay.isPending || (!summary.autopay_enabled && !defaultCard)}
            onChange={(checked) => {
              autopay.reset();
              if (checked) setConfirmAutopay(true);
              else autopay.mutate(false);
            }}
          />
          <div className="mt-3 space-y-2">
            {autopay.isError && (
              <Alert tone="danger" title="AutoPay wasn't changed">
                {autopay.error.message}
              </Alert>
            )}
            {summary.autopay_enabled && practice.data && !practice.data.autopay_enabled && (
              <Alert tone="warning">
                AutoPay is turned off for your practice, so this client's card won't be charged automatically.{' '}
                {canManagePractice ? 'Turn it on in Settings.' : 'A practice owner or manager can turn it on in Settings.'}
              </Alert>
            )}
            {summary.autopay_enabled && summary.autopay_failures > 0 && (
              <Alert tone="warning">
                {summary.autopay_failures === 1
                  ? 'The last AutoPay charge was declined.'
                  : `The last ${summary.autopay_failures} AutoPay charges were declined.`}{' '}
                AutoPay turns off after three declines in a row.
              </Alert>
            )}
            {failedCharges.length > 0 && (
              <Alert tone="warning" title="Recent declined card charges">
                <ul className="space-y-1">
                  {failedCharges.map((payment) => (
                    <li key={payment.id}>
                      {formatDate(payment.created_at, timeZone)} · {formatMoney(payment.amount_cents)}
                      {payment.failure_reason && ` · ${payment.failure_reason}`}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        </div>
      </CardBody>

      <ConfirmDialog
        open={removing !== null}
        title="Remove card?"
        message={
          removing && (
            <p>
              {cardLabel(removing)} will be removed from {fullName(client)}'s account and from Stripe.
              {removing.is_default && summary.saved_cards.length > 1 && ' Their newest other card becomes the default.'}
              {summary.saved_cards.length === 1 && summary.autopay_enabled && ' AutoPay stops charging until they add another card.'}
            </p>
          )
        }
        confirmLabel="Remove card"
        danger
        loading={removeCard.isPending}
        onConfirm={() => removing && !removeCard.isPending && removeCard.mutate(removing)}
        onCancel={() => !removeCard.isPending && setRemoving(null)}
      />
      <ConfirmDialog
        open={confirmAutopay}
        title="Turn on AutoPay?"
        message={
          <p>
            Each night after invoices are created, {defaultCard ? cardLabel(defaultCard) : 'the default card'} is charged for{' '}
            {fullName(ref)}'s full balance
            {summary.balance_cents > 0 && ` (currently ${formatMoney(summary.balance_cents)})`}. Make sure the client has agreed to
            automatic charges.
          </p>
        }
        confirmLabel="Turn on AutoPay"
        loading={autopay.isPending}
        onConfirm={() => !autopay.isPending && autopay.mutate(true)}
        onCancel={() => !autopay.isPending && setConfirmAutopay(false)}
      />
    </Card>
  );
}

function RecentPayments({ summary, onOpen }: { summary: ClientBillingSummary; onOpen: (dialog: BillingDialog) => void }) {
  const { timeZone } = usePracticeDay();
  const { payments_enabled: paymentsEnabled } = summary;
  return (
    <Card>
      <CardHeader
        title="Recent payments"
        actions={
          <LinkButton to="/portal/billing?tab=payments" variant="ghost" size="sm">
            All payments
          </LinkButton>
        }
      />
      {summary.recent_payments.length === 0 ? (
        <EmptyState title="No payments yet" />
      ) : (
        <ul className="divide-y divide-sage-100">
          {summary.recent_payments.map((payment) => {
            const cardBlocked = payment.method === 'card' && !paymentsEnabled;
            return (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-sage-900">
                    {formatDate(payment.received_at ?? payment.created_at, timeZone)} · {PAYMENT_METHOD_LABELS[payment.method]}
                    {payment.reference && <span className="text-sage-500"> · {payment.reference}</span>}
                  </p>
                  <p className="text-xs text-sage-500">
                    {payment.refunded_cents > 0 && `${formatMoney(payment.refunded_cents)} refunded`}
                    {payment.refunded_cents > 0 && payment.unapplied_cents > 0 && ' · '}
                    {payment.unapplied_cents > 0 && `${formatMoney(payment.unapplied_cents)} unapplied credit`}
                    {payment.status === 'failed' && payment.failure_reason}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <PaymentStatusBadge status={payment.status} />
                  <span className="w-24 text-right font-medium tabular-nums text-sage-900">{formatMoney(payment.amount_cents)}</span>
                  {payment.refundable_cents > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Undo2 className="h-4 w-4" />}
                      disabled={cardBlocked}
                      title={cardBlocked ? 'Card refunds need Stripe to be configured' : undefined}
                      onClick={() => onOpen({ kind: 'refund', payment })}
                    >
                      Refund
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
