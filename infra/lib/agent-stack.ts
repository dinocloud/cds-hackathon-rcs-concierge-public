import * as fs from 'fs';
import * as path from 'path';
import { Annotations, ArnFormat, CfnOutput, IgnoreMode, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { TOOL_DEFINITIONS } from '../../lambdas/tools/schema';
import { names } from './naming';
import { REPO_ROOT } from './node-lambda';

/** Nombre del target del Gateway: las tools llegan como `<target>___<tool>`. */
export const GATEWAY_TARGET_NAME = 'tools';

/** Prefijos geograficos de los inference profiles cross-region de Bedrock. */
const INFERENCE_PROFILE_GEO = /^(us|eu|apac|jp|au|ca|us-gov|global)\./;

/**
 * Recursos de bedrock:InvokeModel acotados al modelo configurado.
 * - Inference profile cross-region (ej: us.anthropic...): el profile de la cuenta y el
 *   foundation model subyacente en cualquier region (el profile enruta entre regiones).
 * - Foundation model directo: solo ese modelo en la region del stack.
 * VERIFICAR: formato de ARN de los profiles `global.` (foundation model sin region).
 */
export function bedrockModelResources(stack: Stack, modelId: string): string[] {
  const geo = INFERENCE_PROFILE_GEO.exec(modelId);
  if (!geo) {
    return [stack.formatArn({ service: 'bedrock', account: '', resource: 'foundation-model', resourceName: modelId })];
  }
  const foundationModel = modelId.slice(geo[0].length);
  return [
    stack.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: modelId }),
    `arn:${stack.partition}:bedrock:*::foundation-model/${foundationModel}`,
  ];
}

/** Prefijo de region que corresponde a cada geo de inference profile (`au.` va a ap-southeast-*). */
const GEO_REGION_PREFIX: Record<string, string> = {
  apac: 'ap-',
  jp: 'ap-northeast-',
  au: 'ap-southeast-',
};

/** true si el inference profile del modelo sirve en la region (o si no es un profile geografico). */
export function profileMatchesRegion(modelId: string, region: string): boolean {
  const geo = INFERENCE_PROFILE_GEO.exec(modelId)?.[1];
  if (!geo || geo === 'global') return true;
  return region.startsWith(GEO_REGION_PREFIX[geo] ?? `${geo}-`);
}

/** Avisa si el inference profile no corresponde a la region del deploy (ej: us.* en eu-west-1). */
function warnOnProfileRegionMismatch(stack: Stack, modelId: string): void {
  const geo = INFERENCE_PROFILE_GEO.exec(modelId)?.[1];
  if (!geo || Token.isUnresolved(stack.region)) return;
  if (!profileMatchesRegion(modelId, stack.region)) {
    Annotations.of(stack).addWarningV2(
      'rs-concierge:model-region-mismatch',
      `El modelo ${modelId} es un inference profile "${geo}" y el stack va a ${stack.region}. Ajustar AGENT_MODEL_ID o CDK_DEFAULT_REGION.`,
    );
  }
}

/**
 * Exclusiones del asset del agente, ancladas a la raiz del asset (IgnoreMode.GIT): `/build` y
 * `/tests` no tocan carpetas homonimas dentro de las dependencias de agent/build.
 */
export const AGENT_CODE_EXCLUDE = [
  '/.venv',
  '/venv',
  '/build',
  '/tests',
  '/README.md',
  '/requirements-dev.txt',
  '__pycache__',
  '*.pyc',
  '.pytest_cache',
];

/** Archivos de agent/ que package-agent.sh copia a agent/build, requirements.txt incluido (deben coincidir byte a byte). */
export function staleAgentBuildFiles(agentDir: string, buildDir: string): string[] {
  // requirements.txt tambien: un cambio de dependencias sin reempaquetar deja el build viejo.
  const sources = fs.readdirSync(agentDir).filter((f) => f.endsWith('.py') || f === 'prompt.md' || f === 'requirements.txt');
  return sources.filter((f) => {
    const built = path.join(buildDir, f);
    return !fs.existsSync(built) || !fs.readFileSync(built).equals(fs.readFileSync(path.join(agentDir, f)));
  });
}

/**
 * Codigo del agente: si existe agent/build (scripts/package-agent.sh, con dependencias para
 * linux/arm64) se sube eso; si no, agent/ sin dependencias (sirve para synth, no para correr).
 * scripts/deploy.sh corre package-agent.sh siempre; igual se avisa si el build quedo viejo.
 */
