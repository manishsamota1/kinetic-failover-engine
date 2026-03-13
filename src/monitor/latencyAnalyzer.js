// =============================================================================
// latencyAnalyzer.js — Latency spike detection using sliding window analysis
// =============================================================================
// Maintains a circular buffer of recent latency samples and computes
// percentiles (P50, P95, P99). Detects anomalous latency spikes via
// threshold comparison and rate-of-increase gradient analysis.
// =============================================================================

import { createChildLogger } from '../utils/logger.js';

export class LatencyAnalyzer {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = createChildLogger(logger, { module: 'LatencyAnalyzer' });

    /** @type {number} Maximum number of samples to retain */
    this.windowSize = config.engine.latencyWindowSize || 60;

    /** @type {number} Latency threshold in ms — above this is "degraded" */
    this.thresholdMs = config.engine.latencyThresholdMs || 200;

    /** @type {number[]} Circular buffer of latency samples */
    this.samples = [];

    /** @type {number} Current write position in the circular buffer */
    this.cursor = 0;

    /** @type {boolean} Whether the buffer has wrapped around at least once */
    this.filled = false;
  }

  /**
   * Adds a new latency sample to the sliding window.
   *
   * @param {number} latencyMs - Measured latency in milliseconds
   */
  addSample(latencyMs) {
    if (typeof latencyMs !== 'number' || latencyMs < 0) {
      this.logger.warn({ latencyMs }, 'Invalid latency sample ignored');
      return;
    }

    if (this.samples.length < this.windowSize) {
      // Buffer not yet full — just push
      this.samples.push(latencyMs);
    } else {
      // Buffer full — overwrite at cursor position (circular)
      this.samples[this.cursor] = latencyMs;
      this.filled = true;
    }

    this.cursor = (this.cursor + 1) % this.windowSize;
  }

  /**
   * Returns all samples currently in the window, sorted ascending.
   *
   * @returns {number[]} Sorted copy of current latency samples
   */
  getSortedSamples() {
    return [...this.samples].sort((a, b) => a - b);
  }

  /**
   * Computes the Nth percentile of the current sample window.
   *
   * @param {number} percentile - Percentile to compute (0-100)
   * @returns {number|null} The percentile value, or null if no samples
   */
  getPercentile(percentile) {
    if (this.samples.length === 0) {
      return null;
    }

    const sorted = this.getSortedSamples();
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * @returns {number|null} 50th percentile (median) latency
   */
  getP50() {
    return this.getPercentile(50);
  }

  /**
   * @returns {number|null} 95th percentile latency
   */
  getP95() {
    return this.getPercentile(95);
  }

  /**
   * @returns {number|null} 99th percentile latency
   */
  getP99() {
    return this.getPercentile(99);
  }

  /**
   * @returns {number|null} Average latency across the window
   */
  getAverage() {
    if (this.samples.length === 0) {
      return null;
    }
    const sum = this.samples.reduce((acc, val) => acc + val, 0);
    return Math.round(sum / this.samples.length);
  }

  /**
   * Computes the rate of increase in latency over the most recent samples.
   * Uses linear regression slope over the last N samples (or all if < N).
   *
   * @param {number} [recentCount=10] - Number of recent samples to analyze
   * @returns {number} Slope of latency trend (ms per sample). Positive = increasing.
   */
  getGradient(recentCount = 10) {
    const n = Math.min(recentCount, this.samples.length);
    if (n < 2) {
      return 0;
    }

    // Get the last N samples in chronological order
    const recent = [];
    for (let i = 0; i < n; i++) {
      // Walk backwards from the most recent entry
      const idx = ((this.cursor - 1 - i) % this.samples.length + this.samples.length) % this.samples.length;
      recent.unshift(this.samples[idx]);
    }

    // Simple linear regression: y = mx + b, compute m (slope)
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((s, v) => s + v, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (recent[i] - yMean);
      denominator += (i - xMean) ** 2;
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Determines whether the current latency pattern is anomalous.
   *
   * Anomalous = true if ANY of:
   *   1. P95 exceeds the configured threshold
   *   2. Latency gradient (rate of increase) exceeds 20ms/sample
   *      (sudden spike detection — latency is climbing rapidly)
   *
   * @returns {{anomalous: boolean, reason: string|null, p50: number|null, p95: number|null, p99: number|null, gradient: number}}
   */
  isLatencyAnomalous() {
    const p50 = this.getP50();
    const p95 = this.getP95();
    const p99 = this.getP99();
    const gradient = this.getGradient();

    // Not enough data to make a determination
    if (p95 === null) {
      return { anomalous: false, reason: null, p50, p95, p99, gradient };
    }

    // Check #1: P95 over threshold
    if (p95 > this.thresholdMs) {
      const reason = `P95 latency (${p95}ms) exceeds threshold (${this.thresholdMs}ms)`;
      this.logger.warn({ p50, p95, p99, gradient, threshold: this.thresholdMs }, reason);
      return { anomalous: true, reason, p50, p95, p99, gradient };
    }

    // Check #2: Rapid increase (gradient > 20ms/sample)
    const gradientThreshold = 20;
    if (gradient > gradientThreshold) {
      const reason = `Latency increasing rapidly (gradient: ${gradient.toFixed(1)}ms/sample)`;
      this.logger.warn({ p50, p95, p99, gradient }, reason);
      return { anomalous: true, reason, p50, p95, p99, gradient };
    }

    return { anomalous: false, reason: null, p50, p95, p99, gradient };
  }

  /**
   * Clears all samples and resets the analyzer.
   * Call this after a failover or failback event to start fresh.
   */
  reset() {
    this.samples = [];
    this.cursor = 0;
    this.filled = false;
    this.logger.info('Latency analyzer reset');
  }

  /**
   * Returns a summary of the current state for status reporting.
   *
   * @returns {object} Current analyzer state
   */
  getStatus() {
    return {
      sampleCount: this.samples.length,
      windowSize: this.windowSize,
      p50: this.getP50(),
      p95: this.getP95(),
      p99: this.getP99(),
      average: this.getAverage(),
      gradient: this.getGradient(),
      thresholdMs: this.thresholdMs,
    };
  }
}
