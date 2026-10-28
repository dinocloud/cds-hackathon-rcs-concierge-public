/**
 * Carga datos 100% sinteticos en la tabla catalog (owner: Pablo).
 * Por defecto es dry-run: imprime lo que escribiria. Para escribir en AWS:
 *   AWS_PROFILE=<perfil-dev> CONFIRM=yes CATALOG_TABLE=rs-concierge-dev-catalog npm run seed
 * Escribir en la cuenta dev requiere el OK del TL, igual que un deploy (docs/runbook-deploy-dev.md).
 * Es idempotente: las keys son fijas, volver a correrlo pisa los items (y vuelve a liberar los slots).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { procedureCityKey } from '../lambdas/tools/repo';
import { syntheticProviders, syntheticSlots } from '../lambdas/tools/synthetic-data';

type Item = Record<string, unknown>;
type WriteRequest = { PutRequest: { Item: Item } };

/** Lo minimo del DocumentClient que usa el seed: permite inyectar un fake en los tests. */
export interface BatchWriter {
  send(command: BatchWriteCommand): Promise<{ UnprocessedItems?: Record<string, WriteRequest[]> }>;
}

export interface WriteBatchesOptions {
  /** Intentos por lote, el primero incluido. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Limite de BatchWriteItem. */
const BATCH_SIZE = 25;

export function buildCatalogItems(now = new Date()): Item[] {
  const items: Item[] = [];
  for (const p of syntheticProviders()) {
    // Un item de perfil por procedimiento para el GSI by-procedure-city.
    p.procedures.forEach((procedure, i) => {
      items.push({
        pk: `PROVIDER#${p.providerId}`,
        sk: i === 0 ? 'PROFILE' : `PROFILE#${procedure}`,
        // Misma funcion que usa DynamoRepo.searchProviders: una sola definicion de la key.
        procedureCity: procedureCityKey(procedure, p.city),
        ...p,
      });
    });
    for (const s of syntheticSlots(p.providerId, now)) {
      items.push({ pk: `PROVIDER#${p.providerId}`, sk: `SLOT#${s.startsAt}`, ...s });
    }
  }
  return items;
}

/**
 * Escribe en lotes de 25 y reenvia los UnprocessedItems con backoff min(200 ms * 2^intento, 2 s).
 * BatchWriteItem devuelve 200 con items sin escribir ante throttling: el SDK no los reintenta.
 * Si despues de maxAttempts quedan items, falla en vez de dejar el catalogo incompleto.
 */
export async function writeBatches(doc: BatchWriter, table: string, items: Item[], opts: WriteBatchesOptions = {}): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    let pending: WriteRequest[] = items.slice(i, i + BATCH_SIZE).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > maxAttempts) {
        throw new Error(`Quedaron ${pending.length} items sin escribir después de ${maxAttempts} intentos`);
      }
      if (attempt > 1) await sleep(Math.min(200 * 2 ** (attempt - 1), 2000));
      const out = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = out.UnprocessedItems?.[table] ?? [];
    }
  }
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  makeDoc: () => BatchWriter = () => DynamoDBDocumentClient.from(new DynamoDBClient({})),
  log: (line: string) => void = console.log,
): Promise<void> {
  const items = buildCatalogItems();
  const table = env.CATALOG_TABLE;
  log(`Items sinteticos: ${items.length} (providers ${syntheticProviders().length})`);
  log(`Ejemplo: ${JSON.stringify(items[0])}`);

  if (env.CONFIRM !== 'yes' || !table) {
    log('Dry-run: no se escribio nada. Definir CONFIRM=yes y CATALOG_TABLE para cargar.');
    return;
  }

  await writeBatches(makeDoc(), table, items);
  log(`Cargados ${items.length} items en ${table}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
