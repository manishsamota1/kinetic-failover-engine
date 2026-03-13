// =============================================================================
// dnsManager.js — Route 53 DNS failover record management
// =============================================================================
// Manages Route 53 DNS records to route traffic between primary and secondary
// ALB endpoints. Supports both failover and weighted routing policies.
// =============================================================================

import { Route53Client, ChangeResourceRecordSetsCommand, GetChangeCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { createChildLogger } from '../utils/logger.js';

export class DnsManager {
  /**
   * @param {object} params
   * @param {object} params.config - Full engine configuration
   * @param {import('pino').Logger} params.logger - Parent logger
   * @param {object} [params.route53ClientOverride] - Optional client override for testing
   */
  constructor({ config, logger, route53ClientOverride }) {
    this.config = config;
    this.dnsConfig = config.dns;
    this.logger = createChildLogger(logger, { module: 'DnsManager' });

    // Route 53 is a global service — no region needed, but we use primary region
    this.client = route53ClientOverride || new Route53Client({ region: config.primary.region });
  }

  /**
   * Updates DNS to route all traffic to the primary ALB.
   *
   * @returns {Promise<{success: boolean, changeId: string|null, error: string|null}>}
   */
  async switchToPrimary() {
    this.logger.info('Switching DNS to PRIMARY region');
    return this._updateDnsRecord(
      this.config.primary.alb.dnsName,
      'PRIMARY',
      this.config.secondary.alb.dnsName,
      'SECONDARY'
    );
  }

  /**
   * Updates DNS to route all traffic to the secondary ALB.
   *
   * @returns {Promise<{success: boolean, changeId: string|null, error: string|null}>}
   */
  async switchToSecondary() {
    this.logger.info('Switching DNS to SECONDARY region');
    return this._updateDnsRecord(
      this.config.secondary.alb.dnsName,
      'SECONDARY',
      this.config.primary.alb.dnsName,
      'PRIMARY'
    );
  }

  /**
   * Internal method to update Route 53 resource record sets.
   * Creates an ALIAS A record pointing to the active ALB.
   *
   * @param {string} activeDnsName - DNS name of the active ALB
   * @param {string} activeLabel - Label for logging ('PRIMARY' or 'SECONDARY')
   * @param {string} standbyDnsName - DNS name of the standby ALB
   * @param {string} standbyLabel - Label for logging
   * @returns {Promise<{success: boolean, changeId: string|null, error: string|null}>}
   * @private
   */
  async _updateDnsRecord(activeDnsName, activeLabel, _standbyDnsName, _standbyLabel) {
    if (!this.dnsConfig.hostedZoneId || !this.dnsConfig.domainName) {
      const msg = 'Cannot update DNS: hostedZoneId or domainName not configured';
      this.logger.error(msg);
      return { success: false, changeId: null, error: msg };
    }

    if (!activeDnsName) {
      const msg = `Cannot update DNS: ALB DNS name for ${activeLabel} region is not configured`;
      this.logger.error(msg);
      return { success: false, changeId: null, error: msg };
    }

    try {
      // Determine the hosted zone ID of the ALB (required for ALIAS records)
      // ALB hosted zone IDs are region-specific; we use a well-known mapping
      const albHostedZoneId = this._getAlbHostedZoneId(
        activeLabel === 'PRIMARY' ? this.config.primary.region : this.config.secondary.region
      );

      const command = new ChangeResourceRecordSetsCommand({
        HostedZoneId: this.dnsConfig.hostedZoneId,
        ChangeBatch: {
          Comment: `Kinetic Failover Engine: routing traffic to ${activeLabel} (${activeDnsName})`,
          Changes: [
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: this.dnsConfig.domainName,
                Type: 'A',
                AliasTarget: {
                  DNSName: activeDnsName,
                  HostedZoneId: albHostedZoneId,
                  EvaluateTargetHealth: true,
                },
              },
            },
          ],
        },
      });

      const response = await this.client.send(command);
      const changeId = response.ChangeInfo?.Id;

      this.logger.info(
        { changeId, activeDnsName, activeLabel },
        `DNS record updated — traffic now routed to ${activeLabel}`
      );

      return { success: true, changeId, error: null };
    } catch (error) {
      this.logger.error({ error: error.message, activeLabel }, 'Failed to update DNS record');
      return { success: false, changeId: null, error: error.message };
    }
  }

  /**
   * Sets weighted routing between primary and secondary (for gradual failover).
   *
   * @param {number} primaryWeight - Weight for primary (0-255)
   * @param {number} secondaryWeight - Weight for secondary (0-255)
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  async setWeight(primaryWeight, secondaryWeight) {
    if (!this.dnsConfig.hostedZoneId || !this.dnsConfig.domainName) {
      return { success: false, error: 'hostedZoneId or domainName not configured' };
    }

    try {
      const primaryAlbZoneId = this._getAlbHostedZoneId(this.config.primary.region);
      const secondaryAlbZoneId = this._getAlbHostedZoneId(this.config.secondary.region);

      const command = new ChangeResourceRecordSetsCommand({
        HostedZoneId: this.dnsConfig.hostedZoneId,
        ChangeBatch: {
          Comment: `Kinetic Failover: weighted routing primary=${primaryWeight}, secondary=${secondaryWeight}`,
          Changes: [
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: this.dnsConfig.domainName,
                Type: 'A',
                SetIdentifier: 'primary',
                Weight: primaryWeight,
                AliasTarget: {
                  DNSName: this.config.primary.alb.dnsName,
                  HostedZoneId: primaryAlbZoneId,
                  EvaluateTargetHealth: true,
                },
              },
            },
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: this.dnsConfig.domainName,
                Type: 'A',
                SetIdentifier: 'secondary',
                Weight: secondaryWeight,
                AliasTarget: {
                  DNSName: this.config.secondary.alb.dnsName,
                  HostedZoneId: secondaryAlbZoneId,
                  EvaluateTargetHealth: true,
                },
              },
            },
          ],
        },
      });

      await this.client.send(command);
      this.logger.info({ primaryWeight, secondaryWeight }, 'DNS weighted routing updated');
      return { success: true, error: null };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to set DNS weights');
      return { success: false, error: error.message };
    }
  }

  /**
   * Polls Route 53 until a change has propagated (status = INSYNC).
   *
   * @param {string} changeId - The change ID returned by a previous DNS update
   * @param {number} [maxWaitMs=120000] - Maximum time to wait
   * @param {number} [pollIntervalMs=5000] - How often to poll
   * @returns {Promise<{synced: boolean, elapsedMs: number}>}
   */
  async waitForPropagation(changeId, maxWaitMs = 120000, pollIntervalMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const command = new GetChangeCommand({ Id: changeId });
        const response = await this.client.send(command);

        if (response.ChangeInfo?.Status === 'INSYNC') {
          const elapsedMs = Date.now() - startTime;
          this.logger.info({ changeId, elapsedMs }, 'DNS change propagated (INSYNC)');
          return { synced: true, elapsedMs };
        }

        this.logger.debug({ changeId, status: response.ChangeInfo?.Status }, 'Waiting for DNS propagation...');
      } catch (error) {
        this.logger.warn({ error: error.message, changeId }, 'Error polling DNS change status');
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.warn({ changeId, maxWaitMs }, 'DNS propagation timed out');
    return { synced: false, elapsedMs: Date.now() - startTime };
  }

  /**
   * Queries Route 53 to determine which ALB is currently receiving traffic.
   *
   * @returns {Promise<{activeDnsName: string|null, error: string|null}>}
   */
  async getCurrentRouting() {
    if (!this.dnsConfig.hostedZoneId || !this.dnsConfig.domainName) {
      return { activeDnsName: null, error: 'hostedZoneId or domainName not configured' };
    }

    try {
      const command = new ListResourceRecordSetsCommand({
        HostedZoneId: this.dnsConfig.hostedZoneId,
        StartRecordName: this.dnsConfig.domainName,
        StartRecordType: 'A',
        MaxItems: 5,
      });

      const response = await this.client.send(command);
      const records = response.ResourceRecordSets || [];
      const matchingRecord = records.find(
        (r) => r.Name === this.dnsConfig.domainName || r.Name === `${this.dnsConfig.domainName}.`
      );

      if (matchingRecord?.AliasTarget?.DNSName) {
        return { activeDnsName: matchingRecord.AliasTarget.DNSName.replace(/\.$/, ''), error: null };
      }

      return { activeDnsName: null, error: 'No matching A record found' };
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to query current DNS routing');
      return { activeDnsName: null, error: error.message };
    }
  }

  /**
   * Returns the well-known hosted zone ID for an ALB in a given AWS region.
   * See: https://docs.aws.amazon.com/general/latest/gr/elb.html
   *
   * @param {string} region - AWS region code
   * @returns {string} Hosted zone ID for ALBs in that region
   * @private
   */
  _getAlbHostedZoneId(region) {
    const zoneMap = {
      'us-east-1': 'Z35SXDOTRQ7X7K',
      'us-east-2': 'Z3AADJGX6KTTL2',
      'us-west-1': 'Z368ELLRRE2KJ0',
      'us-west-2': 'Z1H1FL5HABSF5',
      'eu-west-1': 'Z32O12XQLNTSW2',
      'eu-west-2': 'ZHURV8PSTC4K8',
      'eu-west-3': 'Z3Q77PNBQS71R4',
      'eu-central-1': 'Z215JYRZR1TBD5',
      'eu-north-1': 'Z23TAZ6LKFMNIO',
      'ap-southeast-1': 'Z1LMS91P8CMLE5',
      'ap-southeast-2': 'Z1GM3OXH4ZPM65',
      'ap-northeast-1': 'Z14GRHDCWA56QT',
      'ap-northeast-2': 'ZWKZPGTI48KDX',
      'ap-south-1': 'ZP97RAFLXONBS',
      'sa-east-1': 'Z2P70J7HTTTPLU',
      'ca-central-1': 'ZQSVJUPU6J1EY',
      'me-south-1': 'ZS929ML54UIBER',
      'af-south-1': 'Z268VQBMOI5EKX',
    };

    return zoneMap[region] || zoneMap['us-east-1'];
  }
}
