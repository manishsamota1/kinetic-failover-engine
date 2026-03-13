// =============================================================================
// ecsManager.js — ECS task and service management for dual-region failover
// =============================================================================
// Manages ECS services across primary and secondary regions: scaling up the
// secondary on failover, scaling down on failback, and ensuring task health.
// =============================================================================

import {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { createChildLogger } from '../utils/logger.js';

export class EcsManager {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.ecsClientOverrides] - Optional ECS client overrides (for testing)
   *   { primary: ECSClient, secondary: ECSClient }
   */
  constructor({ config, logger, ecsClientOverrides }) {
    this.config = config;
    this.logger = createChildLogger(logger, { module: 'EcsManager' });

    // ECS clients — one per region
    this.clients = {
      primary: ecsClientOverrides?.primary || new ECSClient({ region: config.primary.region }),
      secondary: ecsClientOverrides?.secondary || new ECSClient({ region: config.secondary.region }),
    };
  }

  /**
   * Gets the current status of an ECS service.
   *
   * @param {'primary'|'secondary'} region
   * @returns {Promise<{running: number, desired: number, pending: number, status: string, error: string|null}>}
   */
  async getServiceStatus(region) {
    const regionConfig = this.config[region];
    const client = this.clients[region];

    try {
      const command = new DescribeServicesCommand({
        cluster: regionConfig.ecs.clusterName,
        services: [regionConfig.ecs.serviceName],
      });

      const response = await client.send(command);
      const service = response.services?.[0];

      if (!service) {
        return { running: 0, desired: 0, pending: 0, status: 'NOT_FOUND', error: 'Service not found' };
      }

      return {
        running: service.runningCount || 0,
        desired: service.desiredCount || 0,
        pending: service.pendingCount || 0,
        status: service.status || 'UNKNOWN',
        error: null,
      };
    } catch (error) {
      this.logger.error({ error: error.message, region }, 'Failed to describe ECS service');
      return { running: 0, desired: 0, pending: 0, status: 'ERROR', error: error.message };
    }
  }

  /**
   * Scales the secondary ECS service to match the primary's desired count.
   * Call this during failover to ensure the secondary is ready to handle traffic.
   *
   * @returns {Promise<{success: boolean, desiredCount: number, error: string|null}>}
   */
  async scaleUpSecondary() {
    try {
      // First, check the primary's desired count to mirror it
      const primaryStatus = await this.getServiceStatus('primary');
      const targetCount = Math.max(primaryStatus.desired, 1); // At least 1 task

      this.logger.info(
        { targetCount, primaryDesired: primaryStatus.desired },
        'Scaling up secondary ECS service'
      );

      const command = new UpdateServiceCommand({
        cluster: this.config.secondary.ecs.clusterName,
        service: this.config.secondary.ecs.serviceName,
        desiredCount: targetCount,
      });

      await this.clients.secondary.send(command);

      this.logger.info({ targetCount }, 'Secondary ECS service scale-up initiated');
      return { success: true, desiredCount: targetCount, error: null };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to scale up secondary ECS service');
      return { success: false, desiredCount: 0, error: error.message };
    }
  }

  /**
   * Scales the secondary ECS service back down to standby after failback.
   *
   * @param {number} [standbyCount=0] - Number of tasks to keep running in standby
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async scaleDownSecondary(standbyCount = 0) {
    try {
      this.logger.info({ standbyCount }, 'Scaling down secondary ECS service');

      const command = new UpdateServiceCommand({
        cluster: this.config.secondary.ecs.clusterName,
        service: this.config.secondary.ecs.serviceName,
        desiredCount: standbyCount,
      });

      await this.clients.secondary.send(command);

      this.logger.info({ standbyCount }, 'Secondary ECS service scaled down');
      return { success: true, error: null };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to scale down secondary ECS service');
      return { success: false, error: error.message };
    }
  }

  /**
   * Waits until all tasks in a region's ECS service are RUNNING and healthy.
   *
   * @param {'primary'|'secondary'} region
   * @param {number} [timeoutMs=120000] - Maximum wait time
   * @param {number} [pollIntervalMs=5000] - Polling interval
   * @returns {Promise<{ready: boolean, running: number, desired: number, elapsedMs: number}>}
   */
  async waitForTasksHealthy(region, timeoutMs = 120000, pollIntervalMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getServiceStatus(region);

      if (status.error) {
        this.logger.warn({ error: status.error, region }, 'Error checking service status while waiting');
      } else if (status.running > 0 && status.running >= status.desired) {
        const elapsedMs = Date.now() - startTime;
        this.logger.info(
          { region, running: status.running, desired: status.desired, elapsedMs },
          'All ECS tasks are healthy and running'
        );
        return { ready: true, running: status.running, desired: status.desired, elapsedMs };
      } else {
        this.logger.debug(
          { region, running: status.running, desired: status.desired, pending: status.pending },
          'Waiting for ECS tasks to become healthy...'
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const finalStatus = await this.getServiceStatus(region);
    const elapsedMs = Date.now() - startTime;

    this.logger.warn(
      { region, running: finalStatus.running, desired: finalStatus.desired, elapsedMs },
      'Timed out waiting for ECS tasks to become healthy'
    );

    return {
      ready: false,
      running: finalStatus.running,
      desired: finalStatus.desired,
      elapsedMs,
    };
  }

  /**
   * Copies the latest task definition from the primary region and registers
   * it in the secondary region (if not already identical).
   *
   * @returns {Promise<{success: boolean, taskDefinitionArn: string|null, error: string|null}>}
   */
  async mirrorTaskDefinition() {
    try {
      // Get the primary task definition
      const describeCmd = new DescribeTaskDefinitionCommand({
        taskDefinition: this.config.primary.ecs.taskDefinition,
      });
      const primaryTd = await this.clients.primary.send(describeCmd);
      const td = primaryTd.taskDefinition;

      if (!td) {
        return { success: false, taskDefinitionArn: null, error: 'Primary task definition not found' };
      }

      // Register the same task definition in the secondary region
      const registerCmd = new RegisterTaskDefinitionCommand({
        family: td.taskDefinitionArn?.split('/').pop()?.split(':')[0] || td.family,
        containerDefinitions: td.containerDefinitions,
        taskRoleArn: td.taskRoleArn,
        executionRoleArn: td.executionRoleArn,
        networkMode: td.networkMode,
        requiresCompatibilities: td.requiresCompatibilities,
        cpu: td.cpu,
        memory: td.memory,
        volumes: td.volumes,
        placementConstraints: td.placementConstraints,
        runtimePlatform: td.runtimePlatform,
      });

      const result = await this.clients.secondary.send(registerCmd);
      const newArn = result.taskDefinition?.taskDefinitionArn;

      this.logger.info({ newArn }, 'Task definition mirrored to secondary region');
      return { success: true, taskDefinitionArn: newArn, error: null };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to mirror task definition');
      return { success: false, taskDefinitionArn: null, error: error.message };
    }
  }

  /**
   * Lists and describes all tasks running in a given region's ECS cluster/service.
   *
   * @param {'primary'|'secondary'} region
   * @returns {Promise<{tasks: Array, error: string|null}>}
   */
  async listTasks(region) {
    const regionConfig = this.config[region];
    const client = this.clients[region];

    try {
      const listCmd = new ListTasksCommand({
        cluster: regionConfig.ecs.clusterName,
        serviceName: regionConfig.ecs.serviceName,
      });
      const listResult = await client.send(listCmd);
      const taskArns = listResult.taskArns || [];

      if (taskArns.length === 0) {
        return { tasks: [], error: null };
      }

      const describeCmd = new DescribeTasksCommand({
        cluster: regionConfig.ecs.clusterName,
        tasks: taskArns,
      });
      const describeResult = await client.send(describeCmd);

      const tasks = (describeResult.tasks || []).map((t) => ({
        taskArn: t.taskArn,
        lastStatus: t.lastStatus,
        desiredStatus: t.desiredStatus,
        healthStatus: t.healthStatus,
        startedAt: t.startedAt,
        cpu: t.cpu,
        memory: t.memory,
      }));

      return { tasks, error: null };
    } catch (error) {
      this.logger.error({ error: error.message, region }, 'Failed to list ECS tasks');
      return { tasks: [], error: error.message };
    }
  }
}
