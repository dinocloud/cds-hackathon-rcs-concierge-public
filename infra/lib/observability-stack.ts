import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { names } from './naming';

export interface ObservabilityStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly functions: lambda.IFunction[];
}

/**
 * Dashboard de la demo (owner: Pablo): que se entrego por RCS y que cayo a SMS.
 * Las metricas las emite inbound-router en formato EMF al procesar eventos de entrega
 * (namespace RsConcierge, metrica DeliveryEvent, dimensiones Channel y Status).
 */
export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const n = names(cfg);

    const delivery = (channel: 'RCS' | 'SMS', status: string, label: string) =>
      new cloudwatch.Metric({
        namespace: n.metricsNamespace,
        metricName: 'DeliveryEvent',
        dimensionsMap: { Channel: channel, Status: status },
        statistic: 'Sum',
        period: Duration.minutes(1),
        label,
      });

    const rcsDelivered = delivery('RCS', 'DELIVERED', 'RCS entregado');
    const rcsRead = delivery('RCS', 'READ', 'RCS leido');
    const smsFallback = delivery('SMS', 'DELIVERED', 'SMS (fallback) entregado');
    const failed = delivery('RCS', 'FAILED', 'RCS fallido');

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${cfg.prefix}-delivery`,
      defaultInterval: Duration.hours(3),
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# RS Concierge: entregas RCS vs fallback a SMS\nDatos sinteticos. Ventana por defecto: 3 h.',
        width: 24,
        height: 2,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Entregas (suma en el rango)',
        metrics: [rcsDelivered, rcsRead, smsFallback, failed],
        setPeriodToTimeRange: true,
        width: 12,
        height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'RCS vs SMS por minuto',
        left: [rcsDelivered, smsFallback],
        right: [failed],
        stacked: false,
        width: 12,
        height: 5,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Errores de Lambdas',
        left: props.functions.map((fn) => fn.metricErrors({ period: Duration.minutes(1) })),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Duracion p95 de Lambdas',
        left: props.functions.map((fn) => fn.metricDuration({ period: Duration.minutes(1), statistic: 'p95' })),
        width: 12,
        height: 6,
      }),
    );

    new CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
  }
}
