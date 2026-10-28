import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export const REPO_ROOT = path.join(__dirname, '..', '..');

export interface NodeLambdaProps {
  /** Carpeta dentro de lambdas/ (por ejemplo "tools"). */
  readonly handlerDir: string;
  readonly functionName: string;
  readonly description: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
  readonly memorySize?: number;
}

/**
 * Lambda Node 20 en arm64 empaquetada con esbuild local (sin Docker).
 * El SDK v3 se empaqueta dentro del bundle porque los comandos de RCS y
 * AgentCore pueden ser mas nuevos que el SDK que trae el runtime.
 */
export class NodeLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: NodeLambdaProps) {
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    super(scope, id, {
      functionName: props.functionName,
      description: props.description,
      entry: path.join(REPO_ROOT, 'lambdas', props.handlerDir, 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: [],
        forceDockerBundling: false,
      },
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
    });
  }
}
