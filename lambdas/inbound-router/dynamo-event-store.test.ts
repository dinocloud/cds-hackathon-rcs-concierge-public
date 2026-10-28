import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APPOINTMENTS, FakeDocClient, Item } from '../tools/fake-doc-client';
import { normalizeEvent } from './events';
import * as fx from './fixtures';
import {
  DynamoEventStore,
  EventKey,
  INBOUND_CLAIM_LEASE_MS,
  MESSAGE_EVENTS_TTL_SECONDS,
  claimStatusFromConditionError,
  inboundClaimKey,
} from './index';
import type { DeliveryEvent } from './events';

const MESSAGE_EVENTS = 'message-events';

const CLAIM_CONDITION = 'attribute_not_exists(messageId) OR (claimStatus = :claimed AND claimedAt < :cutoff)';
const ABSENT_CONDITION = 'attribute_not_exists(messageId)';

/** Formato de `err.Item` cuando falla la condicion: unmarshalled, AttributeValue o ausente. */
type ItemFormat = 'plain' | 'attributeValue' | 'none';

/**
 * FakeDocClient de main (appointments) mas la tabla message-events con las dos
 * ConditionExpression que arma DynamoEventStore. Cualquier otra expresion rompe el test, asi un
 * cambio en la condicion real no pasa desapercibido.
 */
class FakeEventsDocClient extends FakeDocClient {
  itemFormat: ItemFormat = 'plain';
  readonly commands: Array<PutCommand | DeleteCommand> = [];

  constructor() {
    super([]);
    this.tables.set(MESSAGE_EVENTS, new Map());
  }

  private eventsKey(key: Item) {
    return `${key.messageId}|${key.eventTimestamp}`;
  }

  private failCondition(old: Item | undefined, returnOld: boolean): never {
    const Item =
      !returnOld || !old || this.itemFormat === 'none'
        ? undefined
        : this.itemFormat === 'plain'
          ? { ...old }
          : Object.fromEntries(Object.entries(old).map(([k, v]) => [k, typeof v === 'number' ? { N: String(v) } : { S: String(v) }]));
    throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {}, Item: Item as never });
  }

  private conditionHolds(expression: string | undefined, old: Item | undefined, values: Item): boolean {
    if (expression === undefined) return true;
    if (expression === ABSENT_CONDITION) return !old;
    if (expression === CLAIM_CONDITION) {
      return !old || (old.claimStatus === values[':claimed'] && (old.claimedAt as number) < (values[':cutoff'] as number));
    }
    throw new Error(`ConditionExpression no soportada por el fake: ${expression}`);
  }

  async send(command: never): Promise<Record<string, unknown>> {
    const cmd = command as PutCommand | DeleteCommand;
    const input = cmd.input as Item & { TableName: string };
    if (input.TableName !== MESSAGE_EVENTS) return super.send(command);
    this.commands.push(cmd);
    const table = this.tables.get(MESSAGE_EVENTS)!;
    if (cmd instanceof DeleteCommand) {
      table.delete(this.eventsKey(input.Key as Item));
      return {};
    }
    const item = input.Item as Item;
    const old = table.get(this.eventsKey(item));
    const values = (input.ExpressionAttributeValues ?? {}) as Item;
    if (!this.conditionHolds(input.ConditionExpression as string | undefined, old, values)) {
      this.failCondition(old, input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD');
    }
    table.set(this.eventsKey(item), { ...item });
    return {};
  }

  lastPut(): PutCommand['input'] {
    const puts = this.commands.filter((c): c is PutCommand => c instanceof PutCommand);
    return puts[puts.length - 1].input;
  }

  eventsItem(key: EventKey) {
    return this.tables.get(MESSAGE_EVENTS)!.get(this.eventsKey(key as unknown as Item));
  }
}

function setup(start = 1_800_000_000_000) {
  const clock = { now: start };
  const doc = new FakeEventsDocClient();
  const store = new DynamoEventStore(MESSAGE_EVENTS, APPOINTMENTS, doc, () => clock.now);
  return { doc, store, clock };
}

const key: EventKey = inboundClaimKey('in-rcs-0001', 'test-salt');

