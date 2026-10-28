import { createHash } from 'crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import {
  CheckResult,
  buildInboundMessage,
  checkDemoSchedule,
  classifyRouterLogs,
  formatResultsTable,
  isE164,
  maskPhone,
  missingOutputs,
  overallExitCode,
  parseAtExpression,
  parseMcpResponse,
  parseStackOutputs,
  readSmokeEnv,
  signPostRequest,
  stackName,
  syntheticPatientRef,
  toolClientContext,
  validateSmokeEnv,
} from './lib';

const FAKE_NUMBER = '+15555550123';
const REMINDER_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:rs-concierge-dev-reminder-sender';

describe('stacks y salidas', () => {
  it('arma los nombres de build-stacks.ts', () => {
    expect(stackName('dev', 'Messaging')).toBe('RsConcierge-dev-Messaging');
  });

  it('junta las salidas de describe-stacks y detecta las que faltan', () => {
    const json = JSON.stringify({
      Stacks: [{ Outputs: [{ OutputKey: 'RcsEventsTopicArn', OutputValue: 'arn:topic' }, { OutputKey: 'GatewayUrl', OutputValue: 'https://gw' }] }],
    });
    const out = parseStackOutputs(json);
    expect(out).toEqual({ RcsEventsTopicArn: 'arn:topic', GatewayUrl: 'https://gw' });
    expect(missingOutputs(out)).toEqual(['MessageEventsTableName', 'AppointmentsTableName', 'AgentRuntimeArn', 'DashboardName']);
  });

  it('tolera un stack sin Outputs', () => {
    expect(parseStackOutputs(JSON.stringify({ Stacks: [{}] }))).toEqual({});
  });
});

describe('entorno y gate', () => {
  it('sin CONFIRM ni DRY_RUN se niega', () => {
    const errors = validateSmokeEnv(readSmokeEnv({ AWS_PROFILE: 'p', AWS_REGION: 'us-east-1', SMOKE_TEST_NUMBER: FAKE_NUMBER }));
    expect(errors).toEqual([expect.stringContaining('CONFIRM=yes')]);
  });

  it('CONFIRM=yes exige perfil, region y numero E.164 para el paso b', () => {
    expect(validateSmokeEnv(readSmokeEnv({ CONFIRM: 'yes' }))).toHaveLength(3);
    expect(validateSmokeEnv(readSmokeEnv({ CONFIRM: 'yes', AWS_PROFILE: 'p', AWS_REGION: 'r', SMOKE_TEST_NUMBER: '5555550123' }))).toEqual([
      expect.stringContaining('SMOKE_TEST_NUMBER'),
    ]);
    expect(validateSmokeEnv(readSmokeEnv({ CONFIRM: 'yes', AWS_PROFILE: 'p', AWS_REGION: 'r', SMOKE_TEST_NUMBER: FAKE_NUMBER }))).toEqual([]);
  });

  it('sin el paso b no hace falta numero', () => {
    expect(validateSmokeEnv(readSmokeEnv({ CONFIRM: 'yes', AWS_PROFILE: 'p', AWS_REGION: 'r', SMOKE_STEPS: 'a,c' }))).toEqual([]);
  });

  it('DRY_RUN=yes no exige nada y rechaza pasos desconocidos', () => {
    expect(validateSmokeEnv(readSmokeEnv({ DRY_RUN: 'yes' }))).toEqual([]);
    expect(validateSmokeEnv(readSmokeEnv({ DRY_RUN: 'yes', SMOKE_STEPS: 'a,x' }))).toEqual([expect.stringContaining('x')]);
  });

  it('defaults: dev, prefijo de naming.ts, limpieza y gateway activos', () => {
    const e = readSmokeEnv({});
    expect(e.prefix).toBe('rs-concierge-dev');
    expect(e.cleanup).toBe(true);
    expect(e.gateway).toBe(true);
    expect([...e.steps]).toEqual(['a', 'b', 'c']);
    expect(readSmokeEnv({ SMOKE_CLEANUP: 'no', SMOKE_GATEWAY: 'no' })).toMatchObject({ cleanup: false, gateway: false });
  });

  it('valida E.164 y enmascara', () => {
    expect(isE164(FAKE_NUMBER)).toBe(true);
    expect(isE164('+0123')).toBe(false);
    expect(maskPhone(FAKE_NUMBER)).toBe('********0123');
  });
});

