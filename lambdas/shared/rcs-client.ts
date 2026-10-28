/**
 * Envio por RCS con fallback por mensaje a SMS, o por SMS directo en el plan B
 * (CHANNEL_MODE=sms, ADR 001). Owner: Leo.
 * Docs:
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-fallback-per-message.html
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-rich-messaging.html
 *
 * Todo lo que arma requests es puro (buildSendRcsInput, buildSendTextInput) y
 * el cliente se inyecta: los tests usan un fake, nunca AWS.
 */
import {
  PinpointSMSVoiceV2Client,
  SendRcsMessageCommand,
  SendTextMessageCommand,
  type SendRcsMessageCommandInput,
  type SendTextMessageCommandInput,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { LIMITS, type OutboundMessage, clampTtl, smsText, truncate } from './rcs-templates';

export type ChannelMode = 'rcs' | 'sms';

export interface RcsSettings {
  /** Obligatorio en modo rcs; en modo sms puede quedar vacio. */
  rcsAgentId: string;
  /** Numero o sender ID para el fallback y para el modo sms (no pool, no agente RCS). */
  smsOriginationIdentity: string;
  configurationSetName: string;
  /** TimeToLive del RCS antes de caer a SMS. Se acota a 1..172800 s. */
  ttlSeconds: number;
  protectConfigurationId?: string;
  /** Default 'rcs'. Con 'sms' todo sale por SendTextMessage (plan B). */
  channelMode?: ChannelMode;
}

export interface RcsSender {
  send(to: string, message: OutboundMessage, context?: Record<string, string>): Promise<string | undefined>;
  /** Texto plano por SMS. Opcional para no romper fakes existentes. */
  sendText?(to: string, body: string, context?: Record<string, string>): Promise<string | undefined>;
}

/** Lo minimo del cliente del SDK que usamos: permite inyectar un fake. */
export interface SmsVoiceClientLike {
  send(command: SendRcsMessageCommand | SendTextMessageCommand): Promise<{ MessageId?: string }>;
}

export const DEFAULT_RCS_TTL_SECONDS = 300;

export function channelModeFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelMode {
  return (env.CHANNEL_MODE ?? '').trim().toLowerCase() === 'sms' ? 'sms' : 'rcs';
}

/** Canal efectivo, para AgentInvokeRequest.channel y metricas. */
export function channelFor(settings: Pick<RcsSettings, 'channelMode'>): 'RCS' | 'SMS' {
  return settings.channelMode === 'sms' ? 'SMS' : 'RCS';
}

export function rcsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RcsSettings {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Falta la variable de entorno ${key}`);
    return value;
  };
  const channelMode = channelModeFromEnv(env);
  return {
    rcsAgentId: channelMode === 'rcs' ? required('RCS_AGENT_ID') : (env.RCS_AGENT_ID ?? ''),
    smsOriginationIdentity: required('SMS_ORIGINATION_IDENTITY'),
    configurationSetName: required('CONFIGURATION_SET_NAME'),
    // `||` y no `??`: RCS_TTL_SECONDS="" daria Number("") = 0, se acotaria a 1 s y casi todo caeria a SMS.
    ttlSeconds: clampTtl(Number(env.RCS_TTL_SECONDS || DEFAULT_RCS_TTL_SECONDS), DEFAULT_RCS_TTL_SECONDS),
    protectConfigurationId: env.PROTECT_CONFIGURATION_ID || undefined,
    channelMode,
  };
}

/** Arma el request de SendRcsMessage. Separado para poder testearlo sin AWS. */
export function buildSendRcsInput(
  settings: RcsSettings,
  to: string,
  message: OutboundMessage,
  context?: Record<string, string>,
): SendRcsMessageCommandInput {
  // El fallback SMS exige MessageBody (max 1600). Las plantillas ya lo dejan en GSM-7 y <= 459 septetos.
  const fallbackBody = truncate(message.fallbackText.trim(), LIMITS.smsFallbackBody, '...');
  return {
    DestinationPhoneNumber: to,
    OriginationIdentity: settings.rcsAgentId,
    RcsMessageContent: message.content,
    TimeToLive: clampTtl(settings.ttlSeconds, DEFAULT_RCS_TTL_SECONDS),
    ConfigurationSetName: settings.configurationSetName,
    ProtectConfigurationId: settings.protectConfigurationId,
    FallbackConfiguration: fallbackBody
      ? { Channel: 'SMS', MessageBody: fallbackBody, OriginationIdentity: settings.smsOriginationIdentity }
      : undefined,
    // Context se loguea en el event destination: sirve para correlacionar en message-events.
    Context: context,
  };
}

/**
 * Arma el request de SendTextMessage para el modo sms (plan B). Usa el numero
 * SMS como origen. VERIFICAR: MessageType TRANSACTIONAL para recordatorios en US.
 */
export function buildSendTextInput(
  settings: RcsSettings,
  to: string,
  body: string,
  context?: Record<string, string>,
): SendTextMessageCommandInput {
  return {
    DestinationPhoneNumber: to,
    OriginationIdentity: settings.smsOriginationIdentity,
    MessageBody: smsText(body, LIMITS.smsFallbackBody),
    MessageType: 'TRANSACTIONAL',
    ConfigurationSetName: settings.configurationSetName,
    ProtectConfigurationId: settings.protectConfigurationId,
    Context: context,
  };
}

export class SdkRcsSender implements RcsSender {
  private readonly client: SmsVoiceClientLike;

  constructor(
    private readonly settings: RcsSettings,
    client: SmsVoiceClientLike | PinpointSMSVoiceV2Client = new PinpointSMSVoiceV2Client({}),
  ) {
    // El cliente real cumple SmsVoiceClientLike en runtime; el cast evita pelear con los overloads de send().
    this.client = client as SmsVoiceClientLike;
  }

  async send(to: string, message: OutboundMessage, context?: Record<string, string>) {
    if (this.settings.channelMode === 'sms') return this.sendText(to, message.fallbackText, context);
    const out = await this.client.send(new SendRcsMessageCommand(buildSendRcsInput(this.settings, to, message, context)));
    return out.MessageId;
  }

  async sendText(to: string, body: string, context?: Record<string, string>) {
    const out = await this.client.send(new SendTextMessageCommand(buildSendTextInput(this.settings, to, body, context)));
    return out.MessageId;
  }
}

/** Factory para los handlers: arma el sender real a partir del entorno. */
export function createSender(settings: RcsSettings = rcsSettingsFromEnv(), client?: SmsVoiceClientLike): RcsSender {
  return new SdkRcsSender(settings, client);
}
