/**
 * Smoke e2e (A5) contra la cuenta dev, despues de un deploy aprobado. Lo lanza scripts/smoke-e2e.sh.
 * Habla con AWS solo a traves del AWS CLI (sin SDKs nuevos) y con fetch firmado al Gateway.
 * - DRY_RUN=yes: imprime los comandos con placeholders, no llama a AWS.
 * - CONFIRM=yes: corre los pasos a, b y c (SMOKE_STEPS) e imprime la tabla PASS/FAIL.
 * No imprime telefonos completos ni credenciales.
 */
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AwsCredentials,
  CheckResult,
  OPTIONAL_OUTPUTS,
  REQUIRED_OUTPUTS,
  STACK_KEYS,
  SmokeEnv,
  buildInboundMessage,
  checkDemoSchedule,
  classifyRouterLogs,
  derivedNames,
  formatResultsTable,
  maskPhone,
  missingOutputs,
  overallExitCode,
  parseMcpResponse,
  parseStackOutputs,
  readSmokeEnv,
  signPostRequest,
  stackName,
  syntheticPatientRef,
  toolClientContext,
  validateSmokeEnv,
} from './lib';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SmokeDeps {
  /** Corre `aws <args>`; en dry-run lo imprime y devuelve vacio. */
  aws(args: string[]): Promise<ExecResult>;
  /** POST HTTP; `headers` de la respuesta con nombres en minuscula (el Gateway devuelve `mcp-session-id`). */
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; text: string; headers?: Record<string, string> }>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  tmpDir: string;
}

