/**
 * Fixtures de eventos SNS (datos sinteticos, telefonos 555). Copiados de los ejemplos de la
 * doc de AWS (21/10/2026) cambiando solo los valores; reemplazar por eventos reales de dev:
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-inbound.html
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-events.html
 * - https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets-event-format.html
 */
import { encodePostback, replyPostback } from '../shared/rcs-templates';

export const RCS_AGENT = 'rcs-00000000000000000000000000000000';
export const PATIENT = '+15555550100';

/** Texto libre por RCS: la doc usa el mismo formato que SMS two-way. RCS manda el numero sin "+". */
export const inboundRcsText = {
  originationNumber: '15555550100',
  destinationNumber: RCS_AGENT,
  messageBody: 'I want rhinoplasty in Miami',
  inboundMessageId: 'in-rcs-0001',
};

/** Texto libre por SMS (CHANNEL_MODE=sms): two-way del numero de fallback. */
export const inboundSmsText = {
  originationNumber: PATIENT,
  destinationNumber: '+15555550199',
  messageKeyword: '',
  messageBody: '2',
  inboundMessageId: 'in-sms-0001',
  previousPublishedMessageId: 'out-0001',
};

export const suggestion = (postbackData: string, text: string, id: string) => ({
  originationNumber: '15555550100',
  destinationNumber: RCS_AGENT,
  messageBody: JSON.stringify({ type: 'SUGGESTION', text, postbackData }),
  inboundMessageId: id,
});

export const postbackSelectSlot = suggestion(
  'a=select_slot&p=prov_miami_01&s=prov_miami_01%232026-10-27T14%3A00%3A00.000Z',
  'Tue Oct 27, 10:00 AM',
  'in-pb-0001',
);
export const postbackConfirm = suggestion('a=confirm&ap=apt_1a2b3c4d', 'Confirm', 'in-pb-0002');
/** Sugerencia de texto: el postback lo arma `replyPostback` de rcs-templates (`a=reply&t=Yes%2C+please`). */
export const postbackReply = suggestion(encodePostback(replyPostback('Yes, please')), 'Yes, please', 'in-pb-0003');

export const typing = {
  originationNumber: '15555550100',
  destinationNumber: RCS_AGENT,
  messageBody: JSON.stringify({ type: 'RCS_TYPING', receivedAt: '2026-10-23T14:00:00.000+0000' }),
  inboundMessageId: '15555550100-2026-10-23T14:00:00.000+0000',
};

export const conversationStarted = {
  originationNumber: '15555550100',
  destinationNumber: RCS_AGENT,
  messageBody: JSON.stringify({ type: 'CONVERSATION_STARTED', startTime: '2026-10-23T14:00:00.000+0000' }),
  inboundMessageId: 'conv-0001',
};

export const optOut = { ...inboundSmsText, messageKeyword: 'STOP', messageBody: 'STOP', inboundMessageId: 'in-stop-1' };

const deliveryBase = {
  eventVersion: '1.0',
  isFinal: true,
  destinationPhoneNumber: PATIENT,
  isoCountryCode: 'US',
  messageRequestTimestamp: 1792500000000,
  messageType: 'TRANSACTIONAL',
  totalMessageParts: 1,
  context: { sessionId: 'rs-sess-x', blockType: 'text', channelMode: 'rcs' },
};

export const rcsDelivered = {
  ...deliveryBase,
  eventType: 'RCS_DELIVERED',
  eventTimestamp: 1792500001000,
  originationPhoneNumber: RCS_AGENT,
  messageId: 'msg-rcs-1',
  messageStatus: 'DELIVERED',
  rcsBusinessId: 'synthetic_agent',
  agentIsoCountryCode: 'US',
};

export const rcsRead = { ...rcsDelivered, eventType: 'RCS_READ', messageStatus: 'READ', eventTimestamp: 1792500002000 };

export const rcsUndeliverable = {
  ...rcsDelivered,
  messageId: 'msg-fb-1',
  messageStatus: 'UNDELIVERABLE',
  eventTimestamp: 1792500003000,
};

/** SMS de fallback: sale del numero E.164. VERIFICAR si conserva messageId y context del envio RCS. */
export const smsFallbackDelivered = {
  ...deliveryBase,
  eventType: 'TEXT_DELIVERED',
  eventTimestamp: 1792500004000,
  originationPhoneNumber: '+15555550199',
  messageId: 'msg-fb-1',
  messageStatus: 'DELIVERED',
};

export const smsSuccessfulSameMessage = {
  ...smsFallbackDelivered,
  eventType: 'TEXT_SUCCESSFUL',
  messageStatus: 'SUCCESSFUL',
  eventTimestamp: 1792500004500,
};

export const smsOnlyDelivered = {
  ...smsFallbackDelivered,
  messageId: 'msg-sms-1',
  context: { sessionId: 'rs-sess-x', blockType: 'text', channelMode: 'sms' },
};

export const smsBlocked = {
  ...smsFallbackDelivered,
  eventType: 'TEXT_CARRIER_BLOCKED',
  messageStatus: 'CARRIER_BLOCKED',
  messageId: 'msg-sms-2',
};

/** VERIFICAR: nombre real del evento de fallback; la doc no lo publica. */
export const rcsFallbackHypothetical = {
  ...rcsDelivered,
  eventType: 'RCS_FALLBACK',
  messageStatus: 'FALLBACK',
  messageId: 'msg-fb-2',
};
