// =============================================================================
// cloudwatchReporter.js — Custom CloudWatch metrics for observability
// =============================================================================
// Pushes custom metrics to CloudWatch on every engine tick and on state
// transitions, enabling dashboards and alarms on failover engine health.
// =============================================================================

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { createChildLogger } from '../utils/logger.js';

export class CloudWatchReporter {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.cloudwatchClientOverride] - Optional client override for testing
   */
  constructor({ config, logger, cloudwatchClientOverride }) {
    this.config = config;
    this.logger = createChildLogger(logger, { module: 'CloudWatchReporter' });
    this.enabled = config.cloudwatch?.enabled || false;
    this.namespace = config.cloudwatch?.namespace || 'KineticFailoverEngine';

    this.client = cloudwatchClientOverride || new CloudWatchClient({ region: config.primary.region });

    // Track failover count
    this.failoverCount = 0;
  }

  /**
   * Publishes a set of metrics to CloudWatch.
   *
   * @param {object} params
   * @param {string} params.engineState - Current engine state
   * @param {number|null} params.latencyP95 - P95 latency in ms
   * @param {string} params.healthStatus - Current health status
   * @param {string} params.activeRegion - Currently active region
   */
  async publishMetrics({ engineState, latencyP95, healthStatus, activeRegion }) {
    if (!this.enabled) {
      return;
    }

    const timestamp = new Date();

    // Map engine state to a numeric value for CloudWatch
    const stateMap = {
      MONITORING: 1,
      DEGRADED: 2,
      FAILING_OVER: 3,
      FAILED_OVER: 4,
      RECOVERING: 5,
      STOPPED: 0,
      ERROR: -1,
    };

    // Map health status to numeric
    const healthMap = {
      HEALTHY: 1,
      DEGRADED: 0.5,
      UNHEALTHY: 0,
      UNKNOWN: -1,
    };

    const metricData = [
      {
        MetricName: 'EngineState',
        Value: stateMap[engineState] ?? -1,
        Unit: 'None',
        Timestamp: timestamp,
        Dimensions: [
          { Name: 'Service', Value: 'KineticFailoverEngine' },
        ],
      },
      {
        MetricName: 'HealthStatus',
        Value: healthMap[healthStatus] ?? -1,
        Unit: 'None',
        Timestamp: timestamp,
        Dimensions: [
          { Name: 'Service', Value: 'KineticFailoverEngine' },
          { Name: 'ActiveRegion', Value: activeRegion || 'unknown' },
        ],
      },
      {
        MetricName: 'FailoverCount',
        Value: this.failoverCount,
        Unit: 'Count',
        Timestamp: timestamp,
        Dimensions: [
          { Name: 'Service', Value: 'KineticFailoverEngine' },
        ],
      },
    ];

    // Only add latency metric if we have a valid value
    if (latencyP95 !== null && latencyP95 !== undefined) {
      metricData.push({
        MetricName: 'LatencyP95',
        Value: latencyP95,
        Unit: 'Milliseconds',
        Timestamp: timestamp,
        Dimensions: [
          { Name: 'Service', Value: 'KineticFailoverEngine' },
          { Name: 'ActiveRegion', Value: activeRegion || 'unknown' },
        ],
      });
    }

    try {
      const command = new PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: metricData,
      });

      await this.client.send(command);
      this.logger.debug({ metricsCount: metricData.length }, 'Published CloudWatch metrics');
    } catch (error) {
      // Don't let CloudWatch failures crash the engine
      this.logger.warn({ error: error.message }, 'Failed to publish CloudWatch metrics');
    }
  }

  /**
   * Increments the failover counter. Call this when a failover event occurs.
   */
  incrementFailoverCount() {
    this.failoverCount++;
  }

  /**
   * Resets the failover counter (e.g., on engine restart).
   */
  resetFailoverCount() {
    this.failoverCount = 0;
  }
}
