// =============================================================================
// dnsManager.test.js — Unit tests for DnsManager
// =============================================================================

import { jest } from '@jest/globals';
import { DnsManager } from '../../src/aws/dnsManager.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  primary: {
    region: 'us-east-1',
    alb: { dnsName: 'primary-alb.us-east-1.elb.amazonaws.com' },
  },
  secondary: {
    region: 'eu-west-1',
    alb: { dnsName: 'secondary-alb.eu-west-1.elb.amazonaws.com' },
  },
  dns: {
    hostedZoneId: 'Z1234567890',
    domainName: 'app.example.com',
    ttl: 30,
    routingPolicy: 'failover',
  },
};

describe('DnsManager', () => {
  let manager;
  let mockRoute53;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRoute53 = { send: jest.fn() };
    manager = new DnsManager({
      config: baseConfig,
      logger: mockLogger,
      route53ClientOverride: mockRoute53,
    });
  });

  describe('switchToSecondary', () => {
    test('updates DNS record successfully', async () => {
      mockRoute53.send.mockResolvedValue({
        ChangeInfo: { Id: '/change/C12345' },
      });

      const result = await manager.switchToSecondary();
      expect(result.success).toBe(true);
      expect(result.changeId).toBe('/change/C12345');
      expect(mockRoute53.send).toHaveBeenCalledTimes(1);
    });

    test('handles Route 53 errors', async () => {
      mockRoute53.send.mockRejectedValue(new Error('InvalidChangeBatch'));

      const result = await manager.switchToSecondary();
      expect(result.success).toBe(false);
      expect(result.error).toBe('InvalidChangeBatch');
    });
  });

  describe('switchToPrimary', () => {
    test('updates DNS record successfully', async () => {
      mockRoute53.send.mockResolvedValue({
        ChangeInfo: { Id: '/change/C67890' },
      });

      const result = await manager.switchToPrimary();
      expect(result.success).toBe(true);
      expect(result.changeId).toBe('/change/C67890');
    });
  });

  describe('getCurrentRouting', () => {
    test('returns active DNS name', async () => {
      mockRoute53.send.mockResolvedValue({
        ResourceRecordSets: [
          {
            Name: 'app.example.com.',
            Type: 'A',
            AliasTarget: { DNSName: 'primary-alb.us-east-1.elb.amazonaws.com.' },
          },
        ],
      });

      const result = await manager.getCurrentRouting();
      expect(result.activeDnsName).toBe('primary-alb.us-east-1.elb.amazonaws.com');
    });

    test('returns null when no record found', async () => {
      mockRoute53.send.mockResolvedValue({
        ResourceRecordSets: [],
      });

      const result = await manager.getCurrentRouting();
      expect(result.activeDnsName).toBeNull();
    });

    test('returns error when not configured', async () => {
      manager.dnsConfig = { hostedZoneId: '', domainName: '' };
      const result = await manager.getCurrentRouting();
      expect(result.error).toContain('not configured');
    });
  });

  describe('waitForPropagation', () => {
    test('returns synced when status is INSYNC', async () => {
      mockRoute53.send.mockResolvedValue({
        ChangeInfo: { Status: 'INSYNC' },
      });

      const result = await manager.waitForPropagation('/change/C12345', 5000, 100);
      expect(result.synced).toBe(true);
    });

    test('times out when status stays PENDING', async () => {
      mockRoute53.send.mockResolvedValue({
        ChangeInfo: { Status: 'PENDING' },
      });

      const result = await manager.waitForPropagation('/change/C12345', 500, 100);
      expect(result.synced).toBe(false);
    });
  });
});
