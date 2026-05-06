/**
 * services/aws.ts
 *
 * Initializes and exports AWS SDK clients.
 * All clients are singletons — call initAwsClients() once at startup.
 */

import { ECSClient } from '@aws-sdk/client-ecs';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EC2Client } from '@aws-sdk/client-ec2';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config.js';

let _ecs: ECSClient | null = null;
let _ecr: ECRClient | null = null;
let _ec2: EC2Client | null = null;
let _sm: SecretsManagerClient | null = null;
let _cwl: CloudWatchLogsClient | null = null;

export function initAwsClients(): void {
  const { awsRegion } = config();
  _ecs = new ECSClient({ region: awsRegion });
  _ecr = new ECRClient({ region: awsRegion });
  _ec2 = new EC2Client({ region: awsRegion });
  _sm = new SecretsManagerClient({ region: awsRegion });
  _cwl = new CloudWatchLogsClient({ region: awsRegion });
}

export function ecsClient(): ECSClient {
  if (!_ecs) throw new Error('AWS clients not initialized — call initAwsClients() first');
  return _ecs;
}

export function ecrClient(): ECRClient {
  if (!_ecr) throw new Error('AWS clients not initialized — call initAwsClients() first');
  return _ecr;
}

export function ec2Client(): EC2Client {
  if (!_ec2) throw new Error('AWS clients not initialized — call initAwsClients() first');
  return _ec2;
}

export function smClient(): SecretsManagerClient {
  if (!_sm) throw new Error('AWS clients not initialized — call initAwsClients() first');
  return _sm;
}

export function cwlClient(): CloudWatchLogsClient {
  if (!_cwl) throw new Error('AWS clients not initialized — call initAwsClients() first');
  return _cwl;
}
