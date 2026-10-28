/**
 * tools (owner: Pablo): target Lambda del AgentCore Gateway.
 * Formato verificado el 2026-10-23 contra
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
 * - event: mapa plano con las propiedades del inputSchema de la tool (sin envoltorio).
 * - context.clientContext.custom.bedrockAgentCoreToolName = "<targetName>___<toolName>".
 * - El contexto trae ademas bedrockAgentCoreMessageVersion, AwsRequestId, McpMessageId,
 *   GatewayId y TargetId: no se usan.
 */
import type { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import type { Appointment, Provider, Slot } from '../shared/contracts';
import { DynamoRepo, InMemoryRepo, Repo, SlotUnavailableError } from './repo';
import {
  EventBridgeReminderScheduler,
  InMemoryReminderScheduler,
  ReminderScheduler,
  ReminderSettings,
  planReminders,
} from './reminders';
import { TOOL_DEFINITIONS, TOOL_NAMES, ToolName } from './schema';

// ---------- Contratos de entrada / salida ----------

export interface SearchProvidersInput { procedure: string; city: string; limit?: number }
export interface GetAvailabilityInput { providerId: string; fromDate?: string; limit?: number }
export interface BookAppointmentInput { providerId: string; slotId: string; patientRef: string; procedure?: string }
export interface RescheduleAppointmentInput { appointmentId: string; newSlotId: string; patientRef: string }
export interface CancelAppointmentInput { appointmentId: string; patientRef: string }

export type ToolResult =
  | { ok: true; providers: Provider[] }
  | { ok: true; providerId: string; providerName: string; slots: Slot[] }
  | { ok: true; appointment: Appointment; provider: Provider }
  | { ok: false; error: string; code: 'NOT_FOUND' | 'SLOT_TAKEN' | 'FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL' };

export interface ToolDeps {
  repo: Repo;
  scheduler: ReminderScheduler;
  reminders: ReminderSettings;
  now: () => Date;
  /** Hex aleatorio para ids y sufijos; inyectable para tests deterministas. */
  newId?: () => string;
  log?: (line: string) => void;
}

// ---------- Logica ----------

export function toolNameFrom(context?: Partial<Context>): ToolName | undefined {
  const raw = context?.clientContext?.custom?.bedrockAgentCoreToolName;
  if (typeof raw !== 'string') return undefined;
  const name = raw.includes('___') ? raw.split('___').pop() : raw;
  return (TOOL_NAMES as readonly string[]).includes(name ?? '') ? (name as ToolName) : undefined;
}

// El agente arma los argumentos: se validan tipos antes de usarlos para no tirar TypeError,
// y un limit no numerico (NaN) cae al default en vez de propagarse.
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const badRequest = (error: string): ToolResult => ({ ok: false, error, code: 'BAD_REQUEST' });
const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? (value as number) : fallback)));

const ACTIVE_STATUSES: ReadonlySet<Appointment['status']> = new Set(['BOOKED', 'CONFIRMED', 'RESCHEDULED']);

