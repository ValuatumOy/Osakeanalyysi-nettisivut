import { App } from 'aws-cdk-lib';

export interface StageConfig {
  /** 'prod' | 'test' — selected with `-c stage=test`; prod is the default. */
  stage: string;
  /** '' for prod, '-test' for test — appended to stack/table/bucket/domain names. */
  suffix: string;
  zoneDomain: string;
  apiDomain: string;
  filesDomain: string;
  /** Members API (test-only stack for now), e.g. members-test.aiequityreports.com. */
  membersApiDomain: string;
  /** REPORT_PDF_BASE_URL for the Lambdas. */
  pdfBaseUrl: string;
  /**
   * The catalog members browse is ALWAYS production's, whatever stage the
   * members stack runs in: an analyst picking a report to build on must see the
   * reports the public site sells, not a stale test bucket. Read-only —
   * the members Lambda never writes catalog state.
   */
  memberCatalogBucket: string;
  memberCatalogStateTable: string;
  /** Origins allowed to call the API / PUT to the bucket (site + local dev). */
  corsOrigins: string[];
  siteUrl: string;
  alertEmail: string;
  /** SSM SecureString prefix, e.g. /aiequityreports/prod (see infra/README.md). */
  secretsPrefix: string;
  /** pdf-report-engine Lambda: function URL + function ARN for IAM-auth invoke. */
  pdfEngineUrl?: string;
  engineFunctionArn?: string;
  /**
   * FMP_IMPORT_URL for the worker: the Trunk whose model the stage's engine
   * reads (prod engine → Wisdom, test engine → trunkdev). Pointing test at
   * Wisdom imported into production and left the model the test report reads
   * untouched (GOOGL, 23 October 2026).
   */
  fmpImportUrl: string;
  /**
   * ENGINE_FID_BY_TICKER for the worker: tickers whose report is rendered from
   * a pinned Trunk model rather than the engine's default (FMP) model. The fids
   * belong to the stage's Trunk, so the map is per stage. UPM.HE: statements
   * imported into its `ValuatumData` model, 28 October 2026.
   */
  engineFidByTicker: Record<string, number>;
}

export function stageConfig(app: App): StageConfig {
  const stage = app.node.tryGetContext('stage') ?? 'prod';
  if (!['prod', 'test'].includes(stage)) {
    throw new Error(`Unknown stage "${stage}" — use -c stage=prod or -c stage=test`);
  }
  const suffix = stage === 'prod' ? '' : `-${stage}`;
  const zoneDomain = 'aiequityreports.com';

  // pdf-report-engine (same account): each stage talks to its own engine
  // stage. Overridable with -c pdfEngineUrl=… / -c engineFunctionArn=….
  const engine = stage === 'prod'
    ? {
        url: 'https://jdnrhdk37rmqzayy2km4jyrlgq0uapaw.lambda-url.eu-west-1.on.aws',
        arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api',
      }
    : {
        url: 'https://7zqqrejifzqphtwfb2imxtn67q0yzekq.lambda-url.eu-west-1.on.aws',
        arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api-test',
      };
  // The Trunk each engine stage reads (pdf-report-engine secret
  // `pdf-report<-test>/customers/Wisdom`); the FMP import must go to the same one.
  const trunkRest = stage === 'prod' ? 'https://wisdom.valuatum.com/rest' : 'https://trunkdev.valuatum.com/rest';

  // Every other stage-dependent URL below uses `suffix` and defaults
  // correctly per stage; this one didn't, and a `stage=test` deploy that
  // forgot the `-c siteUrl=…` override silently fell back to prod's
  // domain — baking a prod link into test's emails and checkout redirects.
  const siteUrl = app.node.tryGetContext('siteUrl') ?? (stage === 'prod' ? `https://www.${zoneDomain}` : `https://test.${zoneDomain}`);

  return {
    stage,
    suffix,
    zoneDomain,
    apiDomain: `api${suffix}.${zoneDomain}`,
    filesDomain: `files${suffix}.${zoneDomain}`,
    membersApiDomain: `members${suffix}.${zoneDomain}`,
    pdfBaseUrl: `https://files${suffix}.${zoneDomain}/reports/pdfs`,
    memberCatalogBucket: 'aiequityreports-pdfs',
    memberCatalogStateTable: 'AiEquityReportsCatalogState',
    // Derived from `siteUrl` (not hardcoded to prod's domains) so the stage
    // actually serving the frontend is always an allowed CORS origin — this
    // had the same non-stage-aware bug siteUrl did, just silent instead of
    // link-visible: test's API/PDF bucket only ever allowed prod's domains.
    corsOrigins: [
      siteUrl,
      ...(stage === 'prod' ? [`https://${zoneDomain}`] : []),
      'http://localhost:3000',
      // The static-site preview, which is where the admin dashboard is driven
      // against the test stage.
      'http://localhost:3100',
    ],
    siteUrl,
    alertEmail: app.node.tryGetContext('alertEmail') ?? 'awswatchdog@valuatum.com',
    secretsPrefix: `/aiequityreports/${stage}`,
    pdfEngineUrl: app.node.tryGetContext('pdfEngineUrl') ?? engine.url,
    engineFunctionArn: app.node.tryGetContext('engineFunctionArn') ?? engine.arn,
    fmpImportUrl: app.node.tryGetContext('fmpImportUrl') ?? `${trunkRest}/dataimport`,
    engineFidByTicker: stage === 'prod' ? { 'UPM.HE': 20798 } : {},
  };
}
