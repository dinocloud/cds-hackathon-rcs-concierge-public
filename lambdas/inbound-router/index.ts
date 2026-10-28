/**
 * inbound-router (owner: Leo): SNS -> normaliza -> AgentCore Runtime -> SendRcsMessage / SendTextMessage.
 *
 * - Texto y postbacks (two-way topic): deriva el session id con el HMAC del telefono, invoca
 *   al agente y responde cada bloque con rcs-templates. CHANNEL_MODE=rcs manda RCS con
 *   fallback a SMS por mensaje; CHANNEL_MODE=sms manda solo SMS (plan B del ADR 001).
 * - Entregas (configuration set): se guardan en message-events y se emiten como metricas EMF.
 * - Idempotencia: SNS entrega al menos una vez. Cada mensaje entrante se reclama con un put
 *   condicional con lease en message-events (`INBOUND#<hmac del id>` / `CLAIM`): estados
 *   CLAIMED -> SENDING -> DONE (o FAILED). Un CLAIMED cuyo lease vencio (la Lambda corto por
 *   timeout) se puede volver a reclamar; SENDING y DONE se descartan como duplicados. Si falla
 *   el primer envio se libera el claim y se propaga el error (el reintento reprocesa); si falla
 *   despues de enviar algun bloque queda FAILED y todo reintento falla, para que el evento
 *   llegue al onFailure (DLQ) sin duplicar bloques. Las entregas se
 *   guardan con put condicional por (messageId, eventType, messageStatus) y las metricas solo
 *   salen la primera vez.
 * - Postbacks de telemetria (`view_profile`, `add_calendar`): solo log y metrica, sin agente.
 * - Logs: telefono enmascarado (maskPhone) y nunca el texto del paciente.
 */
import { createHmac } from 'crypto';
import type { SNSEvent } from 'aws-lambda';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AgentInvokeRequest, AgentReply, PatientInput, ReplyBlock } from '../shared/contracts';
import { maskPhone, patientRef, sessionIdFor } from '../shared/patient';
import { RcsSender, createSender, rcsSettingsFromEnv } from '../shared/rcs-client';
import {
  OutboundMessage,
  bookingConfirmation,
  decodePostback,
  isTelemetryOnlyAction,
  providerCarousel,
  slotOptions,
  textMessage,
} from '../shared/rcs-templates';
import { ChannelMode, parseChannelMode } from '../shared/channel-mode';
import { Channel, DeliveryEvent, NormalizedEvent, normalizeEvent } from './events';

export type { ChannelMode } from '../shared/channel-mode';

/** TTL de los items de message-events (eventos y claims de idempotencia). */
export const MESSAGE_EVENTS_TTL_SECONDS = 14 * 24 * 3600;

/**
 * Lease por defecto del claim de un entrante, si falta INBOUND_CLAIM_LEASE_MS. En el deploy lo
 * calcula el MessagingStack desde el timeout de la Lambda (timeout + 30 s), asi una invocacion
 * viva no pierde su claim; es del orden del primer reintento asincronico (~1 min despues del
 * fallo), asi el reintento de una Lambda cortada por timeout lo puede reclamar.
 */
export const INBOUND_CLAIM_LEASE_MS = 120_000;

/**
 * Timeout por defecto de la llamada a AgentCore si falta AGENT_REQUEST_TIMEOUT_MS. Igual al que
 * calcula el MessagingStack: timeout de la Lambda (90 s) menos 15 s de margen.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 75_000;

// ---------- Dependencias inyectables (los tests usan fakes) ----------

export interface AgentClient {
  invoke(request: AgentInvokeRequest): Promise<AgentReply>;
}

/** Clave de message-events: pk `messageId`, sk `eventTimestamp` (ambas string). */
export interface EventKey {
  messageId: string;
  eventTimestamp: string;
}

/**
 * Resultado de reclamar un entrante:
 * - acquired: nuevo, o CLAIMED con el lease vencido (una invocacion anterior corto).
 * - in_progress: CLAIMED con lease vigente, otra invocacion lo esta procesando.
 *   Tambien si el put fallo sin devolver el item existente: se reintenta en vez de descartar.
 * - done: SENDING o DONE, ya se respondio (o se esta respondiendo): duplicado.
 * - failed: FAILED, un envio fallo despues de mandar algun bloque: no se reprocesa (duplicaria
 *   bloques) pero tampoco se descarta, el reintento falla para que el evento llegue a la DLQ.
 */
