import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import { fileKeys, filesApi, uploadErrorMessage, uploadProblem } from '../../api/files';
import { FilePicker } from '../../shared/forms/FilePicker';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { portalAccessProblem } from './portalAccess';

/** Upload a document to the client's record and share it in their portal. */
export function ShareDocumentModal({ client, onClose }: { client: ClientDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accessProblem = portalAccessProblem(client);
  const name = client.preferred_name || client.first_name;

  const upload = useMutation({
    mutationFn: (chosen: File) => filesApi.share(client.id, chosen, notify && !accessProblem),
    onSuccess: (stored) => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.forClient(client.id) });
      toast.success(`${stored.filename} shared with ${name}`);
      onClose();
    },
    onError: (failure) => setError(uploadErrorMessage(failure)),
  });

  const choose = (chosen: File | null) => {
    setFile(chosen);
    setError(chosen ? uploadProblem(chosen) : null);
  };

  const submit = () => {
    if (!file) {
      setError('Choose a file to share');
      return;
    }
    const problem = uploadProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate(file);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Share a document"
      description={`The document is added to ${name}'s record and appears in their client portal.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<Upload className="h-4 w-4" />} loading={upload.isPending} onClick={submit}>
            Share document
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {accessProblem && (
          <Alert tone="warning" title="The client can't see shared documents yet">
            {accessProblem}
          </Alert>
        )}
        <FilePicker file={file} onChange={choose} error={error} disabled={upload.isPending} />
        {!accessProblem && (
          <Checkbox
            label={`Email ${name} that a document is ready`}
            description="The email has a sign-in link and never includes the document itself."
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
          />
        )}
      </div>
    </Modal>
  );
}
