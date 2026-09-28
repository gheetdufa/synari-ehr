import type { Payment, SavedCard, Superbill } from '../../api/billing';
import type { ClientRef } from '../../api/clients';
import { ChargeCardModal } from './ChargeCardModal';
import { GenerateSuperbillModal } from './GenerateSuperbillModal';
import { InvoiceDetailModal } from './InvoiceDetailModal';
import { NewInvoiceModal } from './NewInvoiceModal';
import { RecordPaymentModal } from './RecordPaymentModal';
import { RefundModal } from './RefundModal';
import { SuperbillDetailModal } from './SuperbillDetailModal';

/** The one billing dialog open at a time (dialogs never stack). */
export type BillingDialog =
  | { kind: 'invoice'; invoiceId: number }
  | { kind: 'newInvoice'; client?: ClientRef; initialClient?: ClientRef; participantIds?: number[] }
  | { kind: 'recordPayment'; client?: ClientRef; invoiceId?: number }
  | { kind: 'refund'; payment: Payment }
  | { kind: 'superbill'; client?: ClientRef }
  | { kind: 'viewSuperbill'; superbill: Superbill }
  | { kind: 'charge'; client: ClientRef; cards: SavedCard[]; balanceCents: number };

/** Renders the open billing dialog and lets dialogs hand off to each other. */
export function BillingDialogs({
  dialog,
  onChange,
}: {
  dialog: BillingDialog | null;
  onChange: (next: BillingDialog | null) => void;
}) {
  if (!dialog) return null;
  const close = () => onChange(null);
  switch (dialog.kind) {
    case 'invoice':
      return (
        <InvoiceDetailModal
          key={dialog.invoiceId}
          invoiceId={dialog.invoiceId}
          onClose={close}
          onRecordPayment={(invoice) => onChange({ kind: 'recordPayment', client: invoice.client, invoiceId: invoice.id })}
        />
      );
    case 'newInvoice':
      return (
        <NewInvoiceModal
          fixedClient={dialog.client}
          initialClient={dialog.initialClient}
          initialParticipantIds={dialog.participantIds}
          onClose={close}
          onCreated={(invoice) => onChange({ kind: 'invoice', invoiceId: invoice.id })}
        />
      );
    case 'recordPayment':
      return <RecordPaymentModal fixedClient={dialog.client} initialInvoiceId={dialog.invoiceId} onClose={close} />;
    case 'refund':
      return <RefundModal payment={dialog.payment} onClose={close} />;
    case 'superbill':
      return (
        <GenerateSuperbillModal
          fixedClient={dialog.client}
          onClose={close}
          onView={(superbill) => onChange({ kind: 'viewSuperbill', superbill })}
        />
      );
    case 'viewSuperbill':
      return <SuperbillDetailModal superbill={dialog.superbill} onClose={close} />;
    case 'charge':
      return <ChargeCardModal client={dialog.client} cards={dialog.cards} balanceCents={dialog.balanceCents} onClose={close} />;
  }
}
