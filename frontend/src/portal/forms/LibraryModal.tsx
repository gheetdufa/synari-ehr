import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { FORM_KIND_LABELS, formKeys, formsApi, type LibraryForm, type TemplateSummary } from '../../api/forms';
import { Button } from '../../ui/Button';
import { Badge, ErrorState } from '../../ui/Display';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';

/** Built-in forms (intake, consents, PHQ-9, GAD-7) that can be added to the practice's templates. */
export function LibraryModal({
  open,
  onClose,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  templates: TemplateSummary[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const library = useQuery({ queryKey: formKeys.library, queryFn: formsApi.library, enabled: open, staleTime: Infinity });

  const add = useMutation({
    mutationFn: (entry: LibraryForm) => formsApi.addFromLibrary(entry.key),
    onSuccess: (template, entry) => {
      queryClient.setQueryData(formKeys.template(template.id), template);
      void queryClient.invalidateQueries({ queryKey: formKeys.templates });
      setAdded((current) => new Set(current).add(entry.key));
      toast.success(`${template.name} added to your forms`);
    },
    onError: (error) => toast.error(error),
  });

  const inPractice = new Set(templates.map((template) => template.library_key).filter(Boolean));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Add from library"
      description="Ready-made forms you can send as they are or adjust to your practice."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {library.isPending && open && <SectionSpinner />}
      {library.error && <ErrorState error={library.error} onRetry={() => void library.refetch()} />}
      {library.data && (
        <ul className="divide-y divide-sage-100">
          {library.data.map((entry) => {
            const justAdded = added.has(entry.key);
            const already = inPractice.has(entry.key);
            const adding = add.isPending && add.variables?.key === entry.key;
            return (
              <li key={entry.key} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-sage-900">{entry.name}</p>
                    <Badge tone="primary">{FORM_KIND_LABELS[entry.kind]}</Badge>
                    {already && !justAdded && <Badge>In your forms</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-3 text-sm text-sage-600">{entry.description}</p>
                </div>
                <Button
                  size="sm"
                  variant={justAdded ? 'ghost' : 'secondary'}
                  icon={justAdded ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  loading={adding}
                  disabled={add.isPending && !adding}
                  onClick={() => add.mutate(entry)}
                  aria-label={`${already || justAdded ? 'Add another copy of' : 'Add'} ${entry.name}`}
                  className="shrink-0 self-start"
                >
                  {justAdded ? 'Added' : already ? 'Add another copy' : 'Add'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
