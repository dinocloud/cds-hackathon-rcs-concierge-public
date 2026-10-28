/**
 * Normalizacion de los mensajes que llegan por SNS (owner: Leo).
 *
 * Formatos tomados de la doc de AWS End User Messaging (consultada el 21/10/2026):
 * - Entrante (two-way topic del RCS agent o del numero SMS):
 *   https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-inbound.html
 *   `originationNumber`, `destinationNumber`, `messageKeyword`, `messageBody`,
 *   `inboundMessageId`, `previousPublishedMessageId`.
 * - Postback y typing (two-way topic, NO el configuration set):
 *   https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-events.html
 *   `messageBody` es un JSON serializado con `type` = `SUGGESTION` (`text`, `postbackData`),
 *   `RCS_TYPING` o `CONVERSATION_STARTED`.
 * - Entrega (event destination del configuration set):
 *   https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets-event-format.html
 *   `eventType`, `messageStatus`, `messageId`, `eventTimestamp` (epoch ms),
 *   `originationPhoneNumber` (id del RCS agent si salio por RCS, E.164 si salio por SMS
 *   o cayo a SMS), `destinationPhoneNumber`, `context`, `isFinal`.
 *
 * VERIFICAR con eventos reales capturados en dev (pegarlos en docs/contrato-eventos.md):
 * - nombres exactos de los eventos de fallback y si llegan como `eventType` o `messageStatus`;
 * - si `TTL_EXPIRATION_REVOKED` llega como `eventType` o `messageStatus`;
 * - si el SMS de fallback conserva el `messageId` y el `context` del SendRcsMessage;
 * - si el texto libre por RCS llega plano en `messageBody` (la doc dice que si) o como JSON;
 * - formato de location share (hoy se descarta).
 */
import { normalizePhone } from '../shared/patient';

export type DeliveryStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'EXPIRED' | 'FALLBACK' | 'OTHER';
export type Channel = 'RCS' | 'SMS';

export interface InboundBase {
  /** Telefono del paciente en E.164 (se normaliza: RCS lo manda sin "+"). Nunca se loguea completo. */
  from: string;
  /** Id del RCS agent (`rcs-...`) o numero SMS que recibio. */
  to?: string;
  /** Canal por el que entro: RCS si el destino es un RCS agent. */
  channel: Channel;
  /** Clave de idempotencia: `inboundMessageId` o, si falta, el MessageId de SNS. */
  inboundMessageId?: string;
  /** Mensaje saliente al que responde, si la doc lo informa. */
  previousPublishedMessageId?: string;
  messageKeyword?: string;
  receivedAt: string;
}

export interface DeliveryEvent {
  kind: 'delivery';
  messageId: string;
  channel: Channel;
  status: DeliveryStatus;
  rawEventType: string;
  rawMessageStatus?: string;
  isFinal?: boolean;
  context?: Record<string, string>;
  eventTimestamp: string;
}

export type NormalizedEvent =
  | ({ kind: 'text'; text: string } & InboundBase)
  | ({ kind: 'postback'; postbackData: string; text?: string } & InboundBase)
  | DeliveryEvent
  | { kind: 'ignored'; reason: string }
  | { kind: 'unknown'; reason: string };

type Raw = Record<string, unknown>;

