import type { ClientDetail } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { formatPlainDate } from '../../lib/format';
import { Checkbox, Field, Input, Select } from '../../ui/Form';
import { timeZoneLabel, timeZoneOptions } from '../settings/timeZones';
import { ageOn, todayIn } from './clientHelpers';
import { useClientPermissions } from './clientPermissions';
import { DetailList, EditableSection, type SectionUpdate } from './EditableSection';
import { blankToNull, isValidEmail } from './formUtils';

const SEX_OPTIONS = ['Female', 'Male', 'Intersex', 'Unknown'];
const PRONOUN_SUGGESTIONS = ['she/her', 'he/him', 'they/them', 'she/they', 'he/they'];

interface PersonalDraft {
  first_name: string;
  last_name: string;
  preferred_name: string;
  pronouns: string;
  date_of_birth: string;
  sex: string;
  gender_identity: string;
  is_minor: boolean;
  referral_source: string;
}

export function personalUpdate(draft: PersonalDraft, today: string): SectionUpdate {
  const errors: Record<string, string> = {};
  if (!draft.first_name.trim()) errors.first_name = 'Enter a first name';
  if (!draft.last_name.trim()) errors.last_name = 'Enter a last name';
  if (draft.date_of_birth && (draft.date_of_birth > today || draft.date_of_birth < '1900-01-01')) {
    errors.date_of_birth = 'Enter a valid date of birth';
  }
  return {
    errors,
    update: {
      first_name: draft.first_name.trim(),
      last_name: draft.last_name.trim(),
      preferred_name: draft.preferred_name.trim(),
      pronouns: draft.pronouns.trim(),
      date_of_birth: draft.date_of_birth || null,
      sex: draft.sex,
      gender_identity: draft.gender_identity.trim(),
      is_minor: draft.is_minor,
      referral_source: draft.referral_source.trim(),
    },
  };
}