export function createTools(deps: ToolDeps) {
  const { repo, scheduler } = deps;
  const newId = deps.newId ?? (() => randomUUID().replace(/-/g, ''));
  const log = deps.log ?? ((line: string) => console.log(line));

  async function loadOwned(appointmentId: unknown, patientRef: unknown) {
    if (!isId(appointmentId) || !isId(patientRef)) return { error: badRequest('appointmentId y patientRef son obligatorios') };
    const appt = await repo.getAppointment(appointmentId);
    if (!appt) return { error: { ok: false, error: 'Turno inexistente', code: 'NOT_FOUND' } as const };
    if (appt.patientRef !== patientRef) return { error: { ok: false, error: 'El turno no es de este paciente', code: 'FORBIDDEN' } as const };
    // Operar sobre un turno cancelado liberaria un slot que ya puede ser de otro paciente.
    if (!ACTIVE_STATUSES.has(appt.status)) return { error: badRequest('El turno ya esta cancelado') };
    return { appt };
  }

  /** Toma el slot del provider esperado. El slotId empieza con el providerId, asi que se chequea antes de escribir. */
  async function takeSlotOf(slotId: unknown, providerId: string): Promise<{ slot: Slot } | { error: ToolResult }> {
    if (!isId(slotId)) return { error: badRequest('slotId es obligatorio') };
    if (!slotId.startsWith(`${providerId}#`)) return { error: badRequest('El slot no pertenece a ese provider') };
    try {
      return { slot: await repo.takeSlot(slotId) };
    } catch (err) {
      if (err instanceof SlotUnavailableError) return { error: { ok: false, error: err.message, code: 'SLOT_TAKEN' } };
      throw err;
    }
  }

  /**
   * Reserva activa del mismo paciente en ese slot. Hace idempotente a book_appointment: si el
   * router reintenta un turno que ya reservo (timeout hacia AgentCore) o el modelo repite la
   * llamada, se devuelve el turno existente en vez de SLOT_TAKEN sobre la propia reserva.
   */
  async function findOwnBooking(patientRef: string, slotId: string): Promise<Appointment | undefined> {
    const found = (await repo.findAppointmentsBySlot(patientRef, slotId)).find((a) => ACTIVE_STATUSES.has(a.status));
    if (found) log(JSON.stringify({ level: 'info', msg: 'reserva existente devuelta', appointmentId: found.appointmentId }));
    return found;
  }

  /** Suelta schedules y slot; las dos cosas corren aunque una falle, y el fallo solo se loguea. */
  async function release(scheduleNames: string[], slotId: string) {
    const results = await Promise.allSettled([scheduler.remove(scheduleNames), repo.releaseSlot(slotId)]);
    for (const r of results) {
      if (r.status === 'rejected') {
        log(JSON.stringify({ level: 'warn', msg: 'no se pudo liberar schedules o slot', slotId, reason: String(r.reason) }));
      }
    }
  }

  return {
    async search_providers(input: SearchProvidersInput): Promise<ToolResult> {
      if (!isId(input.procedure) || !isId(input.city)) return badRequest('procedure y city son obligatorios');
      return { ok: true, providers: await repo.searchProviders(input.procedure, input.city, clamp(input.limit, 1, 5, 5)) };
    },

    async get_availability(input: GetAvailabilityInput): Promise<ToolResult> {
      if (!isId(input.providerId)) return badRequest('providerId es obligatorio');
      const provider = await repo.getProvider(input.providerId);
      if (!provider) return { ok: false, error: 'Provider inexistente', code: 'NOT_FOUND' };
      const from = input.fromDate ? new Date(input.fromDate) : deps.now();
      // Una fecha invalida rompe toISOString() en DynamoRepo: se rechaza antes.
      if (Number.isNaN(from.getTime())) return badRequest('fromDate no es una fecha ISO 8601 valida');
      const slots = await repo.getAvailability(input.providerId, from, clamp(input.limit, 1, 4, 4));
      return { ok: true, providerId: input.providerId, providerName: provider.name, slots };
    },

    async book_appointment(input: BookAppointmentInput): Promise<ToolResult> {
      if (!isId(input.providerId) || !isId(input.patientRef)) return badRequest('providerId y patientRef son obligatorios');
      const provider = await repo.getProvider(input.providerId);
      if (!provider) return { ok: false, error: 'Provider inexistente', code: 'NOT_FOUND' };
      const taken = await takeSlotOf(input.slotId, provider.providerId);
      if ('error' in taken) {
        if (taken.error.ok === false && taken.error.code === 'SLOT_TAKEN') {
          const existing = await findOwnBooking(input.patientRef, input.slotId as string);
          if (existing) return { ok: true, appointment: existing, provider };
        }
        return taken.error;
      }
      const { slot } = taken;
      const now = deps.now();
      const appointmentId = `apt_${newId().slice(0, 16)}`;
      const plans = planReminders(appointmentId, new Date(slot.startsAt), now, deps.reminders);
      // El slot ya esta tomado: si agendar o guardar falla, se devuelve para no perderlo.
      try {
        const appointment: Appointment = {
          appointmentId,
          patientRef: input.patientRef,
          providerId: provider.providerId,
          slotId: slot.slotId,
          procedure: isId(input.procedure) ? input.procedure : undefined, // texto libre del modelo: mismo tope de 128
          startsAt: slot.startsAt,
          status: 'BOOKED',
          reminderScheduleNames: await scheduler.schedule(appointmentId, plans),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        await repo.putAppointment(appointment);
        return { ok: true, appointment, provider };
      } catch (err) {
        await release(plans.map((p) => p.scheduleName), slot.slotId);
        throw err;
      }
    },

    async reschedule_appointment(input: RescheduleAppointmentInput): Promise<ToolResult> {
      const { appt, error } = await loadOwned(input.appointmentId, input.patientRef);
      if (error) return error;
      // El provider se lee antes del commit: un fallo despues no puede convertir el exito en INTERNAL.
      const provider = await repo.getProvider(appt.providerId);
      if (!provider) return { ok: false, error: 'Provider inexistente', code: 'NOT_FOUND' };
      const taken = await takeSlotOf(input.newSlotId, appt.providerId);
      if ('error' in taken) return taken.error;
      const { slot } = taken;
      const now = deps.now();
      // Sufijo unico: los schedules nuevos se crean antes de borrar los viejos, asi que el
      // nombre no puede repetirse ni con dos reprogramaciones en el mismo milisegundo.
      const suffix = `-r${now.getTime()}-${newId().slice(0, 4)}`;
      const plans = planReminders(appt.appointmentId, new Date(slot.startsAt), now, deps.reminders).map((p) => ({
        ...p,
        scheduleName: `${p.scheduleName}${suffix}`,
      }));
      // Primero se agenda y guarda lo nuevo; recien despues se suelta lo viejo. Si algo
      // falla en el medio, el turno sigue apuntando al slot viejo con sus recordatorios.
      let updated: Appointment;
      try {
        updated = {
          ...appt,
          slotId: slot.slotId,
          startsAt: slot.startsAt,
          status: 'RESCHEDULED',
          reminderScheduleNames: await scheduler.schedule(appt.appointmentId, plans),
          updatedAt: now.toISOString(),
        };
        await repo.putAppointment(updated);
      } catch (err) {
        await release(plans.map((p) => p.scheduleName), slot.slotId);
        throw err;
      }
      // Ya quedo guardado: soltar lo viejo no puede convertir el exito en error. Un schedule
      // viejo que sobreviva manda una tarjeta de mas; un slot viejo sin soltar se pierde.
      await release(appt.reminderScheduleNames, appt.slotId);
      return { ok: true, appointment: updated, provider };
    },

    async cancel_appointment(input: CancelAppointmentInput): Promise<ToolResult> {
      const { appt, error } = await loadOwned(input.appointmentId, input.patientRef);
      if (error) return error;
      const provider = await repo.getProvider(appt.providerId);
      if (!provider) return { ok: false, error: 'Provider inexistente', code: 'NOT_FOUND' };
      // Primero se marca cancelado (punto de commit): reminder-sender ignora turnos CANCELLED,
      // asi que un schedule que sobreviva no manda nada. Recien despues se libera el slot.
      const updated: Appointment = { ...appt, status: 'CANCELLED', reminderScheduleNames: [], updatedAt: deps.now().toISOString() };
      await repo.putAppointment(updated);
      await release(appt.reminderScheduleNames, appt.slotId);
      return { ok: true, appointment: updated, provider };
    },
  };
}

// ---------- Wiring real ----------

function defaultDeps(env: NodeJS.ProcessEnv = process.env): ToolDeps {
  // Desplegada usa DynamoDB; MOCK_DATA=true vuelve a los datos en memoria (sin AWS).
  const mock = env.MOCK_DATA === 'true';
  return {
    repo: mock ? new InMemoryRepo() : new DynamoRepo(env.CATALOG_TABLE ?? '', env.APPOINTMENTS_TABLE ?? ''),
    scheduler: mock
      ? new InMemoryReminderScheduler()
      : new EventBridgeReminderScheduler(env.SCHEDULE_GROUP ?? '', env.REMINDER_LAMBDA_ARN ?? '', env.SCHEDULER_ROLE_ARN ?? ''),
    reminders: {
      demoMode: env.DEMO_MODE === 'true',
      demoMinutes48h: Number(env.DEMO_MINUTES_48H ?? 2),
      demoMinutes24h: Number(env.DEMO_MINUTES_24H ?? 4),
    },
    now: () => new Date(),
  };
}

/** Claves que declara el schema: el modelo elige las claves del evento, asi que solo se loguean las conocidas. */
const SCHEMA_KEYS = new Set(TOOL_DEFINITIONS.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));