describe('DynamoEventStore.claimWithLease', () => {
  it('nuevo: acquired con la ConditionExpression real, ALL_OLD, CLAIMED y TTL desde el now() inyectado', async () => {
    const t = setup();
    await expect(t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('acquired');
    expect(t.doc.lastPut()).toMatchObject({
      TableName: MESSAGE_EVENTS,
      ConditionExpression: CLAIM_CONDITION,
      ExpressionAttributeValues: { ':claimed': 'CLAIMED', ':cutoff': t.clock.now - INBOUND_CLAIM_LEASE_MS },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      Item: {
        ...key,
        claimStatus: 'CLAIMED',
        claimedAt: t.clock.now,
        expiresAt: Math.floor(t.clock.now / 1000) + MESSAGE_EVENTS_TTL_SECONDS,
      },
    });
  });

  it('CLAIMED con lease vigente: in_progress; con lease vencido: acquired', async () => {
    const t = setup();
    await t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS);
    await expect(t.store.claimWithLease(key, t.clock.now + INBOUND_CLAIM_LEASE_MS, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('in_progress');
    await expect(t.store.claimWithLease(key, t.clock.now + INBOUND_CLAIM_LEASE_MS + 1, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('acquired');
  });

  describe.each<ItemFormat>(['plain', 'attributeValue'])('err.Item en formato %s', (format) => {
    it.each([
      ['SENDING', 'done'],
      ['DONE', 'done'],
      ['FAILED', 'failed'],
      ['CLAIMED', 'in_progress'],
    ] as const)('%s -> %s, aunque el lease haya vencido', async (status, expected) => {
      const t = setup();
      t.doc.itemFormat = format;
      await t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS);
      if (status !== 'CLAIMED') await t.store.markClaim(key, status, t.clock.now);
      const at = status === 'CLAIMED' ? t.clock.now + 1 : t.clock.now + 10 * INBOUND_CLAIM_LEASE_MS;
      await expect(t.store.claimWithLease(key, at, INBOUND_CLAIM_LEASE_MS)).resolves.toBe(expected);
    });
  });

  it('sin Item en la excepcion: in_progress (se reintenta, no se descarta como duplicado)', async () => {
    const t = setup();
    t.doc.itemFormat = 'none';
    await t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS);
    await t.store.markClaim(key, 'DONE', t.clock.now);
    await expect(t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('in_progress');
  });

  it('ConditionalCheckFailedException por nombre (sin instanceof) tambien se reconoce', async () => {
    const doc = {
      send: async () => {
        throw Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException', Item: { claimStatus: { S: 'FAILED' } } });
      },
    };
    const store = new DynamoEventStore(MESSAGE_EVENTS, APPOINTMENTS, doc, () => 0);
    await expect(store.claimWithLease(key, 0, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('failed');
  });

  it('otro error de DynamoDB se propaga', async () => {
    const doc = { send: async () => Promise.reject(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' })) };
    const store = new DynamoEventStore(MESSAGE_EVENTS, APPOINTMENTS, doc, () => 0);
    await expect(store.claimWithLease(key, 0, INBOUND_CLAIM_LEASE_MS)).rejects.toThrow('throttled');
  });

  it('claimStatusFromConditionError: los dos formatos y sin Item', () => {
    expect(claimStatusFromConditionError({ Item: { claimStatus: 'DONE' } })).toBe('DONE');
    expect(claimStatusFromConditionError({ Item: { claimStatus: { S: 'SENDING' } } })).toBe('SENDING');
    expect(claimStatusFromConditionError({})).toBeUndefined();
  });
});

describe('DynamoEventStore: markClaim, release, claim, entregas y contacto', () => {
  it('markClaim pisa el estado sin condicion; release borra y permite reclamar', async () => {
    const t = setup();
    await t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS);
    await t.store.markClaim(key, 'SENDING', t.clock.now + 5);
    expect(t.doc.lastPut().ConditionExpression).toBeUndefined();
    expect(t.doc.eventsItem(key)).toMatchObject({ claimStatus: 'SENDING', updatedAt: t.clock.now + 5 });
    await t.store.release(key);
    expect(t.doc.eventsItem(key)).toBeUndefined();
    await expect(t.store.claimWithLease(key, t.clock.now, INBOUND_CLAIM_LEASE_MS)).resolves.toBe('acquired');
  });

  it('claim (metricas): put condicional attribute_not_exists, true la primera vez y false despues', async () => {
    const t = setup();
    const metricKey = { messageId: 'out-1', eventTimestamp: 'METRIC#Failed' };
    await expect(t.store.claim(metricKey)).resolves.toBe(true);
    expect(t.doc.lastPut()).toMatchObject({ ConditionExpression: ABSENT_CONDITION, Item: { claimedAt: t.clock.now } });
    await expect(t.store.claim(metricKey)).resolves.toBe(false);
  });

  it('saveDeliveryEvent: deduplica por clave y no guarda el telefono', async () => {
    const t = setup();
    const event = normalizeEvent(JSON.stringify(fx.rcsDelivered)) as DeliveryEvent;
    await expect(t.store.saveDeliveryEvent(event)).resolves.toBe(true);
    await expect(t.store.saveDeliveryEvent(event)).resolves.toBe(false);
    expect(JSON.stringify(t.doc.lastPut().Item)).not.toContain(fx.PATIENT.replace('+', ''));
  });

  it('upsertContact: CONTACT#<ref> en appointments con updatedAt del now() inyectado', async () => {
    const t = setup(Date.UTC(2026, 9, 26, 12));
    await t.store.upsertContact('ref-1', '+15555550100');
    expect(t.doc.tables.get(APPOINTMENTS)!.get('CONTACT#ref-1')).toEqual({
      appointmentId: 'CONTACT#ref-1',
      phone: '+15555550100',
      updatedAt: '2026-10-26T12:00:00.000Z',
    });
  });
});
