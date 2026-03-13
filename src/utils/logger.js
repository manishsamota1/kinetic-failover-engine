// =============================================================================
// logger.js — Structured JSON logging powered by Pino
// =============================================================================
// Provides a pre-configured logger with context enrichment (region, state,
// correlationId). All modules import this single logger instance.
// =============================================================================

import pino from 'pino';

/**
 * Creates and configures the application logger.
 *
 * @param {object} options
 * @param {string} [options.level='info'] - Log level (trace|debug|info|warn|error|fatal)
 * @param {string} [options.format='pretty'] - Output format: 'json' or 'pretty'
 * @returns {import('pino').Logger} Configured Pino logger instance
 */
export function createLogger(options = {}) {
  const { level = 'info', format = 'pretty' } = options;

  const transport =
    format === 'pretty'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined;

  const logger = pino({
    level,
    ...(transport ? { transport } : {}),
    base: {
      service: 'kinetic-failover-engine',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
    },
  });

  return logger;
}

/**
 * Creates a child logger with additional context fields.
 * Use this to add region, state, or correlationId to all log lines
 * within a specific module or operation.
 *
 * @param {import('pino').Logger} logger - Parent logger
 * @param {object} context - Additional fields to include in every log line
 * @param {string} [context.module] - Module name (e.g., 'healthChecker')
 * @param {string} [context.region] - AWS region
 * @param {string} [context.state] - Current engine state
 * @param {string} [context.correlationId] - Unique ID for this failover event
 * @returns {import('pino').Logger} Child logger with enriched context
 */
export function createChildLogger(logger, context) {
  return logger.child(context);
}
