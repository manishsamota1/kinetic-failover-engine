// =============================================================================
// config.js — YAML configuration loader with env-var overrides & validation
// =============================================================================
// Loads config/default.yaml, merges with environment variables (env wins),
// validates with AJV against a strict JSON schema, and exports a frozen object.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import dotenv from 'dotenv';
import { Defaults } from './constants.js';

// Load .env file if present (no-op if missing)
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// JSON Schema for configuration validation
// ---------------------------------------------------------------------------
const configSchema = {
  type: 'object',
  required: ['engine', 'primary', 'secondary', 'dns', 'splitBrain', 'alerting', 'logging'],
  properties: {
    engine: {
      type: 'object',
      required: ['healthCheckIntervalMs', 'latencyThresholdMs', 'failureThreshold', 'cooldownPeriodMs'],
      properties: {
        healthCheckIntervalMs: { type: 'number', minimum: 1000 },
        latencyThresholdMs: { type: 'number', minimum: 10 },
        failureThreshold: { type: 'integer', minimum: 1 },
        cooldownPeriodMs: { type: 'number', minimum: 5000 },
        latencyWindowSize: { type: 'integer', minimum: 5 },
        dryRun: { type: 'boolean' },
      },
    },
    primary: {
      type: 'object',
      required: ['region'],
      properties: {
        region: { type: 'string', minLength: 1 },
        alb: { type: 'object' },
        ecs: { type: 'object' },
      },
    },
    secondary: {
      type: 'object',
      required: ['region'],
      properties: {
        region: { type: 'string', minLength: 1 },
        alb: { type: 'object' },
        ecs: { type: 'object' },
      },
    },
    dns: {
      type: 'object',
      properties: {
        hostedZoneId: { type: 'string' },
        domainName: { type: 'string' },
        ttl: { type: 'integer', minimum: 1 },
        routingPolicy: { type: 'string', enum: ['failover', 'weighted'] },
      },
    },
    splitBrain: {
      type: 'object',
      properties: {
        tableName: { type: 'string' },
        lockTtlSeconds: { type: 'integer', minimum: 10 },
      },
    },
    alerting: { type: 'object' },
    cloudwatch: { type: 'object' },
    logging: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] },
        format: { type: 'string', enum: ['json', 'pretty'] },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Environment variable → config mapping
