import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
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

export interface MembersStackProps extends StackProps {
  config: StageConfig;
  catalogStateTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  pdfBucket: s3.IBucket;
  alertsTopic: sns.ITopic;
  workerFunction: lambda.IFunction;
}

/**
 * Membership / subscription system (LinkedIn freemium for analysts, magic-link
 * subscribers, monthly quotas, presigned download gate). Deliberately its own
 * stack + Lambda so nothing here ships with the prod API. Test stage only for
 * now — the bin only instantiates it for non-prod, and the constructor guard
 * makes a prod deploy a hard error.
 */
export class MembersStack extends Stack {
  constructor(scope: Construct, id: string, props: MembersStackProps) {
    super(scope, id, props);
    const { config } = props;

    if (config.stage === 'prod') {
      throw new Error('MembersStack must not deploy to prod yet — test stage only');
    }

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.zoneDomain });

    // Single table, pk/sk. Item kinds: USER#/PROFILE, EMAIL#|LINKEDIN#|STRIPECUST#/IDENTITY,
    // MAGIC#/TOKEN, USER#/USAGE#<YYYY-MM>, USER#/ENT#<reportId>, USER#/PUB#<genId>,
    // STRIPEEVT#/EVT, USER#/AUDIT#. DESTROY: test data, no orphans on stack delete.
    const membersTable = new dynamodb.Table(this, 'MembersTable', {
      tableName: `AiEquityReportsMembers${config.suffix}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const membersApiUrl = `https://${config.membersApiDomain}`;

    const membersFunction = new NodejsFunction(this, 'MembersFunction', {
      functionName: `AiEquityReportsMembers${config.suffix}`,
      entry: path.join(__dirname, '../../server/lambda/members.js'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(28),
      logGroup: new logs.LogGroup(this, 'MembersLogs', {
        logGroupName: `/aws/lambda/AiEquityReportsMembers${config.suffix}`,
        retention: logs.RetentionDays.ONE_MONTH,
      }),
      bundling: { minify: false, sourcesContent: false },
      environment: {
        STAGE: config.stage,
        MEMBERS_TABLE: membersTable.tableName,
        CATALOG_STATE_TABLE: props.catalogStateTable.tableName,
        // Membership generations run through the same order pipeline as paid
        // fresh reports: create the order, wake the worker, the reconciler does
        // the rest.
        ORDERS_TABLE: props.ordersTable.tableName,
        WORKER_FUNCTION_NAME: props.workerFunction.functionName,
        REPORT_PDF_BUCKET: props.pdfBucket.bucketName,
        REPORT_PDF_PREFIX: 'reports/pdfs/',
        REPORT_PDF_BASE_URL: config.pdfBaseUrl,
        SECRETS_SSM_PREFIX: config.secretsPrefix,
        SITE_URL: config.siteUrl,
        MEMBERS_API_URL: membersApiUrl,
        // Auth redirects may return to any of these; the first is the default.
        // Anything not on this list is rejected (open-redirect guard).
        MEMBERS_FRONTEND_URLS: [
          `https://test.${config.zoneDomain}/members.html`,
          `${config.siteUrl}/members.html`,
          'http://localhost:3100/members.html',
        ].join(','),
        // Fixed fee per published analysis. 0 until the business decision lands,
        // so the ledger records states without promising anyone money.
        BOUNTY_EUR_PER_REPORT: process.env.BOUNTY_EUR_PER_REPORT || '0',
      },
    });

    membersTable.grantReadWriteData(membersFunction);
    props.catalogStateTable.grantReadData(membersFunction);
    props.pdfBucket.grantRead(membersFunction); // presigned GETs for entitled opens
    // Create-only in practice: the worker owns order state transitions.
    props.ordersTable.grantReadWriteData(membersFunction);
    props.workerFunction.grantInvoke(membersFunction);
    membersFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));
    membersFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${config.secretsPrefix}/*`,
      ],
    }));

    const integration = new HttpLambdaIntegration('MembersIntegration', membersFunction);

    // Own narrow CORS — do NOT reuse config.corsOrigins (contains prod origins).
    const httpApi = new apigwv2.HttpApi(this, 'MembersHttpApi', {
      apiName: `AiEquityReportsMembers${config.suffix}`,
      corsPreflight: {
        allowOrigins: [
          'http://localhost:3000',
          'http://localhost:3100',
          config.siteUrl,
          `https://${config.zoneDomain}`, // apex — the site answers on both
          `https://test.${config.zoneDomain}`, // staging branch site
        ],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type', 'x-test-now'],
        maxAge: Duration.days(1),
      },
    });

    const routes: Array<[apigwv2.HttpMethod, string]> = [
      [apigwv2.HttpMethod.GET, '/health'],
      [apigwv2.HttpMethod.GET, '/reports'],
      [apigwv2.HttpMethod.GET, '/auth/linkedin/start'],
      [apigwv2.HttpMethod.GET, '/auth/linkedin/callback'],
      [apigwv2.HttpMethod.POST, '/auth/magic-link'],
      [apigwv2.HttpMethod.GET, '/auth/magic/verify'],
      [apigwv2.HttpMethod.GET, '/me'],
      [apigwv2.HttpMethod.GET, '/me/earnings'],
      [apigwv2.HttpMethod.POST, '/reports/{id}/open'],
      [apigwv2.HttpMethod.POST, '/generations/free'],
      [apigwv2.HttpMethod.GET, '/generations/{genId}'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/submit'],
      [apigwv2.HttpMethod.POST, '/billing/checkout'],
      [apigwv2.HttpMethod.POST, '/billing/fresh-checkout'],
      [apigwv2.HttpMethod.POST, '/billing/webhook'],
      [apigwv2.HttpMethod.POST, '/admin/members/takedown'],
      [apigwv2.HttpMethod.POST, '/admin/members/payout'],
      [apigwv2.HttpMethod.POST, '/admin/members/ban'],
      [apigwv2.HttpMethod.POST, '/test/users'],
      [apigwv2.HttpMethod.POST, '/test/force-publish'],
      [apigwv2.HttpMethod.POST, '/test/publications'],
    ];
    const createdRoutes: apigwv2.HttpRoute[] = [];
    for (const [method, routePath] of routes) {
      createdRoutes.push(...httpApi.addRoutes({ path: routePath, methods: [method], integration }));
    }

    // Same throttle pattern as ApiStack: sane default, tight lid on the
    // brute-forceable routes (magic link spam, admin/test secrets).
    const cfnStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };
    for (const route of createdRoutes) {
      cfnStage.addDependency(route.node.defaultChild as apigwv2.CfnRoute);
    }
    const throttled = (routePath: string) =>
      routePath.startsWith('/admin/') || routePath.startsWith('/test/') || routePath.startsWith('/auth/magic');
    cfnStage.routeSettings = Object.fromEntries(
      routes
        .filter(([, routePath]) => throttled(routePath))
        .map(([method, routePath]) => [
          `${method} ${routePath}`,
          { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
        ]),
    );

    const certificate = new acm.Certificate(this, 'MembersCertificate', {
      domainName: config.membersApiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const domain = new apigwv2.DomainName(this, 'MembersDomain', {
      domainName: config.membersApiDomain,
      certificate,
    });

    new apigwv2.ApiMapping(this, 'MembersMapping', {
      api: httpApi,
      domainName: domain,
      stage: httpApi.defaultStage!,
    });

    new route53.ARecord(this, 'MembersAliasRecord', {
      zone,
      recordName: config.membersApiDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId),
      ),
    });

    new cloudwatch.Alarm(this, 'MembersErrorsAlarm', {
      alarmName: `AiEquityReportsMembersErrors${config.suffix}`,
      alarmDescription: 'Members Lambda is erroring',
      metric: membersFunction.metricErrors({ period: Duration.minutes(15), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.alertsTopic));
  }
}
