import { useCallback, useState, type ReactNode } from 'react';
import type { Appointment, AppointmentKind } from '../../api/appointments';
import { AppointmentDetails, type DetailsTarget } from './AppointmentDetails';
import { AppointmentModal, type AppointmentModalTarget } from './AppointmentModal';

type DialogState = { type: 'details'; target: DetailsTarget } | { type: 'form'; target: AppointmentModalTarget } | null;

export interface AppointmentDialogs {
  openDetails: (appointment: Appointment) => void;
  openDetailsById: (appointmentId: number) => void;
  openCreate: (options: { startsAt: string; clientId?: number | null; clinicianId?: number | null; kind?: AppointmentKind }) => void;
  isOpen: boolean;
  element: ReactNode;
}

/**
 * The appointment details and create/edit dialogs, wired together: "Edit" in the details opens
 * the form, and saving an edit returns to the updated details.
 */
export function useAppointmentDialogs({
  timeZone,
  onClosed,
  showCalendarLink = false,
}: {
  timeZone: string;
  onClosed?: () => void;
  showCalendarLink?: boolean;
}): AppointmentDialogs {
  const [state, setState] = useState<DialogState>(null);

  const close = useCallback(() => {
    setState(null);
    onClosed?.();
  }, [onClosed]);
  const openDetails = useCallback(
    (appointment: Appointment) => setState({ type: 'details', target: { id: appointment.id, initial: appointment } }),
    [],
  );
  const openDetailsById = useCallback((appointmentId: number) => setState({ type: 'details', target: { id: appointmentId } }), []);
  const openCreate = useCallback(
    (options: { startsAt: string; clientId?: number | null; clinicianId?: number | null; kind?: AppointmentKind }) =>
      setState({ type: 'form', target: { mode: 'create', ...options } }),
    [],
  );

  const formTarget = state?.type === 'form' ? state.target : null;
  const editedId = formTarget?.mode === 'edit' ? formTarget.appointment.id : null;

  const element = (
    <>
      <AppointmentDetails
        target={state?.type === 'details' ? state.target : null}
        timeZone={timeZone}
        onClose={close}
        onEdit={(appointment) => setState({ type: 'form', target: { mode: 'edit', appointment } })}
        showCalendarLink={showCalendarLink}
      />
      <AppointmentModal
        target={formTarget}
        timeZone={timeZone}
        onClose={close}
        onSaved={(saved) => {
          const updated = saved.find((appointment) => appointment.id === editedId);
          if (updated) setState({ type: 'details', target: { id: updated.id, initial: updated } });
          else close();
        }}
      />
    </>
  );

  return { openDetails, openDetailsById, openCreate, isOpen: state !== null, element };
}
