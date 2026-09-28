import { PLACE_OF_SERVICE_OPTIONS, type Location, type LocationInput } from '../../../api/practice';

/** The place-of-service select's value for a code that isn't one of the common ones. */
export const OTHER_PLACE_OF_SERVICE = 'other';

const OFFICE = '11';
const TELEHEALTH_AT_HOME = '10';
const VIDEO_CODES = ['02', '10'];

function isCommonCode(code: string): boolean {
  return PLACE_OF_SERVICE_OPTIONS.some((option) => option.code === code);
}

export interface LocationDraft {
  name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  /** A common place-of-service code, or OTHER_PLACE_OF_SERVICE with the code in `pos_other`. */
  pos_choice: string;
  pos_other: string;
  is_video: boolean;
}

export function locationDraft(location: Location | null): LocationDraft {
  const code = location?.place_of_service ?? OFFICE;
  const common = isCommonCode(code);
  return {
    name: location?.name ?? '',
    address_line1: location?.address_line1 ?? '',
    address_line2: location?.address_line2 ?? '',
    city: location?.city ?? '',
    state: location?.state ?? '',
    postal_code: location?.postal_code ?? '',
    pos_choice: common ? code : OTHER_PLACE_OF_SERVICE,
    pos_other: common ? '' : code,
    is_video: location?.is_video ?? false,
  };
}

/**
 * Switch between an office and a video office, moving the place of service along with it
 * (office 11 <-> telehealth at home 10) unless a different code was chosen on purpose.
 */
export function withVideo(draft: LocationDraft, isVideo: boolean): LocationDraft {
  if (isVideo && draft.pos_choice === OFFICE) return { ...draft, is_video: true, pos_choice: TELEHEALTH_AT_HOME };
  if (!isVideo && VIDEO_CODES.includes(draft.pos_choice)) return { ...draft, is_video: false, pos_choice: OFFICE };
  return { ...draft, is_video: isVideo };
}

/** Validate a location draft and build the API payload. Video offices don't keep an address. */
export function locationInput(draft: LocationDraft): {
  input: Omit<LocationInput, 'is_active'>;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'Enter a name, like "Main office"';
  const code = draft.pos_choice === OTHER_PLACE_OF_SERVICE ? draft.pos_other.trim() : draft.pos_choice;
  if (!/^\d{2}$/.test(code)) errors.place_of_service = 'Enter the two-digit place of service code';
  const address = (value: string) => (draft.is_video ? '' : value.trim());
  return {
    errors,
    input: {
      name: draft.name.trim(),
      address_line1: address(draft.address_line1),
      address_line2: address(draft.address_line2),
      city: address(draft.city),
      state: address(draft.state),
      postal_code: address(draft.postal_code),
      place_of_service: code,
      is_video: draft.is_video,
    },
  };
}

/** "11 · Office", or "POS 99" when it isn't one of the common codes. */
export function placeOfServiceLabel(code: string): string {
  const option = PLACE_OF_SERVICE_OPTIONS.find((candidate) => candidate.code === code);
  return option ? `${code} · ${option.label}` : `POS ${code}`;
}

/** One line of address, e.g. "12 Oak St, Suite 4, Portland, OR 97201". */
export function addressLine(location: Location): string {
  const cityLine = [location.city, [location.state, location.postal_code].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [location.address_line1, location.address_line2, cityLine].filter(Boolean).join(', ');
}
