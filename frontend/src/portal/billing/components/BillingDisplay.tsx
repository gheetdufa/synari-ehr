import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CreditCard, Download } from 'lucide-react';
import {
  INVOICE_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  cardExpiry,
  cardLabel,
  invoiceDisplayStatus,
  isCardExpired,
  type Invoice,
  type InvoiceDisplayStatus,
  type PaymentStatus,
  type SavedCard,
} from '../../../api/billing';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Display';
import { Input } from '../../../ui/Form';
import { useToast } from '../../../ui/Toast';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const INVOICE_TONES: Record<InvoiceDisplayStatus, Tone> = {
  open: 'warning',
  partial: 'info',
  overdue: 'danger',
  paid: 'success',
  void: 'neutral',
};

const PAYMENT_TONES: Record<PaymentStatus, Tone> = {
  pending: 'info',
  succeeded: 'success',
  failed: 'danger',
  refunded: 'neutral',
  partially_refunded: 'warning',
};

export function InvoiceStatusBadge({
  invoice,
  today,
}: {
  invoice: Pick<Invoice, 'status' | 'due_on' | 'paid_cents'>;
  today: string;
}) {
  const status = invoiceDisplayStatus(invoice, today);
  return <Badge tone={INVOICE_TONES[status]}>{INVOICE_STATUS_LABELS[status]}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={PAYMENT_TONES[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

/** Brand, last four digits, expiry and default/expired badges for a saved card. */
export function CardSummary({ card, today, children }: { card: SavedCard; today: string; children?: ReactNode }) {
  const expired = isCardExpired(card, today);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="inline-flex h-9 w-12 shrink-0 items-center justify-center rounded-md border border-sage-200 bg-sage-50 text-sage-600">
        <CreditCard className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-sage-900">
          {cardLabel(card)}
          {card.is_default && <Badge tone="primary">Default</Badge>}
          {expired && <Badge tone="danger">Expired</Badge>}
        </p>
        <p className="text-xs text-sage-500">Expires {cardExpiry(card)}</p>
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/** Dollar amount input with a "$" prefix and a decimal keypad on phones. */
export function MoneyInput({ className = '', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <div className={`relative ${className}`}>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-sage-500">
        $
      </span>
      <Input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" className="pl-7 tabular-nums" {...rest} />
    </div>
  );
}

/** A headline number on a billing overview; clickable when `onClick` is given. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  onClick,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'attention';
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-sage-600">{label}</span>
        {icon && <span className="text-primary-600 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${
          tone === 'attention' ? 'text-amber-700' : 'text-sage-900'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-sage-500">{hint}</p>}
    </>
  );
  const classes = 'rounded-xl border border-sage-100 bg-white p-4 text-left shadow-sm';
  if (!onClick) return <div className={classes}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${classes} transition-colors hover:border-primary-200 hover:bg-primary-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400`}
    >
      {body}
    </button>
  );
}

/** Downloads a PDF, showing progress and reporting failures as a toast. */
export function PdfButton({
  download,
  label = 'PDF',
  accessibleLabel,
  variant = 'secondary',
}: {
  download: () => Promise<void>;
  label?: string;
  accessibleLabel?: string;
  variant?: 'secondary' | 'ghost';
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    setLoading(true);
    try {
      await download();
    } catch (error) {
      toast.error(error);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={variant}
      loading={loading}
      icon={<Download className="h-4 w-4" />}
      onClick={onClick}
      aria-label={accessibleLabel}
    >
      {label}
    </Button>
  );
}

/** A label/value pair in a definition list. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-sage-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-sage-900">{children}</dd>
    </div>
  );
}
