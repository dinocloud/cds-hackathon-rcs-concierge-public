import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, IgnoreStrategy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { devConfig } from '../config/dev';
import { AGENT_CODE_EXCLUDE, bedrockModelResources, profileMatchesRegion, staleAgentBuildFiles } from '../lib/agent-stack';
import { buildStacks } from '../lib/build-stacks';
import { CLAIM_LEASE_MARGIN, INBOUND_ROUTER_DLQ_RETENTION, INBOUND_ROUTER_TIMEOUT } from '../lib/messaging-stack';

// Synth sin credenciales: cuenta dummy e IDs de RCS de prueba.
const cfg = {
  ...devConfig,
  account: '000000000000',
  region: 'us-east-1',
  messaging: { ...devConfig.messaging, rcsAgentId: 'rcs-test', smsOriginationIdentity: 'phone-test' },
};

const stacks = buildStacks(new App(), cfg);
const data = Template.fromStack(stacks.data);
const agent = Template.fromStack(stacks.agent);
const messaging = Template.fromStack(stacks.messaging);
const observability = Template.fromStack(stacks.observability);

describe('infra', () => {
  it('DataStack: 3 tablas, schedule group y Lambdas en Node 20 arm64', () => {
    data.resourceCountIs('AWS::DynamoDB::GlobalTable', 3);
    data.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    data.allResourcesProperties('AWS::Lambda::Function', { Runtime: 'nodejs20.x', Architectures: ['arm64'] });
  });

  it('AgentStack: Runtime, Memory, Gateway IAM y target con las 5 tools', () => {
    agent.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    agent.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    agent.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { AuthorizerType: 'AWS_IAM', ProtocolType: 'MCP' });
    agent.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: {
        Mcp: {
          Lambda: {
            ToolSchema: {
              InlinePayload: Match.arrayWith([
                Match.objectLike({ Name: 'search_providers' }),
                Match.objectLike({ Name: 'book_appointment' }),
                Match.objectLike({ Name: 'cancel_appointment' }),
              ]),
            },
          },
        },
      },
    });
  });

  it('AgentStack: Runtime con env vars del agente y sin credenciales', () => {
    agent.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        AGENT_MODE: 'aws',
        MODEL_ID: cfg.agent.modelId,
        GATEWAY_TARGET_NAME: 'tools',
        PROMPT_CACHE: 'true',
        MEMORY_ID: Match.anyValue(),
        GATEWAY_URL: Match.anyValue(),
      }),
    });
    const runtime = Object.values(agent.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    const envKeys = Object.keys(runtime.Properties.EnvironmentVariables).join(' ');
    expect(envKeys).not.toMatch(/SECRET|TOKEN|PASSWORD|ACCESS_KEY/);
  });

  it('AgentStack: rol del Runtime con InvokeModel acotado al modelo configurado, Memory y Gateway', () => {
    const statements = Object.values(agent.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    const bySid = (sid: string) => statements.find((st) => st.Sid === sid);
    const flat = (r: unknown) => JSON.stringify(r);

    const invoke = bySid('InvokeModel');
    expect(invoke.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(flat(invoke.Resource)).not.toContain('foundation-model/*');
    const foundationModel = cfg.agent.modelId.replace(/^[a-z-]+\./, '');
    expect(flat(invoke.Resource)).toContain(`foundation-model/${foundationModel}`);
    expect(flat(invoke.Resource)).toContain(`inference-profile/${cfg.agent.modelId}`);

    const memory = bySid('Memory');
    expect(memory.Action).toEqual(
      expect.arrayContaining(['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents']),
    );
    expect(flat(memory.Resource)).toContain('MemoryArn');

    const gateway = bySid('Gateway');
    expect(gateway.Action).toBe('bedrock-agentcore:InvokeGateway');
    expect(flat(gateway.Resource)).toContain('GatewayArn');
  });

  it('bedrockModelResources: foundation model directo queda en la region del stack', () => {
    const stack = new Stack(new App(), 'T', { env: { account: '000000000000', region: 'us-east-1' } });
    const resources = bedrockModelResources(stack, 'anthropic.claude-3-haiku-20240307-v1:0');
    expect(resources).toHaveLength(1);
    expect(stack.resolve(resources[0])).toEqual({
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0']],
    });
  });

  it('profileMatchesRegion: au. va a ap-southeast-*, apac a ap-*, us a us-*', () => {
    expect(profileMatchesRegion('au.anthropic.claude-sonnet-4-5', 'ap-southeast-2')).toBe(true);
    expect(profileMatchesRegion('au.anthropic.claude-sonnet-4-5', 'au-east-1')).toBe(false);
    expect(profileMatchesRegion('apac.anthropic.claude-sonnet-4-5', 'ap-south-1')).toBe(true);
    expect(profileMatchesRegion('jp.anthropic.claude-sonnet-4-5', 'ap-northeast-1')).toBe(true);
    expect(profileMatchesRegion('us.anthropic.claude-sonnet-4-5', 'us-east-1')).toBe(true);
    expect(profileMatchesRegion('us.anthropic.claude-sonnet-4-5', 'eu-west-1')).toBe(false);
    expect(profileMatchesRegion('global.anthropic.claude-sonnet-4-5', 'eu-west-1')).toBe(true);
    expect(profileMatchesRegion('anthropic.claude-3-haiku-20240307-v1:0', 'eu-west-1')).toBe(true);
  });

  it('AGENT_CODE_EXCLUDE: build y tests solo en la raiz del asset, no dentro de dependencias', () => {
    const root = path.join(os.tmpdir(), 'agent-asset');
    const ignore = IgnoreStrategy.git(root, AGENT_CODE_EXCLUDE);
    const ignored = (rel: string) => ignore.ignores(path.join(root, rel));
    expect(ignored('build/app.py')).toBe(true);
    expect(ignored('tests/test_smoke.py')).toBe(true);
    expect(ignored('README.md')).toBe(true);
    expect(ignored('botocore/build/x.py')).toBe(false);
    expect(ignored('mcp/tests/__init__.py')).toBe(false);
    expect(ignored('pkg/README.md')).toBe(false);
    expect(ignored('pkg/__pycache__/m.pyc')).toBe(true);
    expect(ignored('app.py')).toBe(false);
  });

  it('staleAgentBuildFiles: detecta un build viejo o incompleto', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-src-'));
    const buildDir = path.join(agentDir, 'build');
    fs.mkdirSync(buildDir);
    fs.writeFileSync(path.join(agentDir, 'app.py'), 'v2');
    fs.writeFileSync(path.join(agentDir, 'prompt.md'), 'p');
    fs.writeFileSync(path.join(buildDir, 'app.py'), 'v1');
    expect(staleAgentBuildFiles(agentDir, buildDir).sort()).toEqual(['app.py', 'prompt.md']);
    fs.writeFileSync(path.join(buildDir, 'app.py'), 'v2');
    fs.writeFileSync(path.join(buildDir, 'prompt.md'), 'p');
    expect(staleAgentBuildFiles(agentDir, buildDir)).toEqual([]);
    // Cambiar dependencias sin reempaquetar tambien deja el build viejo.
    fs.writeFileSync(path.join(agentDir, 'requirements.txt'), 'strands-agents>=1.62.0');
    expect(staleAgentBuildFiles(agentDir, buildDir)).toEqual(['requirements.txt']);
    fs.writeFileSync(path.join(buildDir, 'requirements.txt'), 'strands-agents>=1.62.0');
    expect(staleAgentBuildFiles(agentDir, buildDir)).toEqual([]);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('MessagingStack: configuration set con destino SNS y router suscripto', () => {
    messaging.hasResourceProperties('AWS::SMSVOICE::ConfigurationSet', {
      EventDestinations: [Match.objectLike({ SnsDestination: Match.anyValue(), Enabled: true })],
    });
    messaging.resourceCountIs('AWS::SNS::Subscription', 1);
    messaging.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'sms-voice.amazonaws.com' }, Action: 'sns:Publish' }),
        ]),
      },
    });
  });

  it('IAM: ninguna politica con Action "*" y SendRcsMessage acotado a recursos', () => {
    for (const t of [data, agent, messaging]) {
      const policies = t.findResources('AWS::IAM::Policy');
      for (const p of Object.values(policies)) {
        for (const st of p.Properties.PolicyDocument.Statement) {
          expect(st.Action).not.toBe('*');
          if (st.Action === 'sms-voice:SendRcsMessage') expect(st.Resource).not.toBe('*');
        }
      }
    }
  });

  describe('MessagingStack: inbound-router (A4)', () => {
    const statements = (): Array<Record<string, any>> =>
      Object.values(messaging.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const bySid = (sid: string) => {
      const st = statements().find((s) => s.Sid === sid);
      expect(st).toBeDefined();
      return st!;
    };
    const arnsOf = (st: Record<string, any>) => JSON.stringify(st.Resource);

    it('env del router: CHANNEL_MODE, RCS agent, origen SMS, Runtime y tablas', () => {
      messaging.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'rs-concierge-dev-inbound-router',
        Environment: {
          Variables: Match.objectLike({
            CHANNEL_MODE: 'rcs',
            RCS_AGENT_ID: 'rcs-test',
            SMS_ORIGINATION_IDENTITY: 'phone-test',
            CONFIGURATION_SET_NAME: 'rs-concierge-dev-rcs',
            AGENT_RUNTIME_ARN: Match.anyValue(),
            MESSAGE_EVENTS_TABLE: Match.anyValue(),
            PHONE_HASH_SALT_SECRET_ARN: Match.anyValue(),
          }),
        },
      });
    });

    it('InvokeAgentRuntime solo sobre el Runtime del AgentStack', () => {
      const st = bySid('InvokeConciergeRuntime');
      expect(st.Action).toEqual(['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser']);
      expect(st.Resource).toHaveLength(2);
      expect(arnsOf(st)).toContain('Fn::ImportValue');
      expect(arnsOf(st)).not.toContain('"*"');
    });

    const smsStacks = buildStacks(new App(), { ...cfg, messaging: { ...cfg.messaging, channelMode: 'sms' } });
    const smsMessaging = Template.fromStack(smsStacks.messaging);
    const smsStatements = (): Array<Record<string, any>> =>
      Object.values(smsMessaging.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);

    it('modo rcs: solo SendRcsMessage, acotado y con el ARN de phone-number (no pool) para phone-...', () => {
      const rcs = bySid('SendRcsWithSmsFallback');
      expect(rcs.Action).toBe('sms-voice:SendRcsMessage');
      expect(arnsOf(rcs)).toContain('rcs-agent/rcs-test');
      expect(arnsOf(rcs)).toContain('phone-number/phone-test');
      expect(arnsOf(rcs)).not.toContain('pool/');
      expect(statements().find((s) => s.Sid === 'SendSmsOnly')).toBeUndefined();
      for (const r of rcs.Resource) expect(r).not.toBe('*');
    });

    it('modo sms: solo SendTextMessage, acotado y nunca sobre el RCS agent', () => {
      const sms = smsStatements().find((s) => s.Sid === 'SendSmsOnly');
      expect(sms).toBeDefined();
      expect(sms!.Action).toBe('sms-voice:SendTextMessage');
      expect(JSON.stringify(sms!.Resource)).toContain('phone-number/phone-test');
      expect(JSON.stringify(sms!.Resource)).toContain('configuration-set/rs-concierge-dev-rcs');
      expect(JSON.stringify(sms!.Resource)).not.toContain('rcs-agent');
      expect(JSON.stringify(sms!.Resource)).not.toContain('pool/');
      expect(smsStatements().find((s) => s.Sid === 'SendRcsWithSmsFallback')).toBeUndefined();
      for (const r of sms!.Resource) expect(r).not.toBe('*');
    });

    it('origen SMS pool-...: ARN de pool y no de phone-number', () => {
      const poolStacks = buildStacks(new App(), { ...cfg, messaging: { ...cfg.messaging, smsOriginationIdentity: 'pool-test' } });
      const st = Object.values(Template.fromStack(poolStacks.messaging).findResources('AWS::IAM::Policy'))
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .find((s: any) => s.Sid === 'SendRcsWithSmsFallback');
      expect(JSON.stringify(st.Resource)).toContain('pool/pool-test');
      expect(JSON.stringify(st.Resource)).not.toContain('phone-number/');
    });

    it('topic policy y trust del rol two-way: SourceAccount y ArnLike aws:SourceArn', () => {
      const sourceArnCondition = Match.objectLike({
        StringEquals: { 'aws:SourceAccount': Match.anyValue() },
        ArnLike: { 'aws:SourceArn': Match.anyValue() },
      });
      messaging.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'AllowEndUserMessagingPublish', Condition: sourceArnCondition })]) },
      });
      messaging.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'sms-voice.amazonaws.com' }, Condition: sourceArnCondition })],
        },
      });
      const policy = Object.values(messaging.findResources('AWS::SNS::TopicPolicy'))[0] as any;
      const arns = JSON.stringify(policy.Properties.PolicyDocument.Statement.find((st: any) => st.Sid === 'AllowEndUserMessagingPublish').Condition.ArnLike['aws:SourceArn']);
      expect(arns).toContain('rcs-agent/rcs-test');
      expect(arns).toContain('configuration-set/rs-concierge-dev-rcs');
      expect(arns).toContain('phone-number/phone-test');
      const role = Object.values(messaging.findResources('AWS::IAM::Role')).find((r: any) =>
        JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('sms-voice.amazonaws.com')) as any;
      const roleArns = JSON.stringify(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.ArnLike['aws:SourceArn']);
      expect(roleArns).toContain(':sms-voice:');
      expect(roleArns).toContain(':*');
    });

    it('DLQ: SQS en la suscripcion SNS y en el onFailure asincronico, con alarma de profundidad', () => {
      messaging.resourceCountIs('AWS::SQS::Queue', 1);
      const [queueId] = Object.keys(messaging.findResources('AWS::SQS::Queue'));
      messaging.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'lambda',
        RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [queueId, 'Arn'] } },
      });
      messaging.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
        MaximumRetryAttempts: 2,
        DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [queueId, 'Arn'] } } },
      });
      messaging.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [queueId, 'QueueName'] } }],
      });
      // SNS puede escribir en la DLQ (policy que agrega LambdaSubscription).
      messaging.hasResourceProperties('AWS::SQS::QueuePolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: 'sqs:SendMessage', Principal: { Service: 'sns.amazonaws.com' } })]),
        },
      });
    });

    it('timeout de AgentCore menor que el de la Lambda', () => {
      const fns = Object.values(messaging.findResources('AWS::Lambda::Function')) as any[];
      const router = fns.find((f) => f.Properties.FunctionName === 'rs-concierge-dev-inbound-router');
      const agentMs = Number(router.Properties.Environment.Variables.AGENT_REQUEST_TIMEOUT_MS);
      expect(router.Properties.Timeout).toBe(INBOUND_ROUTER_TIMEOUT.toSeconds());
      expect(agentMs).toBeGreaterThan(0);
      expect(agentMs).toBeLessThan(router.Properties.Timeout * 1000);
      // Peor caso del agente: 35 s de turno + 15 s de lectura + cold start (5 a 8 s) = 58 s.
      expect(router.Properties.Timeout).toBe(90);
      expect(agentMs).toBe(75_000);
      expect(agentMs).toBeGreaterThan(58_000);
    });

    it('lease del claim derivado del timeout de la Lambda: INBOUND_CLAIM_LEASE_MS > timeout', () => {
      const fns = Object.values(messaging.findResources('AWS::Lambda::Function')) as any[];
      const router = fns.find((f) => f.Properties.FunctionName === 'rs-concierge-dev-inbound-router');
      const leaseMs = Number(router.Properties.Environment.Variables.INBOUND_CLAIM_LEASE_MS);
      expect(leaseMs).toBe(INBOUND_ROUTER_TIMEOUT.toMilliseconds() + CLAIM_LEASE_MARGIN.toMilliseconds());
      expect(leaseMs).toBeGreaterThan(router.Properties.Timeout * 1000);
      expect(leaseMs).toBe(120_000);
    });

    it('DLQ: retencion corta (4 dias) porque guarda el payload SNS con telefono y texto', () => {
      messaging.hasResourceProperties('AWS::SQS::Queue', {
        MessageRetentionPeriod: INBOUND_ROUTER_DLQ_RETENTION.toSeconds(),
      });
      expect(INBOUND_ROUTER_DLQ_RETENTION.toDays()).toBe(4);
    });

    it('DynamoDB: solo PutItem/DeleteItem en message-events y PutItem en appointments', () => {
      expect(bySid('MessageEventsWrite').Action).toEqual(['dynamodb:PutItem', 'dynamodb:DeleteItem']);
      expect(bySid('AppointmentsContactPut').Action).toBe('dynamodb:PutItem');
      const dynamoActions = statements()
        .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
        .filter((a: string) => a.startsWith('dynamodb:'));
      expect(new Set(dynamoActions)).toEqual(new Set(['dynamodb:PutItem', 'dynamodb:DeleteItem']));
    });

    it('CHANNEL_MODE=sms llega al env del router', () => {
      smsMessaging.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ CHANNEL_MODE: 'sms' }) },
      });
    });

    it('config: CHANNEL_MODE se valida igual que en la Lambda (SMS en mayusculas es sms, invalido falla)', () => {
      const load = (value: string | undefined) => {
        const prev = process.env.CHANNEL_MODE;
        if (value === undefined) delete process.env.CHANNEL_MODE;
        else process.env.CHANNEL_MODE = value;
        try {
          let mode: string | undefined;
          jest.isolateModules(() => {
            mode = require('../config/dev').devConfig.messaging.channelMode;
          });
          return mode;
        } finally {
          if (prev === undefined) delete process.env.CHANNEL_MODE;
          else process.env.CHANNEL_MODE = prev;
        }
      };
      expect(load('SMS')).toBe('sms');
      expect(load(undefined)).toBe('rcs');
      expect(() => load('mms')).toThrow('CHANNEL_MODE invalido');
    });
  });

  it('ObservabilityStack: dashboard de entregas', () => {
    observability.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });
});