describe('payloads sinteticos', () => {
  it('client context con el nombre de tool del Gateway', () => {
    const decoded = JSON.parse(Buffer.from(toolClientContext('book_appointment'), 'base64').toString());
    expect(decoded).toEqual({ custom: { bedrockAgentCoreToolName: 'tools___book_appointment' } });
  });

  it('patientRef de 64 hex, estable por runId y distinto entre corridas', () => {
    expect(syntheticPatientRef('1')).toMatch(/^[0-9a-f]{64}$/);
    expect(syntheticPatientRef('1')).toBe(syntheticPatientRef('1'));
    expect(syntheticPatientRef('1')).not.toBe(syntheticPatientRef('2'));
  });

  it('entrante con la forma del contrato (seccion 2)', () => {
    const msg = buildInboundMessage({ from: FAKE_NUMBER, text: 'hi', runId: 'r1', now: new Date('2026-10-27T10:00:00Z') });
    expect(msg).toEqual({
      originationNumber: FAKE_NUMBER,
      destinationNumber: 'smoke-e2e',
      messageBody: 'hi',
      inboundMessageId: 'smoke-r1',
      timestamp: '2026-10-27T10:00:00.000Z',
    });
  });
});

describe('classifyRouterLogs', () => {
  const line = (o: object) => `2026-10-27T10:00:01.000Z\treq-1\tINFO\t${JSON.stringify(o)}`;

  it('replied cuando hay respuesta enviada', () => {
    const out = classifyRouterLogs([
      'START RequestId: req-1',
      line({ level: 'info', msg: 'respuesta del agente', blocks: ['text', 'provider_carousel'] }),
      line({ level: 'info', msg: 'respuesta enviada', messageId: 'm-1', block: 'text' }),
      line({ level: 'info', msg: 'respuesta enviada', messageId: 'm-2', block: 'provider_carousel' }),
    ]);
    expect(out).toEqual({ status: 'replied', messageIds: ['m-1', 'm-2'], detail: 'bloques text,provider_carousel, 2 enviados' });
  });

  it('failed ante errores del router o timeout de la Lambda', () => {
    expect(classifyRouterLogs([line({ level: 'error', msg: 'fallo al invocar al agente' })]).status).toBe('failed');
    expect(classifyRouterLogs(['2026-10-27T10:00:01Z req-1 Task timed out after 60.00 seconds']).detail).toBe('timeout de la Lambda');
    expect(classifyRouterLogs(['2026-10-27T10:00:01Z\treq-1\tERROR\tInvoke Error']).detail).toBe('error de runtime');
  });

  it('pending sin lineas o con el agente respondido y el envio en curso', () => {
    expect(classifyRouterLogs([]).status).toBe('pending');
    expect(classifyRouterLogs([line({ msg: 'respuesta del agente', blocks: ['text'] })]).detail).toContain('envio pendiente');
  });
});

