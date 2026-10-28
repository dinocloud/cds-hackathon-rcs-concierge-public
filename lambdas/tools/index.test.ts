import type { Context } from 'aws-lambda';
import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { createGatewayHandler, createTools, toolNameFrom } from './index';
import { DynamoRepo, InMemoryRepo } from './repo';
import { EventBridgeReminderScheduler, InMemoryReminderScheduler, SchedulerClientLike } from './reminders';
import { APPOINTMENTS, CATALOG, FakeDocClient } from './fake-doc-client';
import { buildCatalogItems } from '../../scripts/seed-synthetic-data';

const now = new Date('2026-10-26T12:00:00Z');

function setup(demoMode = false) {
  const scheduler = new InMemoryReminderScheduler();
  const tools = createTools({
    repo: new InMemoryRepo(() => now),
    scheduler,
    reminders: { demoMode, demoMinutes48h: 2, demoMinutes24h: 4 },
    now: () => now,
  });
  return { tools, scheduler };
}

describe('tools', () => {
  it('resuelve el nombre de la tool desde el contexto del Gateway', () => {
    const ctx = { clientContext: { custom: { bedrockAgentCoreToolName: 'tools___get_availability' } } } as unknown as Context;
    expect(toolNameFrom(ctx)).toBe('get_availability');
    expect(toolNameFrom({} as Context)).toBeUndefined();
  });

  it('resuelve el nombre con el contexto completo del Gateway y rechaza tools desconocidas', () => {
    const custom = {
      bedrockAgentCoreMessageVersion: '1.0',
      bedrockAgentCoreAwsRequestId: 'req-1',
      bedrockAgentCoreMcpMessageId: 'mcp-1',
      bedrockAgentCoreGatewayId: 'gw-1',
      bedrockAgentCoreTargetId: 'tgt-1',
    };
    const ctx = (tool: string) =>
      ({ clientContext: { custom: { ...custom, bedrockAgentCoreToolName: tool } } }) as unknown as Context;
    expect(toolNameFrom(ctx('tools___book_appointment'))).toBe('book_appointment');
    expect(toolNameFrom(ctx('tools___drop_table'))).toBeUndefined();
  });

  it('flujo completo: buscar, disponibilidad, reservar, reprogramar y cancelar', async () => {
    const { tools, scheduler } = setup(true);

    const search = await tools.search_providers({ procedure: 'Rhinoplasty', city: 'miami' });
    if (!search.ok || !('providers' in search)) throw new Error('search fallo');
    expect(search.providers.length).toBeGreaterThan(0);
    const provider = search.providers[0];

    const avail = await tools.get_availability({ providerId: provider.providerId });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    expect(avail.slots).toHaveLength(4);

    const booked = await tools.book_appointment({ providerId: provider.providerId, slotId: avail.slots[0].slotId, patientRef: 'p1' });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    expect(booked.appointment.reminderScheduleNames).toHaveLength(2);
    expect(scheduler.scheduled.size).toBe(2);

    const again = await tools.book_appointment({ providerId: provider.providerId, slotId: avail.slots[0].slotId, patientRef: 'p2' });
    expect(again).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });

    const forbidden = await tools.cancel_appointment({ appointmentId: booked.appointment.appointmentId, patientRef: 'otro' });
    expect(forbidden).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const moved = await tools.reschedule_appointment({
      appointmentId: booked.appointment.appointmentId,
      newSlotId: avail.slots[1].slotId,
      patientRef: 'p1',
    });
    expect(moved).toMatchObject({ ok: true, appointment: { status: 'RESCHEDULED', slotId: avail.slots[1].slotId } });

    const cancelled = await tools.cancel_appointment({ appointmentId: booked.appointment.appointmentId, patientRef: 'p1' });
    expect(cancelled).toMatchObject({ ok: true, appointment: { status: 'CANCELLED' } });
    expect(scheduler.scheduled.size).toBe(0);
  });
});

const ctxWith = (tool: unknown) => ({ clientContext: { custom: { bedrockAgentCoreToolName: tool } } }) as unknown as Context;

