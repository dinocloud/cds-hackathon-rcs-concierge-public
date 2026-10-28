import { parseChannelMode } from '../../lambdas/shared/channel-mode';
import { EnvConfig } from './types';

const env = process.env;

/** Cuenta dummy para poder sintetizar sin credenciales (ver README). */
const DUMMY_ACCOUNT = '000000000000';

export const devConfig: EnvConfig = {
  envName: 'dev',
  account: env.CDK_DEFAULT_ACCOUNT ?? DUMMY_ACCOUNT,
  region: env.CDK_DEFAULT_REGION ?? 'us-east-1',
  prefix: 'rs-concierge-dev',
  messaging: {
    rcsAgentId: env.RCS_AGENT_ID ?? 'TODO-rcs-agent-id',
    smsOriginationIdentity: env.SMS_ORIGINATION_IDENTITY ?? 'TODO-sms-origination-identity',
    protectConfigurationId: env.PROTECT_CONFIGURATION_ID || undefined,
    rcsTtlSeconds: Number(env.RCS_TTL_SECONDS ?? 300),
    // Misma validacion que la Lambda: case-insensitive y falla en el synth si es invalido.
    channelMode: parseChannelMode(env.CHANNEL_MODE),
  },
  agent: {
    // TODO(agustin): confirmar el inference profile disponible en la region del deploy.
    modelId: env.AGENT_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    memoryEventExpiryDays: 7,
  },
  reminders: {
    demoMode: (env.DEMO_MODE ?? 'true') === 'true',
    demoMinutes48h: Number(env.DEMO_REMINDER_MINUTES_48H ?? 2),
    demoMinutes24h: Number(env.DEMO_REMINDER_MINUTES_24H ?? 4),
  },
  tags: {
    project: 'rs-concierge-rcs',
    owner: 'dinocloud-appdev',
    purpose: 'aws-cds-hackathon-2026',
    data: 'synthetic-only',
  },
};
