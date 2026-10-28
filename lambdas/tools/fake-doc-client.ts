import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClientLike } from './repo';

export const CATALOG = 'catalog';
export const APPOINTMENTS = 'appointments';

export type Item = Record<string, unknown>;

/**
 * Solo para tests. DynamoDB en memoria que entiende solo las operaciones que arma DynamoRepo
 * (keys de data-stack.ts). Sirve para probar el repo sin AWS.
 */
export class FakeDocClient implements DocClientLike {
  readonly tables = new Map<string, Map<string, Item>>();

  constructor(catalogItems: Item[]) {
    this.tables.set(CATALOG, new Map(catalogItems.map((i) => [`${i.pk}|${i.sk}`, { ...i }])));
    this.tables.set(APPOINTMENTS, new Map());
  }

  private keyOf(table: string, key: Item) {
    return table === CATALOG ? `${key.pk}|${key.sk}` : String(key.appointmentId);
  }

  private conditionFailed(): never {
    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  }

  async send(command: GetCommand | PutCommand | QueryCommand | UpdateCommand): Promise<Record<string, unknown>> {
    const commandName = command.constructor.name;
    const input = command.input as Item & { TableName: string };
    const table = this.tables.get(input.TableName)!;
    const values = (input.ExpressionAttributeValues ?? {}) as Item;

    if (command instanceof GetCommand) {
      const item = table.get(this.keyOf(input.TableName, input.Key as Item));
      return { Item: item ? { ...item } : undefined };
    }
    if (command instanceof PutCommand) {
      const item = input.Item as Item;
      table.set(this.keyOf(input.TableName, item), { ...item });
      return {};
    }
    if (command instanceof QueryCommand) {
      let items = [...table.values()];
      if (input.IndexName === 'by-patient') {
        items = items.filter((i) => i.patientHash === values[':p'] && i.startsAt === values[':s']);
      } else if (input.IndexName === 'by-procedure-city') {
        items = items
          .filter((i) => i.procedureCity === values[':pc'])
          .sort((a, b) => (b.rating as number) - (a.rating as number));
      } else {
        items = items
          .filter((i) => i.pk === values[':pk'] && (i.sk as string) >= (values[':from'] as string) && (i.sk as string) <= (values[':to'] as string))
          .sort((a, b) => (a.sk as string).localeCompare(b.sk as string));
        if (input.FilterExpression) items = items.filter((i) => i.available === values[':yes']);
      }
      if (typeof input.Limit === 'number') items = items.slice(0, input.Limit);
      return { Items: items.map((i) => ({ ...i })) };
    }
    if (command instanceof UpdateCommand) {
      const item = table.get(this.keyOf(input.TableName, input.Key as Item));
      if (input.ConditionExpression === 'attribute_exists(pk)') {
        if (!item) this.conditionFailed();
        item!.available = values[':yes'];
        return {};
      }
      if (!item || item.available !== values[':yes']) this.conditionFailed();
      item!.available = values[':no'];
      return { Attributes: { ...item } };
    }
    throw new Error(`Comando no soportado por el fake: ${commandName}`);
  }
}
