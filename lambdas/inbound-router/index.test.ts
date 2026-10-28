import type { SNSEvent } from 'aws-lambda';
import type { AgentInvokeRequest, AgentReply } from '../shared/contracts';
import { buildSendRcsInput, buildSendTextInput, createSender } from '../shared/rcs-client';
import { providerCarousel, textMessage } from '../shared/rcs-templates';
import { syntheticProviders } from '../tools/synthetic-data';
import * as fx from './fixtures';
import { parseChannelMode } from '../shared/channel-mode';
import { classifyDeliveryEvent, normalizeEvent } from './events';
import {
  AgentCoreClient,
  AgentTimeoutError,
  ChannelMode,
  ClaimResult,
  ClaimStatus,
  EventKey,
  EventStore,
  INBOUND_CLAIM_LEASE_MS,
  InboundInProgressError,
  InboundSendFailedError,
  channelModeFromEnv,
  claimLeaseFromEnv,
  createHandler,
  deliveryKey,
  errorSummary,
  inboundClaimKey,
  parseAgentReply,
  postbackToInput,
  summaryMetricFor,
  telemetryPostbackAction,
} from './index';

let snsSeq = 0;
const sns = (...messages: object[]): SNSEvent =>
  ({
    Records: messages.map((m) => ({ Sns: { Message: JSON.stringify(m), MessageId: `sns-${++snsSeq}` } })),
  }) as unknown as SNSEvent;

/** Store en memoria con la misma semantica que los puts condicionales de DynamoDB. */
class FakeStore implements EventStore {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly contacts = new Map<string, string>();
  releaseError?: Error;
  private k = (key: EventKey) => `${key.messageId}|${key.eventTimestamp}`;
  async claim(key: EventKey) {
    if (this.items.has(this.k(key))) return false;
    this.items.set(this.k(key), { ...key });
    return true;
  }
  async claimWithLease(key: EventKey, nowMs: number, leaseMs: number): Promise<ClaimResult> {
    const old = this.items.get(this.k(key));
    const reclaimable = !old || (old.claimStatus === 'CLAIMED' && (old.claimedAt as number) < nowMs - leaseMs);
    if (reclaimable) {
      this.items.set(this.k(key), { ...key, claimStatus: 'CLAIMED', claimedAt: nowMs });
      return 'acquired';
    }
    if (old!.claimStatus === 'FAILED') return 'failed';
    return old!.claimStatus === 'CLAIMED' ? 'in_progress' : 'done';
  }
  async markClaim(key: EventKey, status: Exclude<ClaimStatus, 'CLAIMED'>, nowMs: number) {
    this.items.set(this.k(key), { ...key, claimStatus: status, updatedAt: nowMs });
  }
  async release(key: EventKey) {
    if (this.releaseError) throw this.releaseError;
    this.items.delete(this.k(key));
  }
  async saveDeliveryEvent(e: Parameters<EventStore['saveDeliveryEvent']>[0]) {
    return this.claim(deliveryKey(e));
  }
  async upsertContact(ref: string, phone: string) {
    this.contacts.set(ref, phone);
  }
  /** Claims de entrantes (pk INBOUND#...). */
  inbound() {
    return [...this.items.values()].filter((i) => String(i.messageId).startsWith('INBOUND#'));
  }
}

function setup(
  reply: AgentReply | (() => Promise<AgentReply>),
  channelMode: ChannelMode = 'rcs',
  opts: { now?: () => number } = {},
) {
  const invoked: AgentInvokeRequest[] = [];
  const rcsSent: Array<{ to: string; fallback: string; context?: Record<string, string> }> = [];
  const smsSent: Array<{ to: string; body: string }> = [];
  const logs: string[] = [];
  const store = new FakeStore();
  const handler = createHandler({
    agent: {
      invoke: async (req) => {
        invoked.push(req);
        return typeof reply === 'function' ? reply() : reply;
      },
    },
    rcsSender: { send: async (to, msg, context) => (rcsSent.push({ to, fallback: msg.fallbackText, context }), 'out-rcs') },
    smsSender: { send: async (to, msg) => (smsSent.push({ to, body: msg.fallbackText }), 'out-sms') },
    channelMode,
    store,
    getSalt: async () => 'test-salt',
    metricsNamespace: 'Test',
    log: (l) => logs.push(l),
    now: opts.now,
  });
  const metrics = () =>
    logs
      .map((l) => JSON.parse(l))
      .filter((l) => l._aws)
      .map((l) => l._aws.CloudWatchMetrics[0].Metrics[0].Name as string);
  return { handler, invoked, rcsSent, smsSent, logs, store, metrics };
}

