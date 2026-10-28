import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSmokeEnv } from './lib';
import { ExecResult, SmokeDeps, runSmoke, shellQuote } from './run';

const FAKE_NUMBER = '+15555550123';
const ACCOUNT = '000000000000';
const START = new Date('2026-10-27T10:00:00Z');

interface FakeOptions {
  routerLines?: string[];
  demoMode?: string;
  /** Sesion que devuelve el Gateway falso en initialize (undefined: sin sesion). */
  mcpSessionId?: string;
}

/** AWS CLI falso: responde segun el subcomando y escribe el payload de lambda invoke. */
function fakeDeps(opts: FakeOptions = {}) {
  const calls: string[][] = [];
  const gatewayCalls: Array<{ method: string; headers: Record<string, string> }> = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  let clock = START.getTime();
  const deleted = new Set<string>();
  const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' });
  const outputs: Record<string, Record<string, string>> = {
    Data: { MessageEventsTableName: 'rs-concierge-dev-message-events', AppointmentsTableName: 'rs-concierge-dev-appointments' },
    Agent: { GatewayUrl: 'https://gw.example/mcp', AgentRuntimeArn: 'arn:runtime' },
    Messaging: {
      RcsEventsTopicArn: `arn:aws:sns:us-east-1:${ACCOUNT}:rs-concierge-dev-rcs-events`,
      InboundRouterFunctionName: 'rs-concierge-dev-inbound-router',
      InboundRouterDlqUrl: 'https://sqs.example/dlq',
    },
    Observability: { DashboardName: 'dash' },
  };
  const deps: SmokeDeps = {
    tmpDir,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => undefined,
    fetch: async (_url, init) => {
      const rpc = JSON.parse(init.body) as { id?: number; method: string };
      expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTKEYID\//);
      gatewayCalls.push({ method: rpc.method, headers: init.headers });
      // Gateway con sesion: fuera de initialize exige el Mcp-Session-Id y que ya haya llegado initialized.
      if (opts.mcpSessionId && rpc.method !== 'initialize') {
        if (init.headers['mcp-session-id'] !== opts.mcpSessionId) return { status: 400, text: 'sesion invalida' };
        if (rpc.method !== 'notifications/initialized' && !gatewayCalls.some((c) => c.method === 'notifications/initialized')) {
          return { status: 400, text: 'falta notifications/initialized' };
        }
      }
      if (rpc.id === undefined) return { status: 202, text: '' };
      const result =
        rpc.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gw', version: '1' } }
          : rpc.method === 'tools/list'
            ? { tools: ['search_providers', 'get_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment'].map((t) => ({ name: `tools___${t}` })) }
            : { content: [] };
      const headers: Record<string, string> = rpc.method === 'initialize' && opts.mcpSessionId ? { 'mcp-session-id': opts.mcpSessionId } : {};
      return { status: 200, text: `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`, headers };
    },
    aws: async (args) => {
      calls.push(args);
      const [svc, op] = args;
      if (svc === 'cloudformation') {
        const key = args[args.indexOf('--stack-name') + 1].split('-').pop() as string;
        return ok({ Stacks: [{ Outputs: Object.entries(outputs[key]).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] });
      }
      if (svc === 'configure') return ok({ AccessKeyId: 'TESTKEYID', SecretAccessKey: 'test-secret' });
      if (svc === 'lambda' && op === 'invoke') {
        const tool = JSON.parse(Buffer.from(args[args.indexOf('--client-context') + 1], 'base64').toString()).custom.bedrockAgentCoreToolName.split('___')[1];
        const bodies: Record<string, unknown> = {
          search_providers: { ok: true, providers: [{ providerId: 'prov_miami_01' }] },
          get_availability: { ok: true, slots: [{ slotId: 'prov_miami_01#2026-10-30T14:00:00.000Z' }] },
          book_appointment: { ok: true, appointment: { appointmentId: 'apt_1', reminderScheduleNames: ['apt_1-t48', 'apt_1-t24'] } },
          cancel_appointment: { ok: true, appointment: { appointmentId: 'apt_1', status: 'CANCELLED' } },
        };
        if (tool === 'cancel_appointment') ['apt_1-t48', 'apt_1-t24'].forEach((n) => deleted.add(n));
        fs.writeFileSync(args[args.length - 1], JSON.stringify(bodies[tool]));
        return ok({ StatusCode: 200 });
      }
      if (svc === 'lambda' && op === 'get-function-configuration') {
        return ok({ DEMO_MODE: opts.demoMode ?? 'true', DEMO_MINUTES_48H: '2', DEMO_MINUTES_24H: '4' });
      }
      if (svc === 'sns') return ok({ MessageId: 'sns-1' });
      if (svc === 'logs') {
        return ok({ events: (opts.routerLines ?? []).map((message) => ({ message })) });
      }
      if (svc === 'dynamodb') return ok({ Items: [{ channel: { S: 'RCS' }, status: { S: 'DELIVERED' } }] });
      if (svc === 'sqs') return ok({ Attributes: { ApproximateNumberOfMessages: '0' } });
      if (svc === 'scheduler') {
        const name = args[args.indexOf('--name') + 1];
        if (deleted.has(name)) return { code: 254, stdout: '', stderr: 'An error occurred (ResourceNotFoundException)' };
        const minutes = name.endsWith('t48') ? 2 : 4;
        return ok({
          ScheduleExpression: `at(${new Date(START.getTime() + minutes * 60_000).toISOString().slice(0, 19)})`,
          ScheduleExpressionTimezone: 'UTC',
          Target: { Arn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:rs-concierge-dev-reminder-sender`, Input: JSON.stringify({ appointmentId: 'apt_1', kind: 'T48' }) },
        });
      }
      return { code: 1, stdout: '', stderr: `no esperado: ${args.join(' ')}` };
    },
  };
  return { deps, calls, gatewayCalls };
}

const replied = [
  `x\tINFO\t${JSON.stringify({ msg: 'respuesta del agente', blocks: ['text'] })}`,
  `x\tINFO\t${JSON.stringify({ msg: 'respuesta enviada', messageId: 'm-1' })}`,
];
const confirmEnv = { CONFIRM: 'yes', AWS_PROFILE: 'p', AWS_REGION: 'us-east-1', SMOKE_TEST_NUMBER: FAKE_NUMBER };

describe('runSmoke', () => {
  it('Gateway con sesion: reenvia Mcp-Session-Id y manda notifications/initialized antes de tools/list', async () => {
    const { deps, gatewayCalls } = fakeDeps({ routerLines: replied, mcpSessionId: 'sess-abc' });
    const results = await runSmoke(readSmokeEnv(confirmEnv), deps);
    expect(results.find((r) => r.id === 'a4')).toMatchObject({ status: 'PASS' });
    expect(gatewayCalls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(gatewayCalls[0].headers['mcp-session-id']).toBeUndefined();
    for (const c of gatewayCalls.slice(1)) {
      expect(c.headers['mcp-session-id']).toBe('sess-abc');
      expect(c.headers['mcp-protocol-version']).toBe('2025-06-18');
      // El header de sesion va firmado con SigV4.
      expect(c.headers.authorization).toMatch(/SignedHeaders=[^,]*mcp-session-id/);
    }
  });

  it('Gateway sin sesion: no inventa el header y sigue en PASS', async () => {
    const { deps, gatewayCalls } = fakeDeps({ routerLines: replied });
    const results = await runSmoke(readSmokeEnv(confirmEnv), deps);
    expect(results.find((r) => r.id === 'a4')).toMatchObject({ status: 'PASS' });
    expect(gatewayCalls.every((c) => c.headers['mcp-session-id'] === undefined)).toBe(true);
  });

  it('camino feliz: todos los pasos en PASS y limpieza del turno', async () => {
    const { deps, calls } = fakeDeps({ routerLines: replied });
    const results = await runSmoke(readSmokeEnv(confirmEnv), deps);
    const summary = results.map((r) => `${r.id}:${r.status}`);
    expect(summary).toEqual([
      '0:PASS',
      'a1:PASS',
      'a2:PASS',
      'a3:PASS',
      'a4:PASS',
      'b1:PASS',
      'b2:PASS',
      'b3:PASS',
      'b4:PASS',
      'c1:PASS',
      'c2:PASS',
      'c3:PASS',
      'z1:PASS',
      'z2:PASS',
      'z2:PASS',
    ]);
    // El entrante sale al topic de la salida del stack y el telefono no se guarda en el log.
    const publish = calls.find((c) => c[0] === 'sns') as string[];
    expect(publish[publish.indexOf('--topic-arn') + 1]).toContain('rs-concierge-dev-rcs-events');
    expect(JSON.parse(publish[publish.indexOf('--message') + 1]).originationNumber).toBe(FAKE_NUMBER);
    expect(results.find((r) => r.id === 'b1')?.detail).toContain('********0123');
    expect(results.map((r) => r.detail).join(' ')).not.toContain(FAKE_NUMBER);
  });

  it('el router sin respuesta termina en FAIL por timeout', async () => {
    const { deps } = fakeDeps({ routerLines: [] });
    const results = await runSmoke(readSmokeEnv({ ...confirmEnv, SMOKE_STEPS: 'b', SMOKE_TIMEOUT_SECONDS: '10' }), deps);
    expect(results.find((r) => r.id === 'b2')).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('timeout 10s') });
  });

  it('DEMO_MODE apagado falla c1', async () => {
    const { deps } = fakeDeps({ demoMode: 'false' });
    const results = await runSmoke(readSmokeEnv({ ...confirmEnv, SMOKE_STEPS: 'c', SMOKE_GATEWAY: 'no' }), deps);
    expect(results.find((r) => r.id === 'c1')?.status).toBe('FAIL');
  });

  it('dry-run: arma los comandos sin evaluar resultados', async () => {
    const { deps, calls } = fakeDeps();
    const results = await runSmoke(readSmokeEnv({ DRY_RUN: 'yes', SMOKE_GATEWAY: 'no' }), deps);
    expect(results.every((r) => r.status === 'SKIP')).toBe(true);
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(
      expect.arrayContaining(['sns publish', 'logs filter-log-events', 'scheduler get-schedule', 'lambda invoke']),
    );
    const publish = calls.find((c) => c[0] === 'sns') as string[];
    expect(publish[publish.indexOf('--topic-arn') + 1]).toBe('<RcsEventsTopicArn>');
  });
});

describe('shellQuote', () => {
  it('deja intactos los argumentos simples y cita el resto', () => {
    expect(shellQuote('rs-concierge-dev-tools')).toBe('rs-concierge-dev-tools');
    expect(shellQuote('{"a":1}')).toBe(`'{"a":1}'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
