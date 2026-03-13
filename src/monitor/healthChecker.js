// =============================================================================
// healthChecker.js — Continuous ALB and endpoint health probing
// =============================================================================
// Probes the primary ALB via the AWS ELBv2 API (DescribeTargetHealth) and via
// direct HTTP health checks. Emits health status events for the orchestrator.
// =============================================================================

import { ElasticLoadBalancingV2Client, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import axios from 'axios';
import { HealthStatus } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';

export class HealthChecker {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.elbClientOverride] - Optional ELBv2 client override (for testing)
   */
  constructor({ config, logger, elbClientOverride }) {
    this.config = config;
    this.logger = createChildLogger(logger, { module: 'HealthChecker' });

    // Create ELBv2 clients for both regions
    this.elbClients = {
      primary: elbClientOverride || new ElasticLoadBalancingV2Client({ region: config.primary.region }),
      secondary: elbClientOverride || new ElasticLoadBalancingV2Client({ region: config.secondary.region }),
    };
  }

  /**
   * Checks the health of all targets behind a given ALB target group.
   *
   * @param {string} targetGroupArn - ARN of the target group to check
   * @param {'primary'|'secondary'} region - Which region's client to use
   * @returns {Promise<{healthy: number, unhealthy: number, total: number, targets: Array}>}
   */
  async checkAlbTargetHealth(targetGroupArn, region = 'primary') {
    try {
      const client = this.elbClients[region];
      const command = new DescribeTargetHealthCommand({
        TargetGroupArn: targetGroupArn,
      });
      const response = await client.send(command);
      const descriptions = response.TargetHealthDescriptions || [];

      let healthy = 0;
      let unhealthy = 0;
      const targets = [];

      for (const desc of descriptions) {
        const state = desc.TargetHealth?.State || 'unknown';
        const isHealthy = state === 'healthy';

        if (isHealthy) {
          healthy++;
        } else {
          unhealthy++;
        }

        targets.push({
          id: desc.Target?.Id,
          port: desc.Target?.Port,
          state,
          reason: desc.TargetHealth?.Reason || null,
          description: desc.TargetHealth?.Description || null,
        });
      }

      return {
        healthy,
        unhealthy,
        total: descriptions.length,
        targets,
      };
    } catch (error) {
      this.logger.error({ error: error.message, targetGroupArn, region }, 'Failed to describe target health');
      return {
        healthy: 0,
        unhealthy: 0,
        total: 0,
        targets: [],
        error: error.message,
      };
    }
  }

  /**
   * Performs a direct HTTP GET to the ALB endpoint and measures latency.
   *
   * @param {string} url - Full URL to probe (e.g., http://my-alb.us-east-1.elb.amazonaws.com/health)
   * @param {number} [timeoutMs] - Request timeout in milliseconds
   * @returns {Promise<{healthy: boolean, statusCode: number|null, latencyMs: number, error: string|null}>}
   */
  async checkEndpointHttp(url, timeoutMs) {
    const timeout = timeoutMs || this.config.primary.alb.healthCheckTimeoutMs || 5000;
    const startTime = performance.now();

    try {
      const response = await axios.get(url, {
        timeout,
        // Don't throw on non-2xx — we want to capture the status code
        validateStatus: () => true,
        // Don't follow redirects automatically
        maxRedirects: 0,
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const statusCode = response.status;
      const healthy = statusCode >= 200 && statusCode < 400;

      return {
        healthy,
        statusCode,
        latencyMs,
        error: null,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';

      this.logger.warn(
        { error: error.message, url, latencyMs, isTimeout },
        'HTTP health check failed'
      );

      return {
        healthy: false,
        statusCode: null,
        latencyMs,
        error: isTimeout ? 'TIMEOUT' : error.message,
      };
    }
  }

  /**
   * Runs a full health probe for a specific region. Combines ALB target health
   * and HTTP endpoint checks into a single HealthStatus result.
   *
   * @param {'primary'|'secondary'} region - Which region to probe
   * @returns {Promise<{status: string, latencyMs: number, details: object}>}
   */
  async runProbe(region = 'primary') {
    const regionConfig = this.config[region];
    const albConfig = regionConfig.alb;

    // Run ALB target health check and HTTP check in parallel
    const [targetHealth, httpCheck] = await Promise.all([
      albConfig.targetGroupArn
        ? this.checkAlbTargetHealth(albConfig.targetGroupArn, region)
        : Promise.resolve(null),
      albConfig.dnsName
        ? this.checkEndpointHttp(
            `http://${albConfig.dnsName}${albConfig.healthCheckPath || '/health'}`,
            albConfig.healthCheckTimeoutMs
          )
        : Promise.resolve(null),
    ]);

    // Determine overall health status
    let status;
    const latencyMs = httpCheck?.latencyMs || 0;

    if (httpCheck && !httpCheck.healthy) {
      // HTTP check failed → endpoint is down
      status = HealthStatus.UNHEALTHY;
    } else if (targetHealth && targetHealth.total > 0 && targetHealth.healthy === 0) {
      // All ALB targets unhealthy
      status = HealthStatus.UNHEALTHY;
    } else if (targetHealth && targetHealth.unhealthy > 0) {
      // Some ALB targets unhealthy
      status = HealthStatus.DEGRADED;
    } else if (latencyMs > this.config.engine.latencyThresholdMs) {
      // Latency exceeds threshold
      status = HealthStatus.DEGRADED;
    } else if (!httpCheck && !targetHealth) {
      // No checks could be performed
      status = HealthStatus.UNKNOWN;
    } else {
      status = HealthStatus.HEALTHY;
    }

    const result = {
      status,
      latencyMs,
      region,
      timestamp: new Date().toISOString(),
      details: {
        targetHealth,
        httpCheck,
      },
    };

    this.logger.debug(
      { status, latencyMs, region, healthyTargets: targetHealth?.healthy, totalTargets: targetHealth?.total },
      'Health probe complete'
    );

    return result;
  }
}
