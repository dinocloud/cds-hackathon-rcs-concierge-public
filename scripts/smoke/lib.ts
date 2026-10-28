/**
 * Helpers puros del smoke e2e (A5). Sin AWS: todo lo que habla con la cuenta vive en run.ts.
 * Nombres alineados con infra/lib/naming.ts, infra/lib/build-stacks.ts y las salidas de los
 * stacks (incluidas las que agregan feat/agustin-a4-router y feat/agustin-a2-agente).
 */
import { createHash, createHmac } from 'crypto';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Ids logicos de los 4 stacks, en el orden de build-stacks.ts. */
export const STACK_KEYS = ['Data', 'Agent', 'Messaging', 'Observability'] as const;
export type StackKey = (typeof STACK_KEYS)[number];

export function stackName(envName: string, key: StackKey): string {
  return `RsConcierge-${envName}-${key}`;
}

/** Salidas que el smoke necesita y el stack que las publica. */
export const REQUIRED_OUTPUTS: Record<string, StackKey> = {
  MessageEventsTableName: 'Data',
  AppointmentsTableName: 'Data',
  GatewayUrl: 'Agent',
  AgentRuntimeArn: 'Agent',
  RcsEventsTopicArn: 'Messaging',
  DashboardName: 'Observability',
};

/** Salidas que llegan con PRs abiertos (A4): si faltan se usa el nombre deterministico. */
export const OPTIONAL_OUTPUTS: Record<string, StackKey> = {
  InboundRouterFunctionName: 'Messaging',
  InboundRouterDlqUrl: 'Messaging',
  ChannelMode: 'Messaging',
};

/** Nombres deterministicos (infra/lib/naming.ts y functionName de cada NodeLambda). */
export function derivedNames(prefix: string) {
  return {
    toolsFunction: `${prefix}-tools`,
    reminderSender: `${prefix}-reminder-sender`,
    inboundRouter: `${prefix}-inbound-router`,
    scheduleGroup: `${prefix}-reminders`,
  };
}

/** Convierte la salida JSON de `aws cloudformation describe-stacks` en un mapa clave -> valor. */
export function parseStackOutputs(describeStacksJson: string): Record<string, string> {
  const parsed = JSON.parse(describeStacksJson) as {
    Stacks?: Array<{ Outputs?: Array<{ OutputKey?: string; OutputValue?: string }> }>;
  };
  const out: Record<string, string> = {};
  for (const stack of parsed.Stacks ?? []) {
    for (const o of stack.Outputs ?? []) {
      if (o.OutputKey && o.OutputValue !== undefined) out[o.OutputKey] = o.OutputValue;
    }
  }
  return out;
}

export function missingOutputs(outputs: Record<string, string>): string[] {
  return Object.keys(REQUIRED_OUTPUTS).filter((k) => !outputs[k]);
}

/** E.164: + y entre 8 y 15 digitos, sin espacios. */
export function isE164(value: string | undefined): value is string {
  return typeof value === 'string' && /^\+[1-9][0-9]{7,14}$/.test(value);
}