const okReply: AgentReply = { version: '1', sessionId: 'x', blocks: [{ type: 'text', text: 'ok' }] };

describe('normalizeEvent (fixtures de la doc de AWS)', () => {
  it('texto RCS: normaliza el telefono sin "+" y detecta el canal por el RCS agent', () => {
    expect(normalizeEvent(JSON.stringify(fx.inboundRcsText))).toMatchObject({
      kind: 'text',
      from: fx.PATIENT,
      channel: 'RCS',
      text: 'I want rhinoplasty in Miami',
      inboundMessageId: 'in-rcs-0001',
    });
  });

  it('texto SMS: canal SMS y previousPublishedMessageId', () => {
    expect(normalizeEvent(JSON.stringify(fx.inboundSmsText))).toMatchObject({
      kind: 'text',
      channel: 'SMS',
      previousPublishedMessageId: 'out-0001',
    });
  });

  it('postback SUGGESTION: saca postbackData y texto del messageBody JSON', () => {
    expect(normalizeEvent(JSON.stringify(fx.postbackConfirm))).toMatchObject({
      kind: 'postback',
      postbackData: 'a=confirm&ap=apt_1a2b3c4d',
      text: 'Confirm',
    });
  });

  it('typing, CONVERSATION_STARTED y STOP se ignoran', () => {
    expect(normalizeEvent(JSON.stringify(fx.typing)).kind).toBe('ignored');
    expect(normalizeEvent(JSON.stringify(fx.conversationStarted)).kind).toBe('ignored');
    expect(normalizeEvent(JSON.stringify(fx.optOut)).kind).toBe('ignored');
  });

  it('usa el MessageId de SNS si falta inboundMessageId', () => {
    const { inboundMessageId: _omit, ...noId } = fx.inboundRcsText;
    expect(normalizeEvent(JSON.stringify(noId), 'sns-abc')).toMatchObject({ inboundMessageId: 'sns-abc' });
  });

  it('entregas: canal por eventType u originationPhoneNumber y estado por messageStatus', () => {
    expect(normalizeEvent(JSON.stringify(fx.rcsDelivered))).toMatchObject({ kind: 'delivery', channel: 'RCS', status: 'DELIVERED' });
    expect(normalizeEvent(JSON.stringify(fx.rcsRead))).toMatchObject({ channel: 'RCS', status: 'READ' });
    expect(normalizeEvent(JSON.stringify(fx.rcsUndeliverable))).toMatchObject({ channel: 'RCS', status: 'FAILED' });
    expect(normalizeEvent(JSON.stringify(fx.smsFallbackDelivered))).toMatchObject({ channel: 'SMS', status: 'DELIVERED' });
    expect(normalizeEvent(JSON.stringify(fx.smsBlocked))).toMatchObject({ channel: 'SMS', status: 'FAILED' });
    expect(normalizeEvent(JSON.stringify(fx.rcsFallbackHypothetical))).toMatchObject({ status: 'FALLBACK' });
  });

  it('classifyDeliveryEvent: TEXT_SUCCESSFUL desde un RCS agent es RCS; TTL y PENDING', () => {
    expect(classifyDeliveryEvent('TEXT_SUCCESSFUL', 'SUCCESSFUL', fx.RCS_AGENT)).toEqual({ channel: 'RCS', status: 'DELIVERED' });
    expect(classifyDeliveryEvent('TTL_EXPIRATION_REVOKED')).toEqual({ channel: 'SMS', status: 'EXPIRED' });
    expect(classifyDeliveryEvent('RCS_DELIVERED', 'PENDING')).toEqual({ channel: 'RCS', status: 'SENT' });
    expect(classifyDeliveryEvent('TEXT_TTL_EXPIRED', 'TTL_EXPIRED')).toEqual({ channel: 'SMS', status: 'EXPIRED' });
  });

  it('classifyDeliveryEvent: mapa explicito, UNDELIVERED no es DELIVERED y lo desconocido es OTHER', () => {
    expect(classifyDeliveryEvent('RCS_DELIVERED', 'UNDELIVERED')).toEqual({ channel: 'RCS', status: 'FAILED' });
    expect(classifyDeliveryEvent('TEXT_SOMETHING_NEW', 'SOMETHING_NEW')).toEqual({ channel: 'SMS', status: 'OTHER' });
    expect(classifyDeliveryEvent('TEXT_DELIVERED')).toEqual({ channel: 'SMS', status: 'DELIVERED' });
    expect(classifyDeliveryEvent('RCS_FALLBACK', 'DELIVERED')).toEqual({ channel: 'RCS', status: 'FALLBACK' });
    expect(classifyDeliveryEvent('TTL_EXPIRATION_REVOKE_FAILED')).toEqual({ channel: 'SMS', status: 'OTHER' });
  });

  it('descarta basura', () => {
    expect(normalizeEvent('not json')).toEqual({ kind: 'unknown', reason: 'mensaje SNS no es JSON' });
    expect(normalizeEvent(JSON.stringify({ eventType: 'RCS_DELIVERED' })).kind).toBe('unknown');
    expect(normalizeEvent(JSON.stringify({ foo: 1 })).kind).toBe('unknown');
  });
});

