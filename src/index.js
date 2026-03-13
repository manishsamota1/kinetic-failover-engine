#!/usr/bin/env node
// =============================================================================
// index.js — CLI entry point for the Kinetic Failover Engine
// =============================================================================
// Commands:
//   node src/index.js start      — Start the engine (runs continuously)
//   node src/index.js dry-run    — Start in dry-run mode (no AWS changes)
//   node src/index.js status     — Print current engine status (if running)
//   node src/index.js --help     — Show help
// =============================================================================

import { startEngine, stopEngine, getEngineStatus } from './engine.js';

// ---- Parse CLI arguments ----
const args = process.argv.slice(2);
const command = args[0] || 'start';

// ---- Help text ----
const HELP_TEXT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KINETIC FAILOVER ENGINE
  Zero-Downtime Regional Failover for AWS ECS/ALB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USAGE:
  node src/index.js <command>

COMMANDS:
  start      Start the failover engine (default)
  dry-run    Start in dry-run mode (logs actions without executing)
  status     Print the current engine status
  --help     Show this help message

CONFIGURATION:
  Edit config/default.yaml or set environment variables.
  See .env.example for the full list of environment variables.

EXAMPLES:
  node src/index.js start          # Start the engine
  node src/index.js dry-run        # Test without making AWS changes
  DRY_RUN=true npm start           # Same as dry-run via env var

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

// ---- Graceful shutdown handler ----
function setupGracefulShutdown() {
  const shutdownHandler = async (signal) => {
    console.log(`\n\nReceived ${signal} — shutting down gracefully...`);
    try {
      await stopEngine();
      console.log('Engine stopped. Goodbye.');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdownHandler('SIGINT'));
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    console.error('FATAL: Uncaught exception:', error.message);
    console.error(error.stack);
    try {
      await stopEngine();
    } catch (_) {
      // Best effort
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('FATAL: Unhandled promise rejection:', reason);
    try {
      await stopEngine();
    } catch (_) {
      // Best effort
    }
    process.exit(1);
  });
}

// ---- Command dispatch ----
async function main() {
  switch (command) {
    case 'start': {
      setupGracefulShutdown();
      console.log('Starting Kinetic Failover Engine...\n');
      await startEngine();
      // Engine runs in setInterval — process stays alive
      break;
    }

    case 'dry-run': {
      setupGracefulShutdown();
      console.log('Starting Kinetic Failover Engine in DRY RUN mode...\n');
      console.log('  ℹ️  No AWS resources will be modified.\n');
      await startEngine({ dryRun: true });
      break;
    }

    case 'status': {
      const status = getEngineStatus();
      if (!status) {
        console.log('Engine is not running in this process.');
        console.log('Note: "status" only works when checking a running engine in the same process.');
      } else {
        console.log('\n━━━━ ENGINE STATUS ━━━━');
        console.log(JSON.stringify(status, null, 2));
        console.log('━━━━━━━━━━━━━━━━━━━━━━\n');
      }
      break;
    }

    case '--help':
    case '-h':
    case 'help': {
      console.log(HELP_TEXT);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP_TEXT);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error('FATAL: Failed to start engine:', error.message);
  console.error(error.stack);
  process.exit(1);
});
