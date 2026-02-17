import { readFile } from 'node:fs/promises';
import { Logger } from 'homebridge';
import { AutomationRule, LLMControlNormalizedConfig } from '../settings';

export type HealthSnapshot = {
  timestamp: string;
  process: {
    pid: number;
    uptimeSeconds: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    nodeVersion: string;
    platform: string;
  };
  homebridge: {
    version: string;
    plugin: string;
  };
  watchdog: {
    lastTriggeredAt?: string;
    criticalPatterns: string[];
  };
  automations: {
    total: number;
    enabled: number;
  };
  logSignals: {
    errors: string[];
    criticalHits: string[];
  };
};

export class HealthService {
  constructor(
    private readonly log: Logger,
    private readonly config: LLMControlNormalizedConfig,
    private readonly homebridgeVersion: string,
  ) {}

  async collectSnapshot(automations: AutomationRule[], lastWatchdogTriggeredAt?: string): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const errors: string[] = [];
    const criticalHits: string[] = [];

    if (this.config.monitoring.includeLogs && this.config.monitoring.logFilePath) {
      try {
        const tailLines = await this.readTailLines(
          this.config.monitoring.logFilePath,
          this.config.monitoring.maxLogLines,
        );

        const errorRegex = /(error|failed|exception|critical)/i;
        for (const line of tailLines) {
          if (errorRegex.test(line)) {
            errors.push(line);
          }
        }

        for (const pattern of this.config.watchdog.criticalPatterns) {
          const patternRegex = new RegExp(pattern, 'i');
          for (const line of tailLines) {
            if (patternRegex.test(line)) {
              criticalHits.push(line);
            }
          }
        }
      } catch (error) {
        this.log.warn(`Could not read log file for health snapshot: ${(error as Error).message}`);
      }
    }

    return {
      timestamp: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: this.bytesToMb(mem.rss),
        heapUsedMb: this.bytesToMb(mem.heapUsed),
        heapTotalMb: this.bytesToMb(mem.heapTotal),
        nodeVersion: process.version,
        platform: process.platform,
      },
      homebridge: {
        version: this.homebridgeVersion,
        plugin: 'homebridge-llm-control',
      },
      watchdog: {
        lastTriggeredAt: lastWatchdogTriggeredAt,
        criticalPatterns: this.config.watchdog.criticalPatterns,
      },
      automations: {
        total: automations.length,
        enabled: automations.filter((item) => item.enabled).length,
      },
      logSignals: {
        errors: errors.slice(-25),
        criticalHits: criticalHits.slice(-25),
      },
    };
  }

  hasCriticalSignals(snapshot: HealthSnapshot): boolean {
    if (snapshot.logSignals.criticalHits.length > 0) {
      return true;
    }

    if (snapshot.process.heapUsedMb > 1024) {
      return true;
    }

    return false;
  }

  private bytesToMb(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
  }

  private async readTailLines(filePath: string, maxLines: number): Promise<string[]> {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines));
  }
}