export type ClaimResult = 'acquired' | 'in_progress' | 'done' | 'failed';
export type ClaimStatus = 'CLAIMED' | 'SENDING' | 'DONE' | 'FAILED';

export interface EventStore {
  /** Put condicional sin lease (metricas). true si la clave es nueva, false si ya existia. */
  claim(key: EventKey): Promise<boolean>;
  /** Put condicional con lease: `attribute_not_exists OR (CLAIMED AND claimedAt < now - lease)`. */
  claimWithLease(key: EventKey, nowMs: number, leaseMs: number): Promise<ClaimResult>;
  /** Avanza el estado del claim (SENDING antes de enviar, DONE al terminar, FAILED si falla a mitad). */
  markClaim(key: EventKey, status: Exclude<ClaimStatus, 'CLAIMED'>, nowMs: number): Promise<void>;
  /** Libera un claim para que el reintento de Lambda pueda procesar el mensaje. */
  release(key: EventKey): Promise<void>;
  /** Put condicional del evento de entrega. true si es nuevo. */
  saveDeliveryEvent(event: DeliveryEvent): Promise<boolean>;
  upsertContact(ref: string, phone: string): Promise<void>;
}

export interface RouterDeps {
  agent: AgentClient;
  /** Sender RCS con fallback a SMS (`createSender` de rcs-client en modo rcs). */
  rcsSender: RcsSender;
  /** Sender solo SMS (`createSender` en modo sms), obligatorio si channelMode es sms. */
  smsSender?: RcsSender;
  channelMode: ChannelMode;
  store: EventStore;
  getSalt(): Promise<string>;
  metricsNamespace: string;
  log?: (line: string) => void;
  /** Reloj inyectable (tests del lease). */
  now?: () => number;
  /** Lease del claim (INBOUND_CLAIM_LEASE_MS del stack). Default: INBOUND_CLAIM_LEASE_MS. */
  claimLeaseMs?: number;
}

/** Entrante que otra invocacion tiene tomado: se falla para forzar el reintento de Lambda. */
export class InboundInProgressError extends Error {
  constructor() {
    super('Entrante en proceso por otra invocacion; se reintenta');
    this.name = 'InboundInProgressError';
  }
}

/**
 * Fallo un envio despues de mandar algun bloque: el claim queda FAILED. Se lanza en esa
 * invocacion y en cada reintento, asi el evento termina en el onFailure (DLQ) sin reenviar.
 */
export class InboundSendFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundSendFailedError';
  }
}

export class AgentTimeoutError extends Error {
  constructor(ms: number) {
    super(`AgentCore no respondio en ${ms} ms`);
    this.name = 'AgentTimeoutError';
  }
}

// ---------- Logica pura ----------

export function renderBlock(block: ReplyBlock): OutboundMessage {
  switch (block.type) {
    case 'text':
      return textMessage(block.text, block.suggestions);
    case 'provider_carousel':
      return providerCarousel(block.providers, block.intro);
    case 'slot_options':
      return slotOptions(block.providerName, block.slots);
    case 'booking_confirmation':
      return bookingConfirmation(block.appointment, block.provider);
  }
}

/**
 * Traduce un postback al input del agente.
 * - `a=reply&t=...` se manda como texto (el contrato dice que el agente lo trata como texto).
 * - confirm / reschedule / cancel (botones del recordatorio y de la confirmacion) van como
 *   postback con un texto estructurado. TODO(leo): S1 (stretch) podria resolverlos sin agente.
 * - El resto pasa tal cual, con el texto visible del boton si vino.
 */
/**
 * Accion de telemetria del postback (`view_profile` o `add_calendar`), segun
 * `isTelemetryOnlyAction` de rcs-templates. Un postback que no decodifica no es telemetria.
 */
export function telemetryPostbackAction(postbackData: string): string | undefined {
  const action = decodePostback(postbackData);
  return action && isTelemetryOnlyAction(action) ? action.a : undefined;
}

/** Saca de un texto de error todo lo que parezca un telefono. */
const redactDigits = (text: string) => text.replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted]');

/**
 * Resumen de un error para logs: nombre, mensaje (recortado y sin telefonos), status HTTP y
 * requestId del SDK. Nunca el payload ni el texto del paciente.
 */
