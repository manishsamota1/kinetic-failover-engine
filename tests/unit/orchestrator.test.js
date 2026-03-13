// =============================================================================
// orchestrator.test.js — Unit tests for the Orchestrator state machine
// =============================================================================

import { jest } from '@jest/globals';
import { Orchestrator } from '../../src/failover/orchestrator.js';
import { EngineState, HealthStatus } from '../../src/utils/constants.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  engine: {
    healthCheckIntervalMs: 1000,
    latencyThresholdMs: 200,
    failureThreshold: 3,
    cooldownPeriodMs: 60000,
    latencyWindowSize: 10,
    dryRun: true, // Tests always run in dry-run
  },
  primary: { region: 'us-east-1', alb: { dnsName: 'primary-alb.example.com' }, ecs: {} },
  secondary: { region: 'eu-west-1', alb: { dnsName: 'secondary-alb.example.com' }, ecs: {} },
  dns: {},
  splitBrain: {},
  alerting: {},
  cloudwatch: { enabled: false },
  logging: { level: 'info' },
};

function createMocks() {
  return {
    healthChecker: { runProbe: jest.fn() },
    latencyAnalyzer: {
      addSample: jest.fn(),
      isLatencyAnomalous: jest.fn(() => ({ anomalous: false, reason: null })),
      getP95: jest.fn(() => 50),
      getStatus: jest.fn(() => ({})),
      reset: jest.fn(),
    },
    dnsManager: {
      switchToPrimary: jest.fn(() => ({ success: true })),
      switchToSecondary: jest.fn(() => ({ success: true })),
    },
    ecsManager: {
      scaleUpSecondary: jest.fn(() => ({ success: true, desiredCount: 2 })),
      scaleDownSecondary: jest.fn(() => ({ success: true })),
      waitForTasksHealthy: jest.fn(() => ({ ready: true })),
    },
    splitBrainGuard: {
      acquireLock: jest.fn(() => ({ acquired: true })),
      releaseLock: jest.fn(() => ({ released: true })),
      refreshLock: jest.fn(() => ({ refreshed: true })),
    },
    notifier: { sendAlert: jest.fn() },
    cloudwatchReporter: {
      publishMetrics: jest.fn(),
      incrementFailoverCount: jest.fn(),
    },
  };
}

