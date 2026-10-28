import { Stack } from 'aws-cdk-lib';
import { EnvConfig } from '../config';

/**
 * Nombres deterministicos compartidos entre stacks. Se calculan desde la config
 * (y no con referencias cross-stack) para no generar ciclos entre stacks.
 */
export function names(cfg: EnvConfig) {
  const p = cfg.prefix;
  return {
    catalogTable: `${p}-catalog`,
    appointmentsTable: `${p}-appointments`,
    messageEventsTable: `${p}-message-events`,
    scheduleGroup: `${p}-reminders`,
    configurationSet: `${p}-rcs`,
    eventsTopic: `${p}-rcs-events`,
    /** AgentCore exige nombres con [a-zA-Z][a-zA-Z0-9_]: sin guiones. */
    agentRuntime: `${p}`.replace(/-/g, '_') + '_concierge',
    memory: `${p}`.replace(/-/g, '_') + '_memory',
    gateway: `${p}-gateway`,
    metricsNamespace: 'RsConcierge',
  };
}

/** ARN de un recurso de End User Messaging SMS/Voice v2 (`sms-voice`) en la cuenta y region del stack. */
export function smsVoiceArn(stack: Stack, resource: string, resourceName: string): string {
  return stack.formatArn({ service: 'sms-voice', resource, resourceName });
}

/** ARN de la protect configuration si la config la define; si no, ninguno. */
export function protectConfigurationArns(stack: Stack, cfg: EnvConfig): string[] {
  return cfg.messaging.protectConfigurationId
    ? [smsVoiceArn(stack, 'protect-configuration', cfg.messaging.protectConfigurationId)]
    : [];
}

/** Variable de entorno PROTECT_CONFIGURATION_ID de las Lambdas que envian, solo si la config la define. */
export function protectConfigurationEnv(cfg: EnvConfig): Record<string, string> {
  return cfg.messaging.protectConfigurationId ? { PROTECT_CONFIGURATION_ID: cfg.messaging.protectConfigurationId } : {};
}

/**
 * ARN de IAM del origen SMS (numero o pool). El tipo sale del prefijo del ID: `pool-...` es un
 * pool y cualquier otro ID se trata como PhoneNumberId (`phone-...`). Si ya viene un ARN se usa
 * tal cual. Antes se otorgaban `phone-number/<id>` y `pool/<id>` con el mismo ID, y uno de los
 * dos siempre era un ARN inexistente.
 */
export function originationIdentityArn(stack: Stack, identity: string): string {
  if (identity.startsWith('arn:')) return identity;
  return smsVoiceArn(stack, identity.startsWith('pool-') ? 'pool' : 'phone-number', identity);
}

/**
 * ARNs de End User Messaging SMS/Voice v2 que usa SendRcsMessage.
 * VERIFICAR: formato de ARN del RCS agent contra la doc de IAM de sms-voice
 * (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonpinpointsmsvoicev2.html).
 */
export function sendRcsResources(stack: Stack, cfg: EnvConfig): string[] {
  return [
    smsVoiceArn(stack, 'rcs-agent', cfg.messaging.rcsAgentId),
    smsVoiceArn(stack, 'configuration-set', names(cfg).configurationSet),
    // El fallback a SMS sale por un numero o un pool: se permite solo ese origen.
    originationIdentityArn(stack, cfg.messaging.smsOriginationIdentity),
    ...protectConfigurationArns(stack, cfg),
  ];
}