export function errorSummary(err: unknown): Record<string, string | number | undefined> {
  const e = (err ?? {}) as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  return {
    name: e.name ?? typeof err,
    message: e.message ? redactDigits(e.message).slice(0, 300) : undefined,
    httpStatusCode: e.$metadata?.httpStatusCode,
    requestId: e.$metadata?.requestId,
  };
}

export function postbackToInput(postbackData: string, displayText?: string): PatientInput {
  const action = decodePostback(postbackData);
  if (action?.a === 'reply') return { type: 'text', text: action.t };
  if (action && (action.a === 'confirm' || action.a === 'reschedule' || action.a === 'cancel')) {
    return { type: 'postback', postbackData, text: `[button] action=${action.a} appointmentId=${action.ap}` };
  }
  return displayText ? { type: 'postback', postbackData, text: displayText } : { type: 'postback', postbackData };
}

type EmfDirective = { Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: 'Count' }> };

/** Linea EMF: CloudWatch la convierte en metrica sin llamar a PutMetricData. */
function emfLine(directive: EmfDirective, fields: Record<string, string | number>): string {
  return JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [directive] }, ...fields });
}

/** Metrica que usa el dashboard: `DeliveryEvent` por `Channel` y `Status`. */
export function deliveryMetricLine(namespace: string, channel: string, status: string): string {
  return emfLine(
    { Namespace: namespace, Dimensions: [['Channel', 'Status']], Metrics: [{ Name: 'DeliveryEvent', Unit: 'Count' }] },
    { Channel: channel, Status: status, DeliveryEvent: 1 },
  );
}

export type SummaryMetric = 'RcsDelivered' | 'SmsFallback' | 'Failed';

/**
 * Metrica resumen de un evento de entrega (a lo sumo una por mensaje, se deduplica en el store):
 * - RcsDelivered: canal RCS entregado o leido.
 * - SmsFallback: SMS entregado de un mensaje enviado en modo rcs (o sea, cayo a SMS). El modo
 *   sale del `context.channelMode` que manda el router; si falta (por ejemplo reminder-sender),
 *   se usa el CHANNEL_MODE del router. VERIFICAR que el SMS de fallback conserve `context`.
 * - Failed: SMS fallido o vencido. Un RCS fallido en modo rcs no cuenta: dispara el fallback.
 */
export function summaryMetricFor(event: DeliveryEvent, channelMode: ChannelMode): SummaryMetric | undefined {
  if (event.channel === 'RCS' && (event.status === 'DELIVERED' || event.status === 'READ')) return 'RcsDelivered';
  if (event.channel === 'SMS' && event.status === 'DELIVERED') {
    const mode = event.context?.channelMode ?? channelMode;
    return mode === 'rcs' ? 'SmsFallback' : undefined;
  }
  if (event.channel === 'SMS' && (event.status === 'FAILED' || event.status === 'EXPIRED')) return 'Failed';
  return undefined;
}

export function summaryMetricLine(namespace: string, metric: SummaryMetric): string {
  return emfLine(
    { Namespace: namespace, Dimensions: [['Service']], Metrics: [{ Name: metric, Unit: 'Count' }] },
    { Service: 'inbound-router', [metric]: 1 },
  );
}

/** Metrica de postbacks de telemetria: `PostbackTelemetry` por `Action`. */
export function telemetryMetricLine(namespace: string, action: string): string {
  return emfLine(
    { Namespace: namespace, Dimensions: [['Action']], Metrics: [{ Name: 'PostbackTelemetry', Unit: 'Count' }] },
    { Action: action, PostbackTelemetry: 1 },
  );
}

/**
 * Clave de message-events de un evento de entrega: (messageId, eventType, messageStatus), como
 * recomienda AWS. No usa el timestamp: si falta, `toIso` pone la hora actual y una re-entrega
 * de SNS generaria otra clave. messageStatus entra porque los eventos RCS de estado comparten
 * eventType (RCS_DELIVERED) y el estado real viene en messageStatus.
 */
export function deliveryKey(event: DeliveryEvent): EventKey {
  return { messageId: event.messageId, eventTimestamp: `EVENT#${event.rawEventType}#${event.rawMessageStatus ?? '-'}` };
}

/**
 * Claim de un entrante. El id se hashea con la sal del telefono: `inboundMessageId` puede tener
 * la forma `<telefono>-<timestamp>` y no queremos el telefono en la pk.
 */