/** Igual criterio que maskPhone del router: solo los ultimos 4 digitos. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

export interface SmokeEnv {
  confirm: boolean;
  dryRun: boolean;
  profile?: string;
  region?: string;
  envName: string;
  prefix: string;
  testNumber?: string;
  text: string;
  procedure: string;
  city: string;
  timeoutSeconds: number;
  cleanup: boolean;
  gateway: boolean;
  steps: Set<string>;
}

const truthy = (v: string | undefined) => v === 'yes' || v === 'true' || v === '1';

export function readSmokeEnv(env: NodeJS.ProcessEnv): SmokeEnv {
  const envName = env.SMOKE_ENV || 'dev';
  return {
    confirm: env.CONFIRM === 'yes',
    dryRun: truthy(env.DRY_RUN),
    profile: env.AWS_PROFILE || undefined,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || env.CDK_DEFAULT_REGION || undefined,
    envName,
    prefix: env.SMOKE_PREFIX || `rs-concierge-${envName}`,
    testNumber: env.SMOKE_TEST_NUMBER || undefined,
    text: env.SMOKE_TEXT || 'I want rhinoplasty in Miami',
    procedure: env.SMOKE_PROCEDURE || 'rhinoplasty',
    city: env.SMOKE_CITY || 'Miami',
    timeoutSeconds: Number(env.SMOKE_TIMEOUT_SECONDS || 90),
    cleanup: env.SMOKE_CLEANUP !== 'no',
    gateway: env.SMOKE_GATEWAY !== 'no',
    steps: new Set((env.SMOKE_STEPS || 'a,b,c').split(',').map((s) => s.trim()).filter(Boolean)),
  };
}

/** Errores que impiden arrancar. En dry-run solo se exige lo que hace falta para armar comandos. */
export function validateSmokeEnv(e: SmokeEnv): string[] {
  const errors: string[] = [];
  if (!e.dryRun && !e.confirm) errors.push('Falta CONFIRM=yes (o DRY_RUN=yes para solo imprimir los comandos).');
  if (!e.dryRun && !e.profile) errors.push('Falta AWS_PROFILE.');
  if (!e.dryRun && !e.region) errors.push('Falta AWS_REGION.');
  if (e.steps.has('b') && !e.dryRun && !isE164(e.testNumber)) {
    errors.push('Falta SMOKE_TEST_NUMBER en E.164 (numero de prueba del equipo, nunca en el repo) para el paso b.');
  }
  if (!Number.isFinite(e.timeoutSeconds) || e.timeoutSeconds <= 0) errors.push('SMOKE_TIMEOUT_SECONDS invalido.');
  for (const s of e.steps) if (!['a', 'b', 'c'].includes(s)) errors.push(`Paso desconocido en SMOKE_STEPS: ${s}`);
  return errors;
}

/**
 * Client context de `aws lambda invoke` que imita al Gateway: la Lambda lee
 * context.clientContext.custom.bedrockAgentCoreToolName = "<target>___<tool>".
 */
export function toolClientContext(tool: string, target = 'tools'): string {
  return Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: `${target}___${tool}` } })).toString('base64');
}

/** patientRef sintetico (64 hex, mismo formato que el HMAC del router) que no sale de ningun telefono. */
export function syntheticPatientRef(runId: string): string {
  return createHash('sha256').update(`smoke-e2e:${runId}`).digest('hex');
}

/** Entrante de texto con la forma de docs/contrato-eventos.md seccion 2 (datos sinteticos). */
export function buildInboundMessage(args: { from: string; text: string; runId: string; now: Date; destination?: string }) {
  return {
    originationNumber: args.from,
    destinationNumber: args.destination ?? 'smoke-e2e',
    messageBody: args.text,
    inboundMessageId: `smoke-${args.runId}`,
    timestamp: args.now.toISOString(),
  };
}

export interface RouterOutcome {
  status: 'replied' | 'failed' | 'pending';
  messageIds: string[];
  detail: string;
}

/** Mensajes de error del router (lambdas/inbound-router/index.ts en A4). */
const ROUTER_ERROR_MSGS = [
  'fallo al invocar al agente',
  'fallo al enviar la respuesta',
  'entrante con envio fallido, va a la DLQ',
  'evento descartado',
];

/**
 * Clasifica las lineas de log del router desde la publicacion. Busca los JSON con `msg`
 * ("respuesta del agente", "respuesta enviada" y los de error). Las lineas que no son JSON
 * (START, END, REPORT, errores de runtime) se revisan por "Task timed out" y "ERROR".
 */
