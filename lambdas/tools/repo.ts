/**
 * Acceso a datos de las tools (owner: Pablo).
 * - InMemoryRepo: datos sinteticos en memoria (tests y modo local).
 * - DynamoRepo: tablas catalog y appointments (keys en infra/lib/data-stack.ts).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Appointment, Provider, Slot } from '../shared/contracts';
import { syntheticProviders, syntheticSlots } from './synthetic-data';

export interface Repo {
  searchProviders(procedure: string, city: string, limit: number): Promise<Provider[]>;
  getProvider(providerId: string): Promise<Provider | undefined>;
  getAvailability(providerId: string, from: Date, limit: number): Promise<Slot[]>;
  /** Marca el slot como tomado; falla si ya no esta libre (condicional en Dynamo). */
  takeSlot(slotId: string): Promise<Slot>;
  releaseSlot(slotId: string): Promise<void>;
  putAppointment(appointment: Appointment): Promise<void>;
  getAppointment(appointmentId: string): Promise<Appointment | undefined>;
  /** Turnos del paciente en ese slot (cualquier estado), por el GSI by-patient. */
  findAppointmentsBySlot(patientRef: string, slotId: string): Promise<Appointment[]>;
  /** Telefono del item CONTACT#<patientRef> que escribe inbound-router. */
  getContactPhone(patientRef: string): Promise<string | undefined>;
}

export class SlotUnavailableError extends Error {
  constructor(readonly slotId: string) {
    // Mensaje generico: va de vuelta al modelo, no se le devuelve su propio input.
    super('El horario ya no esta disponible');
    this.name = 'SlotUnavailableError';
  }
}

export class InMemoryRepo implements Repo {
  private readonly providers = syntheticProviders();
  private readonly slots = new Map<string, Slot>();
  private readonly appointments = new Map<string, Appointment>();
  private readonly contactPhones = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {
    for (const p of this.providers) {
      for (const s of syntheticSlots(p.providerId, this.now())) this.slots.set(s.slotId, s);
    }
  }

  async searchProviders(procedure: string, city: string, limit: number) {
    const proc = procedure.trim().toLowerCase();
    const c = city.trim().toLowerCase();
    return this.providers
      .filter((p) => p.city.toLowerCase() === c && p.procedures.includes(proc))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  async getProvider(providerId: string) {
    return this.providers.find((p) => p.providerId === providerId);
  }

  async getAvailability(providerId: string, from: Date, limit: number) {
    return [...this.slots.values()]
      .filter((s) => s.providerId === providerId && s.available && new Date(s.startsAt) > from)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, limit);
  }

  async takeSlot(slotId: string) {
    const slot = this.slots.get(slotId);
    if (!slot || !slot.available) throw new SlotUnavailableError(slotId);
    slot.available = false;
    return { ...slot };
  }

  async releaseSlot(slotId: string) {
    const slot = this.slots.get(slotId);
    if (slot) slot.available = true;
  }

  async putAppointment(appointment: Appointment) {
    this.appointments.set(appointment.appointmentId, { ...appointment });
  }

  async getAppointment(appointmentId: string) {
    const a = this.appointments.get(appointmentId);
    return a ? { ...a } : undefined;
  }

  async findAppointmentsBySlot(patientRef: string, slotId: string) {
    return [...this.appointments.values()].filter((a) => a.patientRef === patientRef && a.slotId === slotId).map((a) => ({ ...a }));
  }

  async getContactPhone(patientRef: string) {
    return this.contactPhones.get(patientRef);
  }

  /** Solo para tests y modo local: en AWS el item CONTACT# lo escribe inbound-router. */
  setContactPhone(patientRef: string, phone: string) {
    this.contactPhones.set(patientRef, phone);
  }
}

// ---------- DynamoDB ----------

/** Lo minimo del DocumentClient que usamos: permite inyectar un fake en los tests. */
export interface DocClientLike {
  send(command: GetCommand | PutCommand | QueryCommand | UpdateCommand): Promise<Record<string, unknown>>;
}

type Item = Record<string, unknown>;

export const providerKey = (providerId: string) => ({ pk: `PROVIDER#${providerId}`, sk: 'PROFILE' });

/** Valor del GSI by-procedure-city; el seed lo escribe igual (scripts/seed-synthetic-data.ts). */
export const procedureCityKey = (procedure: string, city: string) =>
  `${procedure.trim().toLowerCase()}#${city.trim().toLowerCase()}`;

/** slotId = "<providerId>#<startsAt ISO>" (synthetic-data.ts): de ahi salen pk y sk del slot. */
export function slotKey(slotId: string): { pk: string; sk: string } | undefined {
  const i = slotId.indexOf('#');
  if (i <= 0 || i === slotId.length - 1) return undefined;
  return { pk: `PROVIDER#${slotId.slice(0, i)}`, sk: `SLOT#${slotId.slice(i + 1)}` };
}

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

function toProvider(item: Item): Provider {
  const { pk: _pk, sk: _sk, procedureCity: _pc, ...provider } = item;
  return provider as unknown as Provider;
}