export const inboundClaimKey = (inboundMessageId: string, salt: string): EventKey => ({
  messageId: `INBOUND#${createHmac('sha256', salt).update(inboundMessageId).digest('hex')}`,
  eventTimestamp: 'CLAIM',
});

export const metricClaimKey = (messageId: string, metric: SummaryMetric): EventKey => ({
  messageId,
  eventTimestamp: `METRIC#${metric}`,
});

// ---------- Handler ----------

export function createHandler(deps: RouterDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const claimLeaseMs = deps.claimLeaseMs ?? INBOUND_CLAIM_LEASE_MS;
  if (deps.channelMode === 'sms' && !deps.smsSender) throw new Error('CHANNEL_MODE=sms requiere smsSender');
  const sender = deps.channelMode === 'sms' ? deps.smsSender! : deps.rcsSender;
  const replyChannel: Channel = deps.channelMode === 'sms' ? 'SMS' : 'RCS';

  async function handleDelivery(event: DeliveryEvent): Promise<void> {
    const isNew = await deps.store.saveDeliveryEvent(event);
    if (!isNew) {
      log(JSON.stringify({ level: 'info', msg: 'evento de entrega duplicado', messageId: event.messageId }));
      return;
    }
    log(deliveryMetricLine(deps.metricsNamespace, event.channel, event.status));
    const metric = summaryMetricFor(event, deps.channelMode);
    if (metric && (await deps.store.claim(metricClaimKey(event.messageId, metric)))) {
      log(summaryMetricLine(deps.metricsNamespace, metric));
    }
  }

  async function handleInbound(event: Extract<NormalizedEvent, { kind: 'text' | 'postback' }>): Promise<void> {
    const salt = await deps.getSalt();
    const claimKey = event.inboundMessageId ? inboundClaimKey(event.inboundMessageId, salt) : undefined;
    if (claimKey) {
      const claimed = await deps.store.claimWithLease(claimKey, now(), claimLeaseMs);
      if (claimed === 'done') {
        log(JSON.stringify({ level: 'info', msg: 'entrante duplicado', from: maskPhone(event.from) }));
        return;
      }
      if (claimed === 'in_progress') {
        // Otra invocacion lo tiene con lease vigente: se falla para que Lambda reintente
        // despues; el reintento lo ve DONE (y descarta) o con el lease vencido (y procesa).
        log(JSON.stringify({ level: 'warn', msg: 'entrante en proceso, se reintenta', from: maskPhone(event.from) }));
        throw new InboundInProgressError();
      }
      if (claimed === 'failed') {
        // Respuesta enviada a medias en una invocacion anterior: no se reenvia (duplicaria
        // bloques); se falla para que, agotados los reintentos, el evento llegue a la DLQ.
        log(JSON.stringify({ level: 'error', msg: 'entrante con envio fallido, va a la DLQ', from: maskPhone(event.from) }));
        throw new InboundSendFailedError('Entrante con envio fallido en una invocacion anterior; va a la DLQ');
      }
    } else {
      log(JSON.stringify({ level: 'warn', msg: 'entrante sin id: sin idempotencia', from: maskPhone(event.from) }));
    }

    // view_profile y add_calendar son solo telemetria: log + metrica, sin agente.
    const telemetryAction = event.kind === 'postback' ? telemetryPostbackAction(event.postbackData) : undefined;
    if (telemetryAction) {
      log(JSON.stringify({ level: 'info', msg: 'postback de telemetria', action: telemetryAction, from: maskPhone(event.from) }));
      log(telemetryMetricLine(deps.metricsNamespace, telemetryAction));
      if (claimKey) await deps.store.markClaim(claimKey, 'DONE', now());
      return;
    }

    const ref = patientRef(event.from, salt);
    const sessionId = sessionIdFor(ref);

    const request: AgentInvokeRequest = {
      version: '1',
      sessionId,
      patientRef: ref,
      // Canal de respuesta: en modo sms el agente tiene que armar listas numeradas.
      channel: deps.channelMode === 'sms' ? 'SMS' : event.channel,
      input: event.kind === 'postback' ? postbackToInput(event.postbackData, event.text) : { type: 'text', text: event.text },
      receivedAt: event.receivedAt,
      locale: 'en-US',
    };
    // Fuera de alcance de la POC: en CHANNEL_MODE=sms las respuestas C/R/X (y los numeros del menu)
    // no se traducen a postback; llegan al agente como texto libre. El plan B por SMS no entra en
    // la demo porque el origen SMS es un numero SIMULATOR que no entrega a telefonos reales. Si el
    // plan B pasa a ser real, aca va smsKeywordToPostback con el turno activo del paciente
    // (ver docs/contrato-eventos.md, "Respuestas por SMS").

    // Libera el claim para que el reintento asincronico de Lambda reprocese el mensaje. Si el
    // release falla se loguea y el llamador propaga el error original (el lease cubre el reintento).
    async function releaseClaim(): Promise<void> {
      if (!claimKey) return;
      try {
        await deps.store.release(claimKey);
      } catch (releaseErr) {
        log(JSON.stringify({ level: 'error', msg: 'fallo al liberar el claim', sessionId, error: errorSummary(releaseErr) }));
      }
    }

    let reply: AgentReply;
    try {
      await deps.store.upsertContact(ref, event.from);
      reply = await deps.agent.invoke(request);
    } catch (err) {
      log(JSON.stringify({ level: 'error', msg: 'fallo al invocar al agente', sessionId, error: errorSummary(err) }));
      await releaseClaim();
      throw err;
    }

    log(
      JSON.stringify({
        level: 'info',
        msg: 'respuesta del agente',
        from: maskPhone(event.from),
        input: request.input.type,
        blocks: reply.blocks.map((b) => b.type),
        clinicalHandoff: reply.clinicalHandoff ?? false,
      }),
    );

    // SENDING antes de enviar: si la Lambda corta a mitad del loop no se reprocesa, porque
    // reintentar duplicaria los bloques ya enviados. Si un envio falla:
    // - sin ningun bloque enviado: se libera el claim y se propaga el error (el reintento reprocesa);
    // - con algun bloque enviado: FAILED, log error, metrica Failed y error, asi el evento
    //   termina en el onFailure (DLQ) y cada reintento falla sin reenviar.
    if (claimKey) await deps.store.markClaim(claimKey, 'SENDING', now());
    let sent = 0;
    for (const block of reply.blocks) {
      let messageId: Awaited<ReturnType<RcsSender['send']>>;
      try {
        messageId = await sender.send(event.from, renderBlock(block), {
          sessionId,
          blockType: block.type,
          channelMode: deps.channelMode,
        });
      } catch (err) {
        log(
          JSON.stringify({
            level: 'error',
            msg: 'fallo al enviar la respuesta',
            sessionId,
            channel: replyChannel,
            block: block.type,
            sentBlocks: sent,
            totalBlocks: reply.blocks.length,
            error: errorSummary(err),
          }),
        );
        if (sent === 0) {
          await releaseClaim();
          throw err;
        }
        log(summaryMetricLine(deps.metricsNamespace, 'Failed'));
        if (claimKey) {
          try {
            await deps.store.markClaim(claimKey, 'FAILED', now());
          } catch (markErr) {
            // El claim queda SENDING (el reintento lo descarta), pero esta invocacion falla igual.
            log(JSON.stringify({ level: 'error', msg: 'fallo al marcar el claim FAILED', sessionId, error: errorSummary(markErr) }));
          }
        }
        throw new InboundSendFailedError(`Fallo el envio: ${sent} de ${reply.blocks.length} bloques enviados; va a la DLQ`);
      }
      sent++;
      log(
        JSON.stringify({ level: 'info', msg: 'respuesta enviada', to: maskPhone(event.from), channel: replyChannel, messageId, block: block.type }),
      );
    }
    if (claimKey) await deps.store.markClaim(claimKey, 'DONE', now());
  }

  async function handleOne(event: NormalizedEvent): Promise<void> {
    switch (event.kind) {
      case 'unknown':
        log(JSON.stringify({ level: 'warn', msg: 'evento descartado', reason: event.reason }));
        return;
      case 'ignored':
        log(JSON.stringify({ level: 'debug', msg: 'evento ignorado', reason: event.reason }));
        return;
      case 'delivery':
        return handleDelivery(event);
      default:
        return handleInbound(event);
    }
  }

  return async (snsEvent: SNSEvent): Promise<void> => {
    for (const record of snsEvent.Records) {
      await handleOne(normalizeEvent(record.Sns.Message, record.Sns.MessageId));
    }
  };
}

