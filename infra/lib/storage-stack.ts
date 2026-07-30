import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { StageConfig } from './config';

export interface StorageStackProps extends StackProps {
  config: StageConfig;
}

/**
 * Plan §2: the two DynamoDB ledgers (§2.2.1) and the SNS alerts topic every
 * alarm publishes to. (The PDF bucket lives in AiEquityReportsFiles with its
 * CloudFront distribution — the OAC bucket policy forces them together.)
 */
export class StorageStack extends Stack {
  readonly ordersTable: dynamodb.Table;
  readonly catalogStateTable: dynamodb.Table;
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Order ledger (replaces server/data/orders.json). PK = Stripe checkout
    // session id. The API only creates (conditional put), the worker only
    // updates — no shared-object write races (plan §2.2.1).
    this.ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: `AiEquityReportsOrders${config.suffix}`,
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Purchase ledger + weekly free rotation (replaces catalog-state.json).
    // Items: PURCHASE#<sessionId> (TTL at +366d) and WEEK#<isoWeek>.
    this.catalogStateTable = new dynamodb.Table(this, 'CatalogStateTable', {
      tableName: `AiEquityReportsCatalogState${config.suffix}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `AiEquityReportsAlerts${config.suffix}`,
    });
    // Only page a human for prod alarms — test-stage noise stays unsubscribed.
    if (config.stage === 'prod') {
      this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    }
  }
}
