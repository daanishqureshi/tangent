/**
 * utils/safety.ts
 *
 * Hard safety guardrails for all AWS operations.
 *
 * Rules:
 *   1. Tangent may ONLY operate on the "tangent" ECS cluster.
 *      Any call targeting a different cluster throws before reaching AWS.
 *
 *   2. Tangent NEVER deletes anything. No DeleteService, no
 *      DeregisterTaskDefinition, no BatchDeleteImage. Teardown = scale to 0.
 *
 *   3. All destructive actions (deploy, teardown) require explicit confirmation
 *      from the user before executing. See the confirmation store in slack-bot.ts.
 */

import { ALLOWED_CLUSTER, ALLOWED_CLUSTER_ARN } from './constants.js';
import { logger } from './logger.js';

/**
 * Call this before every ECS operation. Throws if the cluster is not the
 * allowed one so the AWS call never fires.
 */
export function assertAllowedCluster(cluster: string): void {
  if (cluster === ALLOWED_CLUSTER || cluster === ALLOWED_CLUSTER_ARN) return;

  const msg = `🚫 Safety guard: refusing to operate on cluster "${cluster}". Tangent only touches the "${ALLOWED_CLUSTER}" cluster.`;
  logger.error({ action: 'safety:cluster_guard_tripped', cluster }, msg);
  throw new Error(msg);
}