describe('Orchestrator', () => {
  let orchestrator;
  let mocks;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = createMocks();
    orchestrator = new Orchestrator({
      config: baseConfig,
      ...mocks,
      logger: mockLogger,
    });
  });

  afterEach(async () => {
    if (orchestrator._intervalId) {
      await orchestrator.stop();
    }
  });

  describe('State Machine Transitions', () => {
    test('starts in STOPPED state', () => {
      expect(orchestrator.state).toBe(EngineState.STOPPED);
    });

    test('valid transition: STOPPED → MONITORING', () => {
      const result = orchestrator.transitionTo(EngineState.MONITORING);
      expect(result).toBe(true);
      expect(orchestrator.state).toBe(EngineState.MONITORING);
    });

    test('valid transition: MONITORING → DEGRADED', () => {
      orchestrator.transitionTo(EngineState.MONITORING);
      const result = orchestrator.transitionTo(EngineState.DEGRADED);
      expect(result).toBe(true);
      expect(orchestrator.state).toBe(EngineState.DEGRADED);
    });

    test('invalid transition: STOPPED → FAILED_OVER', () => {
      const result = orchestrator.transitionTo(EngineState.FAILED_OVER);
      expect(result).toBe(false);
      expect(orchestrator.state).toBe(EngineState.STOPPED);
    });

    test('invalid transition: MONITORING → FAILED_OVER', () => {
      orchestrator.transitionTo(EngineState.MONITORING);
      const result = orchestrator.transitionTo(EngineState.FAILED_OVER);
      expect(result).toBe(false);
    });
  });

  describe('Tick - Monitoring State', () => {
    beforeEach(() => {
      orchestrator.transitionTo(EngineState.MONITORING);
    });

    test('stays in MONITORING when health is OK', async () => {
      mocks.healthChecker.runProbe.mockResolvedValue({
        status: HealthStatus.HEALTHY,
        latencyMs: 50,
        details: {},
      });

      await orchestrator.tick();
      expect(orchestrator.state).toBe(EngineState.MONITORING);
      expect(orchestrator.consecutiveFailures).toBe(0);
    });

    test('transitions to DEGRADED on unhealthy check', async () => {
      mocks.healthChecker.runProbe.mockResolvedValue({
        status: HealthStatus.UNHEALTHY,
        latencyMs: 0,
        details: {},
      });

      await orchestrator.tick();
      expect(orchestrator.state).toBe(EngineState.DEGRADED);
      expect(orchestrator.consecutiveFailures).toBe(1);
    });

    test('triggers failover after consecutive failures reach threshold', async () => {
      mocks.healthChecker.runProbe.mockResolvedValue({
        status: HealthStatus.UNHEALTHY,
        latencyMs: 0,
        details: {},
      });

      // Pre-set consecutive failures to threshold - 1 so the next tick triggers failover
      orchestrator.consecutiveFailures = 2; // threshold is 3

      await orchestrator.tick();

      // In dry-run mode, failover completes immediately: MONITORING → FAILING_OVER → FAILED_OVER
      expect(orchestrator.state).toBe(EngineState.FAILED_OVER);
      expect(orchestrator.activeRegion).toBe('secondary');
    });

    test('transitions to DEGRADED on latency anomaly', async () => {
      mocks.healthChecker.runProbe.mockResolvedValue({
        status: HealthStatus.HEALTHY,
        latencyMs: 300,
        details: {},
      });
      mocks.latencyAnalyzer.isLatencyAnomalous.mockReturnValue({
        anomalous: true,
        reason: 'P95 latency too high',
      });

      await orchestrator.tick();
      expect(orchestrator.state).toBe(EngineState.DEGRADED);
    });
  });

  describe('Tick - Degraded State', () => {
    beforeEach(() => {
      orchestrator.transitionTo(EngineState.MONITORING);
      orchestrator.transitionTo(EngineState.DEGRADED);
      orchestrator.consecutiveFailures = 1;
    });

    test('recovers to MONITORING when health returns to normal', async () => {
      mocks.healthChecker.runProbe.mockResolvedValue({
        status: HealthStatus.HEALTHY,
        latencyMs: 50,
        details: {},
      });

      await orchestrator.tick();
      expect(orchestrator.state).toBe(EngineState.MONITORING);
      expect(orchestrator.consecutiveFailures).toBe(0);
    });
  });

  describe('Cooldown', () => {
    test('cooldown is not active initially', () => {
      expect(orchestrator._isCooldownActive()).toBe(false);
    });

    test('cooldown is active after failover', () => {
      orchestrator.lastFailoverTime = Date.now();
      expect(orchestrator._isCooldownActive()).toBe(true);
    });

    test('cooldown expires after configured period', () => {
      orchestrator.lastFailoverTime = Date.now() - 120000; // 2 minutes ago (cooldown = 60s)
      expect(orchestrator._isCooldownActive()).toBe(false);
    });
  });

  describe('getStatus', () => {
    test('returns complete status', () => {
      const status = orchestrator.getStatus();
      expect(status).toHaveProperty('state', EngineState.STOPPED);
      expect(status).toHaveProperty('activeRegion', 'primary');
      expect(status).toHaveProperty('consecutiveFailures', 0);
      expect(status).toHaveProperty('tickCount', 0);
      expect(status).toHaveProperty('dryRun', true);
    });
  });

  describe('Graceful Shutdown', () => {
    test('stop() transitions to STOPPED', async () => {
      orchestrator.transitionTo(EngineState.MONITORING);
      await orchestrator.stop();
      expect(orchestrator.state).toBe(EngineState.STOPPED);
      expect(orchestrator._running).toBe(false);
    });
  });
});