describe('inbound-router: texto y postbacks', () => {
  const providers = syntheticProviders().slice(0, 3);

  it('texto RCS: session id >= 33, sin telefono al agente, responde el carrusel por RCS', async () => {
    const t = setup({ version: '1', sessionId: 'x', blocks: [{ type: 'provider_carousel', providers }] });
    await t.handler(sns(fx.inboundRcsText));

    expect(t.invoked).toHaveLength(1);
    expect(t.invoked[0].sessionId.length).toBeGreaterThanOrEqual(33);
    expect(t.invoked[0].channel).toBe('RCS');
    expect(t.invoked[0].input).toEqual({ type: 'text', text: 'I want rhinoplasty in Miami' });
    expect(JSON.stringify(t.invoked[0])).not.toContain('5555550100');
    expect(t.rcsSent).toHaveLength(1);
    expect(t.rcsSent[0].to).toBe(fx.PATIENT);
    expect(t.rcsSent[0].context).toMatchObject({ blockType: 'provider_carousel', channelMode: 'rcs' });
    expect(t.smsSent).toHaveLength(0);
    expect(t.store.contacts.size).toBe(1);
  });

  it('mismo telefono, mismo session id (con o sin "+")', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.inboundRcsText, { ...fx.inboundSmsText, inboundMessageId: 'other' }));
    expect(t.invoked[0].sessionId).toBe(t.invoked[1].sessionId);
  });

  it('logs: telefono enmascarado y sin texto del paciente', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.inboundRcsText));
    const all = t.logs.join('\n');
    expect(all).not.toContain('5555550100');
    expect(all).not.toContain('rhinoplasty');
    expect(all).toContain('+15******00');
  });

  it('postback de slot: pasa postbackData y el texto visible', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.postbackSelectSlot));
    expect(t.invoked[0].input).toEqual({
      type: 'postback',
      postbackData: fx.postbackSelectSlot.messageBody && JSON.parse(fx.postbackSelectSlot.messageBody).postbackData,
      text: 'Tue Oct 27, 10:00 AM',
    });
  });

  it('postback de recordatorio (confirm): texto estructurado para el agente', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.postbackConfirm));
    expect(t.invoked[0].input).toEqual({
      type: 'postback',
      postbackData: 'a=confirm&ap=apt_1a2b3c4d',
      text: '[button] action=confirm appointmentId=apt_1a2b3c4d',
    });
  });

  it('postback a=reply se manda como texto', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.postbackReply));
    expect(t.invoked[0].input).toEqual({ type: 'text', text: 'Yes, please' });
    expect(postbackToInput('Open')).toEqual({ type: 'postback', postbackData: 'Open' });
  });

  it('idempotencia: el mismo inboundMessageId dos veces invoca una sola vez', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.inboundRcsText));
    await t.handler(sns(fx.inboundRcsText));
    expect(t.invoked).toHaveLength(1);
    expect(t.rcsSent).toHaveLength(1);
  });

  it('si el agente falla: libera el claim, propaga el error y el reintento procesa', async () => {
    let fail = true;
    const t = setup(async () => {
      if (fail) throw new Error('boom');
      return okReply;
    });
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toThrow('boom');
    expect(t.rcsSent).toHaveLength(0);
    fail = false;
    await t.handler(sns(fx.inboundRcsText));
    expect(t.rcsSent).toHaveLength(1);
  });

  it('claim: termina en DONE y la pk no contiene el inboundMessageId (hash con sal)', async () => {
    const t = setup(okReply);
    const withPhoneId = { ...fx.inboundRcsText, inboundMessageId: '15555550100-1792500000000' };
    await t.handler(sns(withPhoneId));
    const [claim] = t.store.inbound();
    expect(claim).toMatchObject({ eventTimestamp: 'CLAIM', claimStatus: 'DONE' });
    expect(String(claim.messageId)).not.toContain('5555550100');
    expect(claim.messageId).toBe(inboundClaimKey('15555550100-1792500000000', 'test-salt').messageId);
  });

  it('lease: si la Lambda corto (claim CLAIMED sin release), el reintento con el lease vencido procesa', async () => {
    let clock = 1_000_000;
    const t = setup(okReply, 'rcs', { now: () => clock });
    // Simula una invocacion que tomo el claim y murio por timeout antes del catch.
    await t.store.claimWithLease(inboundClaimKey(fx.inboundRcsText.inboundMessageId, 'test-salt'), clock, INBOUND_CLAIM_LEASE_MS);

    // Dentro del lease: otra invocacion lo tiene, se falla para que Lambda reintente.
    clock += INBOUND_CLAIM_LEASE_MS - 1;
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toBeInstanceOf(InboundInProgressError);
    expect(t.invoked).toHaveLength(0);

    // Lease vencido: el reintento lo reclama y responde.
    clock += 2;
    await t.handler(sns(fx.inboundRcsText));
    expect(t.invoked).toHaveLength(1);
    expect(t.rcsSent).toHaveLength(1);
    expect(t.store.inbound()[0].claimStatus).toBe('DONE');

    // Despues de DONE es un duplicado aunque pase el lease.
    clock += 10 * INBOUND_CLAIM_LEASE_MS;
    await t.handler(sns(fx.inboundRcsText));
    expect(t.invoked).toHaveLength(1);
  });

  /** Dos bloques y un sender que falla en el envio numero `failAt` (1-based) mientras `failing` sea true. */
  function sendFailureSetup(failAt: number) {
    const twoBlocks: AgentReply = { version: '1', sessionId: 'x', blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    const t = setup(twoBlocks);
    const sent: string[] = [];
    const state = { failing: true, attempts: 0, invocations: 0 };
    const handler = createHandler({
      agent: { invoke: async () => (state.invocations++, twoBlocks) },
      rcsSender: {
        send: async (_to, msg) => {
          state.attempts++;
          if (state.failing && state.attempts === failAt) throw new Error('send failed for +15555550100');
          sent.push(msg.fallbackText);
          return `out-${state.attempts}`;
        },
      },
      channelMode: 'rcs',
      store: t.store,
      getSalt: async () => 'test-salt',
      metricsNamespace: 'T',
      log: (l) => t.logs.push(l),
    });
    return { ...t, handler, sent, state };
  }

  it('si falla el primer envio (0 bloques enviados): libera el claim, propaga el error y el reintento reprocesa', async () => {
    const t = sendFailureSetup(1);
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toThrow('send failed');
    expect(t.store.inbound()).toHaveLength(0);
    expect(t.metrics()).not.toContain('Failed');
    const errors = t.logs.map((l) => JSON.parse(l)).filter((l) => l.level === 'error');
    expect(errors[0]).toMatchObject({ msg: 'fallo al enviar la respuesta', sentBlocks: 0, totalBlocks: 2 });

    // Reintento asincronico de Lambda: vuelve a invocar al agente y manda los dos bloques.
    t.state.failing = false;
    await t.handler(sns(fx.inboundRcsText));
    expect(t.state.invocations).toBe(2);
    expect(t.sent).toEqual(['a', 'b']);
    expect(t.store.inbound()[0].claimStatus).toBe('DONE');
    expect(t.logs.join('\n')).not.toContain('5555550100');
  });

  it('si falla un envio despues de mandar un bloque: FAILED, metrica Failed y error; el reintento falla sin duplicar (DLQ)', async () => {
    const t = sendFailureSetup(2);
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toBeInstanceOf(InboundSendFailedError);
    expect(t.sent).toEqual(['a']);
    expect(t.store.inbound()[0].claimStatus).toBe('FAILED');
    expect(t.metrics()).toEqual(['Failed']);
    const errors = t.logs.map((l) => JSON.parse(l)).filter((l) => l.level === 'error');
    expect(errors[0]).toMatchObject({ msg: 'fallo al enviar la respuesta', sentBlocks: 1, totalBlocks: 2 });

    // Cada reintento falla (no se toma como duplicado) y no reenvia: agotados, el evento va al onFailure.
    t.state.failing = false;
    for (let i = 0; i < 2; i++) {
      await expect(t.handler(sns(fx.inboundRcsText))).rejects.toBeInstanceOf(InboundSendFailedError);
    }
    expect(t.state.invocations).toBe(1);
    expect(t.sent).toEqual(['a']);
    expect(t.metrics()).toEqual(['Failed']);
    expect(t.logs.join('\n')).not.toContain('5555550100');
  });

  it('si falla marcar FAILED: se loguea y la invocacion falla igual', async () => {
    const t = sendFailureSetup(2);
    const markClaim = t.store.markClaim.bind(t.store);
    t.store.markClaim = async (key, status, nowMs) => {
      if (status === 'FAILED') throw Object.assign(new Error('ddb down'), { name: 'InternalServerError' });
      return markClaim(key, status, nowMs);
    };
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toBeInstanceOf(InboundSendFailedError);
    const msgs = t.logs.map((l) => JSON.parse(l)).filter((l) => l.level === 'error').map((l) => l.msg);
    expect(msgs).toEqual(['fallo al enviar la respuesta', 'fallo al marcar el claim FAILED']);
  });

  it('claimLeaseMs inyectado (INBOUND_CLAIM_LEASE_MS del stack) reemplaza al default', async () => {
    let clock = 1_000_000;
    const logs: string[] = [];
    const t = setup(okReply);
    const handler = createHandler({
      agent: { invoke: async () => okReply },
      rcsSender: { send: async () => 'out' },
      channelMode: 'rcs',
      store: t.store,
      getSalt: async () => 'test-salt',
      metricsNamespace: 'T',
      log: (l) => logs.push(l),
      now: () => clock,
      claimLeaseMs: 1_000,
    });
    await t.store.claimWithLease(inboundClaimKey(fx.inboundRcsText.inboundMessageId, 'test-salt'), clock, 1_000);
    clock += 1_001;
    await handler(sns(fx.inboundRcsText));
    expect(t.store.inbound()[0].claimStatus).toBe('DONE');
  });

  it('claimLeaseFromEnv: lee INBOUND_CLAIM_LEASE_MS, default y valor invalido', () => {
    expect(claimLeaseFromEnv({ INBOUND_CLAIM_LEASE_MS: '150000' })).toBe(150_000);
    expect(claimLeaseFromEnv({})).toBe(INBOUND_CLAIM_LEASE_MS);
    expect(() => claimLeaseFromEnv({ INBOUND_CLAIM_LEASE_MS: 'x' })).toThrow('INBOUND_CLAIM_LEASE_MS invalido');
  });

  it('si el release falla: se propaga el error original y se loguean ambos sin PII', async () => {
    const t = setup(async () => {
      throw Object.assign(new Error('Throttled for +15555550100'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } });
    });
    t.store.releaseError = Object.assign(new Error('ddb down'), { name: 'InternalServerError' });
    await expect(t.handler(sns(fx.inboundRcsText))).rejects.toThrow('Throttled');
    const errors = t.logs.map((l) => JSON.parse(l)).filter((l) => l.level === 'error');
    expect(errors.map((e) => e.msg)).toEqual(['fallo al invocar al agente', 'fallo al liberar el claim']);
    expect(errors[0].error).toMatchObject({ name: 'ThrottlingException', httpStatusCode: 429 });
    expect(errors[1].error).toMatchObject({ name: 'InternalServerError', message: 'ddb down' });
    expect(t.logs.join('\n')).not.toContain('5555550100');
  });

  it('errorSummary: nombre, mensaje sin telefonos y metadata del SDK', () => {
    expect(errorSummary(Object.assign(new Error('bad +1 555 555 0100 x'), { $metadata: { requestId: 'r-1' } }))).toEqual({
      name: 'Error',
      message: 'bad [redacted] x',
      httpStatusCode: undefined,
      requestId: 'r-1',
    });
  });

  it('typing y CONVERSATION_STARTED no invocan al agente', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.typing, fx.conversationStarted, fx.optOut));
    expect(t.invoked).toHaveLength(0);
  });

  it('postbacks view_profile y add_calendar: solo log y metrica, sin agente ni envio', async () => {
    const t = setup(okReply);
    const viewProfile = fx.suggestion('a=view_profile&p=prov_miami_01', 'View profile', 'in-pb-tel-1');
    const addCalendar = fx.suggestion('a=add_calendar&ap=apt_1a2b3c4d', 'Add to calendar', 'in-pb-tel-2');
    await t.handler(sns(viewProfile, addCalendar));
    await t.handler(sns(viewProfile)); // re-entrega de SNS: no se mide dos veces
    expect(t.invoked).toHaveLength(0);
    expect(t.rcsSent).toHaveLength(0);
    expect(t.metrics()).toEqual(['PostbackTelemetry', 'PostbackTelemetry']);
    const actions = t.logs.map((l) => JSON.parse(l)).filter((l) => l.PostbackTelemetry).map((l) => l.Action);
    expect(actions).toEqual(['view_profile', 'add_calendar']);
    expect(t.store.inbound().every((i) => i.claimStatus === 'DONE')).toBe(true);
  });

  it('telemetryPostbackAction: solo view_profile y add_calendar', () => {
    expect(telemetryPostbackAction('a=view_profile&p=prov_1')).toBe('view_profile');
    expect(telemetryPostbackAction('a=add_calendar&ap=apt_1')).toBe('add_calendar');
    expect(telemetryPostbackAction('a=confirm&ap=apt_1')).toBeUndefined();
    expect(telemetryPostbackAction('Open')).toBeUndefined();
  });

  it('CHANNEL_MODE=sms: responde solo por SMS con el texto de fallback y avisa canal SMS al agente', async () => {
    const t = setup({ version: '1', sessionId: 'x', blocks: [{ type: 'provider_carousel', providers }] }, 'sms');
    await t.handler(sns(fx.inboundSmsText));
    expect(t.invoked[0].channel).toBe('SMS');
    expect(t.rcsSent).toHaveLength(0);
    expect(t.smsSent).toHaveLength(1);
    // El cuerpo es el fallbackText de la plantilla (menu numerado), sin depender del copy.
    expect(t.smsSent[0].body).toBe(providerCarousel(providers).fallbackText);
    expect(t.smsSent[0].body).toMatch(/^1\) /m);
  });

  it('CHANNEL_MODE=sms sin smsSender falla al armar el handler', () => {
    expect(() =>
      createHandler({
        agent: { invoke: async () => okReply },
        rcsSender: { send: async () => undefined },
        channelMode: 'sms',
        store: new FakeStore(),
        getSalt: async () => 's',
        metricsNamespace: 'T',
      }),
    ).toThrow('smsSender');
  });
});

