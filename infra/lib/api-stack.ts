import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { StageConfig } from './config';

export interface ApiStackProps extends StackProps {
  config: StageConfig;
  ordersTable: dynamodb.ITable;
  catalogStateTable: dynamodb.ITable;
  pdfBucket: s3.IBucket;
  alertsTopic: sns.ITopic;
  workerFunction: lambda.IFunction;
}

/**
 * One NodejsFunction behind an API Gateway HTTP API at
 * api.aiequityreports.com. Provisioned concurrency 1 in prod (the company
 * search picker is interactive). Admin routes are throttled.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.zoneDomain });

    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      functionName: `AiEquityReportsApi${config.suffix}`,
      entry: path.join(__dirname, '../../server/lambda/api.js'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(28),
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        logGroupName: `/aws/lambda/AiEquityReportsApi${config.suffix}`,
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
        WORKER_FUNCTION_NAME: props.workerFunction.functionName,
        // The order page's text editor asks this API for the rendered report
        // (GET /api/orders/{id}/preview), which reads the job from the engine.
        // Rendering itself stays with the worker; this is a read.
        ...(config.pdfEngineUrl ? { PDF_ENGINE_URL: config.pdfEngineUrl } : {}),
      },
    });

    props.ordersTable.grantReadWriteData(apiFunction);
    props.catalogStateTable.grantReadWriteData(apiFunction);
    props.pdfBucket.grantReadWrite(apiFunction);
    props.workerFunction.grantInvoke(apiFunction);
    // Admin alert emails from the API's error paths (server/email.js).
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));
    if (config.engineFunctionArn) {
      apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
        resources: [config.engineFunctionArn],
      }));
    }
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${config.secretsPrefix}/*`,
      ],
    }));

    // Provisioned concurrency needs a published version; route traffic
    // through the alias so the warm instance is the one serving requests.
    const alias = new lambda.Alias(this, 'ApiLiveAlias', {
      aliasName: 'live',
      version: apiFunction.currentVersion,
      ...(config.stage === 'prod' ? { provisionedConcurrentExecutions: 1 } : {}),
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', alias);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `AiEquityReportsApi${config.suffix}`,
      corsPreflight: {
        allowOrigins: config.corsOrigins,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.days(1),
      },
    });

    const routes: Array<[apigwv2.HttpMethod, string]> = [
      [apigwv2.HttpMethod.GET, '/api/health'],
      [apigwv2.HttpMethod.GET, '/api/reports'],
      [apigwv2.HttpMethod.GET, '/api/reports/{id}'],
      [apigwv2.HttpMethod.GET, '/api/pricing'],
      [apigwv2.HttpMethod.GET, '/api/search-companies'],
      [apigwv2.HttpMethod.POST, '/api/report-purchases'],
      [apigwv2.HttpMethod.POST, '/api/report-download'],
      [apigwv2.HttpMethod.GET, '/api/orders/{id}'],
      [apigwv2.HttpMethod.POST, '/api/orders/{id}/revisions'],
      [apigwv2.HttpMethod.POST, '/api/orders/{id}/edits'],
      [apigwv2.HttpMethod.GET, '/api/orders/{id}/preview'],
      [apigwv2.HttpMethod.GET, '/api/admin/reports'],
      [apigwv2.HttpMethod.GET, '/api/admin/orders/{id}'],
      [apigwv2.HttpMethod.POST, '/api/admin/upload-url'],
      [apigwv2.HttpMethod.POST, '/api/admin/publish'],
      [apigwv2.HttpMethod.POST, '/api/admin/update'],
      [apigwv2.HttpMethod.POST, '/api/admin/delete'],
    ];
    const createdRoutes: apigwv2.HttpRoute[] = [];
    for (const [method, routePath] of routes) {
      createdRoutes.push(...httpApi.addRoutes({ path: routePath, methods: [method], integration }));
    }

    // Stage-level default throttle plus a tight lid on the admin routes
    // (slow any brute force against the shared password).
    const cfnStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };
    // The stage's RouteSettings reference route keys, so the routes must
    // exist before the stage is created/updated — make the ordering explicit.
    for (const route of createdRoutes) {
      cfnStage.addDependency(route.node.defaultChild as apigwv2.CfnRoute);
    }

    // Raw CFN JSON (escape hatch) — keys must be PascalCase here, unlike the
    // typed defaultRouteSettings above.
    cfnStage.routeSettings = Object.fromEntries(
      routes
        .filter(([, routePath]) => routePath.startsWith('/api/admin/'))
        .map(([method, routePath]) => [
          `${method} ${routePath}`,
          { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
        ]),
    );

    // Custom domain: cert + record are both in the hosted zone (Route53 in
    // this account), fully CDK-managed — no manual DNS step.
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: config.apiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const domain = new apigwv2.DomainName(this, 'ApiDomain', {
      domainName: config.apiDomain,
      certificate,
    });

    new apigwv2.ApiMapping(this, 'ApiMapping', {
      api: httpApi,
      domainName: domain,
      stage: httpApi.defaultStage!,
    });

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone,
      recordName: config.apiDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId),
      ),
    });

    // Repeated admin 401s (EMF metric from the API handler) → email.
    new cloudwatch.Alarm(this, 'AdminUnauthorizedAlarm', {
      alarmName: `AiEquityReportsAdminUnauthorized${config.suffix}`,
      alarmDescription: 'Repeated failed admin logins — someone is probing the admin password',
      metric: new cloudwatch.Metric({
        namespace: 'AiEquityReports',
        metricName: 'AdminUnauthorized',
        dimensionsMap: { Stage: config.stage },
        statistic: 'Sum',
        period: Duration.minutes(15),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.alertsTopic));
  }
}
