/**
 * pm2.config.cjs — PM2 ecosystem file for Tangent
 *
 * Usage:
 *   pm2 start pm2.config.cjs
 *   pm2 restart tangent
 *   pm2 logs tangent
 */

module.exports = {
  apps: [
    {
      name: 'tangent',
      script: 'dist/index.js',
      cwd: '/home/ubuntu/tangent',
      env_file: '/home/ubuntu/tangent/.env',

      // Interpreter — Node.js ESM requires no additional flags in Node 24
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',

      // Restart policy
      max_restarts: 10,
      restart_delay: 5000,     // 5s between restarts
      min_uptime: 10000,       // must stay up 10s to count as a successful start

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      out_file: '/home/ubuntu/tangent/logs/tangent.out.log',
      error_file: '/home/ubuntu/tangent/logs/tangent.err.log',

      // Crash recovery
      autorestart: true,
      watch: false,            // do not watch for file changes in prod

      // Environment overrides (non-secret; secrets come from Secrets Manager)
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
