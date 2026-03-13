// =============================================================================
// orchestrator.js — Failover decision engine & finite state machine
// =============================================================================
// The brain of the Kinetic Failover Engine. Runs a continuous monitoring loop,
// feeds health and latency data through the state machine, and triggers
// failover/failback when conditions are met.
//
// State Machine:
//   STOPPED → MONITORING → DEGRADED → FAILING_OVER → FAILED_OVER → RECOVERING → MONITORING
//
// Safety Rails:
//   - Cooldown period prevents rapid flapping between regions
//   - Split-brain guard ensures only one region is ever active
//   - Dry-run mode logs decisions without executing
//   - Consecutive failure threshold prevents single-blip failovers
// =============================================================================

import { EngineState, HealthStatus, AlertSeverity, ValidTransitions } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';

export class Orchestrator {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('../monitor/healthChecker.js').HealthChecker} params.healthChecker
   * @param {import('../monitor/latencyAnalyzer.js').LatencyAnalyzer} params.latencyAnalyzer
   * @param {import('../aws/dnsManager.js').DnsManager} params.dnsManager
   * @param {import('../aws/ecsManager.js').EcsManager} params.ecsManager
   * @param {import('../failover/splitBrainGuard.js').SplitBrainGuard} params.splitBrainGuard
   * @param {import('../alerting/notifier.js').Notifier} params.notifier
   * @param {import('../aws/cloudwatchReporter.js').CloudWatchReporter} params.cloudwatchReporter
   * @param {import('pino').Logger} params.logger
   */
  constructor({ config, healthChecker, latencyAnalyzer, dnsManager, ecsManager, splitBrainGuard, notifier, cloudwatchReporter, logger }) {
    this.config = config;
    this.healthChecker = healthChecker;
    this.latencyAnalyzer = latencyAnalyzer;
    this.dnsManager = dnsManager;
    this.ecsManager = ecsManager;
    this.splitBrainGuard = splitBrainGuard;
    this.notifier = notifier;
    this.cloudwatchReporter = cloudwatchReporter;
    this.logger = createChildLogger(logger, { module: 'Orchestrator' });

    // --- State ---
    this.state = EngineState.STOPPED;
    this.activeRegion = 'primary';
    this.consecutiveFailures = 0;
    this.lastFailoverTime = null;
    this.lastTickTime = null;
    this.tickCount = 0;
    this.startTime = null;

    // --- Loop control ---
    this._intervalId = null;
    this._running = false;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Starts the monitoring loop. Transitions from STOPPED → MONITORING.
   */
  async start() {
    if (this._running) {
      this.logger.warn('Engine is already running');
      return;
    }

    this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.info('  KINETIC FAILOVER ENGINE — STARTING');
    this.logger.info(`  Primary Region:   ${this.config.primary.region}`);
    this.logger.info(`  Secondary Region: ${this.config.secondary.region}`);
    this.logger.info(`  Check Interval:   ${this.config.engine.healthCheckIntervalMs}ms`);
    this.logger.info(`  Failure Threshold: ${this.config.engine.failureThreshold}`);
    this.logger.info(`  Dry Run:          ${this.config.engine.dryRun}`);
    this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    this._running = true;
    this.startTime = Date.now();
    this.transitionTo(EngineState.MONITORING);

    // Start the monitoring loop
    this._intervalId = setInterval(async () => {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error({ error: error.message, stack: error.stack }, 'Unhandled error in tick loop');
        await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'Engine tick error', {
          state: this.state,
          reason: error.message,
        });
      }
    }, this.config.engine.healthCheckIntervalMs);

    // Run the first tick immediately
    await this.tick();
  }

  /**
   * Gracefully stops the monitoring loop.
   */
  async stop() {
    this.logger.info('Engine stopping...');
    this._running = false;

    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    this.transitionTo(EngineState.STOPPED);
    this.logger.info('Engine stopped');
  }

  // ===========================================================================
  // State Machine
  // ===========================================================================

  /**
   * Transitions the engine to a new state, with validation.
   *
   * @param {string} newState - Target state from EngineState enum
   * @returns {boolean} Whether the transition was successful
   */
  transitionTo(newState) {
    const allowed = ValidTransitions[this.state];

    if (!allowed || !allowed.includes(newState)) {
      this.logger.error(
        { currentState: this.state, requestedState: newState, allowedStates: allowed },
        `Invalid state transition: ${this.state} → ${newState}`
      );
      return false;
    }

    const previousState = this.state;
    this.state = newState;

    this.logger.info(
      { previousState, newState, activeRegion: this.activeRegion },
      `State transition: ${previousState} → ${newState}`
    );

    return true;
  }

  // ===========================================================================
  // Core Tick — one iteration of the monitoring loop
  // ===========================================================================

  /**
   * Executes a single monitoring cycle:
   *   1. Probe the active region's health
   *   2. Feed latency data to the analyzer
   *   3. Evaluate state transitions
   *   4. Execute failover/failback if needed
   *   5. Report metrics
   */
  async tick() {
    this.tickCount++;
    this.lastTickTime = Date.now();

    const regionToCheck = this.state === EngineState.FAILED_OVER ? 'primary' : this.activeRegion;

    // ------ Step 1: Health probe ------
    const probe = await this.healthChecker.runProbe(
      this.state === EngineState.FAILED_OVER ? 'primary' : this.activeRegion
    );

    // ------ Step 2: Feed latency to analyzer ------
    if (probe.latencyMs > 0) {
      this.latencyAnalyzer.addSample(probe.latencyMs);
    }

    const latencyAnalysis = this.latencyAnalyzer.isLatencyAnomalous();

    // ------ Step 3: Evaluate state transitions ------
    await this._evaluateState(probe, latencyAnalysis);

    // ------ Step 4: Refresh split-brain lock ------
    if (this.state !== EngineState.STOPPED && this.state !== EngineState.ERROR) {
      const activeRegionName = this.config[this.activeRegion]?.region;
      if (activeRegionName) {
        await this.splitBrainGuard.refreshLock(activeRegionName);
      }
    }

    // ------ Step 5: Report metrics ------
    await this.cloudwatchReporter.publishMetrics({
      engineState: this.state,
      latencyP95: this.latencyAnalyzer.getP95(),
      healthStatus: probe.status,
      activeRegion: this.config[this.activeRegion]?.region,
    });
  }

  /**
   * Evaluates the current health data against the state machine and
   * triggers transitions as needed.
   *
   * @param {object} probe - Health probe result
   * @param {object} latencyAnalysis - Latency analysis result
   * @private
   */
  async _evaluateState(probe, latencyAnalysis) {
    switch (this.state) {
      case EngineState.MONITORING:
        await this._evaluateMonitoring(probe, latencyAnalysis);
        break;

      case EngineState.DEGRADED:
        await this._evaluateDegraded(probe, latencyAnalysis);
        break;

      case EngineState.FAILED_OVER:
        await this._evaluateFailedOver(probe);
        break;

      case EngineState.RECOVERING:
        await this._evaluateRecovering(probe);
        break;

      default:
        // FAILING_OVER, STOPPED, ERROR — no tick evaluation needed
        break;
    }
  }

  /**
   * MONITORING state evaluation:
   *   - If health is UNHEALTHY → increment failure counter
   *   - If health is DEGRADED or latency anomalous → transition to DEGRADED
   *   - If failures exceed threshold → start failover
   *   - Otherwise → reset failure counter
   *
   * @private
   */
  async _evaluateMonitoring(probe, latencyAnalysis) {
    if (probe.status === HealthStatus.UNHEALTHY) {
      this.consecutiveFailures++;
      this.logger.warn(
        { consecutiveFailures: this.consecutiveFailures, threshold: this.config.engine.failureThreshold },
        `Health check FAILED (${this.consecutiveFailures}/${this.config.engine.failureThreshold})`
      );

      if (this.consecutiveFailures >= this.config.engine.failureThreshold) {
        await this._initiateFailover('Consecutive failure threshold reached');
      } else {
        this.transitionTo(EngineState.DEGRADED);
        await this.notifier.sendAlert(AlertSeverity.WARNING, 'Region degraded', {
          state: this.state,
          region: this.config[this.activeRegion].region,
          reason: `Health check failed (${this.consecutiveFailures}/${this.config.engine.failureThreshold})`,
          latencyMs: probe.latencyMs,
        });
      }
    } else if (probe.status === HealthStatus.DEGRADED || latencyAnalysis.anomalous) {
      this.consecutiveFailures++;
      this.transitionTo(EngineState.DEGRADED);

      await this.notifier.sendAlert(AlertSeverity.WARNING, 'Region degraded', {
        state: this.state,
        region: this.config[this.activeRegion].region,
        reason: latencyAnalysis.reason || 'Partial target failures',
        latencyMs: probe.latencyMs,
      });
    } else {
      // Healthy — reset failure counter
      this.consecutiveFailures = 0;
    }
  }

  /**
   * DEGRADED state evaluation:
   *   - If health is back to HEALTHY and latency normal → return to MONITORING
   *   - If still unhealthy → increment failures, check threshold
   *
   * @private
   */
  async _evaluateDegraded(probe, latencyAnalysis) {
    if (probe.status === HealthStatus.HEALTHY && !latencyAnalysis.anomalous) {
      // Recovery
      this.consecutiveFailures = 0;
      this.transitionTo(EngineState.MONITORING);

      await this.notifier.sendAlert(AlertSeverity.RECOVERY, 'Region recovered from degraded state', {
        state: this.state,
        region: this.config[this.activeRegion].region,
      });
    } else if (probe.status === HealthStatus.UNHEALTHY) {
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.config.engine.failureThreshold) {
        await this._initiateFailover('Consecutive failure threshold reached in DEGRADED state');
      }
    }
    // If still DEGRADED but not UNHEALTHY, stay in DEGRADED (no counter change)
  }

  /**
   * FAILED_OVER state evaluation:
   *   - We probe the PRIMARY region to see if it has recovered
   *   - If primary is healthy → transition to RECOVERING
   *
   * @private
   */
  async _evaluateFailedOver(probe) {
    // In FAILED_OVER state, we're probing the primary (the failed region)
    if (probe.status === HealthStatus.HEALTHY) {
      this.logger.info('Primary region appears to have recovered');

      // Check cooldown
      if (this._isCooldownActive()) {
        this.logger.info('Cooldown still active — waiting before failback');
        return;
      }

      this.transitionTo(EngineState.RECOVERING);
      await this._initiateFailback();
    }
  }

  /**
   * RECOVERING state evaluation:
   *   - We're failing back to primary
   *   - Check if primary is still healthy → complete recovery to MONITORING
   *   - If primary fails again → go back to FAILED_OVER
   *
   * @private
   */
  async _evaluateRecovering(probe) {
    if (probe.status === HealthStatus.HEALTHY) {
      this.activeRegion = 'primary';
      this.consecutiveFailures = 0;
      this.latencyAnalyzer.reset();
      this.transitionTo(EngineState.MONITORING);

      await this.notifier.sendAlert(AlertSeverity.RECOVERY, 'Failback complete — primary region active', {
        state: this.state,
        region: this.config.primary.region,
      });
    } else {
      // Primary failed again during recovery — go back to secondary
      this.logger.warn('Primary failed again during recovery — aborting failback');
      this.activeRegion = 'secondary';
      this.transitionTo(EngineState.FAILED_OVER);

      await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'Failback aborted — primary unstable', {
        state: this.state,
        region: this.config.primary.region,
        reason: `Health status: ${probe.status}`,
      });
    }
  }

  // ===========================================================================
  // Failover & Failback Execution
  // ===========================================================================

  /**
   * Initiates the full failover sequence:
   *   1. Transition to FAILING_OVER
   *   2. Check split-brain guard
   *   3. Scale up secondary ECS tasks
   *   4. Wait for secondary to become healthy
   *   5. Update DNS to point to secondary
   *   6. Transition to FAILED_OVER
   *
   * @param {string} reason - Why failover was triggered
   * @private
   */
  async _initiateFailover(reason) {
    this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.info('  ⚡ FAILOVER INITIATED');
    this.logger.info(`  Reason: ${reason}`);
    this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Check cooldown
    if (this._isCooldownActive()) {
      this.logger.warn('Failover blocked — cooldown period active');
      return;
    }

    this.transitionTo(EngineState.FAILING_OVER);

    await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'FAILOVER INITIATED', {
      state: this.state,
      region: this.config.primary.region,
      reason,
      activeRegion: this.config.secondary.region,
    });

    if (this.config.engine.dryRun) {
      this.logger.info('DRY RUN — would failover to secondary, but not executing');
      this.transitionTo(EngineState.FAILED_OVER);
      this.activeRegion = 'secondary';
      this.lastFailoverTime = Date.now();
      return;
    }

    try {
      // Step 1: Acquire lock for secondary region
      const lockResult = await this.splitBrainGuard.acquireLock(this.config.secondary.region);
      if (!lockResult.acquired) {
        this.logger.error('Failed to acquire lock for secondary region — aborting failover');
        this.transitionTo(EngineState.ERROR);
        return;
      }

      // Step 2: Scale up secondary ECS
      this.logger.info('Scaling up secondary ECS service...');
      const scaleResult = await this.ecsManager.scaleUpSecondary();
      if (!scaleResult.success) {
        this.logger.error({ error: scaleResult.error }, 'Failed to scale up secondary');
        await this.splitBrainGuard.releaseLock(this.config.secondary.region);
        this.transitionTo(EngineState.ERROR);
        return;
      }

      // Step 3: Wait for secondary tasks to become healthy
      this.logger.info('Waiting for secondary ECS tasks to become healthy...');
      const healthResult = await this.ecsManager.waitForTasksHealthy('secondary', 120000);
      if (!healthResult.ready) {
        this.logger.error('Secondary ECS tasks did not become healthy in time');
        await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'Failover FAILED — secondary not ready', {
          state: this.state,
          reason: 'ECS tasks did not become healthy',
        });
        await this.splitBrainGuard.releaseLock(this.config.secondary.region);
        this.transitionTo(EngineState.ERROR);
        return;
      }

      // Step 4: Update DNS
      this.logger.info('Updating DNS to route to secondary...');
      const dnsResult = await this.dnsManager.switchToSecondary();
      if (!dnsResult.success) {
        this.logger.error({ error: dnsResult.error }, 'Failed to update DNS');
        await this.splitBrainGuard.releaseLock(this.config.secondary.region);
        this.transitionTo(EngineState.ERROR);
        return;
      }

      // Step 5: Release primary lock
      await this.splitBrainGuard.releaseLock(this.config.primary.region);

      // Step 6: Complete failover
      this.activeRegion = 'secondary';
      this.lastFailoverTime = Date.now();
      this.consecutiveFailures = 0;
      this.latencyAnalyzer.reset();
      this.cloudwatchReporter.incrementFailoverCount();
      this.transitionTo(EngineState.FAILED_OVER);

      this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.logger.info('  ✅ FAILOVER COMPLETE');
      this.logger.info(`  Traffic now routed to: ${this.config.secondary.region}`);
      this.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'FAILOVER COMPLETE', {
        state: this.state,
        activeRegion: this.config.secondary.region,
      });
    } catch (error) {
      this.logger.error({ error: error.message, stack: error.stack }, 'Failover execution failed');
      await this.notifier.sendAlert(AlertSeverity.CRITICAL, 'FAILOVER FAILED', {
        state: this.state,
        reason: error.message,
      });
      this.transitionTo(EngineState.ERROR);
    }
  }

  /**
   * Initiates the failback sequence:
   *   1. Update DNS back to primary
   *   2. Scale down secondary
   *
   * @private
   */
  async _initiateFailback() {
    this.logger.info('Initiating failback to primary region...');

    if (this.config.engine.dryRun) {
      this.logger.info('DRY RUN — would failback to primary, but not executing');
      return;
    }

    try {
      // Step 1: Acquire lock for primary
      const lockResult = await this.splitBrainGuard.acquireLock(this.config.primary.region);
      if (!lockResult.acquired) {
        this.logger.warn('Could not acquire lock for primary — staying on secondary');
        this.transitionTo(EngineState.FAILED_OVER);
        return;
      }

      // Step 2: Update DNS back to primary
      const dnsResult = await this.dnsManager.switchToPrimary();
      if (!dnsResult.success) {
        this.logger.error({ error: dnsResult.error }, 'Failed to update DNS for failback');
        await this.splitBrainGuard.releaseLock(this.config.primary.region);
        this.transitionTo(EngineState.FAILED_OVER);
        return;
      }

      // Step 3: Release secondary lock
      await this.splitBrainGuard.releaseLock(this.config.secondary.region);

      // Step 4: Scale down secondary (with delay to allow DNS propagation)
      this.logger.info('Failback DNS updated — will scale down secondary after propagation');
      setTimeout(async () => {
        try {
          await this.ecsManager.scaleDownSecondary(0);
        } catch (err) {
          this.logger.warn({ error: err.message }, 'Failed to scale down secondary after failback');
        }
      }, 30000); // 30 second delay for DNS propagation

      this.lastFailoverTime = Date.now();

      await this.notifier.sendAlert(AlertSeverity.RECOVERY, 'Failback initiated — returning to primary', {
        state: this.state,
        region: this.config.primary.region,
      });
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failback execution failed');
      this.transitionTo(EngineState.FAILED_OVER);
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Checks whether the cooldown period is still active (prevents flapping).
   *
   * @returns {boolean}
   * @private
   */
  _isCooldownActive() {
    if (!this.lastFailoverTime) {
      return false;
    }
    const elapsed = Date.now() - this.lastFailoverTime;
    const cooldown = this.config.engine.cooldownPeriodMs;

    if (elapsed < cooldown) {
      this.logger.debug(
        { elapsedMs: elapsed, cooldownMs: cooldown, remainingMs: cooldown - elapsed },
        'Cooldown period active'
      );
      return true;
    }
    return false;
  }

  /**
   * Returns the current status of the engine for status reporting.
   *
   * @returns {object} Engine status
   */
  getStatus() {
    return {
      state: this.state,
      activeRegion: this.activeRegion,
      activeRegionName: this.config[this.activeRegion]?.region,
      consecutiveFailures: this.consecutiveFailures,
      tickCount: this.tickCount,
      lastTickTime: this.lastTickTime ? new Date(this.lastTickTime).toISOString() : null,
      lastFailoverTime: this.lastFailoverTime ? new Date(this.lastFailoverTime).toISOString() : null,
      uptimeMs: this.startTime ? Date.now() - this.startTime : 0,
      dryRun: this.config.engine.dryRun,
      latency: this.latencyAnalyzer.getStatus(),
    };
  }
}