// ---------- Implementaciones reales ----------

/** Acepta JSON plano o un stream SSE (`data: {...}`): se queda con el ultimo `data` JSON valido. */
export function parseAgentReply(body: string): AgentReply {
  const trimmed = body.trim();
  let candidate: unknown;
  if (trimmed.startsWith('{')) {
    candidate = JSON.parse(trimmed);
  } else {
    const dataLines = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0 && candidate === undefined; i--) {
      try {
        const parsed = JSON.parse(dataLines[i]);
        candidate = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch {
        // linea parcial del stream: seguir con la anterior
      }
    }
  }
  const reply = candidate as AgentReply | undefined;
  if (!reply || !Array.isArray(reply.blocks)) throw new Error('Respuesta del agente sin blocks');
  return reply;
}

/** Parte de BedrockAgentCoreClient que usa el router (los tests pasan un fake). */
export interface AgentCoreSdk {
  send(
    command: InvokeAgentRuntimeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ response?: { transformToString(): Promise<string> } }>;
}

export function agentTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.AGENT_REQUEST_TIMEOUT_MS ?? DEFAULT_AGENT_TIMEOUT_MS);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`AGENT_REQUEST_TIMEOUT_MS invalido: ${env.AGENT_REQUEST_TIMEOUT_MS}`);
  return ms;
}

