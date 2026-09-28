import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability } from '../../../api/auth';
import type { Location } from '../../../api/practice';
import { WithSession, testSession } from '../../../test/session';
import { ToastProvider } from '../../../ui/Toast';
import { LocationsSettings } from './LocationsSettings';
import { addressLine, locationDraft, locationInput, placeOfServiceLabel, withVideo } from './locationRules';

const practice = vi.hoisted(() => ({ locations: vi.fn(), createLocation: vi.fn(), updateLocation: vi.fn() }));

vi.mock('../../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/practice')>();
  return { ...actual, practiceApi: { ...actual.practiceApi, ...practice } };
});

const OFFICE: Location = {
  id: 1,
  name: 'Main office',
  address_line1: '12 Oak St',
  address_line2: 'Suite 4',
  city: 'Portland',
  state: 'OR',
  postal_code: '97201',
  place_of_service: '11',
  is_video: false,
  is_active: true,
};
const VIDEO: Location = {
  ...OFFICE,
  id: 2,
  name: 'Video office',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  place_of_service: '10',
  is_video: true,
};

describe('location rules', () => {
  it('keeps uncommon place-of-service codes editable', () => {
    expect(locationDraft({ ...OFFICE, place_of_service: '99' })).toMatchObject({ pos_choice: 'other', pos_other: '99' });
    expect(locationDraft(null)).toMatchObject({ pos_choice: '11', is_video: false });
  });

  it('moves the place of service with the video switch unless it was chosen on purpose', () => {
    const office = locationDraft(OFFICE);
    expect(withVideo(office, true)).toMatchObject({ is_video: true, pos_choice: '10' });
    expect(withVideo({ ...office, pos_choice: '02', is_video: true }, false)).toMatchObject({ is_video: false, pos_choice: '11' });
    expect(withVideo({ ...office, pos_choice: 'other', pos_other: '22' }, true)).toMatchObject({ is_video: true, pos_choice: 'other' });
  });

  it('validates the name and code, and drops the address of a video office', () => {
    expect(locationInput({ ...locationDraft(null), name: ' ', pos_choice: 'other', pos_other: '7' }).errors).toEqual({
      name: 'Enter a name, like "Main office"',
      place_of_service: 'Enter the two-digit place of service code',
    });
    expect(locationInput({ ...locationDraft(OFFICE), is_video: true, pos_choice: '02' }).input).toMatchObject({
      address_line1: '',
      city: '',
      place_of_service: '02',
      is_video: true,
    });
  });

  it('describes locations', () => {
    expect(placeOfServiceLabel('02')).toBe('02 · Telehealth (not at home)');
    expect(placeOfServiceLabel('99')).toBe('POS 99');
    expect(addressLine(OFFICE)).toBe('12 Oak St, Suite 4, Portland, OR 97201');
    expect(addressLine(VIDEO)).toBe('');
  });
});

describe('LocationsSettings', () => {
  beforeEach(() => {
    Object.values(practice).forEach((mock) => mock.mockReset());
    practice.locations.mockResolvedValue([OFFICE, VIDEO]);
  });

  function renderLocations(capabilities: Capability[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <WithSession session={testSession({ capabilities })}>
            <LocationsSettings />
          </WithSession>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('adds an office with a typed place-of-service code', async () => {
    const user = userEvent.setup();
    practice.createLocation.mockImplementation((input: Omit<Location, 'id'>) => Promise.resolve({ ...input, id: 3 }));
    renderLocations(['manage_practice']);

    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    const dialog = screen.getByRole('dialog', { name: 'Add location' });
    await user.type(within(dialog).getByLabelText(/Name/), 'Downtown');
    await user.type(within(dialog).getByLabelText('City'), 'Salem');
    await user.selectOptions(within(dialog).getByLabelText('Place of service'), 'other');
    await user.type(within(dialog).getByLabelText(/Code/), '22');
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));

    await waitFor(() =>
      expect(practice.createLocation).toHaveBeenCalledWith({
        name: 'Downtown',
        address_line1: '',
        address_line2: '',
        city: 'Salem',
        state: '',
        postal_code: '',
        place_of_service: '22',
        is_video: false,
        is_active: true,
      }),
    );
  });

  it('deactivates a location after confirming', async () => {
    const user = userEvent.setup();
    practice.updateLocation.mockResolvedValue({ ...OFFICE, is_active: false });
    renderLocations(['manage_practice']);

    const [deactivate] = await screen.findAllByRole('button', { name: 'Deactivate' });
    await user.click(deactivate);
    const dialog = screen.getByRole('dialog', { name: 'Deactivate Main office?' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(practice.updateLocation).toHaveBeenCalledWith(1, { is_active: false }));
  });

  it("lists locations read-only for people who don't manage the practice", async () => {
    renderLocations([]);
    expect(await screen.findByText('12 Oak St, Suite 4, Portland, OR 97201')).toBeInTheDocument();
    expect(screen.getByText('Place of service 10 · Telehealth at home')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });
});
