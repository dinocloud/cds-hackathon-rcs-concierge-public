import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import {
  EventBridgeReminderScheduler,
  ReminderSettings,
  SchedulerClientLike,
  atExpression,
  planReminders,
} from './reminders';

const now = new Date('2026-10-26T12:00:00Z');
const real: ReminderSettings = { demoMode: false, demoMinutes48h: 2, demoMinutes24h: 4 };
const demo: ReminderSettings = { ...real, demoMode: true };

describe('planReminders', () => {
  it('planifica T-48h y T-24h reales y comprimidos en modo demo', () => {
    const startsAt = new Date('2026-10-30T14:00:00Z');
    const plansReal = planReminders('apt_1', startsAt, now, real);
    expect(plansReal.map((p) => p.fireAt.toISOString())).toEqual(['2026-10-28T14:00:00.000Z', '2026-10-29T14:00:00.000Z']);
    const plansDemo = planReminders('apt_1', startsAt, now, demo);
    expect(plansDemo.map((p) => p.fireAt.toISOString())).toEqual(['2026-10-26T12:02:00.000Z', '2026-10-26T12:04:00.000Z']);
    expect(atExpression(plansDemo[0].fireAt)).toBe('at(2026-10-26T12:02:00)');
  });

  it('omite los recordatorios que caerian en el pasado', () => {
    const startsAt = new Date('2026-10-27T14:00:00Z'); // T-48h ya paso, T-24h es manana
    const plans = planReminders('apt_1', startsAt, now, real);
    expect(plans.map((p) => p.kind)).toEqual(['T24']);
    expect(planReminders('apt_1', new Date('2026-10-26T13:00:00Z'), now, real)).toEqual([]);
  });
});

describe('planReminders en el borde exacto', () => {
  const H = 3_600_000;

  it('descarta el T-48h cuando startsAt es exactamente now + 48h (fireAt == now no es futuro)', () => {
    const plans = planReminders('apt_1', new Date(now.getTime() + 48 * H), now, real);
    expect(plans.map((p) => p.kind)).toEqual(['T24']);
  });

  it('conserva el T-48h cuando startsAt es now + 48h + 1 ms', () => {
    const plans = planReminders('apt_1', new Date(now.getTime() + 48 * H + 1), now, real);
    expect(plans.map((p) => p.kind)).toEqual(['T48', 'T24']);
  });

  it('descarta ambos cuando startsAt es exactamente now + 24h', () => {
    expect(planReminders('apt_1', new Date(now.getTime() + 24 * H), now, real)).toEqual([]);
  });

  it('en modo demo con 0 minutos no agenda ese recordatorio', () => {
    const plans = planReminders('apt_1', new Date('2026-10-30T14:00:00Z'), now, { ...demo, demoMinutes48h: 0 });
    expect(plans.map((p) => p.kind)).toEqual(['T24']);
  });
});

class RecordingClient implements SchedulerClientLike {
  readonly commands: Array<CreateScheduleCommand | DeleteScheduleCommand> = [];
  error?: Error;
  async send(command: CreateScheduleCommand | DeleteScheduleCommand) {
    this.commands.push(command);
    if (this.error) throw this.error;
    return {};
  }
}

function setup() {
  const client = new RecordingClient();
  const scheduler = new EventBridgeReminderScheduler('group-1', 'arn:lambda:reminder', 'arn:role:scheduler', client);
  return { client, scheduler };
}

describe('EventBridgeReminderScheduler', () => {
  it('crea un schedule one-time por recordatorio con el ReminderEvent como Input', async () => {
    const { client, scheduler } = setup();
    const plans = planReminders('apt_1', new Date('2026-10-30T14:00:00Z'), now, real);

    const names = await scheduler.schedule('apt_1', plans);

    expect(names).toEqual(['apt_1-t48', 'apt_1-t24']);
    expect(client.commands).toHaveLength(2);
    const first = client.commands[0] as CreateScheduleCommand;
    expect(first).toBeInstanceOf(CreateScheduleCommand);
    expect(first.input).toMatchObject({
      Name: 'apt_1-t48',
      GroupName: 'group-1',
      ScheduleExpression: 'at(2026-10-28T14:00:00)',
      ActionAfterCompletion: 'DELETE',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'arn:lambda:reminder', RoleArn: 'arn:role:scheduler' },
    });
    expect(JSON.parse(first.input.Target!.Input!)).toEqual({ appointmentId: 'apt_1', kind: 'T48' });
  });

  it('borra los schedules por nombre en el grupo', async () => {
    const { client, scheduler } = setup();
    await scheduler.remove(['apt_1-t48', 'apt_1-t24']);
    expect(client.commands.map((c) => (c as DeleteScheduleCommand).input)).toEqual([
      { Name: 'apt_1-t48', GroupName: 'group-1' },
      { Name: 'apt_1-t24', GroupName: 'group-1' },
    ]);
  });

  it('ignora ResourceNotFoundException al borrar', async () => {
    const { client, scheduler } = setup();
    client.error = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    await expect(scheduler.remove(['apt_1-t48'])).resolves.toBeUndefined();
  });

  it('propaga cualquier otro error al borrar', async () => {
    const { client, scheduler } = setup();
    client.error = Object.assign(new Error('boom'), { name: 'ThrottlingException' });
    await expect(scheduler.remove(['apt_1-t48'])).rejects.toThrow('boom');
  });
});
