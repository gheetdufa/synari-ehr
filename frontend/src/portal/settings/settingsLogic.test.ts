import { describe, expect, it } from 'vitest';
import type { AuditEvent, PracticeSettings, Service } from '../../api/practice';
import { testSession } from '../../test/session';
import { actorLabel, humanizeAction, resourceLabel } from './auditActions';
import {
  blocksFromRows,
  copyDay,
  newRow,
  serializeRows,
  suggestedRange,
  validateRows,
  weeklyHours,
} from './availabilityRules';
import { validateAwayMessage } from './MessagingSettings';
import { practiceDraft, practiceInput, validatePractice } from './PracticeDetailsSettings';
import { validateProfile } from './ProfileSettings';
import { validatePasswordChange } from './SecuritySettings';
import { serviceDraft, serviceInput } from './ServiceModal';
import { hoursLabel, isValidSlug, isValidTaxId, isValidTaxonomy, numberOptions, slugify } from './settingsHelpers';
import { settingsTabFrom, settingsTabsFor } from './settingsTabs';
import { timeZoneOptions } from './timeZones';
import { checklistItems } from './WelcomeChecklist';

describe('availability rules', () => {
  it('flags end-before-start, missing times and overlaps on the same day only', () => {
    const a = newRow(0, '09:00', '17:00', 'video');
    const b = newRow(0, '10:00', '11:00', 'video');
    const c = newRow(0, '12:00', '13:00', 'in_person');
    const d = newRow(1, '10:00', '11:00', 'video');
    const e = newRow(2, '15:00', '14:00', 'video');
    const f = newRow(3, '', '14:00', 'video');
    const errors = validateRows([a, b, c, d, e, f]);
    expect(errors[a.key]).toBeUndefined();
    expect(errors[b.key]).toMatch(/Overlaps/);
    expect(errors[c.key]).toMatch(/Overlaps/);
    expect(errors[d.key]).toBeUndefined();
    expect(errors[e.key]).toBe('End time must be after the start time');
    expect(errors[f.key]).toBe('Enter a start and end time');
  });

  it('allows back-to-back ranges', () => {
    expect(validateRows([newRow(4, '09:00', '12:00', 'video'), newRow(4, '12:00', '15:00', 'phone')])).toEqual({});
  });

  it('sends sorted, keyless blocks and ignores order when checking for changes', () => {
    const late = newRow(2, '13:00', '15:00', 'phone');
    const early = newRow(0, '09:00', '10:00', 'video');
    expect(blocksFromRows([late, early])).toEqual([
      { weekday: 0, start_time: '09:00', end_time: '10:00', location_type: 'video', location_id: null },
      { weekday: 2, start_time: '13:00', end_time: '15:00', location_type: 'phone', location_id: null },
    ]);
    expect(serializeRows([late, early])).toBe(serializeRows([{ ...early, key: 99 }, { ...late, key: 100 }]));
  });

  it('suggests 9-5 for an empty day and the next hour otherwise', () => {
    expect(suggestedRange([])).toEqual({ start_time: '09:00', end_time: '17:00' });
    expect(suggestedRange([newRow(0, '09:00', '12:00', 'video')])).toEqual({ start_time: '12:00', end_time: '13:00' });
    expect(suggestedRange([newRow(0, '20:00', '23:30', 'video')])).toEqual({ start_time: '09:00', end_time: '17:00' });
  });

  it('copies one day onto other days, replacing their ranges', () => {
    const rows = [newRow(0, '09:00', '12:00', 'video'), newRow(1, '14:00', '15:00', 'phone'), newRow(5, '10:00', '11:00', 'video')];
    const copied = copyDay(rows, 0, [0, 1, 2]);
    expect(blocksFromRows(copied)).toEqual([
      { weekday: 0, start_time: '09:00', end_time: '12:00', location_type: 'video', location_id: null },
      { weekday: 1, start_time: '09:00', end_time: '12:00', location_type: 'video', location_id: null },
      { weekday: 2, start_time: '09:00', end_time: '12:00', location_type: 'video', location_id: null },
      { weekday: 5, start_time: '10:00', end_time: '11:00', location_type: 'video', location_id: null },
    ]);
    expect(weeklyHours(copied)).toBe(10);
  });
});

