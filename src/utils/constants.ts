// Derived at runtime from config — kept here to avoid circular imports.
// The real values live in src/config.ts; these are defaults used in tests or
// as fallback documentation.

export const SERVICE_PREFIX = 'tangent-';
export const TASK_FAMILY_PREFIX = 'tangent-';

/**
 * Safety guard — Tangent will ONLY ever operate on this ECS cluster.
 * Any operation targeting a different cluster will throw before hitting AWS.
 */
export const ALLOWED_CLUSTER     = 'tangent';
export const ALLOWED_CLUSTER_ARN = 'arn:aws:ecs:us-east-1:307048237966:cluster/tangent';
export const NGROK_IMAGE = 'ngrok/ngrok:latest';

/** How long (ms) to poll CloudWatch for the ngrok tunnel URL.
 *  With minimumHealthyPercent=0, ECS stops the old task first, which can take
 *  30-60s before the new task starts. Give it 3 minutes total. */
export const DEFAULT_TUNNEL_TIMEOUT_MS = 180_000;

/** How frequently to poll during tunnel wait (ms). */
export const TUNNEL_POLL_INTERVAL_MS = 5_000;

/** How frequently to HTTP-poll the ngrok URL directly (ms). */
export const TUNNEL_HTTP_POLL_INTERVAL_MS = 2_000;

/** How long to wait for ECS tasks to drain during teardown (ms). */
export const TEARDOWN_DRAIN_TIMEOUT_MS = 60_000;

/** Health-check: alert if service has been degraded for this long (ms). */
export const DEGRADED_ALERT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Docker build/push timeout (ms). */
export const DOCKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Git clone timeout (ms). */
export const GIT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