function toSlot(item: Item): Slot {
  const { pk: _pk, sk: _sk, ...slot } = item;
  return slot as unknown as Slot;
}

export class DynamoRepo implements Repo {
  constructor(
    readonly catalogTable: string,
    readonly appointmentsTable: string,
    // Sin removeUndefinedValues, un turno sin `procedure` no se puede serializar y falla el Put.
    private readonly doc: DocClientLike = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ) {}

  async searchProviders(procedure: string, city: string, limit: number) {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.catalogTable,
        IndexName: 'by-procedure-city',
        KeyConditionExpression: 'procedureCity = :pc',
        ExpressionAttributeValues: { ':pc': procedureCityKey(procedure, city) },
        ScanIndexForward: false, // rating de mayor a menor
        Limit: limit,
      }),
    );
    return ((out.Items as Item[] | undefined) ?? []).map(toProvider);
  }

  async getProvider(providerId: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.catalogTable, Key: providerKey(providerId) }));
    return out.Item ? toProvider(out.Item as Item) : undefined;
  }

  async getAvailability(providerId: string, from: Date, limit: number) {
    // El filtro de available se aplica despues del Limit de DynamoDB: se pagina hasta juntar `limit`.
    const slots: Slot[] = [];
    let startKey: QueryCommandInput['ExclusiveStartKey'];
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.catalogTable,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          FilterExpression: 'available = :yes',
          ExpressionAttributeValues: {
            ':pk': `PROVIDER#${providerId}`,
            ':from': `SLOT#${from.toISOString()}`,
            ':to': 'SLOT#\uffff', // U+FFFF: cota superior del rango de slots
            ':yes': true,
          },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of (out.Items as Item[] | undefined) ?? []) {
        const slot = toSlot(item);
        // BETWEEN incluye el borde; InMemoryRepo usa "despues de from".
        if (new Date(slot.startsAt) > from) slots.push(slot);
      }
      startKey = out.LastEvaluatedKey as QueryCommandInput['ExclusiveStartKey'];
    } while (startKey && slots.length < limit);
    return slots.slice(0, limit);
  }

  async takeSlot(slotId: string) {
    const key = slotKey(slotId);
    if (!key) throw new SlotUnavailableError(slotId);
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.catalogTable,
          Key: key,
          UpdateExpression: 'SET available = :no',
          ConditionExpression: 'available = :yes',
          ExpressionAttributeValues: { ':no': false, ':yes': true },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toSlot(out.Attributes as Item);
    } catch (err) {
      // Lo tomo otro paciente o el slot no existe.
      if (isConditionFailure(err)) throw new SlotUnavailableError(slotId);
      throw err;
    }
  }

  async releaseSlot(slotId: string) {
    const key = slotKey(slotId);
    if (!key) return;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.catalogTable,
          Key: key,
          UpdateExpression: 'SET available = :yes',
          // Sin esto, UpdateItem crearia un slot fantasma si el id no existe.
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':yes': true },
        }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  async putAppointment(appointment: Appointment) {
    // patientHash alimenta el GSI by-patient (el patientRef ya es el hash del telefono).
    await this.doc.send(
      new PutCommand({ TableName: this.appointmentsTable, Item: { ...appointment, patientHash: appointment.patientRef } }),
    );
  }

  async getAppointment(appointmentId: string) {
    // Lectura consistente: una segunda llamada rapida (doble tap, reintento del agente) no puede
    // leer un turno ya cancelado como BOOKED y liberar un slot que ya es de otro paciente.
    const out = await this.doc.send(
      new GetCommand({ TableName: this.appointmentsTable, Key: { appointmentId }, ConsistentRead: true }),
    );
    const item = out.Item as Item | undefined;
    // La tabla tambien guarda items CONTACT#<patientRef> (telefono): no son turnos.
    if (!item || typeof item.providerId !== 'string') return undefined;
    const { patientHash: _ph, ...appointment } = item;
    return appointment as unknown as Appointment;
  }

  async findAppointmentsBySlot(patientRef: string, slotId: string) {
    const startsAt = slotKey(slotId)?.sk.slice('SLOT#'.length);
    if (!startsAt) return [];
    // GSI: lectura eventualmente consistente. Alcanza para el reintento del router (~1 min despues).
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.appointmentsTable,
        IndexName: 'by-patient',
        KeyConditionExpression: 'patientHash = :p AND startsAt = :s',
        ExpressionAttributeValues: { ':p': patientRef, ':s': startsAt },
      }),
    );
    return ((out.Items as Item[] | undefined) ?? [])
      .filter((i) => i.slotId === slotId)
      .map(({ patientHash: _ph, ...appointment }) => appointment as unknown as Appointment);
  }

  async getContactPhone(patientRef: string) {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.appointmentsTable, Key: { appointmentId: `CONTACT#${patientRef}` } }),
    );
    const phone = (out.Item as Item | undefined)?.phone;
    return typeof phone === 'string' ? phone : undefined;
  }
}
