import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'token',
      'password',
      'secret',
      'authtoken',
      'NGROK_AUTHTOKEN',
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'SLACK_TOKEN',
    ],
    censor: '[REDACTED]',
  },
});