const pick = (raw: Raw, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = key.split('.').reduce<unknown>((acc, k) => (acc as Raw | undefined)?.[k], raw);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const toIso = (value: unknown): string => {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && /^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
};

const isRcsAgentId = (value?: string): boolean => !!value && value.toLowerCase().startsWith('rcs-');

/**
 * eventType que fijan el estado aunque `messageStatus` diga otra cosa (VERIFICAR nombres reales:
 * la doc no publica el del fallback).
 */
const EVENT_TYPE_OVERRIDES: Record<string, DeliveryStatus> = {
  RCS_FALLBACK: 'FALLBACK',
  TTL_EXPIRATION_REVOKED: 'EXPIRED',
};

/**
 * Mapa explicito de estados (sin `includes`: `UNDELIVERED` contiene `DELIVERED`). Se busca
 * primero `messageStatus` y despues `eventType`; lo que no esta en el mapa es `OTHER`.
 * Valores de configuration-sets-event-format.html (SMS) y rcs-events.html (RCS).
 */
export const DELIVERY_STATUS_MAP: Readonly<Record<string, DeliveryStatus>> = {
  // messageStatus
  PENDING: 'SENT',
  QUEUED: 'SENT',
  SENT: 'SENT',
  ACCEPTED: 'SENT',
  DELIVERED: 'DELIVERED',
  SUCCESSFUL: 'DELIVERED',
  READ: 'READ',
  FALLBACK: 'FALLBACK',
  TTL_EXPIRED: 'EXPIRED',
  EXPIRED: 'EXPIRED',
  UNDELIVERABLE: 'FAILED',
  UNDELIVERED: 'FAILED',
  REJECTED: 'FAILED',
  FAILED: 'FAILED',
  BLOCKED: 'FAILED',
  CARRIER_BLOCKED: 'FAILED',
  PROTECT_BLOCKED: 'FAILED',
  SPAM: 'FAILED',
  INVALID: 'FAILED',
  INVALID_MESSAGE: 'FAILED',
  INVALID_NUMBER: 'FAILED',
  UNREACHABLE: 'FAILED',
  CARRIER_UNREACHABLE: 'FAILED',
  UNROUTABLE: 'FAILED',
  OPTED_OUT: 'FAILED',
  UNKNOWN: 'FAILED',
  // eventType (cuando no viene messageStatus o no esta en el mapa)
  RCS_DELIVERED: 'DELIVERED',
  RCS_READ: 'READ',
  TEXT_PENDING: 'SENT',
  TEXT_QUEUED: 'SENT',
  TEXT_DELIVERED: 'DELIVERED',
  TEXT_SUCCESSFUL: 'DELIVERED',
  TEXT_TTL_EXPIRED: 'EXPIRED',
  TEXT_BLOCKED: 'FAILED',
  TEXT_CARRIER_BLOCKED: 'FAILED',
  TEXT_PROTECT_BLOCKED: 'FAILED',
  TEXT_SPAM: 'FAILED',
  TEXT_INVALID: 'FAILED',
  TEXT_INVALID_MESSAGE: 'FAILED',
  TEXT_UNREACHABLE: 'FAILED',
  TEXT_CARRIER_UNREACHABLE: 'FAILED',
  TEXT_OPTED_OUT: 'FAILED',
  TEXT_UNKNOWN: 'FAILED',
  // VERIFICAR: si la revocacion falla el mensaje probablemente ya se entrego; no se cuenta.
  TTL_EXPIRATION_REVOKE_FAILED: 'OTHER',
};

/**
 * Mapea un evento del configuration set a canal y estado.
 * - Canal: RCS si `eventType` empieza con `RCS` o si `originationPhoneNumber` es un RCS agent;
 *   SMS en cualquier otro caso (incluye el SMS de fallback, que sale del numero E.164).
 * - Estado: override por `eventType`, despues `messageStatus` (los eventos RCS llegan con
 *   eventType RCS_DELIVERED y el estado real en messageStatus), despues `eventType`, y `OTHER`.
 */
export function classifyDeliveryEvent(
  eventType: string,
  messageStatus?: string,
  originationPhoneNumber?: string,
): { channel: Channel; status: DeliveryStatus } {
  const t = eventType.trim().toUpperCase();
  const m = messageStatus?.trim().toUpperCase();
  const channel: Channel = t.startsWith('RCS') || isRcsAgentId(originationPhoneNumber) ? 'RCS' : 'SMS';
  const status = EVENT_TYPE_OVERRIDES[t] ?? (m ? DELIVERY_STATUS_MAP[m] : undefined) ?? DELIVERY_STATUS_MAP[t] ?? 'OTHER';
  return { channel, status };
}

/** Tipos de `messageBody` JSON del two-way topic de RCS que no son mensajes del paciente. */
const IGNORED_BODY_TYPES = new Set(['RCS_TYPING', 'CONVERSATION_STARTED']);

/** Palabras de opt-out: las resuelve End User Messaging, el agente no responde. */
const OPT_OUT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCELALL', 'END', 'QUIT', 'OPTOUT', 'STOPALL']);

function parseJsonBody(body: string): Raw | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Raw) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDelivery(raw: Raw, eventType: string, messageId: string): DeliveryEvent {
  const messageStatus = pick(raw, 'messageStatus');
  const { channel, status } = classifyDeliveryEvent(eventType, messageStatus, pick(raw, 'originationPhoneNumber'));
  const context = raw.context && typeof raw.context === 'object' ? (raw.context as Record<string, string>) : undefined;
  return {
    kind: 'delivery',
    messageId,
    channel,
    status,
    rawEventType: eventType,
    rawMessageStatus: messageStatus,
    isFinal: typeof raw.isFinal === 'boolean' ? raw.isFinal : undefined,
    context,
    eventTimestamp: toIso(raw.eventTimestamp ?? raw.timestamp),
  };
}

