import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as smsvoice from 'aws-cdk-lib/aws-smsvoice';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import {
  names,
  originationIdentityArn,
  protectConfigurationArns,
  protectConfigurationEnv,
  sendRcsResources,
  smsVoiceArn,
} from './naming';
import { NodeLambda } from './node-lambda';

/**
 * Timeout del inbound-router. 90 s: la llamada a AgentCore corta a los 75 s (90 - 15) y el
 * lease del claim queda en 120 s (90 + 30). Tiene que superar el peor caso del agente (turno de
 * 35 s + 15 s de lectura en curso + cold start de 5 a 8 s); con 60 s el router abortaba a los 45 s
 * y el reintento podia repetir un book_appointment ya hecho (review de Lucas, PR #3).
 */
export const INBOUND_ROUTER_TIMEOUT = Duration.seconds(90);
/**
 * Margen entre el timeout de la llamada a AgentCore y el de la Lambda: alcanza para liberar el
 * claim y loguear el error antes de que la Lambda corte.
 */
export const AGENT_TIMEOUT_MARGIN = Duration.seconds(15);
/**
 * Margen del lease del claim de un entrante sobre el timeout de la Lambda: el lease
 * (INBOUND_CLAIM_LEASE_MS) se deriva del timeout, asi una invocacion viva nunca pierde su claim.
 */
export const CLAIM_LEASE_MARGIN = Duration.seconds(30);
/** Retencion de la DLQ: guarda el payload SNS completo (telefono y texto del paciente). */
export const INBOUND_ROUTER_DLQ_RETENTION = Duration.days(4);

/**
 * Recursos de SendTextMessage para CHANNEL_MODE=sms. `smsOriginationIdentity` es el
 * PhoneNumberId o PoolId (no el numero E.164: el ARN usa el ID); el tipo de ARN sale del prefijo.
 * VERIFICAR tipos de recurso de SendTextMessage en
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonpinpointsmsvoicev2.html
 */
export function sendTextResources(stack: Stack, cfg: EnvConfig): string[] {
  return [
    originationIdentityArn(stack, cfg.messaging.smsOriginationIdentity),
    smsVoiceArn(stack, 'configuration-set', names(cfg).configurationSet),
    ...protectConfigurationArns(stack, cfg),
  ];
}

export interface MessagingStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly agentRuntimeArn: string;
  readonly appointmentsTable: dynamodb.ITableV2;
  readonly messageEventsTable: dynamodb.ITableV2;
}

/**
 * Origenes que pueden publicar en el topic o asumir el rol two-way: el RCS agent (two-way),
 * el configuration set (event destination) y el numero o pool SMS (two-way del plan B).
 */
export function messagingSourceArns(stack: Stack, cfg: EnvConfig): string[] {
  return [
    smsVoiceArn(stack, 'rcs-agent', cfg.messaging.rcsAgentId),
    smsVoiceArn(stack, 'configuration-set', names(cfg).configurationSet),
    originationIdentityArn(stack, cfg.messaging.smsOriginationIdentity),
  ];
}

/**
 * Canal RCS / SMS (owner: Leo).
 * - SNS topic unico para mensajes entrantes, postbacks y eventos de entrega.
 * - Configuration set de End User Messaging con event destination a ese topic.
 * - Rol de two-way channel para el RCS agent (el agente se registra a mano y se le
 *   apunta este topic, ver scripts/register-rcs-agent.md).
 * - Lambda inbound-router suscripta al topic. CHANNEL_MODE (config) elige RCS con fallback
 *   a SMS o solo SMS. IAM acotado: InvokeAgentRuntime sobre el Runtime, SendRcsMessage (modo
 *   rcs) o SendTextMessage (modo sms) sobre los IDs de la config, y DynamoDB solo PutItem/DeleteItem.
 * - DLQ: la suscripcion SNS (entregas que fallan contra Lambda) y la invocacion asincronica
 *   (reintentos agotados) van a una SQS con alarma de profundidad.
 */