describe('toolNameFrom: formatos raros del nombre', () => {
  it('acepta el nombre sin delimitador ___ si es una tool conocida', () => {
    expect(toolNameFrom(ctxWith('cancel_appointment'))).toBe('cancel_appointment');
  });

  it('devuelve undefined cuando no hay nada despues de ___ o el valor esta vacio', () => {
    expect(toolNameFrom(ctxWith('tools___'))).toBeUndefined();
    expect(toolNameFrom(ctxWith('___'))).toBeUndefined();
    expect(toolNameFrom(ctxWith(''))).toBeUndefined();
  });

  it('toma el ultimo segmento si el target trae ___ y rechaza valores que no son string', () => {
    expect(toolNameFrom(ctxWith('a___b___search_providers'))).toBe('search_providers');
    expect(toolNameFrom(ctxWith(42))).toBeUndefined();
    expect(toolNameFrom(ctxWith(undefined))).toBeUndefined();
    expect(toolNameFrom(undefined)).toBeUndefined();
  });

  it('no deja pasar nombres del prototipo como tools', () => {
    expect(toolNameFrom(ctxWith('tools___constructor'))).toBeUndefined();
    expect(toolNameFrom(ctxWith('tools___toString'))).toBeUndefined();
  });
});

describe('handler del Gateway (MOCK_DATA, sin AWS)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function load() {
    process.env.MOCK_DATA = 'true';
    jest.resetModules();
    return (await import('./index')).handler;
  }

  it('loguea solo las claves del evento, nunca los valores, y despacha la tool', async () => {
    const handler = await load();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const out = await handler({ procedure: 'rhinoplasty', city: 'Miami', patientRef: 'SECRET-REF' }, ctxWith('tools___search_providers'));

    expect(out).toMatchObject({ ok: true });
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ tool: 'search_providers', eventKeys: ['procedure', 'city', 'patientRef'] });
    expect(line).not.toContain('SECRET-REF');
    expect(line).not.toContain('rhinoplasty');
  });

  it('responde BAD_REQUEST para una tool desconocida sin ejecutar nada', async () => {
    const handler = await load();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(handler({}, ctxWith('tools___drop_table'))).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('no revienta si el evento llega nulo', async () => {
    const handler = await load();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(handler(undefined as unknown as Record<string, unknown>, ctxWith('tools___nope'))).resolves.toMatchObject({ code: 'BAD_REQUEST' });
    expect(JSON.parse(String(log.mock.calls[0][0])).eventKeys).toEqual([]);
  });
});

