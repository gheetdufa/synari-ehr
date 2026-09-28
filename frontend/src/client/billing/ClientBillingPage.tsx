import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileCheck2, Lock, Plus, Receipt, X } from 'lucide-react';
import {
  MIN_CARD_CHARGE_CENTS,
  PAYMENT_METHOD_LABELS,
  cardLabel,
  portalBillingApi,
  portalBillingKeys,
  todayInZone,
  type Invoice,
  type PortalBillingSummary,
} from '../../api/billing';
import { ApiError } from '../../api/client';
import { usePortalClient } from '../../auth/ClientAuth';
import { formatDate, formatMoney, formatPlainDate } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { GoodFaithEstimateNotice } from '../../shared/GoodFaithEstimateNotice';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState, PageHeader } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import {
  CardSummary,
  InvoiceStatusBadge,
  PaymentStatusBadge,
  PdfButton,
} from '../../portal/billing/components/BillingDisplay';
import { PayModal } from './PayModal';
import { RETURN_PARAMS, bannerFromParams, type PayTarget, type ReturnBanner } from './helpers';

/** The client's billing: balance, paying online, invoices, payments, saved cards and superbills. */
export default function ClientBillingPage() {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [banner, setBanner] = useState<ReturnBanner | null>(() => bannerFromParams(params));

  useRealtimeEvent('billing.changed', () => queryClient.invalidateQueries({ queryKey: portalBillingKeys.all }));

  useEffect(() => {
    if (!RETURN_PARAMS.some((key) => params.has(key))) return;
    const next = bannerFromParams(params);
    if (next) setBanner(next);
    void queryClient.invalidateQueries({ queryKey: portalBillingKeys.all });
    setParams(
      (current) => {
        const cleaned = new URLSearchParams(current);
        RETURN_PARAMS.forEach((key) => cleaned.delete(key));
        return cleaned;
      },
      { replace: true },
    );
  }, [params, setParams, queryClient]);

  const summary = useQuery({
    queryKey: portalBillingKeys.summary,
    queryFn: portalBillingApi.summary,
    enabled: client.permissions.billing,
  });
  const forbidden = !client.permissions.billing || (summary.error instanceof ApiError && summary.error.status === 403);

  return (
    <div>
      <PageHeader title="Billing" description={`Your balance, invoices and payments with ${client.practice_name}.`} />
      {forbidden ? (
        <Card>
          <EmptyState
            icon={<Receipt />}
            title="Billing isn't available in your portal"
            description={`If you have a question about a bill, contact ${client.clinician_name}.`}
          />
        </Card>
      ) : summary.isLoading ? (
        <SectionSpinner />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : summary.data ? (
        <div className="space-y-6">
          {banner && (
            <div className="relative">
              <Alert tone={banner.tone} title={banner.title}>
                {banner.message}
              </Alert>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setBanner(null)}
                className="absolute right-2 top-2 rounded-md p-1 text-sage-500 hover:bg-white/60 hover:text-sage-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <BillingContent summary={summary.data} />
        </div>
      ) : null}
      <GoodFaithEstimateNotice className="mt-6" />
    </div>
  );
}

function BillingContent({ summary }: { summary: PortalBillingSummary }) {
  const client = usePortalClient();
  const today = todayInZone(client.time_zone);
  const [payTarget, setPayTarget] = useState<{ target: PayTarget; invoiceNumber?: string } | null>(null);
  const invoices = useQuery({ queryKey: portalBillingKeys.invoices, queryFn: portalBillingApi.invoices });
  const payments = useQuery({ queryKey: portalBillingKeys.payments, queryFn: portalBillingApi.payments });
  const superbills = useQuery({ queryKey: portalBillingKeys.superbills, queryFn: portalBillingApi.superbills });
  const canPayOnline = summary.payments_enabled;
  const balance = summary.balance_cents;

  const payInvoice = (invoice: Invoice) =>
    setPayTarget({
      target: { kind: 'invoice', invoiceId: invoice.id, balanceCents: invoice.balance_cents },
      invoiceNumber: invoice.number,
    });

  return (
    <>
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-sage-600">Balance due</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-sage-900">{formatMoney(balance)}</p>
            {summary.credit_cents > 0 && (
              <p className="mt-1 text-sm text-emerald-700">
                You have {formatMoney(summary.credit_cents)} in credit. It's applied to your next invoice automatically.
              </p>
            )}
            {balance === 0 && summary.credit_cents === 0 && <p className="mt-1 text-sm text-sage-600">You're all paid up.</p>}
          </div>
          {canPayOnline && balance >= MIN_CARD_CHARGE_CENTS && (
            <Button
              icon={<Lock className="h-4 w-4" />}
              onClick={() => setPayTarget({ target: { kind: 'balance', balanceCents: balance } })}
            >
              Pay balance
            </Button>
          )}
        </CardBody>
        {canPayOnline && balance > 0 && balance < MIN_CARD_CHARGE_CENTS && (
          <p className="border-t border-sage-100 px-5 py-3 text-sm text-sage-600">
            Balances under {formatMoney(MIN_CARD_CHARGE_CENTS)} can't be paid online. Contact {client.clinician_name} to settle
            it.
          </p>
        )}
        {canPayOnline && summary.autopay_enabled && summary.default_card && balance > 0 && (
          <p className="border-t border-sage-100 px-5 py-3 text-sm text-sage-600">
            AutoPay is on: {cardLabel(summary.default_card)} is charged automatically for your balance.
          </p>
        )}
        {!canPayOnline && balance > 0 && (
          <p className="border-t border-sage-100 px-5 py-3 text-sm text-sage-600">
            Online payments aren't available. Contact {client.clinician_name} to pay.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Invoices" />
        {invoices.isLoading && <SectionSpinner />}
        {invoices.isError && <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} />}
        {invoices.isSuccess && invoices.data.length === 0 && <EmptyState title="No invoices yet" />}
        {invoices.isSuccess && invoices.data.length > 0 && (
          <ul className="divide-y divide-sage-100">
            {invoices.data.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
                    {invoice.number}
                    <InvoiceStatusBadge invoice={invoice} today={today} />
                    {invoice.disputed_at && <Badge tone="warning">In dispute</Badge>}
                  </p>
                  <p className="text-sm text-sage-600">
                    Issued {formatPlainDate(invoice.issued_on)}
                    {invoice.status === 'open' && ` · due ${formatPlainDate(invoice.due_on)}`}
                  </p>
                  {invoice.bill_to_name && <p className="text-sm text-sage-600">Billed to {invoice.bill_to_name}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-2 text-right text-sm">
                    <span className="block font-semibold tabular-nums text-sage-900">
                      {formatMoney(invoice.status === 'open' ? invoice.balance_cents : invoice.total_cents)}
                    </span>
                    {invoice.status === 'open' && invoice.paid_cents > 0 && (
                      <span className="block text-xs text-sage-500">of {formatMoney(invoice.total_cents)}</span>
                    )}
                  </span>
                  <PdfButton
                    download={() => portalBillingApi.downloadInvoicePdf(invoice.id)}
                    accessibleLabel={`Download ${invoice.number} as PDF`}
                  />
                  {canPayOnline && invoice.status === 'open' && invoice.balance_cents >= MIN_CARD_CHARGE_CENTS && (
                    <Button size="sm" onClick={() => payInvoice(invoice)} aria-label={`Pay ${invoice.number}`}>
                      Pay
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Payment history" />
        {payments.isLoading && <SectionSpinner />}
        {payments.isError && <ErrorState error={payments.error} onRetry={() => payments.refetch()} />}
        {payments.isSuccess && payments.data.length === 0 && <EmptyState title="No payments yet" />}
        {payments.isSuccess && payments.data.length > 0 && (
          <ul className="divide-y divide-sage-100">
            {payments.data.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-sage-900">
                    {formatDate(payment.received_at ?? payment.created_at, client.time_zone)}
                  </p>
                  <p className="text-xs text-sage-500">
                    {payment.method === 'card' && payment.reference ? payment.reference : PAYMENT_METHOD_LABELS[payment.method]}
                    {payment.refunded_cents > 0 && ` · ${formatMoney(payment.refunded_cents)} refunded`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <PaymentStatusBadge status={payment.status} />
                  <span className="font-medium tabular-nums text-sage-900">{formatMoney(payment.amount_cents)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canPayOnline && <SavedCards />}

      <Card>
        <CardHeader
          title="Superbills"
          description="Statements you can submit to your insurance company for out-of-network reimbursement."
        />
        {superbills.isLoading && <SectionSpinner />}
        {superbills.isError && <ErrorState error={superbills.error} onRetry={() => superbills.refetch()} />}
        {superbills.isSuccess && superbills.data.length === 0 && (
          <EmptyState icon={<FileCheck2 />} title="No superbills yet" description={`Ask ${client.clinician_name} if you need one.`} />
        )}
        {superbills.isSuccess && superbills.data.length > 0 && (
          <ul className="divide-y divide-sage-100">
            {superbills.data.map((superbill) => (
              <li key={superbill.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-sage-900">{superbill.number}</p>
                  <p className="text-sm text-sage-600">
                    {formatPlainDate(superbill.period_start)} – {formatPlainDate(superbill.period_end)} ·{' '}
                    <span className="tabular-nums">{formatMoney(superbill.total_cents)}</span>
                  </p>
                </div>
                <PdfButton
                  download={() => portalBillingApi.downloadSuperbillPdf(superbill.id)}
                  accessibleLabel={`Download ${superbill.number} as PDF`}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {payTarget && (
        <PayModal
          target={payTarget.target}
          invoiceNumber={payTarget.invoiceNumber}
          hasSavedCard={summary.default_card !== null}
          onClose={() => setPayTarget(null)}
        />
      )}
    </>
  );
}

function SavedCards() {
  const client = usePortalClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const today = todayInZone(client.time_zone);
  const [redirecting, setRedirecting] = useState(false);
  const cards = useQuery({ queryKey: portalBillingKeys.cards, queryFn: portalBillingApi.cards });

  const addCard = useMutation({
    mutationFn: portalBillingApi.setupCard,
    onSuccess: ({ url }) => {
      setRedirecting(true);
      window.location.assign(url);
    },
    onError: (error) => toast.error(error),
  });

  const makeDefault = useMutation({
    mutationFn: portalBillingApi.makeDefaultCard,
    onSuccess: async (updated) => {
      queryClient.setQueryData(portalBillingKeys.cards, updated);
      const card = updated.find((c) => c.is_default);
      if (card) toast.success(`${cardLabel(card)} is now your default card.`);
      await queryClient.invalidateQueries({ queryKey: portalBillingKeys.all });
    },
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <CardHeader
        title="Saved cards"
        description={`Your default card is used for AutoPay and when ${client.practice_name} charges your card.`}
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="h-4 w-4" />}
            loading={addCard.isPending || redirecting}
            onClick={() => !addCard.isPending && !redirecting && addCard.mutate()}
          >
            Add a card
          </Button>
        }
      />
      <CardBody>
        {cards.isLoading && <SectionSpinner />}
        {cards.isError && <ErrorState error={cards.error} onRetry={() => cards.refetch()} />}
        {cards.isSuccess && cards.data.length === 0 && (
          <div className="flex items-center gap-3 text-sm text-sage-600">
            <CreditCard className="h-5 w-5 shrink-0 text-sage-400" aria-hidden="true" />
            No saved cards. Add one to pay faster, or tick "Save card" when you pay.
          </div>
        )}
        {cards.isSuccess && cards.data.length > 0 && (
          <>
            <ul className="space-y-3">
              {cards.data.map((card) => (
                <li key={card.id} className="rounded-lg border border-sage-100 px-3 py-2.5">
                  <CardSummary card={card} today={today}>
                    {!card.is_default && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={makeDefault.isPending && makeDefault.variables === card.id}
                        disabled={makeDefault.isPending}
                        onClick={() => makeDefault.mutate(card.id)}
                        aria-label={`Make ${cardLabel(card)} your default card`}
                      >
                        Make default
                      </Button>
                    )}
                  </CardSummary>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-sage-500">To remove a card, ask {client.clinician_name}.</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
