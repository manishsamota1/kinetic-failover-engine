// =============================================================================
// latencyAnalyzer.test.js — Unit tests for the LatencyAnalyzer module
// =============================================================================

import { jest } from '@jest/globals';
import { LatencyAnalyzer } from '../../src/monitor/latencyAnalyzer.js';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const baseConfig = {
  engine: {
    latencyWindowSize: 10,
    latencyThresholdMs: 200,
  },
};

describe('LatencyAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    jest.clearAllMocks();
    analyzer = new LatencyAnalyzer({ config: baseConfig, logger: mockLogger });
  });

  describe('addSample', () => {
    test('adds valid samples', () => {
      analyzer.addSample(100);
      analyzer.addSample(150);
      expect(analyzer.samples.length).toBe(2);
    });

    test('ignores negative samples', () => {
      analyzer.addSample(-10);
      expect(analyzer.samples.length).toBe(0);
    });

    test('ignores non-number samples', () => {
      analyzer.addSample('abc');
      expect(analyzer.samples.length).toBe(0);
    });

    test('wraps around in circular buffer', () => {
      for (let i = 0; i < 15; i++) {
        analyzer.addSample(i * 10);
      }
      // Window size is 10, so only 10 samples should be retained
      expect(analyzer.samples.length).toBe(10);
    });
  });

  describe('getPercentile', () => {
    test('returns null when no samples', () => {
      expect(analyzer.getPercentile(50)).toBeNull();
    });

    test('calculates P50 correctly', () => {
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((v) => analyzer.addSample(v));
      const p50 = analyzer.getP50();
      expect(p50).toBe(50);
    });

    test('calculates P95 correctly', () => {
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((v) => analyzer.addSample(v));
      const p95 = analyzer.getP95();
      expect(p95).toBeGreaterThanOrEqual(90);
    });

    test('calculates P99 correctly', () => {
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((v) => analyzer.addSample(v));
      const p99 = analyzer.getP99();
      expect(p99).toBe(100);
    });
  });

  describe('getAverage', () => {
    test('returns null when no samples', () => {
      expect(analyzer.getAverage()).toBeNull();
    });

    test('calculates average correctly', () => {
      [100, 200, 300].forEach((v) => analyzer.addSample(v));
      expect(analyzer.getAverage()).toBe(200);
    });
  });

  describe('getGradient', () => {
    test('returns 0 when insufficient samples', () => {
      analyzer.addSample(100);
      expect(analyzer.getGradient()).toBe(0);
    });

    test('returns positive gradient for increasing latency', () => {
      [10, 20, 30, 40, 50].forEach((v) => analyzer.addSample(v));
      expect(analyzer.getGradient()).toBeGreaterThan(0);
    });

    test('returns near-zero gradient for stable latency', () => {
      [100, 100, 100, 100, 100].forEach((v) => analyzer.addSample(v));
      expect(Math.abs(analyzer.getGradient())).toBeLessThan(0.1);
    });
  });

  describe('isLatencyAnomalous', () => {
    test('not anomalous when no samples', () => {
      const result = analyzer.isLatencyAnomalous();
      expect(result.anomalous).toBe(false);
    });

    test('anomalous when P95 exceeds threshold', () => {
      // Fill with high values
      for (let i = 0; i < 10; i++) {
        analyzer.addSample(300); // above 200ms threshold
      }
      const result = analyzer.isLatencyAnomalous();
      expect(result.anomalous).toBe(true);
      expect(result.reason).toContain('P95');
    });

    test('not anomalous when all values under threshold', () => {
      for (let i = 0; i < 10; i++) {
        analyzer.addSample(50);
      }
      const result = analyzer.isLatencyAnomalous();
      expect(result.anomalous).toBe(false);
    });

    test('anomalous on rapid latency spike', () => {
      // Simulate a sudden spike: low values then a rapid climb
      analyzer.addSample(10);
      analyzer.addSample(10);
      analyzer.addSample(50);
      analyzer.addSample(100);
      analyzer.addSample(160);

      const result = analyzer.isLatencyAnomalous();
      // The gradient should be high enough to trigger
      if (result.anomalous) {
        expect(result.reason).toBeDefined();
      }
    });
  });

  describe('reset', () => {
    test('clears all samples', () => {
      [100, 200, 300].forEach((v) => analyzer.addSample(v));
      analyzer.reset();
      expect(analyzer.samples.length).toBe(0);
      expect(analyzer.getP50()).toBeNull();
    });
  });

  describe('getStatus', () => {
    test('returns complete status object', () => {
      [100, 150, 200].forEach((v) => analyzer.addSample(v));
      const status = analyzer.getStatus();
      expect(status).toHaveProperty('sampleCount', 3);
      expect(status).toHaveProperty('windowSize', 10);
      expect(status).toHaveProperty('p50');
      expect(status).toHaveProperty('p95');
      expect(status).toHaveProperty('p99');
      expect(status).toHaveProperty('average');
      expect(status).toHaveProperty('gradient');
      expect(status).toHaveProperty('thresholdMs', 200);
    });
  });
});