/**
 * Cliente de AgentCore con timeout menor que el de la Lambda (AGENT_REQUEST_TIMEOUT_MS, lo
 * calcula el MessagingStack), asi el catch del router llega a liberar el claim:
 * - `requestTimeout`/`connectionTimeout` del http handler del SDK;
 * - `abortSignal` y un timeout total sobre la llamada y la lectura del body.
 */
export class AgentCoreClient implements AgentClient {
  private readonly client: AgentCoreSdk;
  constructor(
    private readonly runtimeArn: string,
    private readonly timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
    client?: AgentCoreSdk,
  ) {
    this.client =
      client ??
      (new BedrockAgentCoreClient({
        requestHandler: { requestTimeout: timeoutMs, connectionTimeout: Math.min(5_000, timeoutMs) },
      }) as unknown as AgentCoreSdk);
  }

  async invoke(request: AgentInvokeRequest): Promise<AgentReply> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.call(request, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(request: AgentInvokeRequest, abortSignal: AbortSignal): Promise<AgentReply> {
    const out = await this.client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.runtimeArn,
        runtimeSessionId: request.sessionId,
        // VERIFICAR: runtimeUserId pide ademas bedrock-agentcore:InvokeAgentRuntimeForUser.
        runtimeUserId: request.patientRef,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(request)),
      }),
      { abortSignal },
    );
    const body = await out.response?.transformToString();
    if (!body) throw new Error('AgentCore devolvio una respuesta vacia');
    return parseAgentReply(body);
  }
}

/** Parte del DynamoDBDocumentClient que usa DynamoEventStore (los tests pasan un fake). */
export interface EventsDocClient {
  send(command: PutCommand | DeleteCommand): Promise<unknown>;
}

/**
 * Estado del claim en `err.Item` de un put condicional fallido, en sus dos formatos:
 * unmarshalled (`'DONE'`) o AttributeValue (`{ S: 'DONE' }`). undefined si no vino el item.
 */
export function claimStatusFromConditionError(err: unknown): string | undefined {
  const raw = (err as { Item?: Record<string, unknown> }).Item?.claimStatus as string | { S?: string } | undefined;
  return typeof raw === 'string' ? raw : raw?.S;
}

export class DynamoEventStore implements EventStore {
  constructor(
    private readonly messageEventsTable: string,
    private readonly appointmentsTable: string,
    private readonly doc: EventsDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
    private readonly now: () => number = Date.now,
  ) {}

  private expiresAt() {
    return Math.floor(this.now() / 1000) + MESSAGE_EVENTS_TTL_SECONDS;
  }

  private async putIfAbsent(item: Record<string, unknown>): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.messageEventsTable,
          Item: item,
          ConditionExpression: 'attribute_not_exists(messageId)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || (err as Error).name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }

  claim(key: EventKey) {
    return this.putIfAbsent({ ...key, claimedAt: this.now(), expiresAt: this.expiresAt() });
  }

