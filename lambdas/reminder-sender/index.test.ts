import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import type { Appointment, ReminderEvent } from '../shared/contracts';
import type { OutboundMessage } from '../shared/rcs-templates';
import { decodePostback } from '../shared/rcs-templates';
import { buildCatalogItems } from '../../scripts/seed-synthetic-data';
import { createTools } from '../tools';
import { APPOINTMENTS, CATALOG, FakeDocClient } from '../tools/fake-doc-client';
import { EventBridgeReminderScheduler, SchedulerClientLike, atExpression } from '../tools/reminders';
import { DynamoRepo } from '../tools/repo';
import { syntheticProviders } from '../tools/synthetic-data';
import { createHandler } from './index';

const provider = syntheticProviders()[0];
const appt = (status: Appointment['status']): Appointment => ({
  appointmentId: 'apt_1',
  patientRef: 'ref-1',
  providerId: provider.providerId,
  slotId: 'slot-1',
  startsAt: '2026-10-30T14:00:00.000Z',
  status,
  reminderScheduleNames: [],
  createdAt: '',
  updatedAt: '',
});

function setup(status: Appointment['status'], phone: string | null = '+15555550100') {
  const sent: Array<{ to: string; fallback: string; postbacks: string[] }> = [];
  const handler = createHandler({
    store: {
      getAppointment: async () => appt(status),
      getProvider: async () => provider,
      getContactPhone: async () => phone ?? undefined,
    },
    sender: {
      send: async (to, msg) => {
        const postbacks =
          msg.content.Content?.RichCard?.CardContent?.Suggestions?.map((s) => decodePostback(s.Reply?.PostbackData ?? '')?.a ?? '') ?? [];
        sent.push({ to, fallback: msg.fallbackText, postbacks });
        return 'msg-9';
      },
    },
    log: () => undefined,
  });
  return { handler, sent };
}

describe('reminder-sender', () => {
  it('manda la tarjeta T-48h con botones y fallback SMS', async () => {
    const t = setup('BOOKED');
    await expect(t.handler({ appointmentId: 'apt_1', kind: 'T48' })).resolves.toEqual({ sent: true, messageId: 'msg-9' });
    expect(t.sent[0].postbacks).toEqual(['confirm', 'reschedule', 'cancel']);
    expect(t.sent[0].fallback).toMatch(/in 2 days/);
  });

  it('no manda nada si el turno esta cancelado o no hay contacto', async () => {
    await expect(setup('CANCELLED').handler({ appointmentId: 'apt_1', kind: 'T24' })).resolves.toEqual({ sent: false, reason: 'INACTIVE' });
    await expect(setup('BOOKED', null).handler({ appointmentId: 'apt_1', kind: 'T24' })).resolves.toEqual({
      sent: false,
      reason: 'NO_CONTACT',
    });
  });
});

describe('reminder-sender con eventos invalidos', () => {
  function guarded() {
    const calls: string[] = [];
    const handler = createHandler({
      store: {
        getAppointment: async (id) => {
          calls.push(id);
          return appt('BOOKED');
        },
        getProvider: async () => provider,
        getContactPhone: async () => '+15555550100',
      },
      sender: { send: async () => 'msg-1' },
      log: () => undefined,
    });
    return { handler, calls };
  }
  const bad = { sent: false, reason: 'BAD_EVENT' };

  it('devuelve BAD_EVENT sin tocar el store cuando kind no es T48 ni T24', async () => {
    const t = guarded();
    await expect(t.handler({ appointmentId: 'apt_1', kind: 'T72' } as unknown as ReminderEvent)).resolves.toEqual(bad);
    await expect(t.handler({ appointmentId: 'apt_1' } as unknown as ReminderEvent)).resolves.toEqual(bad);
    await expect(t.handler({ appointmentId: 'apt_1', kind: 't48' } as unknown as ReminderEvent)).resolves.toEqual(bad);
    expect(t.calls).toEqual([]);
  });

  it('devuelve BAD_EVENT cuando falta appointmentId o el evento es nulo', async () => {
    const t = guarded();
    await expect(t.handler({ kind: 'T48' } as unknown as ReminderEvent)).resolves.toEqual(bad);
    await expect(t.handler({ appointmentId: '', kind: 'T48' })).resolves.toEqual(bad);
    await expect(t.handler(undefined as unknown as ReminderEvent)).resolves.toEqual(bad);
    expect(t.calls).toEqual([]);
  });

  it('devuelve NOT_FOUND cuando el turno existe pero su provider ya no', async () => {
    const handler = createHandler({
      store: { getAppointment: async () => appt('BOOKED'), getProvider: async () => undefined, getContactPhone: async () => '+15555550100' },
      sender: { send: async () => 'msg-1' },
      log: () => undefined,
    });
    await expect(handler({ appointmentId: 'apt_1', kind: 'T48' })).resolves.toEqual({ sent: false, reason: 'NOT_FOUND' });
  });

  it('manda el recordatorio para turnos CONFIRMED y RESCHEDULED', async () => {
    await expect(setup('CONFIRMED').handler({ appointmentId: 'apt_1', kind: 'T24' })).resolves.toMatchObject({ sent: true });
    await expect(setup('RESCHEDULED').handler({ appointmentId: 'apt_1', kind: 'T24' })).resolves.toMatchObject({ sent: true });
  });
});

