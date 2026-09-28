import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { formKeys, formsApi, type FormKind, type FormTemplate } from '../../api/forms';
import { useCan, useSession } from '../../auth/StaffAuth';
import { MAX_TEMPLATE_NAME_LENGTH } from '../../shared/forms/fieldTypes';
import { useToast } from '../../ui/Toast';

/** Whether the signed-in staff member may change form templates: clinicians and practice managers. */
export function useCanEditTemplates(): boolean {
  const { staff } = useSession();
  const managesPractice = useCan('manage_practice');
  return staff.is_clinician || managesPractice;
}

export function copyName(name: string): string {
  return `Copy of ${name}`.slice(0, MAX_TEMPLATE_NAME_LENGTH);
}

/** Opens a template in the editor after caching it, so the editor renders straight away. */
function useOpenTemplate() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (template: FormTemplate) => {
    queryClient.setQueryData(formKeys.template(template.id), template);
    void queryClient.invalidateQueries({ queryKey: formKeys.templates });
    navigate(`/portal/forms/templates/${template.id}`);
  };
}

/** Create an editable copy of a template and open it. Scoring and flags aren't copied. */
export function useDuplicateTemplate() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const open = useOpenTemplate();
  return useMutation({
    mutationFn: async (templateId: number) => {
      const source = await queryClient.fetchQuery({
        queryKey: formKeys.template(templateId),
        queryFn: () => formsApi.template(templateId),
      });
      const copy = await formsApi.createTemplate({
        kind: source.kind,
        name: copyName(source.name),
        description: source.description,
        fields: source.fields,
        requires_signature: source.requires_signature,
      });
      return { source, copy };
    },
    onSuccess: ({ source, copy }) => {
      toast.success(
        source.scoring
          ? "Copy created. Automatic scoring and flags don't carry over to copies, so review responses yourself."
          : 'Copy created',
      );
      open(copy);
    },
    onError: (error) => toast.error(error),
  });
}

/** Create a new template with a single heading, then open it in the editor. */
export function useCreateTemplate() {
  const toast = useToast();
  const open = useOpenTemplate();
  return useMutation({
    mutationFn: (input: { kind: FormKind; name: string }) =>
      formsApi.createTemplate({
        kind: input.kind,
        name: input.name.trim(),
        description: '',
        requires_signature: input.kind === 'consent',
        fields: [{ id: 'new_section', type: 'heading', label: 'New section' }],
      }),
    onSuccess: open,
    onError: (error) => toast.error(error),
  });
}
