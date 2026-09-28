import { ApiError, api } from './client';
import type {
  Appointment,
  AppointmentStatus,
  BookingSource,
  ConflictDetail,
  LocationType,
  StaffRef,
} from './appointments';
import type { ClientStatus } from './clients';

/** A requester as shown on a pending request, with the contact details they gave. */
export interface RequestClient {
  id: number;
  first_name: string;
  last_name: string;
  preferred_name: string;
  status: ClientStatus;
  email: string | null;
  phone: string;
  date_of_birth: string | null;
}

/** An online appointment request (always for one client) awaiting accept or decline. */
export interface AppointmentRequest {
  id: number;
  clinician: StaffRef;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  location_type: LocationType;
  location_id: number | null;
  service_id: number | null;
  service_description: string;
  source: BookingSource;
  request_message: string;
  has_video: boolean;
  created_at: string;
  client: RequestClient;
}

/** A service a client may request online (portal clients never see rates). */
export interface BookableService {
  id: number;
  description: string;
  duration_minutes: number;
}

/** A service on the public booking page, with the clinician's fee for it. */
export interface PricedService extends BookableService {
  rate_cents: number;
}

/** An office in use, so booking pages can say where an in-person slot is. */
export interface BookingLocation {
  id: number;
  name: string;
  address: string;
}

/** A clinician clients can book with; slot dates are in their time zone. */
export interface BookingClinician {
  id: number;
  /** Name with credentials, e.g. "Jordan Lee, LCSW". */
  name: string;
  time_zone: string;
}

export interface PublicBookingClinician extends BookingClinician {
  services: PricedService[];
}

export interface PortalBookingClinician extends BookingClinician {
  services: BookableService[];
}

/** An open time; starts_at/ends_at are UTC. */
export interface Slot {
  starts_at: string;
  ends_at: string;
  location_type: LocationType;
  location_id: number | null;
}

/** What the public booking page shows: the practice and the clinicians taking new clients. */
export interface BookingPageInfo {
  practice_name: string;
  intro: string;
  time_zone: string;
  clinicians: PublicBookingClinician[];
  locations: BookingLocation[];
  /** Show the right-to-receive-a-Good-Faith-Estimate notice (the practice gives estimates). */
  gfe_notice: boolean;
}

/** Who on a portal client's care team they can book with, and where. */
export interface PortalBookingOptions {
  clinicians: PortalBookingClinician[];
  locations: BookingLocation[];
}

/** One clinician's open times for a service: local dates in the clinician's time zone,
 * inclusive, at most 31 days apart. */
export interface SlotRange {
  clinician_id: number;
  service_id: number;
  start_date: string;
  end_date: string;
}

export interface PublicBookingInput {
  clinician_id: number;
  service_id: number;
  starts_at: string;
  location_type: LocationType;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  email: string;
  phone: string;
  message?: string;
  /** Honeypot: real people leave it empty. */
  website?: string;
}

export interface PortalBookingInput {
  clinician_id: number;
  service_id: number;
  starts_at: string;
  location_type: LocationType;
  message?: string;
}

/** An appointment as the client sees it in the portal. */
export interface PortalAppointment {
  id: number;
  starts_at: string;
  ends_at: string;
  /** The client's own attendance if set (e.g. they canceled their place), else the session's. */
  status: AppointmentStatus;
  location_type: LocationType;
  location_details: string;
  has_video: boolean;
  clinician_name: string;
  service_description: string;
  is_group: boolean;
  /** First names of the others in a couples or family session; always empty for groups. */
  other_participants: string[];
  can_cancel: boolean;
  /** Canceling now counts as a late cancellation, which may be charged. */
  cancel_is_late: boolean;
}

export type PortalAppointmentsWhen = 'upcoming' | 'past';

/** The conflicts in a 409 response, or null when the error is something else. */
export function conflictFrom(error: unknown): ConflictDetail | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const detail = error.detail;
  if (detail && typeof detail === 'object' && 'conflicts' in detail && Array.isArray(detail.conflicts)) {
    const found = detail as Partial<ConflictDetail> & Pick<ConflictDetail, 'message' | 'conflicts'>;
    return { message: found.message, conflicts: found.conflicts, client_conflicts: found.client_conflicts ?? [] };
  }
  return null;
}

/** Pending online requests on the calendars you handle. */
export const appointmentRequestsApi = {
  list: (clinicianId?: number) =>
    api<AppointmentRequest[]>('/appointment-requests', { query: { clinician_id: clinicianId } }),
  accept: (id: number, allowConflicts = false) =>
    api<Appointment>(`/appointment-requests/${id}/accept`, {
      method: 'POST',
      query: { allow_conflicts: allowConflicts || undefined },
    }),
  decline: (id: number, body: { reason: string; include_reason: boolean }) =>
    api<Appointment>(`/appointment-requests/${id}/decline`, { body }),
};

/** The public booking page for new clients (no sign-in). */
export const publicBookingApi = {
  page: (slug: string, clinicianId?: number) =>
    api<BookingPageInfo>(`/booking/${encodeURIComponent(slug)}`, {
      realm: null,
      query: { clinician_id: clinicianId },
    }),
  slots: (slug: string, range: SlotRange) =>
    api<Slot[]>(`/booking/${encodeURIComponent(slug)}/slots`, { realm: null, query: { ...range } }),
  request: (slug: string, input: PublicBookingInput) =>
    api<{ status: 'requested' }>(`/booking/${encodeURIComponent(slug)}/requests`, { realm: null, body: input }),
};

/** Online booking for signed-in portal clients, with the clinicians on their care team. */
export const portalBookingApi = {
  options: () => api<PortalBookingOptions>('/portal/booking', { realm: 'client' }),
  slots: (range: SlotRange) => api<Slot[]>('/portal/booking/slots', { realm: 'client', query: { ...range } }),
  request: (input: PortalBookingInput) =>
    api<PortalAppointment>('/portal/booking/requests', { realm: 'client', body: input }),
};

/** The signed-in client's own appointments. */
export const portalAppointmentsApi = {
  list: (when: PortalAppointmentsWhen) =>
    api<PortalAppointment[]>('/portal/appointments', { realm: 'client', query: { when } }),
  cancel: (id: number, reason: string) =>
    api<PortalAppointment>(`/portal/appointments/${id}/cancel`, { realm: 'client', body: { reason } }),
};

export const bookingKeys = {
  requests: ['appointment-requests'] as const,
  publicPage: (slug: string, clinicianId?: number) => ['booking', slug, 'page', clinicianId ?? null] as const,
  publicSlots: (slug: string, range: SlotRange) => ['booking', slug, 'slots', range] as const,
  portalOptions: ['portal', 'booking', 'options'] as const,
  portalSlots: (range: SlotRange) => ['portal', 'booking', 'slots', range] as const,
  portalAppointments: ['portal', 'appointments'] as const,
  portalAppointmentList: (when: PortalAppointmentsWhen) => ['portal', 'appointments', when] as const,
};
