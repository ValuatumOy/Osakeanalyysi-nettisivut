# AiEquityReports infra (CDK)

Serverless backend for aiequityreports.com per `docs/aws-migration-plan.md`.
TypeScript CDK app; **eu-west-1**, same AWS account as pdf-report-engine;
stages `prod` (default) and `test` (`-c stage=test`, suffixing every name with
`-test`).

| Stack | Contents |
|---|---|
| `AiEquityReportsUsEast1` | CloudFront cert for `files.…`, Route53 health check on `/api/health` + "API down" alarm (us-east-1 is mandatory for both) |
| `AiEquityReportsStorage` | S3 PDF bucket, `AiEquityReportsOrders` + `AiEquityReportsCatalogState` DynamoDB tables, SNS alerts topic |
| `AiEquityReportsWorker` | Reconciler/reaper Lambda (reserved concurrency 1), 5-min sweep + daily reap rules, failure/stuck-order alarms |
| `AiEquityReportsApi` | API Lambda + HTTP API at `api.…` (provisioned concurrency 1 in prod), admin route throttling, 401-probe alarm |
| `AiEquityReportsFiles` | CloudFront (OAC) at `files.…` serving the private PDF bucket |

DNS: `aiequityreports.com` is hosted on Route53 in this account — all records
and ACM validations are created by `cdk deploy`; there is no manual DNS step.

## First-time setup

```bash
cd infra && npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/eu-west-1 aws://<ACCOUNT_ID>/us-east-1
```

### Secrets (SSM Parameter Store, SecureString)

CloudFormation cannot create SecureStrings with values, so create them once
per stage by hand (this is the documented home of the env vars — plan §2.2):

```bash
STAGE=test   # or prod
for name in stripe-secret-key catalog-sync-secret wisdom-api-token fmp-import-token admin-upload-password; do
  aws ssm put-parameter --type SecureString --name "/aiequityreports/$STAGE/$name" --value '<VALUE>'
done
```

The Lambdas load these at cold start (`server/aws/secrets.js`). Rotating one:
`put-parameter --overwrite`, then redeploy or wait for containers to recycle.

### Context values

Passed with `-c key=value` (or put in `cdk.context.json`):

| Key | Meaning | Default |
|---|---|---|
| `stage` | `prod` / `test` | `prod` |
| `alertEmail` | SNS alarm subscription | `contact26@valuatum.com` |
| `pdfEngineUrl` | pdf-report-engine Function URL | unset (fresh orders fail loudly) |
| `engineFunctionArn` | engine Lambda ARN for the IAM invoke grant | unset |
| `freshImportEnabled` / `resaleEnabled` / `reaperDryRun` | worker flags | `false` / `false` / `true` |
| `siteUrl` | SITE_URL for emails/links | `https://www.aiequityreports.com` |

## Deploy

```bash
npm run deploy:test    # cdk deploy -c stage=test --all
npm run deploy:prod
```

## One-time migration (plan §5)

1. Copy the box's `reports/pdfs/` locally, then clean + stamp sidecars
   (removes `pdfUrl`, stamps `uploadedAt` from mtimes — required, see plan
   §2.2 item 2):
   `node infra/scripts/stamp-sidecars.mjs /path/to/reports/pdfs`
2. `aws s3 cp /path/to/reports/pdfs "s3://aiequityreports-pdfs<-stage>/reports/pdfs/" --recursive`
3. Import the ledgers:
   `node infra/scripts/import-ledgers.mjs --orders orders.json --state catalog-state.json --stage test`
4. Parity check: diff `GET /api/reports` between the box and the stage API.

At cutover (Phase 3): freeze uploads, re-run steps 2–3 against prod, then flip
Vercel's `CATALOG_API_URL` to `https://api.aiequityreports.com`. Rollback =
flip it back.

## Admin page

Served by Vercel at `/admin` (repo: `admin/index.html`); it talks to this API
with the `admin-upload-password` secret. For the test stage, point it at the
test API from the browser console once:
`localStorage.setItem('aerAdminApiBase', 'https://api-test.aiequityreports.com')`.