// ---------------------------------------------------------------------------
function applyEnvOverrides(config) {
  const env = process.env;

  // Engine tuning
  if (env.HEALTH_CHECK_INTERVAL_MS) { config.engine.healthCheckIntervalMs = Number(env.HEALTH_CHECK_INTERVAL_MS); }
  if (env.LATENCY_THRESHOLD_MS) { config.engine.latencyThresholdMs = Number(env.LATENCY_THRESHOLD_MS); }
  if (env.FAILURE_THRESHOLD) { config.engine.failureThreshold = Number(env.FAILURE_THRESHOLD); }
  if (env.COOLDOWN_PERIOD_MS) { config.engine.cooldownPeriodMs = Number(env.COOLDOWN_PERIOD_MS); }
  if (env.DRY_RUN) { config.engine.dryRun = env.DRY_RUN === 'true'; }

  // Regions
  if (env.AWS_REGION_PRIMARY) { config.primary.region = env.AWS_REGION_PRIMARY; }
  if (env.AWS_REGION_SECONDARY) { config.secondary.region = env.AWS_REGION_SECONDARY; }

  // ALB
  if (env.ALB_ARN_PRIMARY) { config.primary.alb.arn = env.ALB_ARN_PRIMARY; }
  if (env.ALB_DNS_PRIMARY) { config.primary.alb.dnsName = env.ALB_DNS_PRIMARY; }
  if (env.ALB_TARGET_GROUP_ARN_PRIMARY) { config.primary.alb.targetGroupArn = env.ALB_TARGET_GROUP_ARN_PRIMARY; }
  if (env.ALB_ARN_SECONDARY) { config.secondary.alb.arn = env.ALB_ARN_SECONDARY; }
  if (env.ALB_DNS_SECONDARY) { config.secondary.alb.dnsName = env.ALB_DNS_SECONDARY; }
  if (env.ALB_TARGET_GROUP_ARN_SECONDARY) { config.secondary.alb.targetGroupArn = env.ALB_TARGET_GROUP_ARN_SECONDARY; }

  // ECS
  if (env.ECS_CLUSTER_PRIMARY) { config.primary.ecs.clusterName = env.ECS_CLUSTER_PRIMARY; }
  if (env.ECS_SERVICE_PRIMARY) { config.primary.ecs.serviceName = env.ECS_SERVICE_PRIMARY; }
  if (env.ECS_TASK_DEFINITION_PRIMARY) { config.primary.ecs.taskDefinition = env.ECS_TASK_DEFINITION_PRIMARY; }
  if (env.ECS_CLUSTER_SECONDARY) { config.secondary.ecs.clusterName = env.ECS_CLUSTER_SECONDARY; }
  if (env.ECS_SERVICE_SECONDARY) { config.secondary.ecs.serviceName = env.ECS_SERVICE_SECONDARY; }
  if (env.ECS_TASK_DEFINITION_SECONDARY) { config.secondary.ecs.taskDefinition = env.ECS_TASK_DEFINITION_SECONDARY; }

  // DNS
  if (env.ROUTE53_HOSTED_ZONE_ID) { config.dns.hostedZoneId = env.ROUTE53_HOSTED_ZONE_ID; }
  if (env.ROUTE53_DOMAIN_NAME) { config.dns.domainName = env.ROUTE53_DOMAIN_NAME; }
  if (env.DNS_TTL) { config.dns.ttl = Number(env.DNS_TTL); }

  // Split-brain
  if (env.DYNAMODB_LOCK_TABLE) { config.splitBrain.tableName = env.DYNAMODB_LOCK_TABLE; }

  // Alerting
  if (env.SNS_TOPIC_ARN) {
    config.alerting.sns.enabled = true;
    config.alerting.sns.topicArn = env.SNS_TOPIC_ARN;
  }
  if (env.SLACK_WEBHOOK_URL) {
    config.alerting.slack.enabled = true;
    config.alerting.slack.webhookUrl = env.SLACK_WEBHOOK_URL;
  }
  if (env.PAGERDUTY_ROUTING_KEY) {
    config.alerting.pagerDuty.enabled = true;
    config.alerting.pagerDuty.routingKey = env.PAGERDUTY_ROUTING_KEY;
  }

  // Logging
  if (env.LOG_LEVEL) { config.logging.level = env.LOG_LEVEL; }

  return config;
}

// ---------------------------------------------------------------------------
// Load, merge, validate, freeze
// ---------------------------------------------------------------------------

/**
 * Loads configuration from YAML file, merges with environment variables,
 * validates against schema, and returns a deeply frozen config object.
 *
 * @param {string} [configPath] - Optional path to YAML config file.
 *   Defaults to ../../config/default.yaml relative to this module.
 * @returns {object} Validated, frozen configuration object
 * @throws {Error} If config file is missing or validation fails
 */
export function loadConfig(configPath) {
  const filePath = configPath || resolve(__dirname, '..', '..', 'config', 'default.yaml');

  let rawYaml;
  try {
    rawYaml = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${filePath}: ${err.message}`);
  }

  let config;
  try {
    config = yaml.load(rawYaml);
  } catch (err) {
    throw new Error(`Failed to parse YAML config: ${err.message}`);
  }

  // Apply environment variable overrides
  config = applyEnvOverrides(config);

  // Validate against schema
  const ajv = new Ajv({ allErrors: true, useDefaults: true });
  const validate = ajv.compile(configSchema);
  const valid = validate(config);

  if (!valid) {
    const errors = validate.errors
      .map((e) => `  - ${e.instancePath || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  // Deep freeze to prevent accidental mutation
  return deepFreeze(config);
}

/**
 * Recursively freezes an object and all nested objects.
 * @param {object} obj
 * @returns {object} The same object, deeply frozen
 */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}