export function PersonalSection({ client }: { client: ClientDetail }) {
  const { staff } = useSession();
  const { editProfile } = useClientPermissions(client);
  const today = todayIn(staff.time_zone);
  const sexOptions = client.sex && !SEX_OPTIONS.includes(client.sex) ? [client.sex, ...SEX_OPTIONS] : SEX_OPTIONS;
  return (
    <EditableSection<PersonalDraft>
      title="Personal"
      editable={editProfile}
      client={client}
      toDraft={(c) => ({
        first_name: c.first_name,
        last_name: c.last_name,
        preferred_name: c.preferred_name,
        pronouns: c.pronouns,
        date_of_birth: c.date_of_birth ?? '',
        sex: c.sex,
        gender_identity: c.gender_identity,
        is_minor: c.is_minor,
        referral_source: c.referral_source,
      })}
      toUpdate={(draft) => personalUpdate(draft, today)}
      view={
        <DetailList
          items={[
            { label: 'Legal name', value: `${client.first_name} ${client.last_name}` },
            { label: 'Preferred name', value: client.preferred_name },
            { label: 'Pronouns', value: client.pronouns },
            {
              label: 'Date of birth',
              value: client.date_of_birth
                ? `${formatPlainDate(client.date_of_birth)} (age ${ageOn(client.date_of_birth, today)})`
                : '',
            },
            { label: 'Sex', value: client.sex },
            { label: 'Gender identity', value: client.gender_identity },
            { label: 'Minor', value: client.is_minor ? 'Yes' : 'No' },
            { label: 'Referral source', value: client.referral_source },
          ]}
        />
      }
    >
      {({ draft, set, errors }) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal first name" required error={errors.first_name}>
            {(props) => <Input {...props} value={draft.first_name} onChange={(e) => set({ first_name: e.target.value })} />}
          </Field>
          <Field label="Legal last name" required error={errors.last_name}>
            {(props) => <Input {...props} value={draft.last_name} onChange={(e) => set({ last_name: e.target.value })} />}
          </Field>
          <Field label="Preferred name" error={errors.preferred_name}>
            {(props) => (
              <Input {...props} value={draft.preferred_name} onChange={(e) => set({ preferred_name: e.target.value })} />
            )}
          </Field>
          <Field label="Pronouns" error={errors.pronouns}>
            {(props) => (
              <>
                <Input
                  {...props}
                  list="pronoun-suggestions"
                  value={draft.pronouns}
                  onChange={(e) => set({ pronouns: e.target.value })}
                />
                <datalist id="pronoun-suggestions">
                  {PRONOUN_SUGGESTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Date of birth" error={errors.date_of_birth}>
            {(props) => (
              <Input
                {...props}
                type="date"
                max={today}
                value={draft.date_of_birth}
                onChange={(e) => set({ date_of_birth: e.target.value })}
              />
            )}
          </Field>
          <Field label="Sex" error={errors.sex}>
            {(props) => (
              <Select {...props} value={draft.sex} onChange={(e) => set({ sex: e.target.value })}>
                <option value="">Not specified</option>
                {sexOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Gender identity" error={errors.gender_identity}>
            {(props) => (
              <Input {...props} value={draft.gender_identity} onChange={(e) => set({ gender_identity: e.target.value })} />
            )}
          </Field>
          <Field label="Referral source" error={errors.referral_source}>
            {(props) => (
              <Input {...props} value={draft.referral_source} onChange={(e) => set({ referral_source: e.target.value })} />
            )}
          </Field>
          <Checkbox
            className="sm:col-span-2"
            label="Client is a minor"
            description="Add their parents or guardians under Contacts; guardians with portal access sign in with their own email."
            checked={draft.is_minor}
            onChange={(e) => set({ is_minor: e.target.checked })}
          />
        </div>
      )}
    </EditableSection>
  );
}

interface ContactDraft {
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  time_zone: string;
}

export function contactUpdate(draft: ContactDraft): SectionUpdate {
  const errors: Record<string, string> = {};
  if (draft.email.trim() && !isValidEmail(draft.email)) errors.email = 'Enter a valid email address';
  return {
    errors,
    update: {
      email: blankToNull(draft.email)?.toLowerCase() ?? null,
      phone: draft.phone.trim(),
      address_line1: draft.address_line1.trim(),
      address_line2: draft.address_line2.trim(),
      city: draft.city.trim(),
      state: draft.state.trim(),
      postal_code: draft.postal_code.trim(),
      time_zone: draft.time_zone || null,
    },
  };
}

function formatAddress(client: ClientDetail): string {
  const cityLine = [client.city, [client.state, client.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [client.address_line1, client.address_line2, cityLine].filter(Boolean).join('\n');
}

const DEFAULT_ZONE_LABEL = "Their clinician's time zone";

export function ContactSection({ client }: { client: ClientDetail }) {
  const { editProfile } = useClientPermissions(client);
  return (
    <EditableSection<ContactDraft>
      title="Contact information"
      editable={editProfile}
      client={client}
      toDraft={(c) => ({
        email: c.email ?? '',
        phone: c.phone,
        address_line1: c.address_line1,
        address_line2: c.address_line2,
        city: c.city,
        state: c.state,
        postal_code: c.postal_code,
        time_zone: c.time_zone ?? '',
      })}
      toUpdate={contactUpdate}
      view={
        <DetailList
          items={[
            { label: 'Email', value: client.email },
            { label: 'Phone', value: client.phone },
            { label: 'Address', value: <span className="whitespace-pre-line">{formatAddress(client)}</span>, wide: true },
            {
              label: 'Time zone',
              value: client.time_zone ? timeZoneLabel(client.time_zone) : DEFAULT_ZONE_LABEL,
            },
          ]}
        />
      }
    >
      {({ draft, set, errors }) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={errors.email} hint="Used for portal sign-in, reminders and invoices">
            {(props) => (
              <Input {...props} type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} />
            )}
          </Field>
          <Field label="Phone" error={errors.phone}>
            {(props) => <Input {...props} type="tel" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />}
          </Field>
          <Field label="Address line 1" error={errors.address_line1}>
            {(props) => (
              <Input {...props} value={draft.address_line1} onChange={(e) => set({ address_line1: e.target.value })} />
            )}
          </Field>
          <Field label="Address line 2" error={errors.address_line2}>
            {(props) => (
              <Input {...props} value={draft.address_line2} onChange={(e) => set({ address_line2: e.target.value })} />
            )}
          </Field>
          <Field label="City" error={errors.city}>
            {(props) => <Input {...props} value={draft.city} onChange={(e) => set({ city: e.target.value })} />}
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="State" error={errors.state}>
              {(props) => <Input {...props} value={draft.state} onChange={(e) => set({ state: e.target.value })} />}
            </Field>
            <Field label="ZIP" error={errors.postal_code}>
              {(props) => (
                <Input {...props} value={draft.postal_code} onChange={(e) => set({ postal_code: e.target.value })} />
              )}
            </Field>
          </div>
          <Field
            label="Time zone"
            error={errors.time_zone}
            hint="Reminders and portal times use this zone"
            className="sm:col-span-2"
          >
            {(props) => (
              <Select {...props} value={draft.time_zone} onChange={(e) => set({ time_zone: e.target.value })}>
                <option value="">{DEFAULT_ZONE_LABEL}</option>
                {timeZoneOptions(client.time_zone).map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </EditableSection>
  );
}