// ---------- Sobre DynamoRepo real (fake DocumentClient compartido con tools) ----------

const now = new Date('2026-10-26T12:00:00Z');
const PHONE = '+15555550100';
const DAY_MS = 86_400_000;

class RecordingSchedulerClient implements SchedulerClientLike {
  readonly commands: Array<CreateScheduleCommand | DeleteScheduleCommand> = [];
  async send(command: CreateScheduleCommand | DeleteScheduleCommand) {
    this.commands.push(command);
    return {};
  }
  get creates() {
    return this.commands.filter((c): c is CreateScheduleCommand => c instanceof CreateScheduleCommand);
  }
  get deletes() {
    return this.commands.filter((c): c is DeleteScheduleCommand => c instanceof DeleteScheduleCommand);
  }
}

function dynamoSetup(demo?: { demoMode: boolean; demoMinutes48h: number; demoMinutes24h: number }) {
  const doc = new FakeDocClient(buildCatalogItems(now));
  doc.tables.get(APPOINTMENTS)!.set('CONTACT#p1', { appointmentId: 'CONTACT#p1', phone: PHONE });
  const repo = new DynamoRepo(CATALOG, APPOINTMENTS, doc);
  const client = new RecordingSchedulerClient();
  const scheduler = new EventBridgeReminderScheduler('group-1', 'arn:lambda:reminder', 'arn:role:scheduler', client);
  const tools = createTools({
    repo,
    scheduler,
    reminders: demo ?? { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 },
    now: () => now,
  });
  const sent: Array<{ to: string; msg: OutboundMessage }> = [];
  const reminder = createHandler({
    store: repo,
    sender: {
      send: async (to, msg) => {
        sent.push({ to, msg });
        return 'msg-1';
      },
    },
    log: () => undefined,
  });
  return { doc, repo, client, tools, reminder, sent };
}

async function bookLateSlot(tools: ReturnType<typeof dynamoSetup>['tools']) {
  const providerId = 'prov_miami_01';
  const avail = await tools.get_availability({ providerId, fromDate: new Date(now.getTime() + 3 * DAY_MS).toISOString() });
  if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
  const slot = avail.slots[0];
  expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(now.getTime() + 3 * DAY_MS);
  const booked = await tools.book_appointment({ providerId, slotId: slot.slotId, patientRef: 'p1' });
  if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
  return booked;
}

const inputsOf = (client: RecordingSchedulerClient) =>
  client.creates.map((c) => JSON.parse(c.input.Target!.Input!) as ReminderEvent);

describe('reminder-sender sobre DynamoRepo', () => {
  it('manda al telefono del CONTACT# una tarjeta con el nombre del provider', async () => {
    const t = dynamoSetup();
    const booked = await bookLateSlot(t.tools);

    const outcome = await t.reminder({ appointmentId: booked.appointment.appointmentId, kind: 'T48' });

    expect(outcome).toEqual({ sent: true, messageId: 'msg-1' });
    expect(t.sent[0].to).toBe(PHONE);
    const title = t.sent[0].msg.content.Content?.RichCard?.CardContent?.Title;
    expect(title).toContain(booked.provider.name);
  });

  it('un CONTACT# usado como appointmentId no es un turno', async () => {
    const t = dynamoSetup();
    await expect(t.reminder({ appointmentId: 'CONTACT#p1', kind: 'T48' })).resolves.toEqual({ sent: false, reason: 'NOT_FOUND' });
    expect(t.sent).toHaveLength(0);
  });
});

