// =============================================================================
// engine.js — Wires all components together and manages the engine lifecycle
// =============================================================================
// This is the "factory" that creates every module, injects dependencies,
// and exposes a clean startEngine() / stopEngine() API.
// =============================================================================

import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { HealthChecker } from './monitor/healthChecker.js';
import { LatencyAnalyzer } from './monitor/latencyAnalyzer.js';
import { DnsManager } from './aws/dnsManager.js';
import { EcsManager } from './aws/ecsManager.js';
import { CloudWatchReporter } from './aws/cloudwatchReporter.js';
import { SplitBrainGuard } from './failover/splitBrainGuard.js';
import { Notifier } from './alerting/notifier.js';
import { Orchestrator } from './failover/orchestrator.js';

/** @type {Orchestrator|null} */
let orchestrator = null;

/**
 * Creates all components, wires them together, and starts the orchestrator.
 *
 * @param {object} [options]
 * @param {string} [options.configPath] - Path to YAML config file
 * @param {boolean} [options.dryRun] - Override dry-run setting
 * @returns {Promise<Orchestrator>} The running orchestrator instance
 */
export async function startEngine(options = {}) {
  // ---- 1. Load & validate config ----
  const config = loadConfig(options.configPath);

  // Allow dry-run override from CLI
  if (options.dryRun !== undefined) {
    // Config is frozen, so we create a mutable copy for this override
    const mutableConfig = JSON.parse(JSON.stringify(config));
    mutableConfig.engine.dryRun = options.dryRun;
    return _startWithConfig(mutableConfig);
  }

  return _startWithConfig(config);
}

/**
 * Internal startup with a given config object.
 *
 * @param {object} config
 * @returns {Promise<Orchestrator>}
 * @private
 */
async function _startWithConfig(config) {
  // ---- 2. Create logger ----
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
  });

  logger.info('Initializing Kinetic Failover Engine...');

  // ---- 3. Create all components ----
  const healthChecker = new HealthChecker({ config, logger });
  const latencyAnalyzer = new LatencyAnalyzer({ config, logger });
  const dnsManager = new DnsManager({ config, logger });
  const ecsManager = new EcsManager({ config, logger });
  const cloudwatchReporter = new CloudWatchReporter({ config, logger });
  const splitBrainGuard = new SplitBrainGuard({ config, logger });
  const notifier = new Notifier({ config, logger });

  // ---- 4. Ensure DynamoDB lock table exists ----
  if (!config.engine.dryRun) {
    logger.info('Ensuring DynamoDB lock table exists...');
    const tableResult = await splitBrainGuard.ensureTable();
    if (tableResult.error) {
      logger.warn({ error: tableResult.error }, 'Could not verify lock table — continuing anyway');
    } else if (tableResult.created) {
      logger.info('DynamoDB lock table created');
    } else {
      logger.info('DynamoDB lock table already exists');
    }
  }

  // ---- 5. Create orchestrator ----
  orchestrator = new Orchestrator({
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

  // ---- 6. Start the engine ----
  await orchestrator.start();

  return orchestrator;
}

/**
 * Gracefully stops the engine.
 *
 * @returns {Promise<void>}
 */
export async function stopEngine() {
  if (orchestrator) {
    await orchestrator.stop();
    orchestrator = null;
  }
}

/**
 * Returns the current orchestrator's status, or null if not running.
 *
 * @returns {object|null}
 */
export function getEngineStatus() {
  if (!orchestrator) {
    return null;
  }
  return orchestrator.getStatus();
}
