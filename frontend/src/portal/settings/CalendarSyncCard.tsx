import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarSync, Copy } from 'lucide-react';
import { calendarFeedApi, meKeys } from '../../api/me';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge } from '../../ui/Display';
import { Input } from '../../ui/Form';
import { ConfirmDialog } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';

/** Private ICS subscription so appointments show up in Apple Calendar or any other calendar app. */
export function CalendarSyncCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: meKeys.calendarFeed, queryFn: calendarFeedApi.status });
  const [url, setUrl] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: meKeys.calendarFeed });

  const create = useMutation({
    mutationFn: calendarFeedApi.create,
    onSuccess: (data) => {
      setUrl(data.url);
      void refresh();
    },
    onError: (error) => toast.error(error),
  });
  const remove = useMutation({
    mutationFn: calendarFeedApi.remove,
    onSuccess: () => {
      setUrl(null);
      setConfirmOff(false);
      void refresh();
      toast.success('The subscription link is off. The old link no longer works.');
    },
    onError: (error) => toast.error(error),
  });
  const enabled = status.data?.enabled ?? false;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Calendar subscription link {enabled && <Badge tone="success">On</Badge>}
          </span>
        }
        description="Or subscribe to your schedule from any calendar app, such as Apple Calendar. It shows times only, never client names, and updates when the app refreshes it."
      />
      <CardBody className="space-y-3">
        {url && (
          <>
            <Alert tone="warning">Copy this link now; it's shown only once. Anyone with it can see your appointment times.</Alert>
            <div className="flex gap-2">
              <Input readOnly value={url} aria-label="Calendar subscription link" onFocus={(e) => e.target.select()} />
              <Button
                variant="secondary"
                icon={<Copy className="h-4 w-4" />}
                onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success('Link copied'))}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-sage-500">In Google Calendar: Other calendars → From URL. In Apple Calendar: File → New Calendar Subscription.</p>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button icon={<CalendarSync className="h-4 w-4" />} loading={create.isPending} onClick={() => create.mutate()}>
            {enabled ? 'Create a new link' : 'Create a subscription link'}
          </Button>
          {enabled && (
            <Button variant="ghost" onClick={() => setConfirmOff(true)}>
              Turn off
            </Button>
          )}
        </div>
        {enabled && !url && <p className="text-xs text-sage-500">Creating a new link stops the old one from working.</p>}
      </CardBody>
      <ConfirmDialog
        open={confirmOff}
        title="Turn off the subscription link?"
        message="Subscribed calendars will stop updating."
        confirmLabel="Turn off"
        danger
        loading={remove.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}