describe('tools: validaciones y errores', () => {
  it('search_providers rechaza procedure o city vacios con BAD_REQUEST', async () => {
    const { tools } = setup();
    await expect(tools.search_providers({ procedure: '', city: 'Miami' })).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    await expect(tools.search_providers({ procedure: 'rhinoplasty', city: '' })).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('search_providers y get_availability acotan limit (0 -> 1, 99 -> maximo)', async () => {
    const { tools } = setup();
    const one = await tools.search_providers({ procedure: 'rhinoplasty', city: 'Miami', limit: 0 });
    const many = await tools.search_providers({ procedure: 'rhinoplasty', city: 'Miami', limit: 99 });
    if (!one.ok || !many.ok || !('providers' in one) || !('providers' in many)) throw new Error('search fallo');
    expect(one.providers).toHaveLength(1);
    expect(many.providers.length).toBeLessThanOrEqual(5);
    const avail = await tools.get_availability({ providerId: 'prov_miami_01', limit: 99 });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    expect(avail.slots).toHaveLength(4);
  });

  it('get_availability y book_appointment devuelven NOT_FOUND para un provider inexistente', async () => {
    const { tools, scheduler } = setup();
    await expect(tools.get_availability({ providerId: 'prov_nope_99' })).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await expect(tools.book_appointment({ providerId: 'prov_nope_99', slotId: 'x#y', patientRef: 'p1' })).resolves.toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(scheduler.scheduled.size).toBe(0);
  });

  it('book_appointment con un slotId inexistente devuelve SLOT_TAKEN y uno ajeno BAD_REQUEST, sin agendar', async () => {
    const { tools, scheduler } = setup();
    // Bien formado para el provider pero sin slot detras: lo rechaza el repo.
    await expect(
      tools.book_appointment({ providerId: 'prov_miami_01', slotId: 'prov_miami_01#2030-01-01T00:00:00.000Z', patientRef: 'p1' }),
    ).resolves.toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    // Sin el prefijo del provider: se rechaza antes de tocar el repo.
    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: 'basura', patientRef: 'p1' })).resolves.toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
    });
    expect(scheduler.scheduled.size).toBe(0);
  });

  it('cancel y reschedule devuelven NOT_FOUND para un turno inexistente', async () => {
    const { tools } = setup();
    await expect(tools.cancel_appointment({ appointmentId: 'apt_nope', patientRef: 'p1' })).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await expect(
      tools.reschedule_appointment({ appointmentId: 'apt_nope', newSlotId: 'x#y', patientRef: 'p1' }),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('reschedule_appointment a un slot ocupado devuelve SLOT_TAKEN y deja el turno y sus recordatorios intactos', async () => {
    const { tools, scheduler } = setup();
    const avail = await tools.get_availability({ providerId: 'prov_miami_01' });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    const [a, b] = avail.slots;
    const booked = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'p1' });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    await tools.book_appointment({ providerId: 'prov_miami_01', slotId: b.slotId, patientRef: 'p2' });
    const before = [...scheduler.scheduled.keys()];

    const moved = await tools.reschedule_appointment({ appointmentId: booked.appointment.appointmentId, newSlotId: b.slotId, patientRef: 'p1' });

    expect(moved).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    expect([...scheduler.scheduled.keys()]).toEqual(before);
    // el slot original sigue tomado por el turno
    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'p3' })).resolves.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('cancelar libera el slot para que otro paciente lo reserve', async () => {
    const { tools } = setup();
    const avail = await tools.get_availability({ providerId: 'prov_miami_01' });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    const slotId = avail.slots[0].slotId;
    const booked = await tools.book_appointment({ providerId: 'prov_miami_01', slotId, patientRef: 'p1' });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    await tools.cancel_appointment({ appointmentId: booked.appointment.appointmentId, patientRef: 'p1' });
    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId, patientRef: 'p2' })).resolves.toMatchObject({ ok: true });
  });
});

describe('reschedule con el scheduler real y reloj congelado', () => {
  class Recorder implements SchedulerClientLike {
    readonly commands: Array<CreateScheduleCommand | DeleteScheduleCommand> = [];
    async send(c: CreateScheduleCommand | DeleteScheduleCommand) {
      this.commands.push(c);
      return {};
    }
  }
  const DAY = 86_400_000;

  async function twoReschedules() {
    const client = new Recorder();
    const repo = new DynamoRepo(CATALOG, APPOINTMENTS, new FakeDocClient(buildCatalogItems(now)));
    let seq = 0;
    const tools = createTools({
      repo,
      scheduler: new EventBridgeReminderScheduler('g', 'arn:l', 'arn:r', client),
      reminders: { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 },
      now: () => now,
      newId: () => (seq++).toString(16).padEnd(32, '0'), // determinista: los 4 primeros hex cambian en cada llamada
    });
    const avail = await tools.get_availability({ providerId: 'prov_miami_01', fromDate: new Date(now.getTime() + 3 * DAY).toISOString(), limit: 3 });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');
    const [s0, s1, s2] = avail.slots;
    const booked = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: s0.slotId, patientRef: 'p1' });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    const id = booked.appointment.appointmentId;
    const r1 = await tools.reschedule_appointment({ appointmentId: id, newSlotId: s1.slotId, patientRef: 'p1' });
    const r2 = await tools.reschedule_appointment({ appointmentId: id, newSlotId: s2.slotId, patientRef: 'p1' });
    return { client, booked, r1, r2 };
  }

  it('dos reprogramaciones en el mismo instante usan nombres distintos y crean los nuevos antes de borrar los viejos', async () => {
    const { client, booked, r1, r2 } = await twoReschedules();
    if (!booked.ok || !r1.ok || !r2.ok || !('appointment' in booked) || !('appointment' in r1) || !('appointment' in r2)) {
      throw new Error('reschedule fallo');
    }

    // Con now congelado el epoch se repite: el sufijo aleatorio evita el ConflictException de Scheduler.
    const names1 = r1.appointment.reminderScheduleNames;
    const names2 = r2.appointment.reminderScheduleNames;
    expect(names2).not.toEqual(names1);
    expect([...names1, ...names2].every((n) => /-r\d+-[0-9a-f]{4}$/.test(n) && n.length <= 64)).toBe(true);

    // Segunda reprogramacion: crea names2 y recien despues borra names1.
    const second = client.commands.slice(-4);
    expect(second.slice(0, 2).map((c) => (c as CreateScheduleCommand).input.Name)).toEqual(names2);
    expect(second.slice(2).map((c) => (c as DeleteScheduleCommand).input.Name)).toEqual(names1);
    // Primera reprogramacion: borra los nombres del booking original, sin sufijo.
    const first = client.commands.slice(-8, -4);
    expect(first.slice(2).map((c) => (c as DeleteScheduleCommand).input.Name)).toEqual(booked.appointment.reminderScheduleNames);
  });
});