describe('schedules de DEMO_MODE', () => {
  const bookedAt = new Date('2026-10-27T10:00:00Z');
  const base = {
    bookedAt,
    maxMinutes: 6,
    appointmentId: 'apt_1',
    reminderFunction: 'rs-concierge-dev-reminder-sender',
  };

  it('parsea at() en UTC', () => {
    expect(parseAtExpression('at(2026-10-27T10:02:00)')?.toISOString()).toBe('2026-10-27T10:02:00.000Z');
    expect(parseAtExpression('rate(5 minutes)')).toBeUndefined();
  });

  it('acepta un schedule a minutos que apunta a reminder-sender', () => {
    const schedule = {
      ScheduleExpression: 'at(2026-10-27T10:02:00)',
      ScheduleExpressionTimezone: 'UTC',
      Target: { Arn: REMINDER_ARN, Input: JSON.stringify({ appointmentId: 'apt_1', kind: 'T48' }) },
    };
    expect(checkDemoSchedule({ ...base, schedule })).toEqual([]);
  });

  it('marca un schedule sin DEMO_MODE (48 h antes del turno), otro target u otro turno', () => {
    const problems = checkDemoSchedule({
      ...base,
      schedule: {
        ScheduleExpression: 'at(2026-10-29T10:00:00)',
        Target: { Arn: 'arn:aws:lambda:us-east-1:000000000000:function:otra', Input: JSON.stringify({ appointmentId: 'apt_2' }) },
      },
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/dispara a 2880\.0 min/);
  });
});

describe('tabla y exit code', () => {
  const results: CheckResult[] = [
    { id: 'a1', name: 'search_providers', status: 'PASS', detail: '3 providers' },
    { id: 'b3', name: 'message-events', status: 'WARN', detail: 'sin eventos' },
  ];

  it('formatea una tabla alineada', () => {
    const lines = formatResultsTable(results).split('\n');
    expect(lines[0]).toBe('| Paso | Chequeo          | Estado | Detalle     |');
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it('WARN y SKIP no fallan; FAIL si', () => {
    expect(overallExitCode(results)).toBe(0);
    expect(overallExitCode([...results, { id: 'c1', name: 'x', status: 'FAIL', detail: '' }])).toBe(1);
  });
});

describe('MCP y SigV4', () => {
  it('parsea respuestas JSON y SSE', () => {
    expect(parseMcpResponse('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(parseMcpResponse('event: message\ndata: {"id":2,"result":{"tools":[]}}\n\n')).toEqual({ id: 2, result: { tools: [] } });
    expect(parseMcpResponse('<html>')).toBeUndefined();
  });

  it('firma igual que el signer oficial de Smithy', async () => {
    // Credenciales falsas, solo para comparar firmas.
    const credentials = { accessKeyId: 'TESTKEYID', secretAccessKey: 'test-secret', sessionToken: 'test-token' };
    const now = new Date('2026-10-27T10:00:00Z');
    const url = 'https://gw-1.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp';
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const ours = signPostRequest({ url, body, region: 'us-east-1', service: 'bedrock-agentcore', credentials, now, extraHeaders: { Accept: 'application/json' } });

    class Sha256 {
      private readonly h = createHash('sha256');
      private readonly hmacKey?: Buffer;
      private chunks: Buffer[] = [];
      constructor(secret?: string | Uint8Array) {
        if (secret) this.hmacKey = Buffer.from(secret as Uint8Array);
      }
      update(data: string | Uint8Array) {
        this.chunks.push(Buffer.from(data as Uint8Array));
      }
      async digest() {
        const data = Buffer.concat(this.chunks);
        if (this.hmacKey) return new Uint8Array(require('crypto').createHmac('sha256', this.hmacKey).update(data).digest());
        return new Uint8Array(this.h.update(data).digest());
      }
    }
    const signer = new SignatureV4({ credentials, region: 'us-east-1', service: 'bedrock-agentcore', sha256: Sha256 as never, uriEscapePath: true });
    const u = new URL(url);
    const signed = await signer.sign(
      {
        method: 'POST',
        protocol: 'https:',
        hostname: u.hostname,
        path: u.pathname,
        headers: {
          host: u.host,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        },
        body,
      },
      { signingDate: now },
    );
    expect(ours.authorization).toBe(signed.headers.authorization);
    expect(ours['x-amz-security-token']).toBe('test-token');
  });
});
