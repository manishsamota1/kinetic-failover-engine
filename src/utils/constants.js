// =============================================================================
// constants.js — Enums, thresholds, and default values for the failover engine
// =============================================================================

/**
 * Engine states — the finite state machine that governs failover behavior.
 *
 *   MONITORING → DEGRADED → FAILING_OVER → FAILED_OVER → RECOVERING → MONITORING
 *
 * Each state has specific entry/exit conditions and allowed transitions.
 */
export const EngineState = Object.freeze({
  /** Normal operation — primary region is healthy, traffic flowing normally */
  MONITORING: 'MONITORING',

  /** Primary region showing signs of trouble (latency spikes, partial failures) */
  DEGRADED: 'DEGRADED',

  /** Actively executing failover: spinning up secondary ECS, updating DNS */
  FAILING_OVER: 'FAILING_OVER',

  /** Failover complete — traffic is now flowing to the secondary region */
  FAILED_OVER: 'FAILED_OVER',

  /** Primary region is back — gradually shifting traffic back */
  RECOVERING: 'RECOVERING',

  /** Engine is stopped / not yet started */
  STOPPED: 'STOPPED',

  /** An unrecoverable error has occurred */
  ERROR: 'ERROR',
});

/**
 * Valid state transitions. The key is the current state,
 * the value is an array of states that can be transitioned to.
 */
export const ValidTransitions = Object.freeze({
  [EngineState.STOPPED]: [EngineState.MONITORING],
  [EngineState.MONITORING]: [EngineState.DEGRADED, EngineState.FAILING_OVER, EngineState.STOPPED, EngineState.ERROR],
  [EngineState.DEGRADED]: [EngineState.MONITORING, EngineState.FAILING_OVER, EngineState.STOPPED, EngineState.ERROR],
  [EngineState.FAILING_OVER]: [EngineState.FAILED_OVER, EngineState.ERROR],
  [EngineState.FAILED_OVER]: [EngineState.RECOVERING, EngineState.STOPPED, EngineState.ERROR],
  [EngineState.RECOVERING]: [EngineState.MONITORING, EngineState.FAILED_OVER, EngineState.ERROR],
  [EngineState.ERROR]: [EngineState.STOPPED],
});

/**
 * Health status reported by the health checker.
 */
export const HealthStatus = Object.freeze({
  /** All targets healthy, latency within threshold */
  HEALTHY: 'HEALTHY',

  /** Some targets unhealthy or latency elevated (but service still responsive) */
  DEGRADED: 'DEGRADED',

  /** ALB unreachable, all targets down, or HTTP check failed */
  UNHEALTHY: 'UNHEALTHY',

  /** Could not determine health (e.g., network error to AWS API) */
  UNKNOWN: 'UNKNOWN',
});

/**
 * Alert severity levels for the notification system.
 */
export const AlertSeverity = Object.freeze({
  /** Informational — state change logged, no action needed */
  INFO: 'INFO',

  /** Warning — degraded performance detected, monitoring closely */
  WARNING: 'WARNING',

  /** Critical — failover triggered or split-brain detected */
  CRITICAL: 'CRITICAL',

  /** Recovery — primary region back online, failback initiated or complete */
  RECOVERY: 'RECOVERY',
});

/**
 * Default configuration values. These are used if not overridden in
 * config/default.yaml or environment variables.
 */
export const Defaults = Object.freeze({
  HEALTH_CHECK_INTERVAL_MS: 5000,
  LATENCY_THRESHOLD_MS: 200,
  FAILURE_THRESHOLD: 3,
  COOLDOWN_PERIOD_MS: 60000,
  LATENCY_WINDOW_SIZE: 60,
  DNS_TTL: 30,
  LOCK_TTL_SECONDS: 120,
  HTTP_TIMEOUT_MS: 5000,
  CLOUDWATCH_PUBLISH_INTERVAL_MS: 60000,
  LOG_LEVEL: 'info',
});