describe('tools: fallas del scheduler y entradas invalidas (riesgos)', () => {
  const failing = {
    scheduled: new Map(),
    schedule: async () => {
      throw new Error('scheduler caido');
    },
    remove: async () => undefined,
  };

  it('book_appointment libera el slot si el scheduler falla, para no perderlo para siempre', async () => {
    const repo = new InMemoryRepo(() => now);
    const tools = createTools({ repo, scheduler: failing, reminders: { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 }, now: () => now });
    const [slot] = await repo.getAvailability('prov_miami_01', now, 1);

    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: slot.slotId, patientRef: 'p1' })).rejects.toThrow('scheduler caido');

    expect((await repo.getAvailability('prov_miami_01', now, 1))[0].slotId).toBe(slot.slotId);
  });

  it('reschedule_appointment conserva slot y recordatorios viejos si el scheduler falla', async () => {
    const repo = new InMemoryRepo(() => now);
    const okScheduler = new InMemoryReminderScheduler();
    const settings = { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 };
    const booked = await createTools({ repo, scheduler: okScheduler, reminders: settings, now: () => now }).book_appointment({
      providerId: 'prov_miami_01',
      slotId: (await repo.getAvailability('prov_miami_01', now, 1))[0].slotId,
      patientRef: 'p1',
    });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    const [newSlot] = await repo.getAvailability('prov_miami_01', now, 1);
    const tools = createTools({ repo, scheduler: failing, reminders: settings, now: () => now });

    await expect(
      tools.reschedule_appointment({ appointmentId: booked.appointment.appointmentId, newSlotId: newSlot.slotId, patientRef: 'p1' }),
    ).rejects.toThrow('scheduler caido');

    const kept = await repo.getAppointment(booked.appointment.appointmentId);
    expect(kept).toMatchObject({ status: 'BOOKED', slotId: booked.appointment.slotId, reminderScheduleNames: booked.appointment.reminderScheduleNames });
    // El slot nuevo vuelve a estar libre y el viejo sigue tomado por este turno.
    const free = (await repo.getAvailability('prov_miami_01', now, 4)).map((s) => s.slotId);
    expect(free).toContain(newSlot.slotId);
    expect(free).not.toContain(booked.appointment.slotId);
  });

  it('get_availability con fromDate invalido devuelve BAD_REQUEST en vez de lanzar', async () => {
    const repo = new DynamoRepo(CATALOG, APPOINTMENTS, new FakeDocClient(buildCatalogItems(now)));
    const tools = createTools({
      repo,
      scheduler: new InMemoryReminderScheduler(),
      reminders: { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 },
      now: () => now,
    });
    await expect(tools.get_availability({ providerId: 'prov_miami_01', fromDate: 'no-es-fecha' })).resolves.toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
    });
  });

  it('get_availability con limit no numerico no pide NaN slots', async () => {
    const { tools } = setup();
    const out = await tools.get_availability({ providerId: 'prov_miami_01', limit: Number('abc') });
    if (!out.ok || !('slots' in out)) throw new Error('availability fallo');
    expect(out.slots).toHaveLength(4); // el default, no 1 ni 0
  });
});

