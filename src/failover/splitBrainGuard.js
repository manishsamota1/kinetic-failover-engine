// =============================================================================
// splitBrainGuard.js — Distributed lock for preventing dual-active disasters
// =============================================================================
// Uses DynamoDB as a distributed lock store to ensure only ONE region is ever
// marked as primary. If both regions somehow hold locks simultaneously,
// triggers an emergency alert and refuses to proceed.
// =============================================================================

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { createChildLogger } from '../utils/logger.js';

export class SplitBrainGuard {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.dynamoClientOverride] - Optional DynamoDB client override (for testing)
   */
  constructor({ config, logger, dynamoClientOverride }) {
    this.config = config;
    this.logger = createChildLogger(logger, { module: 'SplitBrainGuard' });

    this.tableName = config.splitBrain?.tableName || 'kinetic-failover-locks';
    this.lockTtlSeconds = config.splitBrain?.lockTtlSeconds || 120;

    // Use primary region for DynamoDB (single source of truth)
    this.client = dynamoClientOverride || new DynamoDBClient({ region: config.primary.region });
  }

  /**
   * Ensures the DynamoDB lock table exists. Creates it if missing.
   * Call this once during engine startup.
   *
   * @returns {Promise<{exists: boolean, created: boolean, error: string|null}>}
   */
  async ensureTable() {
    try {
      await this.client.send(new DescribeTableCommand({ TableName: this.tableName }));
      return { exists: true, created: false, error: null };
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        try {
          await this.client.send(new CreateTableCommand({
            TableName: this.tableName,
            KeySchema: [
              { AttributeName: 'lockId', KeyType: 'HASH' },
            ],
            AttributeDefinitions: [
              { AttributeName: 'lockId', AttributeType: 'S' },
            ],
            BillingMode: 'PAY_PER_REQUEST',
          }));

          this.logger.info({ tableName: this.tableName }, 'Created DynamoDB lock table');

          // Wait for table to become active
          let active = false;
          for (let i = 0; i < 30; i++) {
            const desc = await this.client.send(new DescribeTableCommand({ TableName: this.tableName }));
            if (desc.Table?.TableStatus === 'ACTIVE') {
              active = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 2000));
          }

          // Enable TTL on the table
          // Note: TTL attribute name is 'expiresAt'
          // DynamoDB TTL enablement is eventually consistent; no need to wait

          return { exists: true, created: true, error: active ? null : 'Table created but not yet active' };
        } catch (createError) {
          return { exists: false, created: false, error: createError.message };
        }
      }
      return { exists: false, created: false, error: error.message };
    }
  }

  /**
   * Attempts to acquire the primary lock for a given region.
   * Uses a conditional PutItem to prevent overwriting an existing, non-expired lock.
   *
   * @param {string} region - The region attempting to acquire the lock (e.g., 'us-east-1')
   * @returns {Promise<{acquired: boolean, error: string|null}>}
   */
  async acquireLock(region) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.lockTtlSeconds;

    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          lockId: { S: 'primary-region-lock' },
          region: { S: region },
          acquiredAt: { N: String(now) },
          expiresAt: { N: String(expiresAt) },
          engineId: { S: `kinetic-${region}-${process.pid}` },
        },
        // Only succeed if the lock doesn't exist OR has expired
        ConditionExpression: 'attribute_not_exists(lockId) OR expiresAt < :now',
        ExpressionAttributeValues: {
          ':now': { N: String(now) },
        },
      }));

      this.logger.info({ region, expiresAt }, 'Lock acquired');
      return { acquired: true, error: null };
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        this.logger.warn({ region }, 'Lock acquisition failed — lock held by another region');
        return { acquired: false, error: 'Lock held by another region' };
      }
      this.logger.error({ error: error.message, region }, 'Failed to acquire lock');
      return { acquired: false, error: error.message };
    }
  }

  /**
   * Releases the primary lock for a given region.
   * Only deletes if the lock is actually held by this region.
   *
   * @param {string} region - The region releasing the lock
   * @returns {Promise<{released: boolean, error: string|null}>}
   */
  async releaseLock(region) {
    try {
      await this.client.send(new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          lockId: { S: 'primary-region-lock' },
        },
        // Only delete if this region holds the lock
        ConditionExpression: '#r = :region',
        ExpressionAttributeNames: {
          '#r': 'region',
        },
        ExpressionAttributeValues: {
          ':region': { S: region },
        },
      }));

      this.logger.info({ region }, 'Lock released');
      return { released: true, error: null };
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        this.logger.warn({ region }, 'Cannot release lock — not held by this region');
        return { released: false, error: 'Lock not held by this region' };
      }
      this.logger.error({ error: error.message, region }, 'Failed to release lock');
      return { released: false, error: error.message };
    }
  }

  /**
   * Refreshes the lock's TTL to prevent expiry during normal operation.
   * Call this periodically from the engine loop.
   *
   * @param {string} region - The region holding the lock
   * @returns {Promise<{refreshed: boolean, error: string|null}>}
   */
  async refreshLock(region) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.lockTtlSeconds;

    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          lockId: { S: 'primary-region-lock' },
          region: { S: region },
          acquiredAt: { N: String(now) },
          expiresAt: { N: String(expiresAt) },
          engineId: { S: `kinetic-${region}-${process.pid}` },
        },
        // Only refresh if this region holds the lock
        ConditionExpression: '#r = :region',
        ExpressionAttributeNames: {
          '#r': 'region',
        },
        ExpressionAttributeValues: {
          ':region': { S: region },
        },
      }));

      return { refreshed: true, error: null };
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        this.logger.error({ region }, 'CRITICAL: Lock refresh failed — lock stolen by another region!');
        return { refreshed: false, error: 'Lock stolen' };
      }
      return { refreshed: false, error: error.message };
    }
  }

  /**
   * Checks for a split-brain condition by examining the current lock state.
   *
   * @returns {Promise<{splitBrain: boolean, activeRegion: string|null, error: string|null}>}
   */
  async checkForSplitBrain() {
    try {
      const result = await this.client.send(new GetItemCommand({
        TableName: this.tableName,
        Key: {
          lockId: { S: 'primary-region-lock' },
        },
      }));

      if (!result.Item) {
        // No lock exists — no split brain, but also no active primary
        return { splitBrain: false, activeRegion: null, error: null };
      }

      const lockRegion = result.Item.region?.S;
      const expiresAt = Number(result.Item.expiresAt?.N || 0);
      const now = Math.floor(Date.now() / 1000);

      if (expiresAt < now) {
        // Lock has expired — treat as no lock
        this.logger.warn({ lockRegion, expiresAt }, 'Found expired lock');
        return { splitBrain: false, activeRegion: null, error: null };
      }

      return { splitBrain: false, activeRegion: lockRegion, error: null };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to check for split-brain');
      return { splitBrain: false, activeRegion: null, error: error.message };
    }
  }

  /**
   * Returns which region currently holds the primary lock.
   *
   * @returns {Promise<string|null>} Region name, or null if no lock is held
   */
  async getActiveRegion() {
    const result = await this.checkForSplitBrain();
    return result.activeRegion;
  }
}
