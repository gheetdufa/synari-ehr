import { Video } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../../ui/Card';

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-sage-900 px-4 py-3 text-xs leading-relaxed text-sage-50">
      <code>{children}</code>
    </pre>
  );
}

/** Shown until the server has LiveKit settings: how to turn video sessions on. */
export function TelehealthSetup() {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Video className="h-5 w-5 text-primary-600" /> Set up video sessions
          </span>
        }
        description="Synari runs video on LiveKit, an open-source video server. Add its settings to the API and this page will list your video appointments."
      />
      <CardBody className="space-y-6 text-sm text-sage-700">
        <section>
          <h3 className="font-semibold text-sage-900">1. Run a LiveKit server</h3>
          <p className="mt-1">
            For local development, start the dev server that ships with Synari (it listens on ws://localhost:7880 with the
            key <code className="rounded bg-sage-100 px-1">devkey</code> and secret{' '}
            <code className="rounded bg-sage-100 px-1">secret</code>):
          </p>
          <Code>docker compose up livekit</Code>
          <p className="mt-2">
            For production, create a project on LiveKit Cloud or host LiveKit yourself. Use its secure{' '}
            <code className="rounded bg-sage-100 px-1">wss://</code> address.
          </p>
        </section>
        <section>
          <h3 className="font-semibold text-sage-900">2. Add the settings to the API&apos;s environment</h3>
          <p className="mt-1">
            In <code className="rounded bg-sage-100 px-1">backend/.env</code> (or your host&apos;s environment variables):
          </p>
          <Code>{`LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
FRONTEND_URL=https://app.example.com   # where join links should point`}</Code>
        </section>
        <section>
          <h3 className="font-semibold text-sage-900">3. Restart the API</h3>
          <p className="mt-1">
            Reload this page afterwards. Clients join from the link in their reminder or from the client portal, without
            an account, and wait in your waiting room until you admit them.
          </p>
        </section>
      </CardBody>
    </Card>
  );
}