export function classifyRouterLogs(lines: string[]): RouterOutcome {
  const messageIds: string[] = [];
  let agentBlocks: string | undefined;
  const errors: string[] = [];
  for (const raw of lines) {
    const jsonStart = raw.indexOf('{');
    let parsed: Record<string, unknown> | undefined;
    if (jsonStart >= 0) {
      try {
        parsed = JSON.parse(raw.slice(jsonStart)) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
    }
    if (parsed && typeof parsed.msg === 'string') {
      if (parsed.msg === 'respuesta enviada' && typeof parsed.messageId === 'string') messageIds.push(parsed.messageId);
      if (parsed.msg === 'respuesta del agente') agentBlocks = Array.isArray(parsed.blocks) ? parsed.blocks.join(',') : '';
      if (ROUTER_ERROR_MSGS.includes(parsed.msg)) errors.push(parsed.msg);
      continue;
    }
    if (/Task timed out/.test(raw)) errors.push('timeout de la Lambda');
    else if (/\tERROR\t/.test(raw)) errors.push('error de runtime');
  }
  if (errors.length > 0) return { status: 'failed', messageIds, detail: errors.join('; ') };
  if (messageIds.length > 0) {
    return { status: 'replied', messageIds, detail: `bloques ${agentBlocks ?? '?'}, ${messageIds.length} enviados` };
  }
  if (agentBlocks !== undefined) return { status: 'pending', messageIds, detail: `agente respondio (${agentBlocks}), envio pendiente` };
  return { status: 'pending', messageIds, detail: 'sin lineas del router todavia' };
}

/** Parsea `at(yyyy-mm-ddThh:mm:ss)` (UTC) a Date. */
export function parseAtExpression(expr: string | undefined): Date | undefined {
  const m = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/.exec(expr ?? '');
  return m ? new Date(`${m[1]}Z`) : undefined;
}

export interface ScheduleCheckInput {
  schedule: { ScheduleExpression?: string; ScheduleExpressionTimezone?: string; Target?: { Arn?: string; Input?: string } };
  bookedAt: Date;
  /** Minutos maximos esperados en DEMO_MODE (el mayor de DEMO_MINUTES_48H y _24H) mas margen. */
  maxMinutes: number;
  appointmentId: string;
  reminderFunction: string;
}

/** Valida un schedule creado en DEMO_MODE: dispara en minutos, apunta a reminder-sender y lleva el turno. */
export function checkDemoSchedule(i: ScheduleCheckInput): string[] {
  const problems: string[] = [];
  const fireAt = parseAtExpression(i.schedule.ScheduleExpression);
  if (!fireAt) problems.push(`expresion inesperada: ${i.schedule.ScheduleExpression ?? '(vacia)'}`);
  else {
    const minutes = (fireAt.getTime() - i.bookedAt.getTime()) / 60_000;
    // El reloj local y el de la Lambda pueden diferir: se tolera 1 minuto hacia atras.
    if (minutes < -1 || minutes > i.maxMinutes) problems.push(`dispara a ${minutes.toFixed(1)} min (esperado 0 a ${i.maxMinutes})`);
  }
  if (i.schedule.ScheduleExpressionTimezone && i.schedule.ScheduleExpressionTimezone !== 'UTC') {
    problems.push(`zona ${i.schedule.ScheduleExpressionTimezone} (esperado UTC)`);
  }
  if (!i.schedule.Target?.Arn?.endsWith(`:function:${i.reminderFunction}`)) problems.push('el target no es reminder-sender');
  try {
    const input = JSON.parse(i.schedule.Target?.Input ?? '{}') as { appointmentId?: string };
    if (input.appointmentId !== i.appointmentId) problems.push('el Input no lleva el appointmentId');
  } catch {
    problems.push('Input no es JSON');
  }
  return problems;
}

/** Tabla de resultados en texto plano, apta para pegar en ClickUp o en el PR. */
export function formatResultsTable(results: CheckResult[]): string {
  const header = ['Paso', 'Chequeo', 'Estado', 'Detalle'];
  const rows = results.map((r) => [r.id, r.name, r.status, r.detail]);
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells: string[]) => `| ${cells.map((cell, c) => cell.padEnd(widths[c])).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** Exit code: 0 si no hay FAIL (WARN y SKIP no fallan el smoke). */
export function overallExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

// ---------- SigV4 para el Gateway (AWS_IAM) ----------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Firma SigV4 de un POST JSON (sin query string). Devuelve los headers a enviar.
 * Se firma a mano para no sumar dependencias; el servicio del Gateway es `bedrock-agentcore`.
 */
export function signPostRequest(args: {
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const u = new URL(args.url);
  const amzDate = args.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: u.host,
    'x-amz-content-sha256': sha256Hex(args.body),
    'x-amz-date': amzDate,
    ...(args.credentials.sessionToken ? { 'x-amz-security-token': args.credentials.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(args.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const canonicalPath = u.pathname
    .split('/')
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join('/');
  const canonicalRequest = ['POST', canonicalPath || '/', '', canonicalHeaders, signedNames.join(';'), headers['x-amz-content-sha256']].join('\n');
  const scope = `${date}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${args.credentials.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, args.region), args.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
  };
}

/** Respuesta MCP: JSON plano o SSE (`data: {...}`). Devuelve el primer objeto JSON-RPC. */
export function parseMcpResponse(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = trimmed.startsWith('{')
    ? [trimmed]
    : trimmed
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c) as Record<string, unknown>;
    } catch {
      // sigue con la proxima linea
    }
  }
  return undefined;
}
