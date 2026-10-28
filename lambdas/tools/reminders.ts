/**
 * Programacion de recordatorios con EventBridge Scheduler (owner: Pablo).
 * Un schedule one-time por recordatorio; se borran al cancelar o reprogramar.
 */
import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { ReminderEvent, ReminderKind } from '../shared/contracts';

export interface ReminderPlan {
  kind: ReminderKind;
  scheduleName: string;
  fireAt: Date;
}

export interface ReminderSettings {
  demoMode: boolean;
  demoMinutes48h: number;
  demoMinutes24h: number;
}

/**
 * T-48h y T-24h antes del turno. En DEMO_MODE se comprimen a minutos desde ahora,
 * para que el video muestre el flujo completo. Los que caerian en el pasado se omiten.
 */
export function planReminders(appointmentId: string, startsAt: Date, now: Date, s: ReminderSettings): ReminderPlan[] {
  const minutes = (m: number) => m * 60_000;
  const hours = (h: number) => h * 3_600_000;
  const plans: ReminderPlan[] = [
    {
      kind: 'T48',
      scheduleName: `${appointmentId}-t48`,
      fireAt: s.demoMode ? new Date(now.getTime() + minutes(s.demoMinutes48h)) : new Date(startsAt.getTime() - hours(48)),
    },
    {
      kind: 'T24',
      scheduleName: `${appointmentId}-t24`,
      fireAt: s.demoMode ? new Date(now.getTime() + minutes(s.demoMinutes24h)) : new Date(startsAt.getTime() - hours(24)),
    },
  ];
  return plans.filter((p) => p.fireAt.getTime() > now.getTime());
}

/** Scheduler acepta at(yyyy-mm-ddThh:mm:ss) sin zona ni milisegundos, en UTC. */
export function atExpression(date: Date): string {
  return `at(${date.toISOString().slice(0, 19)})`;
}

export interface ReminderScheduler {
  schedule(appointmentId: string, plans: ReminderPlan[]): Promise<string[]>;
  remove(scheduleNames: string[]): Promise<void>;
}

/** Lo minimo del SchedulerClient que usamos: permite inyectar un fake en los tests. */
export interface SchedulerClientLike {
  send(command: CreateScheduleCommand | DeleteScheduleCommand): Promise<unknown>;
}

export class EventBridgeReminderScheduler implements ReminderScheduler {
  constructor(
    private readonly groupName: string,
    private readonly targetArn: string,
    private readonly roleArn: string,
    private readonly client: SchedulerClientLike = new SchedulerClient({}),
  ) {}

  async schedule(appointmentId: string, plans: ReminderPlan[]) {
    for (const plan of plans) {
      const input: ReminderEvent = { appointmentId, kind: plan.kind };
      await this.client.send(
        new CreateScheduleCommand({
          Name: plan.scheduleName,
          GroupName: this.groupName,
          ScheduleExpression: atExpression(plan.fireAt),
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
          Target: { Arn: this.targetArn, RoleArn: this.roleArn, Input: JSON.stringify(input) },
        }),
      );
    }
    return plans.map((p) => p.scheduleName);
  }

  async remove(scheduleNames: string[]) {
    for (const name of scheduleNames) {
      try {
        await this.client.send(new DeleteScheduleCommand({ Name: name, GroupName: this.groupName }));
      } catch (err) {
        // Si ya se ejecuto (ActionAfterCompletion=DELETE) no existe: no es un error.
        if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
      }
    }
  }
}

/** Para tests y modo local: no llama a AWS. */
export class InMemoryReminderScheduler implements ReminderScheduler {
  readonly scheduled = new Map<string, ReminderPlan>();
  async schedule(_appointmentId: string, plans: ReminderPlan[]) {
    plans.forEach((p) => this.scheduled.set(p.scheduleName, p));
    return plans.map((p) => p.scheduleName);
  }
  async remove(scheduleNames: string[]) {
    scheduleNames.forEach((n) => this.scheduled.delete(n));
  }
}
