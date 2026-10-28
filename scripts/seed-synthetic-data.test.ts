import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { procedureCityKey } from '../lambdas/tools/repo';
import { syntheticProviders, syntheticSlots } from '../lambdas/tools/synthetic-data';
import { BatchWriter, buildCatalogItems, main, writeBatches } from './seed-synthetic-data';

const now = new Date('2026-10-26T12:00:00Z');
const TABLE = 'catalog';

type Request = { PutRequest: { Item: Record<string, unknown> } };

/** BatchWriter fake: guarda cada lote enviado y devuelve como no procesados los que diga `unprocessed`. */
class FakeBatchWriter implements BatchWriter {
  readonly sent: Request[][] = [];
  constructor(private readonly unprocessed: (batch: Request[], call: number) => Request[] = () => []) {}

  async send(command: BatchWriteCommand) {
    const batch = (command.input.RequestItems?.[TABLE] ?? []) as Request[];
    this.sent.push(batch);
    const left = this.unprocessed(batch, this.sent.length);
    return left.length > 0 ? { UnprocessedItems: { [TABLE]: left } } : {};
  }
}

const noSleep = async () => {};

describe('buildCatalogItems', () => {
  it('genera un perfil por procedimiento y todos los slots de cada provider', () => {
    const items = buildCatalogItems(now);

    const expected = syntheticProviders().reduce((n, p) => n + p.procedures.length + syntheticSlots(p.providerId, now).length, 0);
    expect(items).toHaveLength(expected);
  });

  it('usa la misma key del GSI que consulta DynamoRepo.searchProviders', () => {
    const items = buildCatalogItems(now);

    const rhinoMiami = items.filter((i) => i.procedureCity === procedureCityKey(' Rhinoplasty ', 'MIAMI'));
    expect(rhinoMiami.length).toBeGreaterThan(0);
    expect(rhinoMiami.every((i) => i.city === 'Miami')).toBe(true);
  });
});

describe('writeBatches', () => {
  it('escribe en lotes de 25 sin reintentar si no hay UnprocessedItems', async () => {
    const doc = new FakeBatchWriter();
    const items = buildCatalogItems(now);

    await writeBatches(doc, TABLE, items, { sleep: noSleep });

    expect(doc.sent.map((b) => b.length)).toEqual(expect.arrayContaining([25]));
    expect(doc.sent.every((b) => b.length <= 25)).toBe(true);
    expect(doc.sent.flat()).toHaveLength(items.length);
  });

  it('reenvia exactamente los items no procesados, con backoff', async () => {
    const items = buildCatalogItems(now).slice(0, 10);
    const doc = new FakeBatchWriter((batch, call) => (call === 1 ? batch.slice(7) : []));
    const waits: number[] = [];

    await writeBatches(doc, TABLE, items, { sleep: async (ms) => void waits.push(ms) });

    expect(doc.sent).toHaveLength(2);
    expect(doc.sent[1]).toEqual(doc.sent[0].slice(7));
    expect(waits).toEqual([400]);
  });

  it('falla si quedan items despues de maxAttempts', async () => {
    const items = buildCatalogItems(now).slice(0, 3);
    const doc = new FakeBatchWriter((batch) => batch);

    await expect(writeBatches(doc, TABLE, items, { maxAttempts: 2, sleep: noSleep })).rejects.toThrow(
      'Quedaron 3 items sin escribir después de 2 intentos',
    );
    expect(doc.sent).toHaveLength(2);
  });

  it('el backoff tiene un tope de 2 s', async () => {
    const items = buildCatalogItems(now).slice(0, 1);
    const doc = new FakeBatchWriter((batch, call) => (call < 6 ? batch : []));
    const waits: number[] = [];

    await writeBatches(doc, TABLE, items, { maxAttempts: 6, sleep: async (ms) => void waits.push(ms) });

    expect(waits).toEqual([400, 800, 1600, 2000, 2000]);
  });
});

describe('main', () => {
  it.each([
    ['sin CONFIRM', { CATALOG_TABLE: TABLE }],
    ['sin CATALOG_TABLE', { CONFIRM: 'yes' }],
    ['con CONFIRM distinto de yes', { CONFIRM: 'YES', CATALOG_TABLE: TABLE }],
  ])('es dry-run %s: no crea el cliente ni escribe', async (_case, env) => {
    const makeDoc = jest.fn();
    const lines: string[] = [];

    await main(env, makeDoc, (l) => lines.push(l));

    expect(makeDoc).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/^Items sinteticos: \d+/);
    expect(lines.at(-1)).toMatch(/^Dry-run/);
  });

  it('con CONFIRM=yes y CATALOG_TABLE escribe todos los items', async () => {
    const doc = new FakeBatchWriter();

    await main({ CONFIRM: 'yes', CATALOG_TABLE: TABLE }, () => doc, () => {});

    expect(doc.sent.flat()).toHaveLength(buildCatalogItems().length);
  });
});
