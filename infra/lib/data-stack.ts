import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { names, protectConfigurationEnv, sendRcsResources } from './naming';
import { NodeLambda } from './node-lambda';

export interface DataStackProps extends StackProps {
  readonly config: EnvConfig;
}

/**
 * Datos y backend de reservas (owner: Pablo).
 * - Tablas: catalog (providers + slots sinteticos), appointments, message-events.
 * - Lambda `tools`: target del AgentCore Gateway (buscar, disponibilidad, reservar...).
 * - Lambda `reminder-sender` + schedule group de EventBridge Scheduler.
 */
export class DataStack extends Stack {
  readonly catalogTable: dynamodb.TableV2;
  readonly appointmentsTable: dynamodb.TableV2;
  readonly messageEventsTable: dynamodb.TableV2;
  readonly toolsFunction: NodeLambda;
  readonly reminderSender: NodeLambda;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const n = names(cfg);

    // pk = PROVIDER#<id>, sk = PROFILE | SLOT#<isoStart>. GSI por procedimiento + ciudad.
    this.catalogTable = new dynamodb.TableV2(this, 'Catalog', {
      tableName: n.catalogTable,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: 'by-procedure-city',
          partitionKey: { name: 'procedureCity', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'rating', type: dynamodb.AttributeType.NUMBER },
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // pk = appointmentId. GSI por hash de telefono (nunca el telefono en claro como clave).
    this.appointmentsTable = new dynamodb.TableV2(this, 'Appointments', {
      tableName: n.appointmentsTable,
      partitionKey: { name: 'appointmentId', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: 'by-patient',
          partitionKey: { name: 'patientHash', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // pk = messageId, sk = eventTimestamp. TTL para no acumular eventos de la demo.
    this.messageEventsTable = new dynamodb.TableV2(this, 'MessageEvents', {
      tableName: n.messageEventsTable,
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventTimestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ReminderScheduleGroup', {
      name: n.scheduleGroup,
    });

    this.reminderSender = new NodeLambda(this, 'ReminderSender', {
      handlerDir: 'reminder-sender',
      functionName: `${cfg.prefix}-reminder-sender`,
      description: 'Envia el recordatorio T-48h / T-24h por RCS con fallback a SMS',
      environment: {
        APPOINTMENTS_TABLE: this.appointmentsTable.tableName,
        CATALOG_TABLE: this.catalogTable.tableName,
        RCS_AGENT_ID: cfg.messaging.rcsAgentId,
        SMS_ORIGINATION_IDENTITY: cfg.messaging.smsOriginationIdentity,
        CONFIGURATION_SET_NAME: n.configurationSet,
        RCS_TTL_SECONDS: String(cfg.messaging.rcsTtlSeconds),
        ...protectConfigurationEnv(cfg),
      },
    });
    this.appointmentsTable.grantReadWriteData(this.reminderSender);
    this.catalogTable.grantReadData(this.reminderSender);
    this.reminderSender.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sms-voice:SendRcsMessage'],
        resources: sendRcsResources(this, cfg),
      }),
    );

    // Rol que asume EventBridge Scheduler para invocar reminder-sender.
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'EventBridge Scheduler invoca reminder-sender',
    });
    this.reminderSender.grantInvoke(schedulerRole);

    this.toolsFunction = new NodeLambda(this, 'Tools', {
      handlerDir: 'tools',
      functionName: `${cfg.prefix}-tools`,
      description: 'Target Lambda del AgentCore Gateway: providers, disponibilidad y turnos',
      timeout: Duration.seconds(10),
      environment: {
        CATALOG_TABLE: this.catalogTable.tableName,
        APPOINTMENTS_TABLE: this.appointmentsTable.tableName,
        SCHEDULE_GROUP: n.scheduleGroup,
        REMINDER_LAMBDA_ARN: this.reminderSender.functionArn,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        DEMO_MODE: String(cfg.reminders.demoMode),
        DEMO_MINUTES_48H: String(cfg.reminders.demoMinutes48h),
        DEMO_MINUTES_24H: String(cfg.reminders.demoMinutes24h),
      },
    });
    this.catalogTable.grantReadWriteData(this.toolsFunction); // marca slots como tomados
    this.appointmentsTable.grantReadWriteData(this.toolsFunction);
    this.toolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule'],
        resources: [
          this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${n.scheduleGroup}/*` }),
        ],
      }),
    );
    this.toolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    this.toolsFunction.node.addDependency(scheduleGroup);

    new CfnOutput(this, 'CatalogTableName', { value: this.catalogTable.tableName });
    new CfnOutput(this, 'AppointmentsTableName', { value: this.appointmentsTable.tableName });
    new CfnOutput(this, 'MessageEventsTableName', { value: this.messageEventsTable.tableName });
  }
}