export class MessagingStack extends Stack {
  readonly inboundRouter: NodeLambda;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const n = names(cfg);
    // Solo publican los recursos de End User Messaging de esta cuenta y de esta config.
    const sourceConditions = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': messagingSourceArns(this, cfg) },
    };

    // TODO(leo): evaluar cifrado con CMK; requiere key policy para sms-voice.amazonaws.com.
    const eventsTopic = new sns.Topic(this, 'RcsEventsTopic', {
      topicName: n.eventsTopic,
      displayName: 'RS concierge: eventos RCS/SMS',
      enforceSSL: true,
    });
    eventsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEndUserMessagingPublish',
        principals: [new iam.ServicePrincipal('sms-voice.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [eventsTopic.topicArn],
        conditions: sourceConditions,
      }),
    );

    // Rol que End User Messaging asume para publicar los mensajes entrantes del RCS agent.
    // UpdateRcsAgent valida el rol con un SourceArn que no es el del agente: con la lista
    // exacta falla con RESOURCE_NOT_ACCESSIBLE, asi que el trust acota a sms-voice de esta
    // cuenta y region. El topic sigue con la lista exacta.
    const twoWayRole = new iam.Role(this, 'RcsTwoWayChannelRole', {
      assumedBy: new iam.ServicePrincipal('sms-voice.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:sms-voice:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Two-way channel del RCS agent hacia el topic de eventos',
    });
    eventsTopic.grantPublish(twoWayRole);

    new smsvoice.CfnConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: n.configurationSet,
      messageFeedbackEnabled: false,
      ...(cfg.messaging.protectConfigurationId
        ? { protectConfigurationId: cfg.messaging.protectConfigurationId }
        : {}),
      eventDestinations: [
        {
          eventDestinationName: 'rcs-events-to-sns',
          enabled: true,
          // TODO(leo): acotar a los tipos de evento de RCS y SMS que usamos (ver docs/contrato-eventos.md).
          matchingEventTypes: ['ALL'],
          snsDestination: { topicArn: eventsTopic.topicArn },
        },
      ],
    });

    // Sal para el hash del telefono: se genera en el deploy, nunca vive en el repo.
    const phoneHashSalt = new secretsmanager.Secret(this, 'PhoneHashSalt', {
      secretName: `${cfg.prefix}/phone-hash-salt`,
      description: 'Sal para derivar el session id y el patientRef desde el telefono',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    this.inboundRouter = new NodeLambda(this, 'InboundRouter', {
      handlerDir: 'inbound-router',
      functionName: `${cfg.prefix}-inbound-router`,
      description: 'Normaliza eventos RCS/SNS, invoca al agente y responde por RCS',
      timeout: INBOUND_ROUTER_TIMEOUT, // cold start de AgentCore: 5 a 8 s
      memorySize: 512,
      environment: {
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        APPOINTMENTS_TABLE: props.appointmentsTable.tableName,
        MESSAGE_EVENTS_TABLE: props.messageEventsTable.tableName,
        RCS_AGENT_ID: cfg.messaging.rcsAgentId,
        SMS_ORIGINATION_IDENTITY: cfg.messaging.smsOriginationIdentity,
        CONFIGURATION_SET_NAME: n.configurationSet,
        RCS_TTL_SECONDS: String(cfg.messaging.rcsTtlSeconds),
        CHANNEL_MODE: cfg.messaging.channelMode,
        // Menor que el timeout de la Lambda para que el catch libere el claim.
        AGENT_REQUEST_TIMEOUT_MS: String(INBOUND_ROUTER_TIMEOUT.toMilliseconds() - AGENT_TIMEOUT_MARGIN.toMilliseconds()),
        // Mayor que el timeout de la Lambda: derivado de INBOUND_ROUTER_TIMEOUT, no de un comentario.
        INBOUND_CLAIM_LEASE_MS: String(INBOUND_ROUTER_TIMEOUT.toMilliseconds() + CLAIM_LEASE_MARGIN.toMilliseconds()),
        ...protectConfigurationEnv(cfg),
        PHONE_HASH_SALT_SECRET_ARN: phoneHashSalt.secretArn,
        METRICS_NAMESPACE: n.metricsNamespace,
      },
    });

    // DLQ del router: recibe lo que SNS no pudo entregar a la Lambda y lo que la Lambda no pudo
    // procesar tras los reintentos asincronicos. SSE-SQS (SNS no publica en colas con la clave
    // administrada de KMS). Guarda el payload SNS completo (telefono y texto del paciente): por
    // eso la retencion es corta (4 dias, alcanza para un fin de semana largo).
    const routerDlq = new sqs.Queue(this, 'InboundRouterDlq', {
      queueName: `${cfg.prefix}-inbound-router-dlq`,
      retentionPeriod: INBOUND_ROUTER_DLQ_RETENTION,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    eventsTopic.addSubscription(new subs.LambdaSubscription(this.inboundRouter, { deadLetterQueue: routerDlq }));
    this.inboundRouter.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
      onFailure: new destinations.SqsDestination(routerDlq),
    });
    // Cualquier mensaje en la DLQ es un paciente sin respuesta o un evento perdido.
    // Sin accion a proposito (POC): se mira en la consola de CloudWatch, ver docs/contrato-eventos.md.
    // TODO(leo): conectar la alarma a un topic de notificaciones cuando exista.
    new cloudwatch.Alarm(this, 'InboundRouterDlqAlarm', {
      alarmName: `${cfg.prefix}-inbound-router-dlq-depth`,
      alarmDescription: 'Hay mensajes en la DLQ del inbound-router (ver docs/contrato-eventos.md)',
      metric: routerDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    phoneHashSalt.grantRead(this.inboundRouter);
    // message-events: eventos de entrega y claims de idempotencia (put condicional) y
    // liberacion del claim si falla el agente (DeleteItem). Nada de Scan/Query/Update.
    this.inboundRouter.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MessageEventsWrite',
        actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
        resources: [props.messageEventsTable.tableArn],
      }),
    );
    // appointments: solo escribe el item CONTACT#<hash> (telefono para los recordatorios).
    this.inboundRouter.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AppointmentsContactPut',
        actions: ['dynamodb:PutItem'],
        resources: [props.appointmentsTable.tableArn],
      }),
    );
    // VERIFICAR: runtimeUserId (actorId de Memory) pide InvokeAgentRuntimeForUser ademas de
    // InvokeAgentRuntime. El sufijo /* cubre el endpoint DEFAULT del Runtime.
    this.inboundRouter.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConciergeRuntime',
        actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
        resources: [props.agentRuntimeArn, `${props.agentRuntimeArn}/*`],
      }),
    );
    // Solo el permiso del modo configurado: cambiar CHANNEL_MODE requiere redeploy.
    if (cfg.messaging.channelMode === 'rcs') {
      this.inboundRouter.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'SendRcsWithSmsFallback',
          actions: ['sms-voice:SendRcsMessage'],
          resources: sendRcsResources(this, cfg),
        }),
      );
    } else {
      // CHANNEL_MODE=sms: SendTextMessage solo desde el numero o pool de fallback (nunca el RCS agent).
      this.inboundRouter.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'SendSmsOnly',
          actions: ['sms-voice:SendTextMessage'],
          resources: sendTextResources(this, cfg),
        }),
      );
    }

    new CfnOutput(this, 'RcsEventsTopicArn', { value: eventsTopic.topicArn });
    new CfnOutput(this, 'RcsTwoWayChannelRoleArn', { value: twoWayRole.roleArn });
    new CfnOutput(this, 'ConfigurationSetName', { value: n.configurationSet });
    new CfnOutput(this, 'InboundRouterFunctionName', { value: this.inboundRouter.functionName });
    new CfnOutput(this, 'ChannelMode', { value: cfg.messaging.channelMode });
    new CfnOutput(this, 'InboundRouterDlqUrl', { value: routerDlq.queueUrl });
  }
}
