import { ConfirmDialog } from '../../ui/Modal';

/** Confirmation before removing one of your own messages. */
export function RemoveMessageDialog({
  open,
  loading,
  otherName,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  loading: boolean;
  otherName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Remove this message?"
      message={`The message and any attached files will be replaced with “Message removed” for you and ${otherName}. This can't be undone.`}
      confirmLabel="Remove message"
      danger
      loading={loading}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
