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
// The staging branch's own Vercel URL. Named once because both the CORS list
// and the auth return allowlist need it whenever another branch's preview is
// holding the test.aiequityreports.com alias.
const STAGING_BRANCH_ORIGIN = 'https://osakeanalyysi-nettisivut-git-staging-valuatum-dk.vercel.app';

export class MembersStack extends Stack {
  constructor(scope: Construct, id: string, props: MembersStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Prod guard lifted 20.8.2026: the engine's revision feature is live in
    // production, which was the gate (docs/members-test.md).

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

    // The member-facing catalog is production's, in every stage. Imported by
    // name and read-only: nothing here writes to a production resource, and on
    // the prod stage these resolve to the same bucket/table props carry anyway.
    const catalogBucket = s3.Bucket.fromBucketName(
      this, 'MemberCatalogBucket', config.memberCatalogBucket);
    const catalogStateTable = dynamodb.Table.fromTableName(
      this, 'MemberCatalogStateTable', config.memberCatalogStateTable);

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
        // Always production's catalog, whatever stage this is: an analyst must
        // pick from the reports the public site actually sells (see config.ts).
        CATALOG_STATE_TABLE: catalogStateTable.tableName,
        // Membership generations run through the same order pipeline as paid
        // fresh reports: create the order, wake the worker, the reconciler does
        // the rest.
        ORDERS_TABLE: props.ordersTable.tableName,
        WORKER_FUNCTION_NAME: props.workerFunction.functionName,
        REPORT_PDF_BUCKET: catalogBucket.bucketName,
        REPORT_PDF_PREFIX: 'reports/pdfs/',
        REPORT_PDF_BASE_URL: config.memberCatalogPdfBaseUrl,
        // This stage's own bucket, where the reconciler delivers what members
        // generate. Those PDFs are never in the production catalog listing, so
        // they are presigned straight from the order's pdfFileName.
        GENERATED_PDF_BUCKET: props.pdfBucket.bucketName,
        SECRETS_SSM_PREFIX: config.secretsPrefix,
        // Allowances are demand-tuned (Esa, 17.8.2026): overriding this variable
        // changes the three numbers per role/tier without a code change. Empty
        // means the defaults in server/members/tiers.js.
        MEMBERS_LIMITS_JSON: process.env.MEMBERS_LIMITS_JSON || '',
        SITE_URL: config.siteUrl,
        MEMBERS_API_URL: membersApiUrl,
        // Auth redirects may return to any of these; the first is the default.
        // Anything not on this list is rejected (open-redirect guard).
        // The FIRST entry is the fallback for a rejected/missing returnTo, so
        // it must be this stage's own site — a prod error page must never land
        // on the test domain. The store page is a valid return target too: the
        // anonymous buy flow returns there to hand over the purchased PDF.
        MEMBERS_FRONTEND_URLS: [...new Set([
          `${config.siteUrl}/members.html`,
          `${config.siteUrl}/report-store.html`,
          `https://${config.zoneDomain}/members.html`, // apex — the site answers on both
          `https://${config.zoneDomain}/report-store.html`,
          `https://test.${config.zoneDomain}/members.html`,
          `https://test.${config.zoneDomain}/report-store.html`,
          'http://localhost:3100/members.html',
          // Same reason as the CORS entry: another branch's preview can hold the
          // test.aiequityreports.com alias, and without this a sign-in started
          // on the staging branch URL returns to whatever that alias points at.
          ...(config.stage === 'prod' ? [] : [
            `${STAGING_BRANCH_ORIGIN}/members.html`,
            `${STAGING_BRANCH_ORIGIN}/report-store.html`,
          ]),
        ])].join(','),
        // Fixed fee per published analysis. 0 until the business decision lands,
        // so the ledger records states without promising anyone money.
        BOUNTY_EUR_PER_REPORT: process.env.BOUNTY_EUR_PER_REPORT || '0',
        // What one read by a paying subscriber pays the analyst who wrote it.
        SUBSCRIBER_READ_EUR: process.env.SUBSCRIBER_READ_EUR || '0.5',
      },
    });

    membersTable.grantReadWriteData(membersFunction);
    catalogStateTable.grantReadData(membersFunction);
    catalogBucket.grantRead(membersFunction); // presigned GETs for entitled opens
    props.pdfBucket.grantRead(membersFunction); // this stage's own generations
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
        // Deduped: siteUrl is stage-aware and equals the test entry on test.
        allowOrigins: [...new Set([
          'http://localhost:3000',
          'http://localhost:3100',
          config.siteUrl,
          `https://${config.zoneDomain}`, // apex — the site answers on both
          `https://test.${config.zoneDomain}`, // staging branch site
          // test.aiequityreports.com is a Vercel alias and another branch's
          // preview can hold it, which leaves the staging site reachable only
          // by its own branch URL. Non-prod only.
          ...(config.stage === 'prod' ? [] : [STAGING_BRANCH_ORIGIN]),
        ])],
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
      [apigwv2.HttpMethod.GET, '/analyses'],
      [apigwv2.HttpMethod.GET, '/me'],
      [apigwv2.HttpMethod.GET, '/me/earnings'],
      [apigwv2.HttpMethod.POST, '/me/role'],
      [apigwv2.HttpMethod.POST, '/analyses/{genId}/open'],
      [apigwv2.HttpMethod.POST, '/analyses/{genId}/review'],
      [apigwv2.HttpMethod.POST, '/analyses/{genId}/review/edit'],
      [apigwv2.HttpMethod.GET, '/reviews/mine'],
      [apigwv2.HttpMethod.POST, '/reports/{id}/open'],
      [apigwv2.HttpMethod.POST, '/generations/free'],
      // A bought generation: the Stripe receipt becomes a running order.
      [apigwv2.HttpMethod.POST, '/generations/fresh'],
      [apigwv2.HttpMethod.POST, '/generations/coverage'],
      [apigwv2.HttpMethod.GET, '/generations'],
      [apigwv2.HttpMethod.GET, '/generations/{genId}'],
      // The order page's revision workspace, for a member's own run.
      [apigwv2.HttpMethod.GET, '/generations/{genId}/order'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/revisions'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/submit'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/price'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/prompts-public'],
      [apigwv2.HttpMethod.POST, '/generations/{genId}/revisions-checkout'],
      [apigwv2.HttpMethod.POST, '/me/linkedin'],
      [apigwv2.HttpMethod.POST, '/billing/checkout'],
      [apigwv2.HttpMethod.POST, '/billing/fresh-checkout'],
      [apigwv2.HttpMethod.POST, '/billing/topup-checkout'],
      [apigwv2.HttpMethod.POST, '/billing/webhook'],
      [apigwv2.HttpMethod.GET, '/analyses/{genId}/free'],
      [apigwv2.HttpMethod.POST, '/analyses/{genId}/buy-checkout'],
      [apigwv2.HttpMethod.POST, '/analyses/{genId}/fork-checkout'],
      [apigwv2.HttpMethod.GET, '/analyses/{genId}/purchased'],
      [apigwv2.HttpMethod.GET, '/admin/members/publications'],
      [apigwv2.HttpMethod.GET, '/admin/members/earnings'],
      [apigwv2.HttpMethod.POST, '/admin/members/grant-generation'],
      [apigwv2.HttpMethod.POST, '/admin/members/role'],
      [apigwv2.HttpMethod.POST, '/admin/members/feature'],
      [apigwv2.HttpMethod.POST, '/admin/members/takedown'],
      [apigwv2.HttpMethod.POST, '/admin/members/reopen'],
      [apigwv2.HttpMethod.POST, '/admin/members/payout'],
      [apigwv2.HttpMethod.POST, '/admin/members/ban'],
      [apigwv2.HttpMethod.POST, '/test/users'],
      [apigwv2.HttpMethod.POST, '/test/force-publish'],
      [apigwv2.HttpMethod.POST, '/test/publications'],
      [apigwv2.HttpMethod.POST, '/test/sales'],
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
    // The one route that mints a signed S3 URL with no account behind it. The
    // document is free by design, but presigning is Lambda and S3 cost on
    // demand, so it gets a lid of its own — looser than the secret-bearing
    // routes, tighter than the default.
    // Unauthenticated routes that cost money to serve: presigning S3 URLs and
    // creating Stripe sessions. Looser than the secret-bearing routes, tighter
    // than the default.
    const publicPaid = [
      'GET /analyses/{genId}/free',
      'POST /analyses/{genId}/buy-checkout',
      'GET /analyses/{genId}/purchased',
    ];
    cfnStage.routeSettings = {
      ...Object.fromEntries(
        routes
          .filter(([, routePath]) => throttled(routePath))
          .map(([method, routePath]) => [
            `${method} ${routePath}`,
            { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
          ]),
      ),
      ...Object.fromEntries(publicPaid.map((route) =>
        [route, { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 }])),
    };

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
