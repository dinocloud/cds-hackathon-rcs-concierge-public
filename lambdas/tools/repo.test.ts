import type { Appointment } from '../shared/contracts';
import { buildCatalogItems } from '../../scripts/seed-synthetic-data';
import { createTools } from './index';
import { APPOINTMENTS, CATALOG, FakeDocClient, Item } from './fake-doc-client';
import { InMemoryReminderScheduler } from './reminders';
import { DocClientLike, DynamoRepo, InMemoryRepo, Repo, SlotUnavailableError, slotKey } from './repo';

const now = new Date('2026-10-26T12:00:00Z');

function dynamoRepo() {
  const doc = new FakeDocClient(buildCatalogItems(now));
  return { repo: new DynamoRepo(CATALOG, APPOINTMENTS, doc), doc };
}

// El mismo contrato tiene que valer para los dos repos: el modo local y el desplegado no pueden divergir.
describe.each<[string, () => { repo: Repo; setPhone: (ref: string, phone: string) => void }]>([
  [
    'InMemoryRepo',
    () => {
      const repo = new InMemoryRepo(() => now);
      return { repo, setPhone: (ref, phone) => repo.setContactPhone(ref, phone) };
    },
  ],
  [
    'DynamoRepo',
    () => {
      const { repo, doc } = dynamoRepo();
      const setPhone = (ref: string, phone: string) =>
        doc.tables.get(APPOINTMENTS)!.set(`CONTACT#${ref}`, { appointmentId: `CONTACT#${ref}`, phone });
      return { repo, setPhone };
    },
  ],
])('contrato de Repo: %s', (_name, make) => {
  const makeRepo = () => make().repo;

  it('busca por procedimiento y ciudad sin importar mayusculas, ordenado por rating', async () => {
    const providers = await makeRepo().searchProviders(' Rhinoplasty ', 'MIAMI', 5);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((p) => p.city === 'Miami' && p.procedures.includes('rhinoplasty'))).toBe(true);
    const ratings = providers.map((p) => p.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    expect(providers[0]).not.toHaveProperty('pk');
    expect(providers[0]).not.toHaveProperty('procedureCity');
  });

  it('devuelve el provider por id o undefined', async () => {
    const repo = makeRepo();
    await expect(repo.getProvider('prov_miami_01')).resolves.toMatchObject({ providerId: 'prov_miami_01', city: 'Miami' });
    await expect(repo.getProvider('prov_nope_99')).resolves.toBeUndefined();
  });

  it('lista slots libres posteriores a from, en orden y con limite', async () => {
    const repo = makeRepo();
    const all = await repo.getAvailability('prov_miami_01', now, 4);
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.startsAt)).toEqual([...all.map((s) => s.startsAt)].sort());
    expect(all[0]).not.toHaveProperty('sk');

    // from igual a un slot: ese slot no se incluye.
    const later = await repo.getAvailability('prov_miami_01', new Date(all[0].startsAt), 4);
    expect(later[0].slotId).toBe(all[1].slotId);
  });

  it('toma un slot una sola vez y lo libera', async () => {
    const repo = makeRepo();
    const [slot] = await repo.getAvailability('prov_miami_01', now, 1);
    await expect(repo.takeSlot(slot.slotId)).resolves.toMatchObject({ slotId: slot.slotId, available: false });
    await expect(repo.takeSlot(slot.slotId)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect((await repo.getAvailability('prov_miami_01', now, 1))[0].slotId).not.toBe(slot.slotId);

    await repo.releaseSlot(slot.slotId);
    expect((await repo.getAvailability('prov_miami_01', now, 1))[0].slotId).toBe(slot.slotId);
  });

  it('un slot inexistente no se puede tomar y liberarlo no falla', async () => {
    const repo = makeRepo();
    await expect(repo.takeSlot('prov_miami_01#2030-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(repo.takeSlot('basura')).rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(repo.releaseSlot('prov_miami_01#2030-01-01T00:00:00.000Z')).resolves.toBeUndefined();
  });

  it('devuelve el telefono de contacto si existe y undefined si no', async () => {
    const { repo, setPhone } = make();
    setPhone('ref-1', '+15555550100');
    await expect(repo.getContactPhone('ref-1')).resolves.toBe('+15555550100');
    await expect(repo.getContactPhone('ref-nope')).resolves.toBeUndefined();
  });

  it('guarda y lee turnos', async () => {
    const repo = makeRepo();
    const appt: Appointment = {
      appointmentId: 'apt_test',
      patientRef: 'ref-1',
      providerId: 'prov_miami_01',
      slotId: 'prov_miami_01#2026-10-27T14:00:00.000Z',
      startsAt: '2026-10-27T14:00:00.000Z',
      status: 'BOOKED',
      reminderScheduleNames: ['apt_test-t48', 'apt_test-t24'],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await repo.putAppointment(appt);
    await expect(repo.getAppointment('apt_test')).resolves.toEqual(appt);
    await expect(repo.getAppointment('apt_nope')).resolves.toBeUndefined();
  });
});

describe('DynamoRepo', () => {
  it('escribe patientHash para el GSI by-patient y no confunde items CONTACT# con turnos', async () => {
    const { repo, doc } = dynamoRepo();
    await repo.putAppointment({
      appointmentId: 'apt_1',
      patientRef: 'ref-1',
      providerId: 'prov_miami_01',
      slotId: 's',
      startsAt: '2026-10-27T14:00:00.000Z',
      status: 'BOOKED',
      reminderScheduleNames: [],
      createdAt: '',
      updatedAt: '',
    });
    expect(doc.tables.get(APPOINTMENTS)!.get('apt_1')).toMatchObject({ patientHash: 'ref-1' });

    doc.tables.get(APPOINTMENTS)!.set('CONTACT#ref-1', { appointmentId: 'CONTACT#ref-1', phone: '+15555550100' });
    await expect(repo.getAppointment('CONTACT#ref-1')).resolves.toBeUndefined();
  });

  it('ignora un CONTACT# sin phone de tipo string', async () => {
    const { repo, doc } = dynamoRepo();
    doc.tables.get(APPOINTMENTS)!.set('CONTACT#ref-2', { appointmentId: 'CONTACT#ref-2', phone: 123 });
    await expect(repo.getContactPhone('ref-2')).resolves.toBeUndefined();
  });

  it('arma las keys del slot desde el slotId', () => {
    expect(slotKey('prov_miami_01#2026-10-27T14:00:00.000Z')).toEqual({
      pk: 'PROVIDER#prov_miami_01',
      sk: 'SLOT#2026-10-27T14:00:00.000Z',
    });
    expect(slotKey('sin-separador')).toBeUndefined();
    expect(slotKey('#2026')).toBeUndefined();
  });

  it('takeSlot con slotId sin # falla como SLOT_TAKEN y releaseSlot lo ignora, sin llamar a DynamoDB', async () => {
    // Arrange
    const send = jest.fn(async () => ({}));
    const repo = new DynamoRepo(CATALOG, APPOINTMENTS, { send });
    // Act + Assert
    await expect(repo.takeSlot('sin-separador')).rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(repo.takeSlot('prov_miami_01#')).rejects.toBeInstanceOf(SlotUnavailableError);
    await expect(repo.releaseSlot('sin-separador')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  describe('getAvailability con paginacion (LastEvaluatedKey)', () => {
    const slotItem = (n: number) => ({
      pk: 'PROVIDER#prov_miami_01',
      sk: `SLOT#2026-11-0${n}T14:00:00.000Z`,
      slotId: `prov_miami_01#2026-11-0${n}T14:00:00.000Z`,
      providerId: 'prov_miami_01',
      startsAt: `2026-11-0${n}T14:00:00.000Z`,
      durationMinutes: 30,
      available: true,
    });
    /** Responde una pagina por llamada y registra el ExclusiveStartKey recibido. */
    function pagedDoc(pages: Array<{ Items: Item[]; LastEvaluatedKey?: Item }>) {
      const startKeys: unknown[] = [];
      let call = 0;
      const doc: DocClientLike = {
        send: async (command) => {
          startKeys.push((command.input as { ExclusiveStartKey?: unknown }).ExclusiveStartKey);
          return pages[call++] ?? { Items: [] };
        },
      };
      return { doc, startKeys, calls: () => call };
    }
    const from = new Date('2026-10-26T12:00:00Z');

    it('sigue con la segunda pagina si la primera vino vacia por el filtro y reenvia la key', async () => {
      const lek = { pk: 'PROVIDER#prov_miami_01', sk: 'SLOT#x' };
      const t = pagedDoc([{ Items: [], LastEvaluatedKey: lek }, { Items: [slotItem(2), slotItem(3)] }]);
      const slots = await new DynamoRepo(CATALOG, APPOINTMENTS, t.doc).getAvailability('prov_miami_01', from, 4);
      expect(slots.map((s) => s.startsAt)).toEqual([slotItem(2).startsAt, slotItem(3).startsAt]);
      expect(t.startKeys).toEqual([undefined, lek]);
    });

    it('junta slots de varias paginas y recorta a limit sin pedir paginas de mas', async () => {
      const lek = { pk: 'PROVIDER#prov_miami_01', sk: 'SLOT#x' };
      const t = pagedDoc([
        { Items: [slotItem(2)], LastEvaluatedKey: lek },
        { Items: [slotItem(3), slotItem(4)], LastEvaluatedKey: lek },
        { Items: [slotItem(5)] },
      ]);
      const slots = await new DynamoRepo(CATALOG, APPOINTMENTS, t.doc).getAvailability('prov_miami_01', from, 2);
      expect(slots).toHaveLength(2);
      expect(slots.map((s) => s.slotId)).toEqual([slotItem(2).slotId, slotItem(3).slotId]);
      expect(t.calls()).toBe(2);
      expect(slots[0]).not.toHaveProperty('sk');
    });

    it('termina cuando no hay LastEvaluatedKey aunque no junte limit', async () => {
      const t = pagedDoc([{ Items: [slotItem(2)] }]);
      const slots = await new DynamoRepo(CATALOG, APPOINTMENTS, t.doc).getAvailability('prov_miami_01', from, 4);
      expect(slots).toHaveLength(1);
      expect(t.calls()).toBe(1);
    });

    it('descarta el slot que empieza exactamente en from aunque BETWEEN lo incluya', async () => {
      const t = pagedDoc([{ Items: [slotItem(2), slotItem(3)] }]);
      const slots = await new DynamoRepo(CATALOG, APPOINTMENTS, t.doc).getAvailability('prov_miami_01', new Date(slotItem(2).startsAt), 4);
      expect(slots.map((s) => s.slotId)).toEqual([slotItem(3).slotId]);
    });
  });

  it('propaga errores de DynamoDB que no son de condicion', async () => {
    const doc: DocClientLike = { send: async () => Promise.reject(Object.assign(new Error('boom'), { name: 'ThrottlingException' })) };
    const repo = new DynamoRepo(CATALOG, APPOINTMENTS, doc);
    await expect(repo.takeSlot('prov_miami_01#2026-10-27T14:00:00.000Z')).rejects.toThrow('boom');
    await expect(repo.releaseSlot('prov_miami_01#2026-10-27T14:00:00.000Z')).rejects.toThrow('boom');
  });

  it('findAppointmentsBySlot consulta el GSI by-patient, filtra por slotId y saca patientHash', async () => {
    const { repo, doc } = dynamoRepo();
    const base = {
      patientRef: 'ref-1',
      providerId: 'prov_miami_01',
      startsAt: '2026-10-27T14:00:00.000Z',
      status: 'BOOKED' as const,
      reminderScheduleNames: [],
      createdAt: '',
      updatedAt: '',
    };
    await repo.putAppointment({ ...base, appointmentId: 'apt_1', slotId: 'prov_miami_01#2026-10-27T14:00:00.000Z' });
    // Mismo paciente y misma hora con otro provider: no es ese slot.
    await repo.putAppointment({ ...base, appointmentId: 'apt_2', providerId: 'prov_miami_02', slotId: 'prov_miami_02#2026-10-27T14:00:00.000Z' });
    await repo.putAppointment({ ...base, appointmentId: 'apt_3', patientRef: 'ref-2', slotId: 'prov_miami_01#2026-10-27T14:00:00.000Z' });
    const send = jest.spyOn(doc, 'send');

    const found = await repo.findAppointmentsBySlot('ref-1', 'prov_miami_01#2026-10-27T14:00:00.000Z');

    expect(found.map((a) => a.appointmentId)).toEqual(['apt_1']);
    expect(found[0]).not.toHaveProperty('patientHash');
    expect(send.mock.calls[0][0].input).toMatchObject({ IndexName: 'by-patient', ExpressionAttributeValues: { ':p': 'ref-1', ':s': '2026-10-27T14:00:00.000Z' } });
  });

  it('findAppointmentsBySlot con un slotId sin # devuelve [] sin llamar a DynamoDB', async () => {
    const { repo, doc } = dynamoRepo();
    const send = jest.spyOn(doc, 'send');
    await expect(repo.findAppointmentsBySlot('ref-1', 'basura')).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('flujo de las tools de punta a punta sobre DynamoDB', async () => {
    const scheduler = new InMemoryReminderScheduler();
    const tools = createTools({
      repo: dynamoRepo().repo,
      scheduler,
      reminders: { demoMode: true, demoMinutes48h: 2, demoMinutes24h: 4 },
      now: () => now,
    });

    const search = await tools.search_providers({ procedure: 'rhinoplasty', city: 'Miami' });
    if (!search.ok || !('providers' in search)) throw new Error('search fallo');
    const avail = await tools.get_availability({ providerId: search.providers[0].providerId });
    if (!avail.ok || !('slots' in avail)) throw new Error('availability fallo');

    const booked = await tools.book_appointment({ providerId: avail.providerId, slotId: avail.slots[0].slotId, patientRef: 'p1' });
    if (!booked.ok || !('appointment' in booked)) throw new Error('book fallo');
    await expect(
      tools.book_appointment({ providerId: avail.providerId, slotId: avail.slots[0].slotId, patientRef: 'p2' }),
    ).resolves.toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    // Reintento del mismo paciente: el turno existente, no SLOT_TAKEN.
    await expect(
      tools.book_appointment({ providerId: avail.providerId, slotId: avail.slots[0].slotId, patientRef: 'p1' }),
    ).resolves.toMatchObject({ ok: true, appointment: { appointmentId: booked.appointment.appointmentId } });

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