describe('inbound-router: entregas y metricas EMF', () => {
  it('RCS entregado y leido: guarda ambos, DeliveryEvent x2 y RcsDelivered una sola vez', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.rcsDelivered, fx.rcsRead));
    expect(t.invoked).toHaveLength(0);
    expect(t.metrics()).toEqual(['DeliveryEvent', 'RcsDelivered', 'DeliveryEvent']);
    const first = JSON.parse(t.logs[0]);
    expect(first).toMatchObject({ Channel: 'RCS', Status: 'DELIVERED', DeliveryEvent: 1 });
  });

  it('fallback: RCS UNDELIVERABLE no cuenta como Failed; el SMS entregado cuenta SmsFallback una vez', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.rcsUndeliverable, fx.smsFallbackDelivered, fx.smsSuccessfulSameMessage));
    expect(t.metrics()).toEqual(['DeliveryEvent', 'DeliveryEvent', 'SmsFallback', 'DeliveryEvent']);
  });

  it('SMS en modo sms no es fallback; SMS bloqueado es Failed', async () => {
    const t = setup(okReply, 'sms');
    await t.handler(sns(fx.smsOnlyDelivered, fx.smsBlocked));
    expect(t.metrics()).toEqual(['DeliveryEvent', 'DeliveryEvent', 'Failed']);
  });

  it('evento duplicado de SNS: no se guarda ni se mide dos veces', async () => {
    const t = setup(okReply);
    await t.handler(sns(fx.rcsDelivered));
    await t.handler(sns(fx.rcsDelivered));
    expect(t.metrics()).toEqual(['DeliveryEvent', 'RcsDelivered']);
  });

  it('re-entrega sin eventTimestamp: la clave es messageId + eventType + messageStatus', async () => {
    const { eventTimestamp: _omit, ...noTs } = fx.smsBlocked;
    const t = setup(okReply, 'sms');
    await t.handler(sns(noTs));
    await new Promise((r) => setTimeout(r, 5));
    await t.handler(sns(noTs));
    expect(t.metrics()).toEqual(['DeliveryEvent', 'Failed']);
    expect(deliveryKey(normalizeEvent(JSON.stringify(noTs)) as never)).toEqual({
      messageId: 'msg-sms-2',
      eventTimestamp: 'EVENT#TEXT_CARRIER_BLOCKED#CARRIER_BLOCKED',
    });
  });

  it('summaryMetricFor usa CHANNEL_MODE si el evento no trae context', () => {
    const e = { ...(normalizeEvent(JSON.stringify(fx.smsFallbackDelivered)) as never as object), context: undefined };
    expect(summaryMetricFor(e as never, 'rcs')).toBe('SmsFallback');
    expect(summaryMetricFor(e as never, 'sms')).toBeUndefined();
  });
});

