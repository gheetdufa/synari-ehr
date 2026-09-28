import { Alert } from '../../../ui/Display';

/** Explains that card features need Stripe and how a self-hosted practice turns it on. */
export function StripeSetupNotice() {
  return (
    <Alert tone="neutral" title="Online card payments are off">
      Cash, check and other payments you record work as usual. To let clients pay by card, save cards and use AutoPay, add{' '}
      <code className="rounded bg-white px-1 text-xs">STRIPE_SECRET_KEY</code> and{' '}
      <code className="rounded bg-white px-1 text-xs">STRIPE_WEBHOOK_SECRET</code> to the server's environment (see{' '}
      <code className="rounded bg-white px-1 text-xs">backend/.env.example</code>) and restart it.
    </Alert>
  );
}
