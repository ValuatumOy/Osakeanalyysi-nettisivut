#!/usr/bin/env node
// AiEquityReports backend infra (docs/aws-migration-plan.md). Same AWS account
// as pdf-report-engine, eu-west-1, stage selected with `-c stage=test`
// (default prod). Deploy order is handled by CDK via the stack dependencies:
// UsEast1 (certs/health) → Storage → Worker → Api → Files.
import { App } from 'aws-cdk-lib';
import { stageConfig } from '../lib/config';
import { StorageStack } from '../lib/storage-stack';
import { UsEast1Stack } from '../lib/us-east-1-stack';
import { FilesStack } from '../lib/files-stack';
import { WorkerStack } from '../lib/worker-stack';
import { ApiStack } from '../lib/api-stack';

const app = new App();
const config = stageConfig(app);

const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error('CDK_DEFAULT_ACCOUNT is not set — run with AWS credentials (aws sso login / aws-vault)');
}

const euWest1 = { account, region: 'eu-west-1' };
const usEast1 = { account, region: 'us-east-1' };

const usEast1Stack = new UsEast1Stack(app, `AiEquityReportsUsEast1${config.suffix}`, {
  env: usEast1,
  crossRegionReferences: true,
  config,
});

const storage = new StorageStack(app, `AiEquityReportsStorage${config.suffix}`, {
  env: euWest1,
  config,
});

const files = new FilesStack(app, `AiEquityReportsFiles${config.suffix}`, {
  env: euWest1,
  crossRegionReferences: true,
  config,
  certificate: usEast1Stack.filesCertificate,
});

const worker = new WorkerStack(app, `AiEquityReportsWorker${config.suffix}`, {
  env: euWest1,
  config,
  ordersTable: storage.ordersTable,
  catalogStateTable: storage.catalogStateTable,
  pdfBucket: files.pdfBucket,
  alertsTopic: storage.alertsTopic,
});

new ApiStack(app, `AiEquityReportsApi${config.suffix}`, {
  env: euWest1,
  config,
  ordersTable: storage.ordersTable,
  catalogStateTable: storage.catalogStateTable,
  pdfBucket: files.pdfBucket,
  alertsTopic: storage.alertsTopic,
  workerFunction: worker.workerFunction,
});
