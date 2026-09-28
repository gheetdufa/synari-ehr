import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { meApi, meKeys, type StaffPreferences } from '../../api/me';
import { practiceApi, practiceKeys, type PracticeSettings } from '../../api/practice';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { useToast } from '../../ui/Toast';
import { changedFields, fieldErrors } from '../clients/formUtils';
import { pick } from './settingsHelpers';
import { useDraft } from './useDraft';

/** Shown instead of the save bar on practice-wide settings the signed-in person can't change. */
export const READ_ONLY_NOTE = 'Only team members who manage the practice can change these settings.';

/**
 * Card wrapper for a settings form with an unsaved-changes footer and a Save button. With
 * `readOnly`, every control is disabled and the footer explains why.
 */
export function SettingsForm({
  title,
  description,
  dirty,
  saving,
  readOnly = false,
  onSubmit,
  onDiscard,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  dirty: boolean;
  saving: boolean;
  readOnly?: boolean;
  onSubmit: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!readOnly) onSubmit();
  };
  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader title={title} description={description} />
        <fieldset disabled={readOnly} className="min-w-0">
          <CardBody className="space-y-5">{children}</CardBody>
        </fieldset>
        {readOnly ? (
          <p className="flex items-center gap-2 rounded-b-xl border-t border-sage-100 bg-sage-50/60 px-5 py-3 text-sm text-sage-600">
            <Lock className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
            {READ_ONLY_NOTE}
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-sage-100 bg-sage-50/60 px-5 py-3">
            <p className="mr-auto text-sm" aria-live="polite">
              {dirty ? (
                <span className="flex items-center gap-2 font-medium text-amber-700">
                  <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" /> Unsaved changes
                </span>
              ) : (
                <span className="text-sage-500">All changes saved</span>
              )}
            </p>
            <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
              Discard
            </Button>
            <Button type="submit" loading={saving} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

/** PATCH practice-wide settings and put the result in the cache. */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<PracticeSettings>) => practiceApi.updateSettings(changes),
    onSuccess: (settings) => queryClient.setQueryData(practiceKeys.settings, settings),
  });
}

/** PATCH the signed-in person's own preferences and put the result in the cache. */
export function useSavePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<StaffPreferences>) => meApi.updatePreferences(changes),
    onSuccess: (preferences) => queryClient.setQueryData(meKeys.preferences, preferences),
  });
}

/**
 * Draft + save for some fields of a settings object. Saving sends only the changed keys; server
 * validation errors come back keyed by field name.
 */
function useFieldsForm<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
  save: UseMutationResult<T, Error, Partial<T>>,
  successMessage: string,
) {
  const toast = useToast();
  const form = useDraft<Pick<T, K>>(pick(source, keys));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (validate?: (draft: Pick<T, K>) => Record<string, string>) => {
    const found = validate ? validate(form.draft) : {};
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = changedFields(source, form.draft as Partial<T>);
    if (Object.keys(changes).length === 0) return;
    save.mutate(changes, {
      onSuccess: () => toast.success(successMessage),
      onError: (error) => {
        const serverErrors = fieldErrors(error);
        if (Object.keys(serverErrors).length > 0) setErrors(serverErrors);
        else toast.error(error);
      },
    });
  };

  const discard = () => {
    setErrors({});
    form.discard();
  };

  return { ...form, discard, errors, saving: save.isPending, submit };
}

/** A form over some practice-wide settings (PATCH /practice/settings). */
export function usePracticeSettingsForm<K extends keyof PracticeSettings>(
  settings: PracticeSettings,
  keys: readonly K[],
  successMessage = 'Settings saved',
) {
  return useFieldsForm(settings, keys, useSaveSettings(), successMessage);
}

/** A form over some of the signed-in person's own preferences (PATCH /me/preferences). */
export function usePreferencesForm<K extends keyof StaffPreferences>(
  preferences: StaffPreferences,
  keys: readonly K[],
  successMessage = 'Preferences saved',
) {
  return useFieldsForm(preferences, keys, useSavePreferences(), successMessage);
}
