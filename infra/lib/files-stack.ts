import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { StageConfig } from './config';

export interface FilesStackProps extends StackProps {
  config: StageConfig;
  certificate: acm.ICertificate; // us-east-1 (crossRegionReferences)
}

/**
 * Plan §3: the private PDF catalog bucket with CloudFront (OAC) in front,
 * serving permanent, unsigned download URLs at files.aiequityreports.com. No
 * directory listing — the exact link is required, same threat model as the
 * old nginx setup. Bucket and distribution share a stack because the OAC
 * bucket policy ties them together.
 */
export class FilesStack extends Stack {
  readonly pdfBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FilesStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: config.zoneDomain });

    // The catalog: reports/pdfs/<Name>_<ddmmyyyy>.pdf + sidecar JSONs, same
    // flat layout as the box. Private — served only through CloudFront (OAC),
    // written by the worker/admin API, PUT directly by the admin page via
    // presigned URLs (hence the CORS rule). Never auto-deleted (plan §3).
    this.pdfBucket = new s3.Bucket(this, 'PdfBucket', {
      bucketName: `aiequityreports-pdfs${config.suffix}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: config.corsOrigins,
        allowedHeaders: ['content-type'],
        maxAge: 3600,
      }],
    });

    const distribution = new cloudfront.Distribution(this, 'FilesDistribution', {
      comment: `AiEquityReports PDF catalog (${config.stage})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.pdfBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      domainNames: [config.filesDomain],
      certificate: props.certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new route53.ARecord(this, 'FilesAliasRecord', {
      zone,
      recordName: config.filesDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'FilesAliasRecordV6', {
      zone,
      recordName: config.filesDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
  }
}