describe('tools: hallazgos de review (status, provider del slot, compensacion)', () => {
  // Modo demo: siempre dos schedules, aunque el primer slot libre sea manana.
  const settings = { demoMode: true, demoMinutes48h: 2, demoMinutes24h: 4 };

  /** InMemoryRepo cuyo putAppointment falla a demanda, para probar la compensacion. */
  class FlakyRepo extends InMemoryRepo {
    failPut = false;
    override async putAppointment(appointment: Parameters<InMemoryRepo['putAppointment']>[0]) {
      if (this.failPut) throw new Error('dynamo caido');
      return super.putAppointment(appointment);
    }
  }

  function setupFlaky() {
    const repo = new FlakyRepo(() => now);
    const scheduler = new InMemoryReminderScheduler();
    const warnings: string[] = [];
    const tools = createTools({ repo, scheduler, reminders: settings, now: () => now, log: (l) => warnings.push(l) });
    return { repo, scheduler, tools, warnings };
  }

  async function freeSlots(repo: InMemoryRepo, providerId = 'prov_miami_01') {
    return (await repo.getAvailability(providerId, now, 50)).map((s) => s.slotId);
  }

  async function book(tools: ReturnType<typeof createTools>, repo: InMemoryRepo, patientRef = 'p1') {
    const [slot] = await repo.getAvailability('prov_miami_01', now, 1);
    const out = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: slot.slotId, patientRef });
    if (!out.ok || !('appointment' in out)) throw new Error('book fallo');
    return out.appointment;
  }

  it('cancelar dos veces no libera el slot que ya tomo otro paciente', async () => {
    const { tools, repo } = setupFlaky();
    const a = await book(tools, repo, 'A');
    await tools.cancel_appointment({ appointmentId: a.appointmentId, patientRef: 'A' });
    const b = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'B' });
    expect(b).toMatchObject({ ok: true });

    const again = await tools.cancel_appointment({ appointmentId: a.appointmentId, patientRef: 'A' });

    expect(again).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await freeSlots(repo)).not.toContain(a.slotId);
  });

  it('reservar dos veces el mismo slot devuelve el turno existente sin agendar de nuevo', async () => {
    const { tools, repo, scheduler } = setupFlaky();
    const a = await book(tools, repo, 'A');
    const schedules = scheduler.scheduled.size;

    const again = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'A' });

    expect(again).toMatchObject({ ok: true, appointment: { appointmentId: a.appointmentId, status: 'BOOKED' }, provider: { providerId: 'prov_miami_01' } });
    expect(scheduler.scheduled.size).toBe(schedules);
  });

  it('el slot reservado por otro paciente sigue siendo SLOT_TAKEN', async () => {
    const { tools, repo } = setupFlaky();
    const a = await book(tools, repo, 'A');

    const other = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'B' });

    expect(other).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
  });

  it('un turno propio cancelado en ese slot no cuenta como reserva existente', async () => {
    const { tools, repo } = setupFlaky();
    const a = await book(tools, repo, 'A');
    await tools.cancel_appointment({ appointmentId: a.appointmentId, patientRef: 'A' });
    await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'B' });

    const again = await tools.book_appointment({ providerId: 'prov_miami_01', slotId: a.slotId, patientRef: 'A' });

    expect(again).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
  });

  it('reprogramar un turno cancelado devuelve BAD_REQUEST y no lo revive', async () => {
    const { tools, repo } = setupFlaky();
    const a = await book(tools, repo);
    await tools.cancel_appointment({ appointmentId: a.appointmentId, patientRef: 'p1' });
    const [other] = await repo.getAvailability('prov_miami_01', now, 1);

    const out = await tools.reschedule_appointment({ appointmentId: a.appointmentId, newSlotId: other.slotId, patientRef: 'p1' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await repo.getAppointment(a.appointmentId)).toMatchObject({ status: 'CANCELLED' });
    expect(await freeSlots(repo)).toContain(other.slotId);
  });

  it('no reserva un slot de otro provider y lo deja libre', async () => {
    const { tools, repo, scheduler } = setupFlaky();
    const providers = await repo.searchProviders('rhinoplasty', 'miami', 5);
    const [a, b] = providers.map((p) => p.providerId);
    expect(a).not.toEqual(b);
    const [slotOfB] = await repo.getAvailability(b, now, 1);

    const out = await tools.book_appointment({ providerId: a, slotId: slotOfB.slotId, patientRef: 'p1' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await freeSlots(repo, b)).toContain(slotOfB.slotId);
    expect(scheduler.scheduled.size).toBe(0);
  });

  it('no reprograma hacia un slot de otro provider', async () => {
    const { tools, repo } = setupFlaky();
    const appt = await book(tools, repo);
    const other = (await repo.searchProviders('rhinoplasty', 'miami', 5)).find((p) => p.providerId !== appt.providerId)!;
    const [slotOfOther] = await repo.getAvailability(other.providerId, now, 1);

    const out = await tools.reschedule_appointment({ appointmentId: appt.appointmentId, newSlotId: slotOfOther.slotId, patientRef: 'p1' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await repo.getAppointment(appt.appointmentId)).toMatchObject({ status: 'BOOKED', slotId: appt.slotId });
    expect(await freeSlots(repo, other.providerId)).toContain(slotOfOther.slotId);
  });

  it('si falla guardar la reserva, borra los schedules creados y libera el slot', async () => {
    const { tools, repo, scheduler } = setupFlaky();
    const [slot] = await repo.getAvailability('prov_miami_01', now, 1);
    repo.failPut = true;

    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: slot.slotId, patientRef: 'p1' })).rejects.toThrow('dynamo caido');

    expect(scheduler.scheduled.size).toBe(0);
    expect(await freeSlots(repo)).toContain(slot.slotId);
  });

  it('libera el slot aunque borrar los schedules tambien falle, y loguea el aviso', async () => {
    const repo = new InMemoryRepo(() => now);
    const warnings: string[] = [];
    const down = {
      schedule: async () => {
        throw new Error('scheduler caido');
      },
      remove: async () => {
        throw new Error('scheduler sigue caido');
      },
    };
    const tools = createTools({ repo, scheduler: down, reminders: settings, now: () => now, log: (l) => warnings.push(l) });
    const [slot] = await repo.getAvailability('prov_miami_01', now, 1);

    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: slot.slotId, patientRef: 'p1' })).rejects.toThrow('scheduler caido');

    expect(await freeSlots(repo)).toContain(slot.slotId);
    expect(warnings.some((w) => w.includes('scheduler sigue caido'))).toBe(true);
  });

  it('si falla guardar la cancelacion, el turno sigue activo y el slot tomado', async () => {
    const { tools, repo, scheduler } = setupFlaky();
    const appt = await book(tools, repo);
    repo.failPut = true;

    await expect(tools.cancel_appointment({ appointmentId: appt.appointmentId, patientRef: 'p1' })).rejects.toThrow('dynamo caido');

    expect(await repo.getAppointment(appt.appointmentId)).toMatchObject({ status: 'BOOKED', reminderScheduleNames: appt.reminderScheduleNames });
    expect(await freeSlots(repo)).not.toContain(appt.slotId);
    expect(scheduler.scheduled.size).toBe(2);
  });

  it('reprogramar sigue siendo exito aunque no se puedan borrar los schedules viejos', async () => {
    const repo = new InMemoryRepo(() => now);
    const inner = new InMemoryReminderScheduler();
    let failRemove = false;
    const scheduler = {
      schedule: (id: string, plans: Parameters<InMemoryReminderScheduler['schedule']>[1]) => inner.schedule(id, plans),
      remove: async (names: string[]) => {
        if (failRemove) throw new Error('scheduler caido');
        return inner.remove(names);
      },
    };
    const warnings: string[] = [];
    const tools = createTools({ repo, scheduler, reminders: settings, now: () => now, log: (l) => warnings.push(l) });
    const appt = await book(tools, repo);
    const [newSlot] = await repo.getAvailability('prov_miami_01', now, 1);
    failRemove = true;

    const out = await tools.reschedule_appointment({ appointmentId: appt.appointmentId, newSlotId: newSlot.slotId, patientRef: 'p1' });

    expect(out).toMatchObject({ ok: true, appointment: { status: 'RESCHEDULED', slotId: newSlot.slotId } });
    const free = await freeSlots(repo);
    expect(free).toContain(appt.slotId);
    expect(free).not.toContain(newSlot.slotId);
    expect(warnings).toHaveLength(1);
  });

  it('valida tipos de los argumentos antes de tocar el repo', async () => {
    const { tools } = setupFlaky();
    await expect(tools.get_availability({ providerId: 123 as unknown as string })).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    await expect(tools.search_providers({ procedure: ['x'] as unknown as string, city: 'miami' })).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    await expect(tools.cancel_appointment({ appointmentId: '', patientRef: 'p1' })).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    await expect(tools.book_appointment({ providerId: 'prov_miami_01', slotId: {} as unknown as string, patientRef: 'p1' })).resolves.toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
    });
  });

  it('usa newId para el appointmentId (16 hex) y el sufijo de reprogramacion', async () => {
    const repo = new InMemoryRepo(() => now);
    const ids = ['0123456789abcdef0123456789abcdef', 'ffff0000ffff0000ffff0000ffff0000'];
    const tools = createTools({ repo, scheduler: new InMemoryReminderScheduler(), reminders: settings, now: () => now, newId: () => ids.shift()! });
    const appt = await book(tools, repo);
    expect(appt.appointmentId).toBe('apt_0123456789abcdef');
    const [newSlot] = await repo.getAvailability('prov_miami_01', now, 1);

    const out = await tools.reschedule_appointment({ appointmentId: appt.appointmentId, newSlotId: newSlot.slotId, patientRef: 'p1' });

    if (!out.ok || !('appointment' in out)) throw new Error('reschedule fallo');
    expect(out.appointment.reminderScheduleNames).toEqual([`apt_0123456789abcdef-t48-r${now.getTime()}-ffff`, `apt_0123456789abcdef-t24-r${now.getTime()}-ffff`]);
  });

  it('el handler responde INTERNAL sin filtrar el mensaje del SDK ni el stack', async () => {
    const { tools } = setupFlaky();
    const sdkError = Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), { name: 'AccessDeniedException' });
    tools.search_providers = async () => {
      throw sdkError;
    };
    const lines: string[] = [];
    const handler = createGatewayHandler(tools, (l) => void lines.push(l));
    const ctx = { awsRequestId: 'req-1', clientContext: { custom: { bedrockAgentCoreToolName: 'tools___search_providers' } } } as unknown as Context;

    const out = await handler({ procedure: 'rhinoplasty', city: 'miami' }, ctx);

    expect(out).toEqual({ ok: false, error: 'Error interno', code: 'INTERNAL' });
    expect(JSON.stringify(out)).not.toMatch(/arn:|123456789012/);
    const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.level === 'error');
    expect(errorLine).toMatchObject({ tool: 'search_providers', requestId: 'req-1', errorName: 'AccessDeniedException' });
    expect(JSON.stringify(errorLine)).not.toMatch(/arn:|at |\.ts:/);
  });

  it('el handler trata un evento nulo como vacio y responde BAD_REQUEST, sin lanzar', async () => {
    const { tools } = setupFlaky();
    const handler = createGatewayHandler(tools, () => undefined);
    const ctx = { clientContext: { custom: { bedrockAgentCoreToolName: 'tools___search_providers' } } } as unknown as Context;

    await expect(handler(null, ctx)).resolves.toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });
});