describe('settings helpers', () => {
  it('slugifies names for booking links', () => {
    expect(slugify('Dr. Dana Lée, LCSW')).toBe('dr-dana-lee-lcsw');
    expect(slugify('  --Calm   Harbor Therapy-- ')).toBe('calm-harbor-therapy');
    expect(slugify('x'.repeat(100)).length).toBe(80);
  });

  it('matches the API slug rule', () => {
    expect(isValidSlug('dana-lee')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('-dana')).toBe(false);
    expect(isValidSlug('Dana')).toBe(false);
  });

  it('builds option lists that include the current value', () => {
    expect(numberOptions([24, 48, 72], 36)).toEqual([24, 36, 48, 72]);
    expect(numberOptions([24, 48], 48)).toEqual([24, 48]);
    expect(hoursLabel(48)).toBe('48 hours (2 days)');
    expect(hoursLabel(1)).toBe('1 hour');
    expect(hoursLabel(36)).toBe('36 hours');
  });

  it('keeps an unusual time zone selectable', () => {
    expect(timeZoneOptions('Europe/Lisbon')[0]).toEqual({ value: 'Europe/Lisbon', label: 'Europe/Lisbon' });
    expect(timeZoneOptions('America/Chicago').some((zone) => zone.value === 'Europe/Lisbon')).toBe(false);
  });

  it('checks tax ids by type and taxonomy codes', () => {
    expect(isValidTaxId('12-3456789', 'EIN')).toBe(true);
    expect(isValidTaxId('123456789', 'EIN')).toBe(true);
    expect(isValidTaxId('123-45-6789', 'EIN')).toBe(false);
    expect(isValidTaxId('123-45-6789', 'SSN')).toBe(true);
    expect(isValidTaxonomy('101YM0800X')).toBe(true);
    expect(isValidTaxonomy('101ym0800x')).toBe(false);
    expect(isValidTaxonomy('101YM0800')).toBe(false);
  });

  it('falls back to the profile tab, including for tabs the person can not see', () => {
    const biller = testSession({
      staff: { is_clinician: false, role: 'biller' },
      capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
    });
    const visible = settingsTabsFor(biller);
    expect(settingsTabFrom('booking', visible)).toBe('booking');
    expect(settingsTabFrom('bogus', visible)).toBe('profile');
    expect(settingsTabFrom('availability', visible)).toBe('profile');
  });

  it('shows availability to clinicians and to staff who schedule for everyone', () => {
    const scheduler = testSession({
      staff: { is_clinician: false, role: 'scheduler' },
      capabilities: ['view_all_clients', 'schedule_all'],
    });
    expect(settingsTabsFor(scheduler)).toContain('availability');
    expect(settingsTabsFor(testSession({ staff: { role: 'clinician' }, capabilities: [] }))).toContain('availability');
  });
});

function actor(changes: Partial<AuditEvent>): AuditEvent {
  return {
    id: 1,
    actor_role: 'staff',
    actor_id: null,
    actor_name: '',
    client_id: null,
    client_name: '',
    action: 'client.view',
    resource_type: '',
    resource_id: null,
    ip_address: '',
    user_agent: '',
    detail: null,
    created_at: '2026-09-20T14:00:00Z',
    sealed: true,
    ...changes,
  };
}

describe('audit log labels', () => {
  it.each([
    ['auth.login', 'Signed in'],
    ['client.view', 'Viewed a client'],
    ['invoice.list', 'Viewed invoices'],
    ['messages.list', 'Viewed conversations'],
    ['invoice.void', 'Voided an invoice'],
    ['note.sign', 'Signed a note'],
    ['widget.frobnicate', 'Widget frobnicate'],
  ])('%s -> %s', (action, label) => {
    expect(humanizeAction(action)).toBe(label);
  });

  it('labels actors and records', () => {
    expect(resourceLabel('client_form', 4)).toBe('Client form #4');
    expect(resourceLabel('staff', 7)).toBe('Team member #7');
    expect(resourceLabel('', null)).toBe('');
    const staff = (actorId: number, name: string) => actor({ actor_role: 'staff', actor_id: actorId, actor_name: name });
    expect(actorLabel(staff(1, 'Dana Lee'), 1)).toBe('You');
    expect(actorLabel(staff(2, 'Jordan Park'), 1)).toBe('Jordan Park');
    expect(actorLabel(staff(3, ''), 1)).toBe('Team member #3');
  });

  it('names clients acting on their own record, and says when a job or no one signed in did it', () => {
    const client = actor({ actor_role: 'client', actor_id: 9, client_id: 9, client_name: 'Alex Rivera' });
    expect(actorLabel(client, 1)).toBe('Alex Rivera');
    expect(actorLabel({ ...client, detail: { contact_id: 4 } }, 1)).toBe("Alex Rivera's contact");
    expect(actorLabel({ ...client, client_id: 12, client_name: 'Sam Park' }, 1)).toBe('Client #9');
    expect(actorLabel({ ...client, client_name: '' }, 1)).toBe('Client #9');
    expect(actorLabel(actor({ actor_role: 'system', action: 'invoice.auto_create' }), 1)).toBe('Synari (automatic)');
    expect(actorLabel(actor({ actor_role: 'system', action: 'admin.unlock' }), 1)).toBe('Server admin');
    expect(actorLabel(actor({ actor_role: 'anonymous', action: 'auth.login_failed' }), 1)).toBe('Not signed in');
  });
});

