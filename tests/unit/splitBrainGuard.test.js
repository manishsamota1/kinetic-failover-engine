// =============================================================================
// splitBrainGuard.test.js — Unit tests for SplitBrainGuard
// =============================================================================

import { jest } from '@jest/globals';
import { SplitBrainGuard } from '../../src/failover/splitBrainGuard.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  primary: { region: 'us-east-1' },
  secondary: { region: 'eu-west-1' },
  splitBrain: {
    tableName: 'test-locks',
    lockTtlSeconds: 120,
  },
};

describe('SplitBrainGuard', () => {
  let guard;
  let mockDynamo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamo = { send: jest.fn() };
    guard = new SplitBrainGuard({
      config: baseConfig,
      logger: mockLogger,
      dynamoClientOverride: mockDynamo,
    });
  });

  describe('acquireLock', () => {
    test('successfully acquires lock when none exists', async () => {
      mockDynamo.send.mockResolvedValue({});
      const result = await guard.acquireLock('us-east-1');
      expect(result.acquired).toBe(true);
      expect(result.error).toBeNull();
    });

    test('fails to acquire lock when held by another region', async () => {
      const error = new Error('Conditional check failed');
      error.name = 'ConditionalCheckFailedException';
      mockDynamo.send.mockRejectedValue(error);

      const result = await guard.acquireLock('eu-west-1');
      expect(result.acquired).toBe(false);
      expect(result.error).toContain('Lock held');
    });

    test('handles DynamoDB errors gracefully', async () => {
      mockDynamo.send.mockRejectedValue(new Error('ServiceUnavailable'));
      const result = await guard.acquireLock('us-east-1');
      expect(result.acquired).toBe(false);
      expect(result.error).toBe('ServiceUnavailable');
    });
  });

  describe('releaseLock', () => {
    test('successfully releases lock held by this region', async () => {
      mockDynamo.send.mockResolvedValue({});
      const result = await guard.releaseLock('us-east-1');
      expect(result.released).toBe(true);
    });

    test('fails to release lock not held by this region', async () => {
      const error = new Error('Conditional check failed');
      error.name = 'ConditionalCheckFailedException';
      mockDynamo.send.mockRejectedValue(error);

      const result = await guard.releaseLock('eu-west-1');
      expect(result.released).toBe(false);
    });
  });

  describe('refreshLock', () => {
    test('successfully refreshes lock TTL', async () => {
      mockDynamo.send.mockResolvedValue({});
      const result = await guard.refreshLock('us-east-1');
      expect(result.refreshed).toBe(true);
    });

    test('detects stolen lock', async () => {
      const error = new Error('Conditional check failed');
      error.name = 'ConditionalCheckFailedException';
      mockDynamo.send.mockRejectedValue(error);

      const result = await guard.refreshLock('us-east-1');
      expect(result.refreshed).toBe(false);
      expect(result.error).toBe('Lock stolen');
    });
  });

  describe('checkForSplitBrain', () => {
    test('no split brain when no lock exists', async () => {
      mockDynamo.send.mockResolvedValue({ Item: null });
      const result = await guard.checkForSplitBrain();
      expect(result.splitBrain).toBe(false);
      expect(result.activeRegion).toBeNull();
    });

    test('returns active region when lock exists and is valid', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
      mockDynamo.send.mockResolvedValue({
        Item: {
          region: { S: 'us-east-1' },
          expiresAt: { N: String(futureExpiry) },
        },
      });

      const result = await guard.checkForSplitBrain();
      expect(result.splitBrain).toBe(false);
      expect(result.activeRegion).toBe('us-east-1');
    });

    test('treats expired lock as no lock', async () => {
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
      mockDynamo.send.mockResolvedValue({
        Item: {
          region: { S: 'us-east-1' },
          expiresAt: { N: String(pastExpiry) },
        },
      });

      const result = await guard.checkForSplitBrain();
      expect(result.activeRegion).toBeNull();
    });
  });

  describe('getActiveRegion', () => {
    test('returns region when lock is held', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
      mockDynamo.send.mockResolvedValue({
        Item: {
          region: { S: 'eu-west-1' },
          expiresAt: { N: String(futureExpiry) },
        },
      });

      const region = await guard.getActiveRegion();
      expect(region).toBe('eu-west-1');
    });
  });
});
