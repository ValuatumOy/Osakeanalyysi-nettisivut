import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { StageConfig } from './config';

export interface UsEast1StackProps extends StackProps {
  config: StageConfig;
}

/**
 * Everything that AWS forces into us-east-1:
 *  - the CloudFront certificate for files.aiequityreports.com,
 *  - the Route53 health check on GET /api/health and its alarm (Route53
 *    health-check metrics only exist in us-east-1), with its own small topic
 *    so the "API down" email works even if eu-west-1 is unreachable.
 */
export class UsEast1Stack extends Stack {
  readonly filesCertificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: UsEast1StackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.zoneDomain });

    this.filesCertificate = new acm.Certificate(this, 'FilesCertificate', {
      domainName: config.filesDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Outside-in "API down" detection.
    const healthCheck = new route53.CfnHealthCheck(this, 'ApiHealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: config.apiDomain,
        resourcePath: '/api/health',
        port: 443,
        requestInterval: 30,
        failureThreshold: 3,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: `AiEquityReportsApiHealth${config.suffix}` }],
    });

    const topic = new sns.Topic(this, 'HealthAlertsTopic', {
      topicName: `AiEquityReportsHealthAlerts${config.suffix}`,
    });
    // Only page a human for prod alarms — test-stage noise stays unsubscribed.
    if (config.stage === 'prod') {
      topic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    }

    const healthMetric = new cloudwatch.Metric({
      namespace: 'AWS/Route53',
      metricName: 'HealthCheckStatus',
      dimensionsMap: { HealthCheckId: healthCheck.attrHealthCheckId },
      statistic: 'Minimum',
      period: Duration.minutes(1),
    });

    new cloudwatch.Alarm(this, 'ApiDownAlarm', {
      alarmName: `AiEquityReportsApiDown${config.suffix}`,
      alarmDescription: `${config.apiDomain}/api/health is failing from Route53 health checkers`,
      metric: healthMetric,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic));
  }
}
