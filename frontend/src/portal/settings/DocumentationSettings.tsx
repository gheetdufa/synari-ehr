import { Sparkles } from 'lucide-react';
import type { NoteFormatId, StaffPreferences } from '../../api/me';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Alert } from '../../ui/Display';
import { Field, Select, Textarea } from '../../ui/Form';
import { SettingsForm, usePreferencesForm } from './SettingsForm';

const KEYS = ['note_format_default', 'ai_style_instructions'] as const;

export const NOTE_FORMATS: { id: NoteFormatId; label: string }[] = [
  { id: 'SOAP', label: 'SOAP: Subjective, Objective, Assessment, Plan' },
  { id: 'DAP', label: 'DAP: Data, Assessment, Plan' },
  { id: 'BIRP', label: 'BIRP: Behavior, Intervention, Response, Plan' },
  { id: 'GIRP', label: 'GIRP: Goals, Intervention, Response, Plan' },
  { id: 'PIRP', label: 'PIRP: Problem, Intervention, Response, Plan' },
  { id: 'SIRP', label: 'SIRP: Situation, Intervention, Response, Plan' },
  { id: 'FREEFORM', label: 'Free-form narrative' },
];

/** Your default progress-note format and the style guidance the AI note drafter follows for you. */
export function DocumentationSettings({ preferences }: { preferences: StaffPreferences }) {
  const config = usePublicConfig();
  const form = usePreferencesForm(preferences, KEYS, 'Documentation preferences saved');
  const { draft, set, errors } = form;

  return (
    <SettingsForm
      title="Documentation"
      description="Your defaults for new progress notes. Everyone on the team sets their own."
      dirty={form.dirty}
      saving={form.saving}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      <Field label="Default note format" error={errors.note_format_default} className="sm:max-w-md">
        {(props) => (
          <Select
            {...props}
            value={draft.note_format_default}
            onChange={(e) => set({ note_format_default: e.target.value as NoteFormatId })}
          >
            {NOTE_FORMATS.map((format) => (
              <option key={format.id} value={format.id}>
                {format.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="space-y-4 border-t border-sage-100 pt-5">
        {config.ai_enabled ? (
          <div className="flex items-start gap-3 rounded-lg border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" aria-hidden="true" />
            <p>
              <span className="font-semibold">AI note drafting is available.</span> Clinical content (your session
              notes, transcripts and these instructions) is sent to the AI provider configured on this server only
              when you use an AI feature. Nothing is sent otherwise, and every draft needs your review and signature.
            </p>
          </div>
        ) : (
          <Alert tone="neutral" title="AI features are off on this server">
            No clinical content is sent to any AI provider. An administrator can enable AI drafting by configuring a
            provider API key for the server; your instructions below are saved for when it&apos;s on.
          </Alert>
        )}
        <Field
          label="AI writing style"
          hint="How you like notes written: tone, tense, length, terms to use or avoid. Don't include client information."
          error={errors.ai_style_instructions}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={6}
              maxLength={20000}
              value={draft.ai_style_instructions}
              placeholder="Write in third person, past tense. Keep each section to 2–4 sentences. Use person-first language."
              onChange={(e) => set({ ai_style_instructions: e.target.value })}
            />
          )}
        </Field>
      </div>
    </SettingsForm>
  );
}