/** Comillas simples de shell solo si hacen falta, para que el dry-run sea copiable. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function realDeps(e: SmokeEnv): SmokeDeps {
  const base = [...(e.profile ? ['--profile', e.profile] : []), ...(e.region ? ['--region', e.region] : [])];
  return {
    aws: (args) => {
      // `configure export-credentials` tiene su propio --format: solo lleva el perfil.
      const full =
        args[0] === 'configure'
          ? [...args, ...(e.profile ? ['--profile', e.profile] : [])]
          : [...args, ...base, '--output', 'json', '--no-cli-pager'];
      if (e.dryRun) {
        console.log(`  aws ${full.map(shellQuote).join(' ')}`);
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      return new Promise((resolve) => {
        execFile('aws', full, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      });
    },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, text: await res.text(), headers };
    },
    now: () => new Date(),
    sleep: (ms) => (e.dryRun ? Promise.resolve() : new Promise((r) => setTimeout(r, ms))),
    log: (line) => console.log(line),
    tmpDir: fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rs-smoke-')),
  };
}

const PLACEHOLDER = (key: string) => `<${key}>`;

export async function runSmoke(e: SmokeEnv, deps: SmokeDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => {
    results.push(r);
    deps.log(`[${r.status}] ${r.id} ${r.name}: ${r.detail}`);
  };
  const dry = e.dryRun;
  const runId = `${deps.now().getTime()}-${randomBytes(2).toString('hex')}`;
  const n = derivedNames(e.prefix);

  // 0. Salidas de los 4 stacks.
  deps.log('# 0. Salidas de CloudFormation');
  const outputs: Record<string, string> = {};
  for (const key of STACK_KEYS) {
    const res = await deps.aws(['cloudformation', 'describe-stacks', '--stack-name', stackName(e.envName, key)]);
    if (dry) continue;
    if (res.code !== 0) {
      add({ id: '0', name: `stack ${stackName(e.envName, key)}`, status: 'FAIL', detail: firstLine(res.stderr) });
      continue;
    }
    Object.assign(outputs, parseStackOutputs(res.stdout));
  }
  if (dry) {
    for (const k of [...Object.keys(REQUIRED_OUTPUTS), ...Object.keys(OPTIONAL_OUTPUTS)]) outputs[k] = PLACEHOLDER(k);
  } else {
    const missing = missingOutputs(outputs);
    add({
      id: '0',
      name: 'salidas de los 4 stacks',
      status: missing.length === 0 && !results.some((r) => r.status === 'FAIL') ? 'PASS' : 'FAIL',
      detail: missing.length === 0 ? `${Object.keys(outputs).length} salidas` : `faltan ${missing.join(', ')}`,
    });
    if (results.some((r) => r.status === 'FAIL')) return results;
  }
  const routerFunction = outputs.InboundRouterFunctionName || n.inboundRouter;

  const invokeTool = async (tool: string, payload: Record<string, unknown>) => {
    const outFile = path.join(deps.tmpDir, `${tool}-${results.length}.json`);
    const res = await deps.aws([
      'lambda',
      'invoke',
      '--function-name',
      n.toolsFunction,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--client-context',
      toolClientContext(tool),
      '--payload',
      JSON.stringify(payload),
      outFile,
    ]);
    if (dry) return undefined;
    if (res.code !== 0) return { ok: false, error: firstLine(res.stderr), code: 'CLI' } as Record<string, unknown>;
    const meta = safeJson(res.stdout) as { FunctionError?: string } | undefined;
    const body = safeJson(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '') as Record<string, unknown> | undefined;
    if (meta?.FunctionError) return { ok: false, error: `FunctionError ${meta.FunctionError}`, code: 'LAMBDA' };
    return body;
  };

  let appointmentId: string | undefined;
  let scheduleNames: string[] = [];
  let bookedAt: Date | undefined;
  const patientRef = syntheticPatientRef(runId);

  // a. Tools: Lambda directa y Gateway.
  if (e.steps.has('a') || e.steps.has('c')) {
    deps.log('# a. Tools (Lambda directa con el client context del Gateway)');
    const search = await invokeTool('search_providers', { procedure: e.procedure, city: e.city, limit: 3 });
    const providers = (search?.providers as Array<{ providerId: string }> | undefined) ?? [];
    if (!dry) {
      add(toolCheck('a1', 'search_providers', search, providers.length > 0 ? `${providers.length} providers` : 'sin providers (falta npm run seed?)', providers.length > 0));
    }
    const providerId = providers[0]?.providerId ?? PLACEHOLDER('providerId');
    const avail = await invokeTool('get_availability', { providerId, limit: 2 });
    const slots = (avail?.slots as Array<{ slotId: string }> | undefined) ?? [];
    if (!dry) add(toolCheck('a2', 'get_availability', avail, `${slots.length} slots libres`, slots.length > 0));
    const slotId = slots[0]?.slotId ?? PLACEHOLDER('slotId');
    if (dry || slots.length > 0) {
      bookedAt = deps.now();
      const book = await invokeTool('book_appointment', { providerId, slotId, patientRef, procedure: e.procedure });
      const appt = book?.appointment as { appointmentId?: string; reminderScheduleNames?: string[] } | undefined;
      appointmentId = appt?.appointmentId;
      scheduleNames = appt?.reminderScheduleNames ?? [];
      if (!dry) add(toolCheck('a3', 'book_appointment', book, `${appointmentId ?? '?'} con ${scheduleNames.length} recordatorios`, !!appointmentId));
    } else {
      add({ id: 'a3', name: 'book_appointment', status: 'SKIP', detail: 'sin slot libre' });
    }

    if (e.gateway) {
      deps.log('# a4. Gateway MCP (SigV4): initialize, tools/list y tools/call search_providers');
      add(await gatewayCheck(e, deps, outputs.GatewayUrl));
    } else {
      add({ id: 'a4', name: 'Gateway MCP', status: 'SKIP', detail: 'SMOKE_GATEWAY=no' });
    }
  }

  // b. Entrante sintetico por SNS y resultado del router.
  if (e.steps.has('b')) {
    deps.log('# b. Entrante sintetico al topic SNS y resultado del inbound-router');
    const from = e.testNumber ?? '<SMOKE_TEST_NUMBER>';
    const publishedAt = deps.now();
    const message = buildInboundMessage({ from, text: e.text, runId, now: publishedAt });
    const pub = await deps.aws(['sns', 'publish', '--topic-arn', outputs.RcsEventsTopicArn, '--message', JSON.stringify(message)]);
    if (!dry) {
      add({
        id: 'b1',
        name: 'sns publish entrante',
        status: pub.code === 0 ? 'PASS' : 'FAIL',
        detail: pub.code === 0 ? `de ${maskPhone(from)}, id smoke-${runId}` : firstLine(pub.stderr),
      });
    }
    if (dry || pub.code === 0) {
      const logArgs = ['logs', 'filter-log-events', '--log-group-name', `/aws/lambda/${routerFunction}`, '--start-time', String(publishedAt.getTime() - 5_000)];
      let outcome = classifyRouterLogs([]);
      const deadline = publishedAt.getTime() + e.timeoutSeconds * 1000;
      do {
        await deps.sleep(5_000);
        const res = await deps.aws(logArgs);
        if (dry) break;
        const events = (safeJson(res.stdout) as { events?: Array<{ message?: string }> } | undefined)?.events ?? [];
        outcome = classifyRouterLogs(events.map((ev) => ev.message ?? ''));
      } while (outcome.status === 'pending' && deps.now().getTime() < deadline);
      if (!dry) {
        add({
          id: 'b2',
          name: 'router: agente y respuesta',
          status: outcome.status === 'replied' ? 'PASS' : 'FAIL',
          detail: outcome.status === 'pending' ? `timeout ${e.timeoutSeconds}s: ${outcome.detail}` : outcome.detail,
        });
      }

      // Eventos de entrega del primer envio en message-events (pueden tardar: WARN, no FAIL).
      const firstId = outcome.messageIds[0] ?? (dry ? PLACEHOLDER('messageId') : undefined);
      if (firstId) {
        const q = await deps.aws([
          'dynamodb',
          'query',
          '--table-name',
          outputs.MessageEventsTableName,
          '--key-condition-expression',
          'messageId = :m',
          '--expression-attribute-values',
          JSON.stringify({ ':m': { S: firstId } }),
          '--projection-expression',
          'eventTimestamp, channel, #s',
          '--expression-attribute-names',
          JSON.stringify({ '#s': 'status' }),
        ]);
        if (!dry) {
          const items = (safeJson(q.stdout) as { Items?: Array<Record<string, { S?: string }>> } | undefined)?.Items ?? [];
          const states = items.map((it) => `${it.channel?.S ?? '?'}/${it.status?.S ?? '?'}`).filter((s) => s !== '?/?');
          add({
            id: 'b3',
            name: 'message-events del envio',
            status: q.code !== 0 ? 'FAIL' : states.length > 0 ? 'PASS' : 'WARN',
            detail: q.code !== 0 ? firstLine(q.stderr) : states.length > 0 ? states.join(', ') : 'sin eventos de entrega todavia',
          });
        }
      }

      if (outputs.InboundRouterDlqUrl) {
        const dlq = await deps.aws(['sqs', 'get-queue-attributes', '--queue-url', outputs.InboundRouterDlqUrl, '--attribute-names', 'ApproximateNumberOfMessages']);
        if (!dry) {
          const count = Number((safeJson(dlq.stdout) as { Attributes?: { ApproximateNumberOfMessages?: string } } | undefined)?.Attributes?.ApproximateNumberOfMessages ?? NaN);
          add({
            id: 'b4',
            name: 'DLQ del router',
            status: dlq.code !== 0 ? 'FAIL' : count === 0 ? 'PASS' : 'WARN',
            detail: dlq.code !== 0 ? firstLine(dlq.stderr) : `${Number.isNaN(count) ? '?' : count} mensajes`,
          });
        }
      } else {
        add({ id: 'b4', name: 'DLQ del router', status: 'SKIP', detail: 'sin salida InboundRouterDlqUrl (A4 sin desplegar)' });
      }
    }
  }

  // c. DEMO_MODE y schedules de EventBridge del turno reservado en a3.
  if (e.steps.has('c')) {
    deps.log('# c. DEMO_MODE y schedules de EventBridge Scheduler');
    const cfg = await deps.aws(['lambda', 'get-function-configuration', '--function-name', n.toolsFunction, '--query', 'Environment.Variables']);
    const vars = (safeJson(cfg.stdout) as Record<string, string> | undefined) ?? {};
    if (!dry) {
      add({
        id: 'c1',
        name: 'tools DEMO_MODE',
        status: vars.DEMO_MODE === 'true' ? 'PASS' : 'FAIL',
        detail: `DEMO_MODE=${vars.DEMO_MODE ?? '?'} T48=${vars.DEMO_MINUTES_48H ?? '?'}m T24=${vars.DEMO_MINUTES_24H ?? '?'}m`,
      });
    }
    const maxMinutes = Math.max(Number(vars.DEMO_MINUTES_48H ?? 2), Number(vars.DEMO_MINUTES_24H ?? 4)) + 2;
    const names = dry ? [`${PLACEHOLDER('appointmentId')}-t48`, `${PLACEHOLDER('appointmentId')}-t24`] : scheduleNames;
    if (!dry && (!appointmentId || names.length === 0)) {
      add({ id: 'c2', name: 'schedules T48/T24', status: 'FAIL', detail: 'no hay turno o recordatorios del paso a3' });
    }
    for (const [i, name] of names.entries()) {
      const res = await deps.aws(['scheduler', 'get-schedule', '--group-name', n.scheduleGroup, '--name', name]);
      if (dry || !appointmentId || !bookedAt) continue;
      const problems =
        res.code !== 0
          ? [firstLine(res.stderr)]
          : checkDemoSchedule({ schedule: safeJson(res.stdout) ?? {}, bookedAt, maxMinutes, appointmentId, reminderFunction: n.reminderSender });
      add({ id: `c${i + 2}`, name: `schedule ${name.endsWith('t48') ? 'T48' : name.endsWith('t24') ? 'T24' : name}`, status: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.join('; ') || 'at() en minutos, target reminder-sender' });
    }
  }

  // Limpieza: cancelar el turno sintetico (libera el slot y borra los schedules).
  if ((appointmentId || dry) && (e.steps.has('a') || e.steps.has('c'))) {
    if (e.cleanup) {
      deps.log('# Limpieza: cancel_appointment del turno sintetico');
      const cancel = await invokeTool('cancel_appointment', { appointmentId: appointmentId ?? PLACEHOLDER('appointmentId'), patientRef });
      if (!dry) add(toolCheck('z1', 'cancel_appointment (limpieza)', cancel, 'slot liberado y schedules borrados', true));
      for (const name of dry ? [] : scheduleNames) {
        const res = await deps.aws(['scheduler', 'get-schedule', '--group-name', n.scheduleGroup, '--name', name]);
        const gone = res.code !== 0 && /ResourceNotFound/.test(res.stderr);
        add({ id: 'z2', name: `schedule ${name} borrado`, status: gone ? 'PASS' : 'FAIL', detail: gone ? 'ResourceNotFound' : 'sigue existiendo' });
      }
    } else {
      add({ id: 'z1', name: 'limpieza', status: 'WARN', detail: `SMOKE_CLEANUP=no: ${appointmentId} queda reservado y sus recordatorios van a disparar` });
    }
  }
  return results;
}

function toolCheck(id: string, name: string, body: Record<string, unknown> | undefined, okDetail: string, extraOk: boolean): CheckResult {
  if (!body) return { id, name, status: 'FAIL', detail: 'respuesta vacia' };
  if (body.ok !== true) return { id, name, status: 'FAIL', detail: `${String(body.code ?? '')} ${String(body.error ?? '')}`.trim() };
  return { id, name, status: extraOk ? 'PASS' : 'FAIL', detail: okDetail };
}

async function gatewayCheck(e: SmokeEnv, deps: SmokeDeps, gatewayUrl: string): Promise<CheckResult> {
  const id = 'a4';
  const name = 'Gateway MCP (SigV4)';
  // Credenciales temporales del perfil: solo en memoria, nunca se imprimen.
  const creds = await deps.aws(['configure', 'export-credentials', '--format', 'process']);
  if (e.dryRun) {
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call tools___search_providers']) {
      deps.log(`  POST ${gatewayUrl} (SigV4 bedrock-agentcore, JSON-RPC ${method})`);
    }
    return { id, name, status: 'SKIP', detail: 'dry-run' };
  }
  const c = safeJson(creds.stdout) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string } | undefined;
  if (!c?.AccessKeyId || !c.SecretAccessKey) return { id, name, status: 'FAIL', detail: 'no se pudieron exportar credenciales del perfil' };
  const credentials: AwsCredentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  // Streamable HTTP de MCP: si initialize devuelve `Mcp-Session-Id`, va en todos los requests
  // siguientes, junto con la version de protocolo negociada.
  const session: Record<string, string> = {};
  const post = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...payload });
    const headers = signPostRequest({
      url: gatewayUrl,
      body,
      region: e.region ?? 'us-east-1',
      service: 'bedrock-agentcore',
      credentials,
      now: deps.now(),
      extraHeaders: { accept: 'application/json, text/event-stream', ...session },
    });
    const res = await deps.fetch(gatewayUrl, { method: 'POST', headers, body });
    return { status: res.status, headers: res.headers ?? {}, rpc: parseMcpResponse(res.text) };
  };
  const call = (rpcId: number, method: string, params?: Record<string, unknown>) => post({ id: rpcId, method, ...(params ? { params } : {}) });
  try {
    // VERIFICAR: version de protocolo MCP que acepta el Gateway.
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rs-smoke', version: '1' } });
    if (init.status !== 200) return { id, name, status: 'FAIL', detail: `initialize HTTP ${init.status}` };
    const sessionId = init.headers['mcp-session-id'];
    if (sessionId) session['mcp-session-id'] = sessionId;
    const negotiated = (init.rpc?.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if (negotiated) session['mcp-protocol-version'] = negotiated;
    // Notificacion sin id: el server responde 202 sin cuerpo.
    const initialized = await post({ method: 'notifications/initialized' });
    if (initialized.status >= 300) return { id, name, status: 'FAIL', detail: `notifications/initialized HTTP ${initialized.status}` };
    const list = await call(2, 'tools/list');
    const search = await call(3, 'tools/call', { name: 'tools___search_providers', arguments: { procedure: e.procedure, city: e.city, limit: 1 } });
    const tools = ((list.rpc?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
    const expected = ['search_providers', 'get_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment'];
    const missing = expected.filter((t) => !tools.some((name) => name.endsWith(`___${t}`)));
    const searchOk = search.status === 200 && !search.rpc?.error && !(search.rpc?.result as { isError?: boolean } | undefined)?.isError;
    if (missing.length > 0) return { id, name, status: 'FAIL', detail: `tools/list sin ${missing.join(', ')}` };
    return { id, name, status: searchOk ? 'PASS' : 'FAIL', detail: searchOk ? `${tools.length} tools, tools/call OK` : `tools/call HTTP ${search.status}` };
  } catch (err) {
    return { id, name, status: 'FAIL', detail: (err as Error).message };
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 160) || 'error sin detalle';
}

async function main() {
  const e = readSmokeEnv(process.env);
  const errors = validateSmokeEnv(e);
  if (errors.length > 0) {
    errors.forEach((err) => console.error(`ERROR: ${err}`));
    process.exit(2);
  }
  console.log(`Smoke e2e ${e.dryRun ? '(DRY-RUN, no llama a AWS)' : ''} env=${e.envName} prefijo=${e.prefix} region=${e.region ?? '<AWS_REGION>'} perfil=${e.profile ?? '<AWS_PROFILE>'} pasos=${[...e.steps].join(',')}`);
  const deps = realDeps(e);
  const results = await runSmoke(e, deps);
  fs.rmSync(deps.tmpDir, { recursive: true, force: true });
  if (e.dryRun) {
    console.log('\nDry-run terminado: no se ejecuto nada contra AWS.');
    return;
  }
  console.log(`\n${formatResultsTable(results)}\n`);
  const code = overallExitCode(results);
  console.log(code === 0 ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
