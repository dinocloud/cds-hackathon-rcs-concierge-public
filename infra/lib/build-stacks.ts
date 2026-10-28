import { App } from 'aws-cdk-lib';
import { EnvConfig } from '../config';
import { AgentStack } from './agent-stack';
import { DataStack } from './data-stack';
import { MessagingStack } from './messaging-stack';
import { ObservabilityStack } from './observability-stack';

/**
 * Orden de dependencias: Data -> Agent -> Messaging -> Observability.
 * Se usa desde bin/app.ts y desde los tests de infra.
 */
export function buildStacks(app: App, cfg: EnvConfig) {
  const env = { account: cfg.account, region: cfg.region };
  const id = (name: string) => `RsConcierge-${cfg.envName}-${name}`;

  const data = new DataStack(app, id('Data'), { env, config: cfg });
  const agent = new AgentStack(app, id('Agent'), {
    env,
    config: cfg,
    toolsFunction: data.toolsFunction,
  });
  const messaging = new MessagingStack(app, id('Messaging'), {
    env,
    config: cfg,
    agentRuntimeArn: agent.runtimeArn,
    appointmentsTable: data.appointmentsTable,
    messageEventsTable: data.messageEventsTable,
  });
  const observability = new ObservabilityStack(app, id('Observability'), {
    env,
    config: cfg,
    functions: [messaging.inboundRouter, data.toolsFunction, data.reminderSender],
  });

  return { data, agent, messaging, observability };
}
