#!/usr/bin/env node
// =============================================================================
// simulateOutage.js — Chaos simulation script
// =============================================================================
// Simulates a primary region outage by running the engine with mocked AWS
// clients. Demonstrates the full failover sequence without touching real AWS.
//
// Usage: npm run chaos
// =============================================================================

import { LatencyAnalyzer } from '../../src/monitor/latencyAnalyzer.js';
import { Orchestrator } from '../../src/failover/orchestrator.js';
import { EngineState, HealthStatus, AlertSeverity } from '../../src/utils/constants.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger({ level: 'info', format: 'pretty' });

// ==== Configuration ====
const config = {
  engine: {
    healthCheckIntervalMs: 2000,
    latencyThresholdMs: 200,
    failureThreshold: 3,
    cooldownPeriodMs: 10000,
    latencyWindowSize: 20,
    dryRun: true, // CHAOS SIMULATION — no real AWS calls
  },
  primary: {
    region: 'us-east-1',
    alb: { dnsName: 'primary-alb.us-east-1.elb.amazonaws.com', targetGroupArn: 'arn:primary-tg', healthCheckPath: '/health', healthCheckTimeoutMs: 5000 },
    ecs: { clusterName: 'primary-cluster', serviceName: 'primary-service', taskDefinition: 'app:5' },
  },
  secondary: {
    region: 'eu-west-1',
    alb: { dnsName: 'secondary-alb.eu-west-1.elb.amazonaws.com', targetGroupArn: 'arn:secondary-tg', healthCheckPath: '/health', healthCheckTimeoutMs: 5000 },
    ecs: { clusterName: 'secondary-cluster', serviceName: 'secondary-service', taskDefinition: 'app:5' },
  },
  dns: { hostedZoneId: 'Z_SIMULATED', domainName: 'app.simulation.local', ttl: 30, routingPolicy: 'failover' },
  splitBrain: { tableName: 'simulation-locks', lockTtlSeconds: 120 },
  alerting: { sns: { enabled: false }, slack: { enabled: false }, pagerDuty: { enabled: false } },
  cloudwatch: { enabled: false },
  logging: { level: 'info', format: 'pretty' },
};

// ==== Simulated Scenario Timeline ====
const SCENARIO = [
  // Tick 1-5: Everything healthy
  { tick: 1, status: HealthStatus.HEALTHY, latencyMs: 45 },
  { tick: 2, status: HealthStatus.HEALTHY, latencyMs: 52 },
  { tick: 3, status: HealthStatus.HEALTHY, latencyMs: 48 },
  { tick: 4, status: HealthStatus.HEALTHY, latencyMs: 55 },
  { tick: 5, status: HealthStatus.HEALTHY, latencyMs: 51 },

  // Tick 6-8: Latency starts climbing (regional degradation)
  { tick: 6, status: HealthStatus.DEGRADED, latencyMs: 180 },
  { tick: 7, status: HealthStatus.DEGRADED, latencyMs: 350 },
  { tick: 8, status: HealthStatus.UNHEALTHY, latencyMs: 0 },

  // Tick 9-11: Full outage
  { tick: 9, status: HealthStatus.UNHEALTHY, latencyMs: 0 },
  { tick: 10, status: HealthStatus.UNHEALTHY, latencyMs: 0 },
  { tick: 11, status: HealthStatus.UNHEALTHY, latencyMs: 0 },

  // Tick 12-15: Primary starts recovering (after failover)
  { tick: 12, status: HealthStatus.UNHEALTHY, latencyMs: 0 },
  { tick: 13, status: HealthStatus.DEGRADED, latencyMs: 300 },
  { tick: 14, status: HealthStatus.HEALTHY, latencyMs: 90 },
  { tick: 15, status: HealthStatus.HEALTHY, latencyMs: 55 },
];