describe('flujo de recordatorios de punta a punta (tools + Scheduler + reminder-sender)', () => {
  it('reserva, dispara T48 y T24, cancela y los disparos tardios quedan INACTIVE', async () => {
    const t = dynamoSetup();
    const booked = await bookLateSlot(t.tools);
    const { appointmentId, reminderScheduleNames } = booked.appointment;

    expect(t.client.creates).toHaveLength(2);
    expect(t.client.creates.map((c) => c.input.Name)).toEqual(reminderScheduleNames);
    const inputs = inputsOf(t.client);
    expect(inputs.map((i) => i.kind)).toEqual(['T48', 'T24']);

    for (const input of inputs) await expect(t.reminder(input)).resolves.toMatchObject({ sent: true });
    expect(t.sent.map((s) => s.msg.fallbackText)).toEqual([
      expect.stringContaining('in 2 days'),
      expect.stringContaining('tomorrow'),
    ]);

    const cancelled = await t.tools.cancel_appointment({ appointmentId, patientRef: 'p1' });
    expect(cancelled).toMatchObject({ ok: true, appointment: { status: 'CANCELLED' } });
    expect(t.client.deletes.map((d) => d.input.Name)).toEqual(reminderScheduleNames);

    for (const input of inputs) await expect(t.reminder(input)).resolves.toEqual({ sent: false, reason: 'INACTIVE' });
    expect(t.sent).toHaveLength(2);
  });

  it('un schedule viejo que sobrevive a una reprogramacion manda la tarjeta con el horario nuevo, nunca el viejo', async () => {
    const t = dynamoSetup();
    const booked = await bookLateSlot(t.tools);
    const { appointmentId } = booked.appointment;
    const [oldT48] = inputsOf(t.client);
    await t.reminder(oldT48);
    const textBefore = t.sent[0].msg.fallbackText;

    const avail = await t.tools.get_availability({ providerId: 'prov_miami_01', fromDate: new Date(now.getTime() + 3 * DAY_MS).toISOString() });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    const moved = await t.tools.reschedule_appointment({ appointmentId, newSlotId: avail.slots[0].slotId, patientRef: 'p1' });
    expect(moved).toMatchObject({ ok: true, appointment: { status: 'RESCHEDULED', slotId: avail.slots[0].slotId } });

    // El Input viejo y el nuevo (creates[2]) tienen el mismo appointmentId y kind: la tarjeta sale igual.
    const [, , newT48] = inputsOf(t.client);
    expect(newT48).toEqual(oldT48);
    await expect(t.reminder(oldT48)).resolves.toMatchObject({ sent: true });
    await expect(t.reminder(newT48)).resolves.toMatchObject({ sent: true });
    const [textOldInput, textNewInput] = t.sent.slice(1).map((s) => s.msg.fallbackText);
    expect(textOldInput).toEqual(textNewInput);
    expect(textOldInput).not.toEqual(textBefore); // ya muestra el horario reprogramado
  });

  it('en DEMO_MODE agenda a los 2 y 4 minutos y el mismo flujo funciona', async () => {
    const t = dynamoSetup({ demoMode: true, demoMinutes48h: 2, demoMinutes24h: 4 });
    const booked = await bookLateSlot(t.tools);

    expect(t.client.creates.map((c) => c.input.ScheduleExpression)).toEqual([
      atExpression(new Date(now.getTime() + 2 * 60_000)),
      atExpression(new Date(now.getTime() + 4 * 60_000)),
    ]);
    const inputs = inputsOf(t.client);
    for (const input of inputs) await expect(t.reminder(input)).resolves.toMatchObject({ sent: true });

    await t.tools.cancel_appointment({ appointmentId: booked.appointment.appointmentId, patientRef: 'p1' });
    expect(t.client.deletes).toHaveLength(2);
    for (const input of inputs) await expect(t.reminder(input)).resolves.toEqual({ sent: false, reason: 'INACTIVE' });
  });
});