/** Despacho del Gateway sobre un set de tools; separado del wiring real para poder testearlo con fakes. */
export function createGatewayHandler(tools: ReturnType<typeof createTools>, log: (line: string) => void = console.log) {
  return async (event: Record<string, unknown> | null | undefined, context?: Partial<Context>): Promise<ToolResult> => {
    const name = toolNameFrom(context);
    const requestId = context?.awsRequestId;
    const input = event ?? {};
    const keys = Object.keys(input);
    const eventKeys = keys.filter((k) => SCHEMA_KEYS.has(k));
    // Solo claves, nunca valores: pueden traer datos del paciente.
    log(JSON.stringify({ level: 'info', msg: 'tool invocada', tool: name, requestId, eventKeys, unknownKeys: keys.length - eventKeys.length }));
    if (!name) return { ok: false, error: 'Tool desconocida', code: 'BAD_REQUEST' };
    const fn = tools[name] as (input: unknown) => Promise<ToolResult>;
    try {
      return await fn(input);
    } catch (err) {
      // Al modelo no le llegan ni el stack ni los mensajes del SDK (traen ARN y cuenta). Sin
      // "intenta de nuevo": reservar o reprogramar no son idempotentes.
      log(JSON.stringify({ level: 'error', msg: 'tool fallo', tool: name, requestId, errorName: (err as { name?: string })?.name }));
      return { ok: false, error: 'Error interno', code: 'INTERNAL' };
    }
  };
}

let gateway: ReturnType<typeof createGatewayHandler> | undefined;

export const handler = async (event: Record<string, unknown>, context: Context): Promise<ToolResult> => {
  gateway ??= createGatewayHandler(createTools(defaultDeps()));
  return gateway(event, context);
};
