import { SendRcsMessageCommand, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import {
  type RcsSettings,
  type SmsVoiceClientLike,
  SdkRcsSender,
  buildSendRcsInput,
  buildSendTextInput,
  channelFor,
  rcsSettingsFromEnv,
} from './rcs-client';
import { reminderCard, textMessage } from './rcs-templates';
import { syntheticProviders } from '../tools/synthetic-data';

const settings: RcsSettings = {
  rcsAgentId: 'rcs-agent-test',
  smsOriginationIdentity: '+15555550199',
  configurationSetName: 'rs-concierge-test-rcs',
  ttlSeconds: 120,
};

function fakeClient() {
  const calls: Array<SendRcsMessageCommand | SendTextMessageCommand> = [];
  const client: SmsVoiceClientLike = {
    send: async (cmd) => (calls.push(cmd), { MessageId: `m-${calls.length}` }),
  };
  return { client, calls };
}

describe('rcs-client', () => {
  it('arma SendRcsMessage con FallbackConfiguration SMS y TTL', () => {
    const msg = textMessage('Hello');
    const input = buildSendRcsInput(settings, '+15555550100', msg, { sessionId: 's' });
    expect(input).toMatchObject({
      DestinationPhoneNumber: '+15555550100',
      OriginationIdentity: 'rcs-agent-test',
      TimeToLive: 120,
      ConfigurationSetName: 'rs-concierge-test-rcs',
      FallbackConfiguration: { Channel: 'SMS', MessageBody: 'Hello', OriginationIdentity: '+15555550199' },
      Context: { sessionId: 's' },
    });
    expect(input.RcsMessageContent).toBe(msg.content);
  });

  it('acota TTL y MessageBody del fallback a los limites documentados', () => {
    const input = buildSendRcsInput({ ...settings, ttlSeconds: 10_000_000 }, '+1', {
      content: { Content: { TextMessage: { Body: 'x' } } },
      fallbackText: 'y'.repeat(2000),
    });
    expect(input.TimeToLive).toBe(172800);
    expect(input.FallbackConfiguration?.MessageBody?.length).toBe(1600);
    const noFallback = buildSendRcsInput(settings, '+1', { content: { Content: { TextMessage: { Body: 'x' } } }, fallbackText: ' ' });
    expect(noFallback.FallbackConfiguration).toBeUndefined();
  });

  it('arma SendTextMessage para el modo sms con el numero SMS como origen', () => {
    const input = buildSendTextInput(settings, '+15555550100', 'Hola “mundo”', { reminder: 'T24' });
    expect(input).toEqual({
      DestinationPhoneNumber: '+15555550100',
      OriginationIdentity: '+15555550199',
      MessageBody: 'Hola "mundo"',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: 'rs-concierge-test-rcs',
      ProtectConfigurationId: undefined,
      Context: { reminder: 'T24' },
    });
  });

  it('SdkRcsSender en modo rcs manda SendRcsMessage con el cliente inyectado', async () => {
    const { client, calls } = fakeClient();
    const sender = new SdkRcsSender(settings, client);
    const provider = syntheticProviders()[0];
    const appt = {
      appointmentId: 'apt_1',
      patientRef: 'r',
      providerId: provider.providerId,
      slotId: 's',
      startsAt: '2026-10-29T14:00:00.000Z',
      status: 'BOOKED' as const,
      reminderScheduleNames: [],
      createdAt: '',
      updatedAt: '',
    };
    await expect(sender.send('+15555550100', reminderCard(appt, provider, 'T48'))).resolves.toBe('m-1');
    expect(calls[0]).toBeInstanceOf(SendRcsMessageCommand);
    expect((calls[0] as SendRcsMessageCommand).input.FallbackConfiguration?.MessageBody).toMatch(/Reply 1, 2 or 3/);
  });

  it('SdkRcsSender en modo sms manda el texto SMS por SendTextMessage', async () => {
    const { client, calls } = fakeClient();
    const sender = new SdkRcsSender({ ...settings, channelMode: 'sms' }, client);
    await sender.send('+15555550100', textMessage('Pick one:', ['A', 'B']));
    expect(calls[0]).toBeInstanceOf(SendTextMessageCommand);
    expect((calls[0] as SendTextMessageCommand).input.MessageBody).toBe('Pick one:\n1) A\n2) B\nReply 1 or 2.');
    await sender.sendText('+15555550100', 'plain');
    expect((calls[1] as SendTextMessageCommand).input.MessageBody).toBe('plain');
  });

  it('lee la config del entorno: rcs exige RCS_AGENT_ID, sms no', () => {
    const base = { SMS_ORIGINATION_IDENTITY: '+1555', CONFIGURATION_SET_NAME: 'cs', RCS_TTL_SECONDS: '0' };
    expect(() => rcsSettingsFromEnv(base)).toThrow(/RCS_AGENT_ID/);
    const sms = rcsSettingsFromEnv({ ...base, CHANNEL_MODE: 'SMS' });
    expect(sms.channelMode).toBe('sms');
    expect(sms.ttlSeconds).toBe(1);
    expect(channelFor(sms)).toBe('SMS');
    const rcs = rcsSettingsFromEnv({ ...base, RCS_AGENT_ID: 'agent', RCS_TTL_SECONDS: undefined });
    expect(rcs).toMatchObject({ channelMode: 'rcs', ttlSeconds: 300, rcsAgentId: 'agent' });
    expect(channelFor(rcs)).toBe('RCS');
  });

  it('RCS_TTL_SECONDS vacio usa el default (no cae a 1 s)', () => {
    const env = { SMS_ORIGINATION_IDENTITY: '+1555', CONFIGURATION_SET_NAME: 'cs', RCS_AGENT_ID: 'agent' };
    expect(rcsSettingsFromEnv({ ...env, RCS_TTL_SECONDS: '' }).ttlSeconds).toBe(300);
    expect(rcsSettingsFromEnv({ ...env, RCS_TTL_SECONDS: '120' }).ttlSeconds).toBe(120);
  });
});