function agentCodeDir(stack: Stack): string {
  const agentDir = path.join(REPO_ROOT, 'agent');
  const build = path.join(agentDir, 'build');
  if (fs.existsSync(path.join(build, 'app.py'))) {
    const stale = staleAgentBuildFiles(agentDir, build);
    if (stale.length > 0) {
      Annotations.of(stack).addWarningV2(
        'rs-concierge:agent-build-stale',
        `agent/build esta desactualizado (${stale.join(', ')}). Correr scripts/package-agent.sh antes de desplegar.`,
      );
    }
    return build;
  }
  Annotations.of(stack).addWarningV2(
    'rs-concierge:agent-code-without-deps',
    'agent/build no existe: el Runtime se sintetiza sin dependencias. Correr scripts/package-agent.sh antes de desplegar.',
  );
  return path.join(REPO_ROOT, 'agent');
}

export interface AgentStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly toolsFunction: lambda.IFunction;
}

/**
 * Agente concierge en AgentCore (owner: Agustin).
 * - Memory: sesion por paciente (PII redactada antes de escribir, ver agent/pii.py).
 * - Gateway (MCP, auth IAM) con un target Lambda `tools`.
 * - Runtime: agente Strands en Python, codigo desde agent/ como asset S3.
 */
export class AgentStack extends Stack {
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const n = names(cfg);
    warnOnProfileRegionMismatch(this, cfg.agent.modelId);

    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: n.memory,
      description: 'Memoria de sesion del concierge (solo datos sinteticos, PII redactada)',
      eventExpiryDuration: cfg.agent.memoryEventExpiryDays,
      memoryStrategies: [
        {
          // TODO(agustin): el agente todavia no lee los resumenes (solo memoria de corto plazo
          // por sesion). La estrategia tiene costo de extraccion: leerla o sacarla.
          summaryMemoryStrategy: {
            name: 'session_summary',
            namespaces: ['/summaries/{actorId}/{sessionId}'],
          },
        },
      ],
    });

    // Gateway: el Runtime lo llama firmando con SigV4 (AWS_IAM).
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'AgentCore Gateway invoca la Lambda tools',
    });
    props.toolsFunction.grantInvoke(gatewayRole);

    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: n.gateway,
      description: 'Tools de reservas del concierge',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
    });

    new agentcore.CfnGatewayTarget(this, 'ToolsTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: GATEWAY_TARGET_NAME,
      description: 'Lambda tools sobre DynamoDB sintetica',
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: props.toolsFunction.functionArn,
            toolSchema: { inlinePayload: TOOL_DEFINITIONS },
          },
        },
      },
    });

    // Codigo del agente (ver agentCodeDir): deploy siempre despues de scripts/package-agent.sh.
    const agentCode = new Asset(this, 'AgentCode', {
      path: agentCodeDir(this),
      ignoreMode: IgnoreMode.GIT,
      exclude: AGENT_CODE_EXCLUDE,
    });

    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Rol de ejecucion del agente concierge en AgentCore Runtime',
    });
    agentCode.grantRead(runtimeRole);
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeModel',
        // Strands usa ConverseStream, que se autoriza con estas dos acciones.
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: bedrockModelResources(this, cfg.agent.modelId),
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Memory',
        // Las que usa AgentCoreMemorySessionManager (memoria de corto plazo de la sesion).
        // DeleteEvent: update_message reemplaza un evento (crea el nuevo y borra el viejo) y la
        // migracion de eventos legacy tambien borra (bedrock-agentcore 1.24, session_manager.py).
        // Sin RetrieveMemoryRecords: el agente no lee memoria de largo plazo todavia.
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:DeleteEvent',
        ],
        resources: [memory.attrMemoryArn],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Gateway',
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.attrGatewayArn],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WorkloadIdentity',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
        resources: [
          this.formatArn({ service: 'bedrock-agentcore', resource: 'workload-identity-directory', resourceName: 'default' }),
          this.formatArn({
            service: 'bedrock-agentcore',
            resource: 'workload-identity-directory',
            resourceName: `default/workload-identity/${n.agentRuntime}-*`,
          }),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Logs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [
          this.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: '/aws/bedrock-agentcore/runtimes/*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Traces',
        // X-Ray no soporta permisos a nivel de recurso.
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );

    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: n.agentRuntime,
      description: 'Concierge de turnos (Strands) para la POC RCS',
      roleArn: runtimeRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: agentCode.s3BucketName, prefix: agentCode.s3ObjectKey } },
          entryPoint: ['app.py'],
          // VERIFICAR: valores validos del runtime administrado (PYTHON_3_10 a PYTHON_3_13).
          runtime: 'PYTHON_3_12',
        },
      },
      environmentVariables: {
        AGENT_MODE: 'aws',
        AGENT_REGION: this.region,
        MEMORY_ID: memory.attrMemoryId,
        GATEWAY_URL: gateway.attrGatewayUrl,
        GATEWAY_TARGET_NAME,
        MODEL_ID: cfg.agent.modelId,
        PROMPT_CACHE: 'true',
        LOG_LEVEL: 'INFO',
      },
      tags: cfg.tags,
    });
    runtime.node.addDependency(runtimeRole);

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, 'MemoryId', { value: memory.attrMemoryId });
    new CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl });
  }
}
