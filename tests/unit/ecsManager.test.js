// =============================================================================
// ecsManager.test.js — Unit tests for EcsManager
// =============================================================================

import { jest } from '@jest/globals';
import { EcsManager } from '../../src/aws/ecsManager.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  primary: {
    region: 'us-east-1',
    ecs: {
      clusterName: 'primary-cluster',
      serviceName: 'primary-service',
      taskDefinition: 'my-app:5',
    },
  },
  secondary: {
    region: 'eu-west-1',
    ecs: {
      clusterName: 'secondary-cluster',
      serviceName: 'secondary-service',
      taskDefinition: 'my-app:5',
    },
  },
};

describe('EcsManager', () => {
  let manager;
  let mockPrimary;
  let mockSecondary;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrimary = { send: jest.fn() };
    mockSecondary = { send: jest.fn() };
    manager = new EcsManager({
      config: baseConfig,
      logger: mockLogger,
      ecsClientOverrides: { primary: mockPrimary, secondary: mockSecondary },
    });
  });

  describe('getServiceStatus', () => {
    test('returns service status correctly', async () => {
      mockPrimary.send.mockResolvedValue({
        services: [{
          runningCount: 3,
          desiredCount: 3,
          pendingCount: 0,
          status: 'ACTIVE',
        }],
      });

      const result = await manager.getServiceStatus('primary');
      expect(result.running).toBe(3);
      expect(result.desired).toBe(3);
      expect(result.status).toBe('ACTIVE');
    });

    test('handles missing service', async () => {
      mockPrimary.send.mockResolvedValue({ services: [] });

      const result = await manager.getServiceStatus('primary');
      expect(result.status).toBe('NOT_FOUND');
    });

    test('handles errors', async () => {
      mockPrimary.send.mockRejectedValue(new Error('ClusterNotFound'));

      const result = await manager.getServiceStatus('primary');
      expect(result.error).toBe('ClusterNotFound');
    });
  });

  describe('scaleUpSecondary', () => {
    test('scales secondary to match primary desired count', async () => {
      // getServiceStatus for primary
      mockPrimary.send.mockResolvedValue({
        services: [{ desiredCount: 3, runningCount: 3, pendingCount: 0, status: 'ACTIVE' }],
      });
      // updateService for secondary
      mockSecondary.send.mockResolvedValue({});

      const result = await manager.scaleUpSecondary();
      expect(result.success).toBe(true);
      expect(result.desiredCount).toBe(3);
    });

    test('ensures at least 1 task even if primary is 0', async () => {
      mockPrimary.send.mockResolvedValue({
        services: [{ desiredCount: 0, runningCount: 0, pendingCount: 0, status: 'ACTIVE' }],
      });
      mockSecondary.send.mockResolvedValue({});

      const result = await manager.scaleUpSecondary();
      expect(result.desiredCount).toBe(1);
    });
  });

  describe('scaleDownSecondary', () => {
    test('scales secondary to standby count', async () => {
      mockSecondary.send.mockResolvedValue({});

      const result = await manager.scaleDownSecondary(0);
      expect(result.success).toBe(true);
    });
  });

  describe('waitForTasksHealthy', () => {
    test('returns ready when tasks are running', async () => {
      mockSecondary.send.mockResolvedValue({
        services: [{ runningCount: 2, desiredCount: 2, pendingCount: 0, status: 'ACTIVE' }],
      });

      const result = await manager.waitForTasksHealthy('secondary', 2000, 100);
      expect(result.ready).toBe(true);
      expect(result.running).toBe(2);
    });

    test('times out when tasks never become healthy', async () => {
      mockSecondary.send.mockResolvedValue({
        services: [{ runningCount: 0, desiredCount: 2, pendingCount: 2, status: 'ACTIVE' }],
      });

      const result = await manager.waitForTasksHealthy('secondary', 500, 100);
      expect(result.ready).toBe(false);
    });
  });

  describe('mirrorTaskDefinition', () => {
    test('copies task definition to secondary region', async () => {
      mockPrimary.send.mockResolvedValue({
        taskDefinition: {
          family: 'my-app',
          containerDefinitions: [{ name: 'app', image: 'nginx:latest' }],
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          cpu: '256',
          memory: '512',
        },
      });
      mockSecondary.send.mockResolvedValue({
        taskDefinition: {
          taskDefinitionArn: 'arn:aws:ecs:eu-west-1:123:task-definition/my-app:1',
        },
      });

      const result = await manager.mirrorTaskDefinition();
      expect(result.success).toBe(true);
      expect(result.taskDefinitionArn).toContain('my-app');
    });
  });
});
