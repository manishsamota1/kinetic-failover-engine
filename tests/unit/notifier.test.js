// =============================================================================
// notifier.test.js — Unit tests for the Notifier
// =============================================================================

import { jest } from '@jest/globals';
import { Notifier } from '../../src/alerting/notifier.js';
import { AlertSeverity } from '../../src/utils/constants.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  primary: { region: 'us-east-1' },
  alerting: {
    sns: { enabled: true, topicArn: 'arn:aws:sns:us-east-1:123:test-topic' },
    slack: { enabled: false, webhookUrl: '' },
    pagerDuty: { enabled: false, routingKey: '' },
  },
};

describe('Notifier', () => {
  let notifier;
  let mockSns;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSns = { send: jest.fn().mockResolvedValue({}) };
    notifier = new Notifier({
      config: baseConfig,
      logger: mockLogger,
      snsClientOverride: mockSns,
    });
  });

  describe('sendAlert', () => {
    test('sends alert via enabled channels', async () => {
      await notifier.sendAlert(AlertSeverity.CRITICAL, 'Test alert', {
        state: 'FAILING_OVER',
        region: 'us-east-1',
      });

      // SNS is enabled, should have been called
      expect(mockSns.send).toHaveBeenCalledTimes(1);
    });

    test('does not crash on channel failure', async () => {
      mockSns.send.mockRejectedValue(new Error('SNS Error'));

      // Should not throw
      await expect(
        notifier.sendAlert(AlertSeverity.CRITICAL, 'Test', {})
      ).resolves.not.toThrow();
    });

    test('logs the alert', async () => {
      await notifier.sendAlert(AlertSeverity.WARNING, 'Degraded', {});
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('_formatMessage', () => {
    test('includes all fields in formatted message', () => {
      const message = notifier._formatMessage(
        AlertSeverity.CRITICAL,
        'Test Event',
        {
          state: 'FAILING_OVER',
          region: 'us-east-1',
          reason: 'Threshold exceeded',
          latencyMs: 500,
        },
        '2024-01-01T00:00:00Z'
      );

      expect(message).toContain('CRITICAL');
      expect(message).toContain('Test Event');
      expect(message).toContain('FAILING_OVER');
      expect(message).toContain('us-east-1');
      expect(message).toContain('Threshold exceeded');
      expect(message).toContain('500');
    });
  });
});
