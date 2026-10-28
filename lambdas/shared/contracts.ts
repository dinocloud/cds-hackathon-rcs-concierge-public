/**
 * Contratos internos entre Lambdas y el agente. El detalle y los ejemplos
 * viven en docs/contrato-eventos.md: si se cambia algo aca, actualizar ese doc
 * y agent/contracts.py (espejo en Python).
 */

// ---------- Dominio (datos sinteticos) ----------

export interface Provider {
  providerId: string;
  name: string;
  specialty: string;
  procedures: string[];
  city: string;
  rating: number;
  reviewCount: number;
  verified: boolean;
  imageUrl: string;
  profileUrl: string;
}

export interface Slot {
  slotId: string;
  providerId: string;
  startsAt: string; // ISO 8601 UTC
  durationMinutes: number;
  available: boolean;
}

export type AppointmentStatus = 'BOOKED' | 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED';

export interface Appointment {
  appointmentId: string;
  patientRef: string; // hash del telefono, nunca el telefono
  providerId: string;
  slotId: string;
  procedure?: string;
  startsAt: string;
  status: AppointmentStatus;
  reminderScheduleNames: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------- Router -> agente (payload de InvokeAgentRuntime) ----------

export type PatientInput =
  | { type: 'text'; text: string }
  | { type: 'postback'; postbackData: string; text?: string };

export interface AgentInvokeRequest {
  /** Version del contrato, para poder evolucionarlo sin romper. */
  version: '1';
  /** Igual al runtimeSessionId (>= 33 caracteres). */
  sessionId: string;
  /** Hash del telefono: es el actorId de Memory y el patientRef de las tools. */
  patientRef: string;
  channel: 'RCS' | 'SMS';
  input: PatientInput;
  /** Hora del mensaje entrante, ISO 8601. */
  receivedAt: string;
  locale: 'en-US' | 'es-US';
}

// ---------- Agente -> router (respuesta del Runtime) ----------

export type ReplyBlock =
  | { type: 'text'; text: string; suggestions?: string[] }
  | { type: 'provider_carousel'; intro?: string; providers: Provider[] }
  | { type: 'slot_options'; providerId: string; providerName: string; slots: Slot[] }
  | { type: 'booking_confirmation'; appointment: Appointment; provider: Provider };

export interface AgentReply {
  version: '1';
  sessionId: string;
  blocks: ReplyBlock[];
  /** Si true, el agente detecto algo clinico y derivo a la clinica. */
  clinicalHandoff?: boolean;
}

// ---------- Scheduler -> reminder-sender ----------

export type ReminderKind = 'T48' | 'T24';

export interface ReminderEvent {
  appointmentId: string;
  kind: ReminderKind;
}