/**
 * @param message `Sns.Message` del record.
 * @param snsMessageId `Sns.MessageId`, se usa como clave de idempotencia si falta `inboundMessageId`.
 */
export function normalizeEvent(message: string, snsMessageId?: string): NormalizedEvent {
  let raw: Raw;
  try {
    raw = JSON.parse(message) as Raw;
  } catch {
    return { kind: 'unknown', reason: 'mensaje SNS no es JSON' };
  }
  if (!raw || typeof raw !== 'object') return { kind: 'unknown', reason: 'mensaje SNS no es un objeto' };

  // ---- Evento de entrega (configuration set) ----
  const eventType = pick(raw, 'eventType');
  if (eventType) {
    const messageId = pick(raw, 'messageId');
    if (!messageId) return { kind: 'unknown', reason: 'evento de entrega sin messageId' };
    return normalizeDelivery(raw, eventType, messageId);
  }

  // ---- Entrante (two-way topic) ----
  const origination = pick(raw, 'originationNumber');
  if (!origination) return { kind: 'unknown', reason: 'sin numero de origen' };
  const to = pick(raw, 'destinationNumber');
  const base: InboundBase = {
    from: normalizePhone(origination),
    to,
    channel: isRcsAgentId(to) ? 'RCS' : 'SMS',
    inboundMessageId: pick(raw, 'inboundMessageId') ?? snsMessageId,
    previousPublishedMessageId: pick(raw, 'previousPublishedMessageId'),
    messageKeyword: pick(raw, 'messageKeyword'),
    receivedAt: toIso(raw.timestamp ?? raw.receivedTimestamp),
  };

  const body = pick(raw, 'messageBody');
  if (!body) return { kind: 'unknown', reason: 'evento entrante sin messageBody' };

  const json = parseJsonBody(body);
  if (json) {
    const type = typeof json.type === 'string' ? json.type.toUpperCase() : undefined;
    if (type && IGNORED_BODY_TYPES.has(type)) return { kind: 'ignored', reason: `evento ${type}` };
    if (type === 'SUGGESTION') {
      const postbackData = pick(json, 'postbackData');
      if (!postbackData) return { kind: 'unknown', reason: 'SUGGESTION sin postbackData' };
      const receivedAt = json.receivedAt !== undefined ? toIso(json.receivedAt) : base.receivedAt;
      return { kind: 'postback', ...base, receivedAt, postbackData, text: pick(json, 'text') };
    }
    if (type) return { kind: 'ignored', reason: `tipo de messageBody no soportado: ${type}` };
    // JSON sin `type`: se trata como texto libre.
  }

  const keyword = (base.messageKeyword ?? body).trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(keyword)) return { kind: 'ignored', reason: 'palabra clave de opt-out' };

  return { kind: 'text', ...base, text: body };
}
