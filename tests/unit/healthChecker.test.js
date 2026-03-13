// =============================================================================
// healthChecker.test.js — Unit tests for the HealthChecker module
// =============================================================================

import { jest } from '@jest/globals';
import { HealthChecker } from '../../src/monitor/healthChecker.js';
import { HealthStatus } from '../../src/utils/constants.js';

// Mock logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

// Mock ELBv2 client
const mockElbClient = {
  send: jest.fn(),
};

// Base config
const baseConfig = {
  engine: { latencyThresholdMs: 200 },
  primary: {
    region: 'us-east-1',
    alb: {
      arn: 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/test/123',
      dnsName: 'test-alb.us-east-1.elb.amazonaws.com',
      targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/test/123',
      healthCheckPath: '/health',
      healthCheckTimeoutMs: 5000,
    },
    ecs: {},
  },
  secondary: {
    region: 'eu-west-1',
    alb: {
      arn: 'arn:aws:elasticloadbalancing:eu-west-1:123:loadbalancer/app/test/456',
      dnsName: 'test-alb.eu-west-1.elb.amazonaws.com',
      targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:123:targetgroup/test/456',
      healthCheckPath: '/health',
      healthCheckTimeoutMs: 5000,
    },
    ecs: {},
  },
};

describe('HealthChecker', () => {
  let checker;

  beforeEach(() => {
    jest.clearAllMocks();
    checker = new HealthChecker({
      config: baseConfig,
      logger: mockLogger,
      elbClientOverride: mockElbClient,
    });
  });

  describe('checkAlbTargetHealth', () => {
    test('returns healthy when all targets are healthy', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
          { Target: { Id: '10.0.0.2', Port: 8080 }, TargetHealth: { State: 'healthy' } },
        ],
      });

      const result = await checker.checkAlbTargetHealth('arn:test', 'primary');
      expect(result.healthy).toBe(2);
      expect(result.unhealthy).toBe(0);
      expect(result.total).toBe(2);
    });

    test('returns degraded counts when some targets are unhealthy', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
          { Target: { Id: '10.0.0.2', Port: 8080 }, TargetHealth: { State: 'unhealthy', Reason: 'Target.Timeout' } },
        ],
      });

      const result = await checker.checkAlbTargetHealth('arn:test', 'primary');
      expect(result.healthy).toBe(1);
      expect(result.unhealthy).toBe(1);
      expect(result.total).toBe(2);
    });

    test('returns zero counts when all targets are unhealthy', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'unhealthy' } },
          { Target: { Id: '10.0.0.2', Port: 8080 }, TargetHealth: { State: 'draining' } },
        ],
      });

      const result = await checker.checkAlbTargetHealth('arn:test', 'primary');
      expect(result.healthy).toBe(0);
      expect(result.unhealthy).toBe(2);
    });

    test('handles AWS API errors gracefully', async () => {
      mockElbClient.send.mockRejectedValue(new Error('AccessDenied'));

      const result = await checker.checkAlbTargetHealth('arn:test', 'primary');
      expect(result.healthy).toBe(0);
      expect(result.total).toBe(0);
      expect(result.error).toBe('AccessDenied');
    });
  });

  describe('runProbe', () => {
    test('returns UNHEALTHY when all ALB targets are down', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'unhealthy' } },
        ],
      });

      // Override checkEndpointHttp to simulate HTTP failure
      checker.checkEndpointHttp = jest.fn().mockResolvedValue({
        healthy: false,
        statusCode: null,
        latencyMs: 0,
        error: 'TIMEOUT',
      });

      const result = await checker.runProbe('primary');
      expect(result.status).toBe(HealthStatus.UNHEALTHY);
    });

    test('returns DEGRADED when some targets are unhealthy', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
          { Target: { Id: '10.0.0.2', Port: 8080 }, TargetHealth: { State: 'unhealthy' } },
        ],
      });

      checker.checkEndpointHttp = jest.fn().mockResolvedValue({
        healthy: true,
        statusCode: 200,
        latencyMs: 50,
        error: null,
      });

      const result = await checker.runProbe('primary');
      expect(result.status).toBe(HealthStatus.DEGRADED);
    });

    test('returns HEALTHY when everything is fine', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
        ],
      });

      checker.checkEndpointHttp = jest.fn().mockResolvedValue({
        healthy: true,
        statusCode: 200,
        latencyMs: 50,
        error: null,
      });

      const result = await checker.runProbe('primary');
      expect(result.status).toBe(HealthStatus.HEALTHY);
    });

    test('returns DEGRADED when latency exceeds threshold', async () => {
      mockElbClient.send.mockResolvedValue({
        TargetHealthDescriptions: [
          { Target: { Id: '10.0.0.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
        ],
      });

      checker.checkEndpointHttp = jest.fn().mockResolvedValue({
        healthy: true,
        statusCode: 200,
        latencyMs: 500, // exceeds 200ms threshold
        error: null,
      });

      const result = await checker.runProbe('primary');
      expect(result.status).toBe(HealthStatus.DEGRADED);
    });
  });
});
