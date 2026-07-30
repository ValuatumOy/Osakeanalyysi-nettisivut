import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { StageConfig } from './config';

export interface WorkerStackProps extends StackProps {
  config: StageConfig;
  ordersTable: dynamodb.ITable;
  catalogStateTable: dynamodb.ITable;
  pdfBucket: s3.IBucket;
  alertsTopic: sns.ITopic;
}

/**
 * Plan §2/§2.1: the reconciler + reaper worker. Event-driven with a scheduled
 * backstop — async-invoked by the API on fresh orders, swept by EventBridge
 * every 5 minutes, reaped daily. Reserved concurrency 1 replaces the old
 * in-process single-flight guard.
 */
export class WorkerStack extends Stack {
  readonly workerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.workerFunction = new NodejsFunction(this, 'WorkerFunction', {
      functionName: `AiEquityReportsWorker${config.suffix}`,
      entry: path.join(__dirname, '../../server/lambda/worker.js'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 1024,
      timeout: Duration.minutes(10),
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'WorkerLogs', {
        logGroupName: `/aws/lambda/AiEquityReportsWorker${config.suffix}`,
        retention: logs.RetentionDays.ONE_MONTH,
      }),
      bundling: { minify: false, sourcesContent: false },
      environment: {
        STAGE: config.stage,
        ORDERS_TABLE: props.ordersTable.tableName,
        CATALOG_STATE_TABLE: props.catalogStateTable.tableName,
        REPORT_PDF_BUCKET: props.pdfBucket.bucketName,
        REPORT_PDF_PREFIX: 'reports/pdfs/',
        REPORT_PDF_BASE_URL: config.pdfBaseUrl,
        SECRETS_SSM_PREFIX: config.secretsPrefix,
        SITE_URL: config.siteUrl,
        // Reconciler cadence (plan §2.1): poll the engine inside one
        // invocation (~8 min window, 20 s apart). The first live test render
        // took ~27 min (78 polls) — a real AI research pipeline, not a
        // template fill — so the budget is 150 polls (~50 min) to give slow
        // renders room while still failing hung jobs within the hour.
        RECONCILER_POLL_WINDOW_MS: '480000',
        RECONCILER_POLL_DELAY_MS: '20000',
        RECONCILER_MAX_POLLS: '150',
        EMIT_ORDER_METRICS: 'true',
        // Matches prod-on-the-box today; flip via context when ready.
        FRESH_IMPORT_ENABLED: this.node.tryGetContext('freshImportEnabled') ?? 'false',
        RESALE_ENABLED: this.node.tryGetContext('resaleEnabled') ?? 'false',
        REAPER_DRY_RUN: this.node.tryGetContext('reaperDryRun') ?? 'true',
        ...(config.pdfEngineUrl ? { PDF_ENGINE_URL: config.pdfEngineUrl } : {}),
      },
    });

    // Grants (plan §2.2 item 3): tables, bucket, SES, engine invoke, secrets.
    props.ordersTable.grantReadWriteData(this.workerFunction);
    props.catalogStateTable.grantReadWriteData(this.workerFunction);
    props.pdfBucket.grantReadWrite(this.workerFunction);
    this.workerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));
    if (config.engineFunctionArn) {
      this.workerFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
        resources: [config.engineFunctionArn],
      }));
    }
    this.workerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${config.secretsPrefix}/*`,
      ],
    }));

    // Backstop sweep — what recovers crashed invocations and lost events.
    new events.Rule(this, 'SweepRule', {
      ruleName: `AiEquityReportsWorkerSweep${config.suffix}`,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(this.workerFunction, {
        event: events.RuleTargetInput.fromObject({ action: 'tick', reason: 'sweep' }),
      })],
    });

    // Daily reaper (plan §3: hides expired resales, never deletes).
    new events.Rule(this, 'ReapRule', {
      ruleName: `AiEquityReportsWorkerReap${config.suffix}`,
      schedule: events.Schedule.cron({ minute: '15', hour: '3' }),
      targets: [new eventsTargets.LambdaFunction(this.workerFunction, {
        event: events.RuleTargetInput.fromObject({ action: 'reap' }),
      })],
    });

    // ── alarms (plan §2.3) ──────────────────────────────────────────────────
    const alarmAction = new cloudwatchActions.SnsAction(props.alertsTopic);

    new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
      alarmName: `AiEquityReportsWorkerErrors${config.suffix}`,
      alarmDescription: 'Worker Lambda reported an error in the last 15 minutes',
      metric: this.workerFunction.metricErrors({ period: Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // EMF gauges emitted by reconciler.tick() (server/reconciler.js).
    const orderMetric = (name: string) => new cloudwatch.Metric({
      namespace: 'AiEquityReports',
      metricName: name,
      dimensionsMap: { Stage: config.stage },
      statistic: 'Maximum',
      period: Duration.minutes(15),
    });

    new cloudwatch.Alarm(this, 'OrdersFailedAlarm', {
      alarmName: `AiEquityReportsOrdersFailed${config.suffix}`,
      alarmDescription: 'An order is FAILED (last 24h) — the buyer paid and needs manual handling',
      metric: orderMetric('OrdersFailedRecent'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'OrdersStuckAlarm', {
      alarmName: `AiEquityReportsOrdersStuck${config.suffix}`,
      alarmDescription: 'An order has sat in NEW/IMPORTING for over 30 minutes',
      metric: orderMetric('OrdersStuck'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);
  }
}