  async claimWithLease(key: EventKey, nowMs: number, leaseMs: number): Promise<ClaimResult> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.messageEventsTable,
          Item: { ...key, claimStatus: 'CLAIMED', claimedAt: nowMs, expiresAt: this.expiresAt() },
          ConditionExpression: 'attribute_not_exists(messageId) OR (claimStatus = :claimed AND claimedAt < :cutoff)',
          ExpressionAttributeValues: { ':claimed': 'CLAIMED', ':cutoff': nowMs - leaseMs },
          // Devuelve el item existente en la excepcion, sin GetItem.
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'acquired';
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException || (err as Error).name === 'ConditionalCheckFailedException')) throw err;
      switch (claimStatusFromConditionError(err)) {
        case 'SENDING':
        case 'DONE':
          return 'done';
        case 'FAILED':
          return 'failed';
        default:
          // CLAIMED con lease vigente, o sin Item (no deberia pasar con ALL_OLD): se reintenta
          // en vez de descartar el mensaje como duplicado.
          return 'in_progress';
      }
    }
  }

  async markClaim(key: EventKey, status: Exclude<ClaimStatus, 'CLAIMED'>, nowMs: number) {
    await this.doc.send(
      new PutCommand({
        TableName: this.messageEventsTable,
        Item: { ...key, claimStatus: status, updatedAt: nowMs, expiresAt: this.expiresAt() },
      }),
    );
  }

  async release(key: EventKey) {
    await this.doc.send(new DeleteCommand({ TableName: this.messageEventsTable, Key: key }));
  }

  saveDeliveryEvent(event: DeliveryEvent) {
    // No se guarda el telefono de destino.
    return this.putIfAbsent({
      ...deliveryKey(event),
      occurredAt: event.eventTimestamp,
      channel: event.channel,
      status: event.status,
      rawEventType: event.rawEventType,
      rawMessageStatus: event.rawMessageStatus,
      isFinal: event.isFinal,
      context: event.context,
      expiresAt: this.expiresAt(),
    });
  }

  async upsertContact(ref: string, phone: string) {
    // Item CONTACT#<hash> en appointments: telefono para enviar recordatorios.
    await this.doc.send(
      new PutCommand({
        TableName: this.appointmentsTable,
        Item: { appointmentId: `CONTACT#${ref}`, phone, updatedAt: new Date(this.now()).toISOString() },
      }),
    );
  }
}

let cachedSalt: string | undefined;
async function saltFromSecretsManager(): Promise<string> {
  if (cachedSalt) return cachedSalt;
  const out = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: process.env.PHONE_HASH_SALT_SECRET_ARN }),
  );
  cachedSalt = out.SecretString ?? '';
  return cachedSalt;
}

/** INBOUND_CLAIM_LEASE_MS del stack (timeout de la Lambda + margen); si falta, INBOUND_CLAIM_LEASE_MS. */
export function claimLeaseFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.INBOUND_CLAIM_LEASE_MS ?? INBOUND_CLAIM_LEASE_MS);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`INBOUND_CLAIM_LEASE_MS invalido: ${env.INBOUND_CLAIM_LEASE_MS}`);
  return ms;
}

/** Misma validacion que la config de CDK (`parseChannelMode`). */
export function channelModeFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelMode {
  return parseChannelMode(env.CHANNEL_MODE);
}

let realHandler: ReturnType<typeof createHandler> | undefined;
export const handler = async (event: SNSEvent) => {
  if (!realHandler) {
    const channelMode = channelModeFromEnv();
    const settings = rcsSettingsFromEnv();
    realHandler = createHandler({
      agent: new AgentCoreClient(process.env.AGENT_RUNTIME_ARN ?? '', agentTimeoutFromEnv()),
      // Un solo cliente de rcs-client: en modo sms SendTextMessage con el fallbackText de la plantilla.
      rcsSender: createSender({ ...settings, channelMode: 'rcs' }),
      smsSender: createSender({ ...settings, channelMode: 'sms' }),
      channelMode,
      store: new DynamoEventStore(process.env.MESSAGE_EVENTS_TABLE ?? '', process.env.APPOINTMENTS_TABLE ?? ''),
      getSalt: saltFromSecretsManager,
      metricsNamespace: process.env.METRICS_NAMESPACE ?? 'RsConcierge',
      claimLeaseMs: claimLeaseFromEnv(),
    });
  }
  return realHandler(event);
};
