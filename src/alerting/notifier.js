// =============================================================================
// notifier.js — Multi-channel alerting (SNS, Slack, PagerDuty)
// =============================================================================
// Dispatches alerts to all configured channels. Failures in one channel
// won't affect others or crash the engine.
// =============================================================================

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import axios from 'axios';
import { AlertSeverity } from '../utils/constants.js';
import { createChildLogger } from '../utils/logger.js';

export class Notifier {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.snsClientOverride] - Optional SNS client override (for testing)
   */
  constructor({ config, logger, snsClientOverride }) {
    this.config = config;
    this.alertConfig = config.alerting || {};
    this.logger = createChildLogger(logger, { module: 'Notifier' });

    this.snsClient = snsClientOverride || new SNSClient({ region: config.primary.region });
  }

  /**
   * Sends an alert to all enabled channels. Each channel is independent —
   * a failure in one won't prevent others from receiving the alert.
   *
   * @param {string} severity - One of AlertSeverity values (INFO, WARNING, CRITICAL, RECOVERY)
   * @param {string} title - Short summary of the event
   * @param {object} details - Additional context
   * @param {string} [details.state] - Current engine state
   * @param {string} [details.region] - Affected region
   * @param {string} [details.reason] - Why this alert was triggered
   * @param {number} [details.latencyMs] - Current latency
   */
  async sendAlert(severity, title, details = {}) {
    const timestamp = new Date().toISOString();
    const message = this._formatMessage(severity, title, details, timestamp);

    this.logger.info({ severity, title }, `Alert: ${title}`);

    // Fire all channels in parallel — don't wait for one to complete before starting another
    const results = await Promise.allSettled([
      this.alertConfig.sns?.enabled ? this._notifySns(message, severity) : Promise.resolve('disabled'),
      this.alertConfig.slack?.enabled ? this._notifySlack(message, severity, title) : Promise.resolve('disabled'),
      this.alertConfig.pagerDuty?.enabled ? this._notifyPagerDuty(severity, title, details, timestamp) : Promise.resolve('disabled'),
    ]);

    // Log any failures
    const channelNames = ['SNS', 'Slack', 'PagerDuty'];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        this.logger.warn(
          { channel: channelNames[i], error: results[i].reason?.message },
          `Alert delivery failed for ${channelNames[i]}`
        );
      }
    }
  }

  /**
   * Formats a human-readable alert message.
   *
   * @param {string} severity
   * @param {string} title
   * @param {object} details
   * @param {string} timestamp
   * @returns {string}
   * @private
   */
  _formatMessage(severity, title, details, timestamp) {
    const lines = [
      `🚨 KINETIC FAILOVER ENGINE ALERT`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Severity:  ${severity}`,
      `Event:     ${title}`,
      `Timestamp: ${timestamp}`,
    ];

    if (details.state) { lines.push(`State:     ${details.state}`); }
    if (details.region) { lines.push(`Region:    ${details.region}`); }
    if (details.reason) { lines.push(`Reason:    ${details.reason}`); }
    if (details.latencyMs !== undefined) { lines.push(`Latency:   ${details.latencyMs}ms`); }
    if (details.activeRegion) { lines.push(`Active:    ${details.activeRegion}`); }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return lines.join('\n');
  }

  /**
   * Publishes an alert to an SNS topic.
   *
   * @param {string} message - Formatted alert message
   * @param {string} severity - Alert severity
   * @returns {Promise<void>}
   * @private
   */
  async _notifySns(message, severity) {
    const topicArn = this.alertConfig.sns?.topicArn;
    if (!topicArn) {
      this.logger.warn('SNS topic ARN not configured');
      return;
    }

    try {
      await this.snsClient.send(new PublishCommand({
        TopicArn: topicArn,
        Subject: `[${severity}] Kinetic Failover Engine Alert`,
        Message: message,
        MessageAttributes: {
          severity: {
            DataType: 'String',
            StringValue: severity,
          },
        },
      }));

      this.logger.debug('Alert sent via SNS');
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to send SNS alert');
      throw error;
    }
  }

  /**
   * Posts an alert to a Slack incoming webhook.
   *
   * @param {string} message - Formatted alert message
   * @param {string} severity - Alert severity
   * @param {string} title - Alert title
   * @returns {Promise<void>}
   * @private
   */
  async _notifySlack(message, severity, title) {
    const webhookUrl = this.alertConfig.slack?.webhookUrl;
    if (!webhookUrl) {
      this.logger.warn('Slack webhook URL not configured');
      return;
    }

    // Map severity to Slack color
    const colorMap = {
      [AlertSeverity.INFO]: '#2196F3',
      [AlertSeverity.WARNING]: '#FF9800',
      [AlertSeverity.CRITICAL]: '#F44336',
      [AlertSeverity.RECOVERY]: '#4CAF50',
    };

    const payload = {
      attachments: [
        {
          color: colorMap[severity] || '#757575',
          title: `🚨 ${title}`,
          text: message,
          footer: 'Kinetic Failover Engine',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    try {
      await axios.post(webhookUrl, payload, { timeout: 10000 });
      this.logger.debug('Alert sent via Slack');
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to send Slack alert');
      throw error;
    }
  }

  /**
   * Triggers a PagerDuty incident via the Events API v2.
   *
   * @param {string} severity - Alert severity
   * @param {string} title - Alert title
   * @param {object} details - Additional context
   * @param {string} timestamp - ISO timestamp
   * @returns {Promise<void>}
   * @private
   */
  async _notifyPagerDuty(severity, title, details, timestamp) {
    const routingKey = this.alertConfig.pagerDuty?.routingKey;
    if (!routingKey) {
      this.logger.warn('PagerDuty routing key not configured');
      return;
    }

    // Map our severity to PagerDuty severity
    const pdSeverityMap = {
      [AlertSeverity.INFO]: 'info',
      [AlertSeverity.WARNING]: 'warning',
      [AlertSeverity.CRITICAL]: 'critical',
      [AlertSeverity.RECOVERY]: 'info',
    };

    // Determine event action
    const eventAction = severity === AlertSeverity.RECOVERY ? 'resolve' : 'trigger';

    const payload = {
      routing_key: routingKey,
      event_action: eventAction,
      dedup_key: 'kinetic-failover-engine-primary',
      payload: {
        summary: title,
        source: 'kinetic-failover-engine',
        severity: pdSeverityMap[severity] || 'warning',
        timestamp,
        custom_details: details,
      },
    };

    try {
      await axios.post('https://events.pagerduty.com/v2/enqueue', payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });
      this.logger.debug('Alert sent via PagerDuty');
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to send PagerDuty alert');
      throw error;
    }
  }
}
