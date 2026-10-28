/**
 * reminder-sender (owner: Pablo): lo invoca EventBridge Scheduler en T-48h / T-24h.
 * Manda la tarjeta con confirmar / reprogramar / cancelar por RCS y, si el
 * dispositivo no soporta RCS o vence el TTL, el mismo recordatorio cae a SMS.
 */
import type { ReminderEvent } from '../shared/contracts';
import { maskPhone } from '../shared/patient';
import { RcsSender, SdkRcsSender, rcsSettingsFromEnv } from '../shared/rcs-client';
import { reminderCard } from '../shared/rcs-templates';
import { DynamoRepo, Repo } from '../tools/repo';

/** Lo que el sender necesita del Repo de tools; getContactPhone lee el item CONTACT# de inbound-router. */
export type ReminderStore = Pick<Repo, 'getAppointment' | 'getProvider' | 'getContactPhone'>;

export interface ReminderDeps {
  store: ReminderStore;
  sender: RcsSender;
  log?: (line: string) => void;
}

export type ReminderOutcome =
  | { sent: true; messageId?: string }
  | { sent: false; reason: 'NOT_FOUND' | 'INACTIVE' | 'NO_CONTACT' | 'BAD_EVENT' };

const ACTIVE = new Set(['BOOKED', 'CONFIRMED', 'RESCHEDULED']);

export function createHandler(deps: ReminderDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (event: ReminderEvent): Promise<ReminderOutcome> => {
    if (!event?.appointmentId || (event.kind !== 'T48' && event.kind !== 'T24')) {
      return { sent: false, reason: 'BAD_EVENT' };
    }
    const appt = await deps.store.getAppointment(event.appointmentId);
    if (!appt) return { sent: false, reason: 'NOT_FOUND' };
    // Un schedule viejo puede disparar despues de cancelar: se ignora.
    if (!ACTIVE.has(appt.status)) return { sent: false, reason: 'INACTIVE' };

    const [provider, phone] = await Promise.all([
      deps.store.getProvider(appt.providerId),
      deps.store.getContactPhone(appt.patientRef),
    ]);
    if (!provider) return { sent: false, reason: 'NOT_FOUND' };
    if (!phone) return { sent: false, reason: 'NO_CONTACT' };

    const messageId = await deps.sender.send(phone, reminderCard(appt, provider, event.kind), {
      appointmentId: appt.appointmentId,
      reminder: event.kind,
    });
    log(JSON.stringify({ level: 'info', msg: 'recordatorio enviado', to: maskPhone(phone), kind: event.kind, messageId }));
    return { sent: true, messageId };
  };
}

let realHandler: ReturnType<typeof createHandler> | undefined;
export const handler = async (event: ReminderEvent) => {
  realHandler ??= createHandler({
    store: new DynamoRepo(process.env.CATALOG_TABLE ?? '', process.env.APPOINTMENTS_TABLE ?? ''),
    sender: new SdkRcsSender(rcsSettingsFromEnv()),
  });
  return realHandler(event);
};