describe('settings validation', () => {
  const practice = practiceDraft(testSession({ practice: { booking_slug: 'lee-counseling' } }).practice);

  it('checks the practice name, billing identity and booking link', () => {
    expect(validatePractice(practice)).toEqual({});
    expect(validatePractice({ ...practice, name: ' ' })).toHaveProperty('name');
    expect(validatePractice({ ...practice, booking_slug: 'Bad Slug' })).toHaveProperty('booking_slug');
    expect(validatePractice({ ...practice, tax_id: '123-45-6789' })).toEqual({ tax_id: 'An EIN looks like 12-3456789' });
    expect(validatePractice({ ...practice, tax_id: '123-45-6789', tax_id_type: 'SSN' })).toEqual({});
    expect(validatePractice({ ...practice, npi: '12' })).toHaveProperty('npi');
    expect(validatePractice({ ...practice, billing_provider: 'organization' })).toEqual({
      npi: 'Billing as the practice needs the group NPI',
    });
    expect(validatePractice({ ...practice, billing_provider: 'organization', npi: '1234567893' })).toEqual({});
  });

  it('trims practice fields and clears a blank booking link', () => {
    const input = practiceInput({ ...practice, name: ' Lee Counseling ', booking_slug: ' ' });
    expect(input).toMatchObject({ name: 'Lee Counseling', booking_slug: null, tax_id_type: 'EIN' });
  });

  it('limits the away message and requires text when it is on', () => {
    expect(validateAwayMessage({ away_message_enabled: false, away_message: '' })).toEqual({});
    expect(validateAwayMessage({ away_message_enabled: true, away_message: ' ' })).toHaveProperty('away_message');
    expect(validateAwayMessage({ away_message_enabled: false, away_message: 'x'.repeat(601) })).toHaveProperty('away_message');
  });

  it('checks the NPI, taxonomy and names on the profile', () => {
    const profile = {
      first_name: 'Dana',
      last_name: 'Lee',
      credentials: '',
      license_number: '',
      license_state: '',
      npi: '123',
      taxonomy_code: '',
      phone: '',
      time_zone: 'America/New_York',
      accepting_new_clients: true,
    };
    expect(validateProfile(profile)).toEqual({ npi: 'An NPI is exactly 10 digits' });
    expect(validateProfile({ ...profile, npi: '1234567890' })).toEqual({});
    expect(validateProfile({ ...profile, npi: '', taxonomy_code: 'nope' })).toHaveProperty('taxonomy_code');
    expect(validateProfile({ ...profile, npi: '', first_name: ' ' })).toHaveProperty('first_name');
  });

  it('checks password length, change and confirmation', () => {
    expect(validatePasswordChange({ current: 'old-password', next: 'short', confirm: 'short' })).toHaveProperty('next');
    expect(validatePasswordChange({ current: 'same-password', next: 'same-password', confirm: 'same-password' })).toHaveProperty('next');
    expect(validatePasswordChange({ current: 'old-password', next: 'a-new-password', confirm: 'different' })).toEqual({
      confirm: "Passwords don't match",
    });
    expect(validatePasswordChange({ current: 'old-password', next: 'a-new-password', confirm: 'a-new-password' })).toEqual({});
  });

  it('validates services and only lets online services take new clients', () => {
    const draft = { ...serviceDraft(null), code: '90834', description: 'Psychotherapy', rate: '150', bookable_by_new_clients: true };
    const { input, errors } = serviceInput(draft);
    expect(errors).toEqual({});
    expect(input).toMatchObject({ rate_cents: 15000, duration_minutes: 50, bookable_by_new_clients: false });
    expect(serviceInput({ ...draft, code: 'bad code', duration_minutes: '2', rate: 'x' }).errors).toEqual({
      code: 'Use up to 20 letters, numbers or hyphens',
      duration_minutes: 'Enter a length between 5 and 600 minutes',
      rate_cents: 'Enter an amount like 150 or 150.00',
    });
  });
});

describe('welcome checklist', () => {
  const settings = { booking_enabled: true, reminder_email_enabled: true, reminder_sms_enabled: false } as PracticeSettings;
  const services = [{ is_active: true, rate_cents: 0 } as Service];

  it('marks steps done from current data', () => {
    const session = testSession({ staff: { credentials: 'LCSW', license_number: 'L1' } });
    const done = Object.fromEntries(checklistItems(session, settings, services, []).map((item) => [item.tab, item.done]));
    expect(done).toEqual({ profile: true, services: false, availability: false, practice: false, notifications: true });
  });

  it('sends the booking step to the booking tab once the practice has a link', () => {
    const session = testSession({ practice: { booking_slug: 'lee-counseling' } });
    const booking = checklistItems(session, settings, services, []).find((item) => item.title === 'Turn on your booking link');
    expect(booking).toMatchObject({ tab: 'booking', done: true });
  });

  it("leaves out clinician steps for an owner who doesn't see clients", () => {
    const session = testSession({ staff: { is_clinician: false } });
    const tabs = checklistItems(session, settings, services, undefined).map((item) => item.tab);
    expect(tabs).toEqual(['services', 'practice', 'notifications']);
  });
});
