// Lazily-constructed AWS SDK clients for the Lambda runtime. Credentials come
// from the function role via the default provider chain; region from
// AWS_REGION (set by Lambda). Everything is created on first use so requiring
// this module on the box (where the SDK packages are absent from
// server/node_modules) never happens — callers only require server/aws/* when
// the corresponding env vars (ORDERS_TABLE, REPORT_PDF_BUCKET, …) are set.

let docClient;
let s3Client;
let ssmClient;
let lambdaClient;

function dynamo() {
  if (!docClient) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

function s3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
}

function ssm() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

function lambda() {
  if (!lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    lambdaClient = new LambdaClient({});
  }
  return lambdaClient;
}

module.exports = { dynamo, s3, ssm, lambda };