describe('CHANNEL_MODE: misma validacion en la config y en la Lambda', () => {
  it('case-insensitive, vacio es rcs e invalido falla', () => {
    expect(parseChannelMode('SMS')).toBe('sms');
    expect(parseChannelMode(' Rcs ')).toBe('rcs');
    expect(parseChannelMode(undefined)).toBe('rcs');
    expect(parseChannelMode('')).toBe('rcs');
    expect(() => parseChannelMode('mms')).toThrow('CHANNEL_MODE invalido');
    expect(channelModeFromEnv({ CHANNEL_MODE: 'SMS' })).toBe('sms');
    expect(() => channelModeFromEnv({ CHANNEL_MODE: 'whatsapp' })).toThrow('CHANNEL_MODE invalido');
  });
});

describe('AgentCoreClient: timeout menor que el de la Lambda', () => {
  const request = {
    version: '1',
    sessionId: 'rs-sess-' + 'a'.repeat(64),
    patientRef: 'a'.repeat(64),
    channel: 'RCS',
    input: { type: 'text', text: 'hi' },
    receivedAt: '2026-10-23T14:00:00Z',
    locale: 'en-US',
  } as AgentInvokeRequest;

  it('corta con AgentTimeoutError y aborta la llamada del SDK', async () => {
    let aborted = false;
    const sdk = {
      send: (_cmd: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise<never>(() => options?.abortSignal?.addEventListener('abort', () => (aborted = true))),
    };
    const client = new AgentCoreClient('arn:runtime', 20, sdk);
    await expect(client.invoke(request)).rejects.toBeInstanceOf(AgentTimeoutError);
    expect(aborted).toBe(true);
  });

  it('respuesta a tiempo: parsea el body y pasa el abortSignal', async () => {
    let signal: AbortSignal | undefined;
    const sdk = {
      send: async (_cmd: unknown, options?: { abortSignal?: AbortSignal }) => {
        signal = options?.abortSignal;
        return { response: { transformToString: async () => JSON.stringify(okReply) } };
      },
    };
    await expect(new AgentCoreClient('arn:runtime', 1000, sdk).invoke(request)).resolves.toMatchObject({ blocks: [{ type: 'text' }] });
    expect(signal).toBeDefined();
  });
});

describe('payloads de envio y respuesta del agente', () => {
  const settings = {
    rcsAgentId: fx.RCS_AGENT,
    smsOriginationIdentity: 'phone-test',
    configurationSetName: 'rs-concierge-dev-rcs',
    ttlSeconds: 300,
  };

  it('RCS: FallbackConfiguration a SMS con el texto plano y Context', () => {
    const input = buildSendRcsInput(settings, fx.PATIENT, textMessage('hi'), { channelMode: 'rcs' });
    expect(input.FallbackConfiguration).toMatchObject({ Channel: 'SMS', MessageBody: 'hi', OriginationIdentity: 'phone-test' });
    expect(input.Context).toEqual({ channelMode: 'rcs' });
  });

  it('SMS: SendTextMessage desde el numero de fallback', () => {
    expect(buildSendTextInput(settings, fx.PATIENT, textMessage('hi').fallbackText)).toMatchObject({
      DestinationPhoneNumber: fx.PATIENT,
      OriginationIdentity: 'phone-test',
      MessageBody: 'hi',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: 'rs-concierge-dev-rcs',
    });
  });

  it('createSender en modo sms (smsSender del handler): SendTextMessage con el fallbackText', async () => {
    const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const client = { send: async (command: never) => (commands.push(command), { MessageId: 'out-sms' }) };
    const smsSender = createSender({ ...settings, channelMode: 'sms' }, client);
    const message = textMessage('hi', ['Yes', 'No']);
    await expect(smsSender.send(fx.PATIENT, message, { channelMode: 'sms' })).resolves.toBe('out-sms');
    expect(commands).toHaveLength(1);
    expect(commands[0].constructor.name).toBe('SendTextMessageCommand');
    expect(commands[0].input).toMatchObject({
      DestinationPhoneNumber: fx.PATIENT,
      OriginationIdentity: 'phone-test',
      MessageBody: message.fallbackText,
      Context: { channelMode: 'sms' },
    });
  });

  it('parseAgentReply acepta JSON plano y SSE', () => {
    expect(parseAgentReply(JSON.stringify(okReply)).blocks).toHaveLength(1);
    const sse = `data: {"partial":\n\ndata: ${JSON.stringify(okReply)}\n\n`;
    expect(parseAgentReply(sse).blocks).toHaveLength(1);
    expect(() => parseAgentReply('{"version":"1"}')).toThrow('sin blocks');
  });
});