// ==== Run Simulation ====
async function runSimulation() {
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔥 CHAOS SIMULATION — Primary Region Outage');
  console.log('  This demonstrates the full failover lifecycle.');
  console.log('  No real AWS resources are used (dry-run mode).');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();

  let currentTick = 0;

  // Mock health checker
  const healthChecker = {
    runProbe: async () => {
      const scenario = SCENARIO[currentTick] || SCENARIO[SCENARIO.length - 1];
      return {
        status: scenario.status,
        latencyMs: scenario.latencyMs,
        region: 'primary',
        timestamp: new Date().toISOString(),
        details: {},
      };
    },
  };

  const latencyAnalyzer = new LatencyAnalyzer({ config, logger });

  // Mock AWS components
  const dnsManager = {
    switchToPrimary: async () => ({ success: true, changeId: '/change/sim-primary' }),
    switchToSecondary: async () => ({ success: true, changeId: '/change/sim-secondary' }),
  };

  const ecsManager = {
    scaleUpSecondary: async () => ({ success: true, desiredCount: 3 }),
    scaleDownSecondary: async () => ({ success: true }),
    waitForTasksHealthy: async () => ({ ready: true, running: 3, desired: 3, elapsedMs: 2000 }),
  };

  const splitBrainGuard = {
    acquireLock: async () => ({ acquired: true }),
    releaseLock: async () => ({ released: true }),
    refreshLock: async () => ({ refreshed: true }),
  };

  const alerts = [];
  const notifier = {
    sendAlert: async (severity, title, details) => {
      alerts.push({ severity, title, timestamp: new Date().toISOString(), details });
    },
  };

  const cloudwatchReporter = {
    publishMetrics: async () => {},
    incrementFailoverCount: () => {},
  };

  // Create orchestrator
  const orchestrator = new Orchestrator({
    config,
    healthChecker,
    latencyAnalyzer,
    dnsManager,
    ecsManager,
    splitBrainGuard,
    notifier,
    cloudwatchReporter,
    logger,
  });

  orchestrator.transitionTo(EngineState.MONITORING);
  orchestrator._running = true;
  orchestrator.startTime = Date.now();

  // Run all scenario ticks
  const timeline = [];

  for (let i = 0; i < SCENARIO.length; i++) {
    currentTick = i;
    const scenario = SCENARIO[i];

    const beforeState = orchestrator.state;
    await orchestrator.tick();
    const afterState = orchestrator.state;

    const entry = {
      tick: scenario.tick,
      healthInput: scenario.status,
      latencyInput: scenario.latencyMs,
      stateBefore: beforeState,
      stateAfter: afterState,
      activeRegion: orchestrator.activeRegion,
      failures: orchestrator.consecutiveFailures,
    };

    timeline.push(entry);

    // Print tick summary
    const stateChanged = beforeState !== afterState;
    const stateIcon = stateChanged ? '⚡' : '  ';
    const healthIcon = scenario.status === HealthStatus.HEALTHY ? '🟢' : scenario.status === HealthStatus.DEGRADED ? '🟡' : '🔴';

    console.log(
      `${stateIcon} Tick ${String(scenario.tick).padStart(2)} | ${healthIcon} ${scenario.status.padEnd(10)} | ` +
      `Latency: ${String(scenario.latencyMs).padStart(4)}ms | ` +
      `State: ${afterState.padEnd(14)} | ` +
      `Region: ${orchestrator.activeRegion} | ` +
      `Failures: ${orchestrator.consecutiveFailures}`
    );

    // Small delay between ticks for readability
    await new Promise((r) => setTimeout(r, 300));
  }

  // Print summary
  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📊 SIMULATION SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Total ticks:     ${SCENARIO.length}`);
  console.log(`  Final state:     ${orchestrator.state}`);
  console.log(`  Active region:   ${orchestrator.activeRegion}`);
  console.log(`  Alerts sent:     ${alerts.length}`);
  console.log();

  if (alerts.length > 0) {
    console.log('  📬 ALERTS:');
    for (const alert of alerts) {
      console.log(`    [${alert.severity}] ${alert.title}`);
    }
  }

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ Simulation complete. No real AWS resources were affected.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
}

runSimulation().catch((error) => {
  console.error('❌ Simulation failed:', error);
  process.exit(1);
});
