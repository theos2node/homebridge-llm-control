import { exec as execCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import cron, { ScheduledTask } from 'node-cron';
import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import {
  AutomationRule,
  LLMControlNormalizedConfig,
  LLMControlPlatformConfig,
  PLUGIN_NAME,
  PLATFORM_NAME,
  normalizeConfig,
} from './settings';
import { OpenAIClient } from './llm/openai-client';
import { PersistentState, StateStore, VirtualDevice, VirtualDeviceType } from './state/state-store';
import { HealthService } from './monitoring/health-service';
import { TelegramService } from './messaging/telegram-service';
import { NtfyService } from './messaging/ntfy-service';
import { DiscordWebhookService } from './messaging/discord-webhook-service';
import { AutomationService } from './automation/automation-service';
import {
  deepMerge,
  getAtPath,
  isPlainObject,
  parseUserValue,
  redactSecrets,
  setAtPath,
  unsetAtPath,
} from './runtime/runtime-config';
import { HbEntity, HomebridgeAccessoryControl } from './homebridge/accessory-control';
import { JobScheduler, OneShotJob, OneShotJobAction } from './scheduler/job-scheduler';

const execAsync = promisify(execCallback);

const SECRET_PATHS: string[][] = [
  ['provider', 'apiKey'],
  ['messaging', 'botToken'],
  ['messaging', 'pairingSecret'],
  ['ntfy', 'topic'],
  ['discordWebhook', 'webhookUrl'],
];

const SECRET_PATH_STRINGS = new Set(SECRET_PATHS.map((path) => path.join('.')));

const ALLOWED_RUNTIME_CONFIG_PATHS = new Set<string>([
  'provider.preset',
  'provider.apiKey',
  'provider.model',
  'provider.baseUrl',
  'provider.organization',
  'provider.temperature',
  'provider.maxTokens',
  'provider.requestTimeoutMs',
  'messaging.enabled',
  'messaging.pairingMode',
  'messaging.pairingSecret',
  'messaging.onboardingCode',
  'messaging.allowedChatIds',
  'messaging.pollIntervalMs',
  'ntfy.enabled',
  'ntfy.serverUrl',
  'ntfy.topic',
  'ntfy.subscribeEnabled',
  'ntfy.publishEnabled',
  'discordWebhook.enabled',
  'discordWebhook.webhookUrl',
  'homebridgeControl.enabled',
  'homebridgeControl.includeChildBridges',
  'homebridgeControl.refreshIntervalSeconds',
  'operations.scheduledRestartEnabled',
  'operations.restartEveryHours',
  'operations.notifyOnHomebridgeStartup',
  'operations.notifyOnHomebridgeRestart',
  'monitoring.dailyMonitoringEnabled',
  'monitoring.dailyMonitoringTime',
  'monitoring.timezone',
  'monitoring.includeLogs',
  'monitoring.logFilePath',
  'monitoring.maxLogLines',
  'watchdog.enabled',
  'watchdog.checkIntervalMinutes',
  'watchdog.criticalPatterns',
  'watchdog.autoTriggerOnCritical',
  'selfHealing.enabled',
  'selfHealing.maxActionsPerDay',
]);

const parseDurationToSeconds = (input: string): number | null => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  let totalSeconds = 0;
  const regex = /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    if (unit === 'd' || unit === 'day' || unit === 'days') {
      totalSeconds += value * 86400;
    } else if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours') {
      totalSeconds += value * 3600;
    } else if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
      totalSeconds += value * 60;
    } else {
      totalSeconds += value;
    }
  }

  return totalSeconds > 0 ? totalSeconds : null;
};

const extractDelaySecondsFromText = (text: string): number | null => {
  const lower = text.toLowerCase();
  const match = lower.match(
    /\b(?:in|after)\s+((?:\d+\s*(?:d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\s*)+)\b/,
  );
  if (!match) {
    return null;
  }

  return parseDurationToSeconds(match[1]);
};

const formatDelayShort = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86400)}d`;
};

export class LLMControlPlatform implements DynamicPlatformPlugin {
  private readonly baseConfig?: LLMControlNormalizedConfig;
  private config?: LLMControlNormalizedConfig;
  private readonly stateStore?: StateStore;
  private llmClient?: OpenAIClient;
  private healthService?: HealthService;

  private telegramService?: TelegramService;
  private ntfyService?: NtfyService;
  private discordWebhookService?: DiscordWebhookService;
  private automationService?: AutomationService;
  private dailyMonitorTask?: ScheduledTask;
  private watchdogTimer?: NodeJS.Timeout;
  private scheduledRestartTimer?: NodeJS.Timeout;

  private hbControl?: HomebridgeAccessoryControl;
  private jobScheduler?: JobScheduler;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly virtualAccessories = new Map<string, PlatformAccessory>();

  private ready = false;
  private state: PersistentState = {
    oneShotJobs: [],
    runtimeConfig: {},
    virtualDevices: [],
    runtimeAutomations: [],
    commandCooldowns: {},
    actionQuota: {
      date: new Date().toISOString().slice(0, 10),
      count: 0,
    },
  };
  private lastWatchdogTriggeredAt?: string;

  private pendingSetup?:
    | {
        step: 'preset';
      }
    | {
        step: 'baseUrl';
        preset: 'custom';
      }
    | {
        step: 'apiKey';
        preset: 'openai' | 'custom';
        baseUrl?: string;
      }
    | {
        step: 'model';
        preset: 'openai' | 'custom';
        baseUrl?: string;
        apiKey: string;
      };

  constructor(
    private readonly log: Logger,
    rawConfig: LLMControlPlatformConfig,
    private readonly api: API,
  ) {
    this.log.info(`[${PLATFORM_NAME}] Initializing plugin...`);

    try {
      this.baseConfig = normalizeConfig(rawConfig, this.log);
    } catch (error) {
      this.log.error(`[${PLATFORM_NAME}] Invalid config. Plugin disabled: ${(error as Error).message}`);
      return;
    }

    this.stateStore = new StateStore(log, api.user.storagePath());

    this.api.on('didFinishLaunching', () => {
      void this.bootstrap();
    });

    this.api.on('shutdown', () => {
      this.stopSchedulers();
      this.telegramService?.stop();
      this.ntfyService?.stop();
      this.automationService?.stop();
      this.hbControl?.stop();
      this.jobScheduler?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    // Called by Homebridge for cached accessories.
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async bootstrap(): Promise<void> {
    if (!this.baseConfig || !this.stateStore) {
      return;
    }

    this.state = await this.stateStore.load();
    if (!this.state.linkedChatId) {
      this.state.setupHelloSent = false;
    }

    const previousStartupAt = this.state.lastStartupAt;
    const now = new Date().toISOString();
    this.state.lastStartupAt = now;
    await this.persistState();

    await this.applyConfigUpdate('startup');
    await this.maybeSendStartupNotification(previousStartupAt, now);

    this.ready = true;
    this.log.info(`[${PLATFORM_NAME}] Plugin started.`);
  }

  private computeEffectiveConfig(): LLMControlNormalizedConfig {
    if (!this.baseConfig) {
      throw new Error('Base config is not initialized');
    }

    const runtimeConfig = isPlainObject(this.state.runtimeConfig) ? this.state.runtimeConfig : {};
    const merged = deepMerge(this.baseConfig, runtimeConfig);
    return normalizeConfig(merged as unknown as LLMControlPlatformConfig, this.log);
  }

  private async applyConfigUpdate(reason: string): Promise<void> {
    if (!this.baseConfig || !this.stateStore) {
      return;
    }

    let nextConfig: LLMControlNormalizedConfig;
    try {
      nextConfig = this.computeEffectiveConfig();
    } catch (error) {
      this.log.error(`[${PLATFORM_NAME}] Failed to apply config update (${reason}): ${(error as Error).message}`);
      return;
    }

    const previousConfig = this.config;
    this.config = nextConfig;
    this.healthService = new HealthService(this.log, nextConfig, this.api.serverVersion);

    if (nextConfig.provider.apiKey && (nextConfig.provider.preset !== 'custom' || nextConfig.provider.baseUrl)) {
      this.llmClient = new OpenAIClient(this.log, { ...nextConfig.provider, apiKey: nextConfig.provider.apiKey });
    } else {
      this.llmClient = undefined;
      this.log.warn(
        `[${PLATFORM_NAME}] LLM provider is not fully configured. Run /setup in Telegram or set provider.apiKey (and baseUrl for custom).`,
      );
    }

    if (!this.state.onboardingCode) {
      this.state.onboardingCode = nextConfig.messaging.onboardingCode ?? this.generateOnboardingCode();
      await this.persistState();
    }

    // Automations
    this.automationService?.stop();
    this.automationService = new AutomationService(
      this.log,
      nextConfig.automations,
      this.state,
      nextConfig.monitoring.timezone,
      async (rule) => {
        await this.handleAutomationTrigger(rule);
      },
    );
    this.automationService.start();

    // Telegram
    const tokenChanged =
      previousConfig?.messaging.botToken !== nextConfig.messaging.botToken ||
      previousConfig?.messaging.pollIntervalMs !== nextConfig.messaging.pollIntervalMs;

    const shouldRunTelegram = nextConfig.messaging.enabled && Boolean(nextConfig.messaging.botToken);
    if (!shouldRunTelegram) {
      if (nextConfig.messaging.enabled && !nextConfig.messaging.botToken) {
        this.log.warn(`[${PLATFORM_NAME}] Telegram messaging is enabled but no bot token is set. Messaging is disabled.`);
      }
      this.telegramService?.stop();
      this.telegramService = undefined;
    } else if (!this.telegramService || tokenChanged) {
      this.telegramService?.stop();
      this.telegramService = new TelegramService(
        this.log,
        nextConfig.messaging.botToken as string,
        nextConfig.messaging.pollIntervalMs,
        async (message) => {
          await this.handleTelegramMessage(message.chatId, message.text);
        },
      );

      try {
        await this.telegramService.start();

        if (this.state.linkedChatId) {
          this.log.info(`[${PLATFORM_NAME}] Telegram is enabled and linked to chat ${this.state.linkedChatId}.`);
          if (!this.state.setupHelloSent) {
            await this.telegramService.sendMessage(
              this.state.linkedChatId,
              `Hey it's set up. Homebridge LLM Control is online. Send /help to see commands.`,
            );
            this.state.setupHelloSent = true;
            await this.persistState();
          }
        } else if (nextConfig.messaging.pairingMode === 'first_message') {
          this.log.info(
            `[${PLATFORM_NAME}] Telegram pairing mode: auto-link first chat. Send any message to your bot to link.`,
          );
        } else if (nextConfig.messaging.pairingMode === 'secret') {
          this.log.info(
            `[${PLATFORM_NAME}] Telegram pairing mode: secret. Send /link <your-secret> to your bot to link.`,
          );
        } else {
          this.log.info(
            `[${PLATFORM_NAME}] Telegram pairing mode: onboarding code. Send /start ${this.state.onboardingCode} to your bot to link.`,
          );
        }
      } catch (error) {
        this.log.error(`[${PLATFORM_NAME}] Telegram start failed: ${(error as Error).message}`);
        this.telegramService.stop();
        this.telegramService = undefined;
      }
    }

    // ntfy (two-way)
    const shouldRunNtfy = nextConfig.ntfy.enabled;
    const ntfyConfigChanged =
      previousConfig?.ntfy.enabled !== nextConfig.ntfy.enabled ||
      previousConfig?.ntfy.serverUrl !== nextConfig.ntfy.serverUrl ||
      previousConfig?.ntfy.topic !== nextConfig.ntfy.topic ||
      previousConfig?.ntfy.subscribeEnabled !== nextConfig.ntfy.subscribeEnabled ||
      previousConfig?.ntfy.publishEnabled !== nextConfig.ntfy.publishEnabled;

    if (!shouldRunNtfy) {
      this.ntfyService?.stop();
      this.ntfyService = undefined;
    } else if (!this.ntfyService || ntfyConfigChanged) {
      this.ntfyService?.stop();

      const desiredTopic = nextConfig.ntfy.topic ?? this.state.ntfyTopic;
      if (!desiredTopic) {
        this.state.ntfyTopic = this.generateNtfyTopic();
        await this.persistState();
      } else if (desiredTopic !== this.state.ntfyTopic) {
        this.state.ntfyTopic = desiredTopic;
        await this.persistState();
      }

      const topic = this.state.ntfyTopic as string;
      this.ntfyService = new NtfyService(
        this.log,
        nextConfig.ntfy.serverUrl,
        topic,
        {
          subscribeEnabled: nextConfig.ntfy.subscribeEnabled,
          publishEnabled: nextConfig.ntfy.publishEnabled,
          outgoingTag: 'llmcontrol-out',
        },
        async (message) => {
          await this.handleAuthorizedMessage(
            'ntfy',
            async (reply) => {
              await this.ntfyService?.sendMessage(reply);
            },
            message.text,
          );
        },
      );

      try {
        await this.ntfyService.start();
        this.log.info(`[${PLATFORM_NAME}] ntfy enabled. Topic: ${nextConfig.ntfy.serverUrl}/${topic}`);

        if (!this.state.ntfyHelloSent) {
          await this.ntfyService.sendMessage(
            `Hey it's set up. Homebridge LLM Control is online.\n\nTry:\n- /hb list\n- /hb schedule 30m off lights\n- /help`,
          );
          this.state.ntfyHelloSent = true;
          await this.persistState();
        }
      } catch (error) {
        this.log.error(`[${PLATFORM_NAME}] ntfy start failed: ${(error as Error).message}`);
        this.ntfyService.stop();
        this.ntfyService = undefined;
      }
    }

    // Discord webhook (outbound notifications)
    const shouldRunDiscordWebhook = nextConfig.discordWebhook.enabled && Boolean(nextConfig.discordWebhook.webhookUrl);
    const discordWebhookChanged =
      previousConfig?.discordWebhook.enabled !== nextConfig.discordWebhook.enabled ||
      previousConfig?.discordWebhook.webhookUrl !== nextConfig.discordWebhook.webhookUrl;

    if (!shouldRunDiscordWebhook) {
      this.discordWebhookService = undefined;
    } else if (!this.discordWebhookService || discordWebhookChanged) {
      this.discordWebhookService = new DiscordWebhookService(this.log, nextConfig.discordWebhook.webhookUrl as string);
      if (!this.state.discordWebhookHelloSent) {
        try {
          await this.discordWebhookService.sendMessage(`Homebridge LLM Control is online (Discord webhook configured).`);
          this.state.discordWebhookHelloSent = true;
          await this.persistState();
        } catch (error) {
          this.log.warn(`[${PLATFORM_NAME}] Discord webhook test message failed: ${(error as Error).message}`);
        }
      }
    }

    // Schedulers (daily monitor + watchdog)
    this.startSchedulers();

    // Homebridge accessory control + one-shot jobs
    this.hbControl?.stop();
    this.hbControl = undefined;
    if (nextConfig.homebridgeControl.enabled) {
      this.hbControl = new HomebridgeAccessoryControl(this.log, this.api, this.api.user.storagePath(), nextConfig.homebridgeControl);
      this.hbControl.start();
    }

    if (!this.jobScheduler) {
      this.jobScheduler = new JobScheduler(this.log);
    }
    this.syncOneShotJobs();

    // Virtual devices
    this.syncVirtualDevices();
  }

  private startSchedulers(): void {
    if (!this.config) {
      return;
    }

    this.stopSchedulers();

    if (this.config.monitoring.dailyMonitoringEnabled) {
      if (!this.llmClient) {
        this.log.warn(`[${PLATFORM_NAME}] Daily monitoring is enabled but LLM is not configured. Skipping schedule.`);
      } else {
        const [hour, minute] = this.config.monitoring.dailyMonitoringTime.split(':').map(Number);
        const expression = `${minute} ${hour} * * *`;

        this.dailyMonitorTask = cron.schedule(
          expression,
          async () => {
            await this.runHealthAnalysis('daily-monitor', { notifyMode: 'always' });
          },
          { timezone: this.config.monitoring.timezone },
        );

        this.log.info(
          `[${PLATFORM_NAME}] Daily monitoring scheduled at ${this.config.monitoring.dailyMonitoringTime} (${this.config.monitoring.timezone}).`,
        );
      }
    }

    if (this.config.watchdog.enabled) {
      if (!this.llmClient) {
        this.log.warn(`[${PLATFORM_NAME}] Watchdog is enabled but LLM is not configured. Skipping watchdog timer.`);
      } else {
        const intervalMs = this.config.watchdog.checkIntervalMinutes * 60_000;
        this.watchdogTimer = setInterval(() => {
          void this.runWatchdog();
        }, intervalMs);
        this.log.info(`[${PLATFORM_NAME}] Watchdog interval set to ${this.config.watchdog.checkIntervalMinutes} minute(s).`);
      }
    }

    if (this.config.operations.scheduledRestartEnabled) {
      const intervalMs = this.config.operations.restartEveryHours * 60 * 60 * 1000;
      this.scheduledRestartTimer = setInterval(() => {
        void this.restartHomebridge(`scheduled restart every ${this.config?.operations.restartEveryHours ?? '?'} hour(s)`);
      }, intervalMs);
      this.log.info(`[${PLATFORM_NAME}] Scheduled Homebridge restart every ${this.config.operations.restartEveryHours} hour(s).`);
    }
  }

  private stopSchedulers(): void {
    if (this.dailyMonitorTask) {
      this.dailyMonitorTask.stop();
      this.dailyMonitorTask.destroy();
      this.dailyMonitorTask = undefined;
    }

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }

    if (this.scheduledRestartTimer) {
      clearInterval(this.scheduledRestartTimer);
      this.scheduledRestartTimer = undefined;
    }
  }

  private syncOneShotJobs(): void {
    if (!this.jobScheduler) {
      return;
    }

    this.jobScheduler.sync(
      () => this.state.oneShotJobs,
      async (nextJobs) => {
        this.state.oneShotJobs = nextJobs;
        await this.persistState();
      },
      async (job) => {
        await this.executeOneShotJob(job);
      },
    );
  }

  private async executeOneShotJob(job: OneShotJob): Promise<void> {
    if (job.action.type === 'set_hb_entity') {
      if (!this.hbControl) {
        throw new Error('Homebridge control is not initialized.');
      }
      await this.hbControl.setEntity(job.action.entityId, { on: job.action.on, brightness: job.action.brightness });
      return;
    }

    if (job.action.type === 'restart_homebridge') {
      await this.restartHomebridge(job.action.reason);
      return;
    }
  }

  private async scheduleOneShotJobs(runAt: Date, actions: OneShotJobAction[]): Promise<OneShotJob[]> {
    if (actions.length === 0) {
      return [];
    }

    const createdAt = new Date().toISOString();
    const jobs: OneShotJob[] = actions.map((action) => ({
      id: randomUUID(),
      createdAt,
      runAt: runAt.toISOString(),
      action,
    }));

    this.state.oneShotJobs.push(...jobs);
    await this.persistState();
    this.syncOneShotJobs();
    return jobs;
  }

  private async scheduleOneShotJob(runAt: Date, action: OneShotJobAction): Promise<OneShotJob> {
    const jobs = await this.scheduleOneShotJobs(runAt, [action]);
    return jobs[0];
  }

  private hbControlStatusText(): string {
    if (!this.config) {
      return 'Homebridge control: not initialized';
    }
    if (!this.config.homebridgeControl.enabled) {
      return 'Homebridge control: disabled';
    }
    if (!this.hbControl) {
      return 'Homebridge control: starting...';
    }

    const last = this.hbControl.getLastRefreshAt();
    const count = this.hbControl.listEntities().length;
    return `Homebridge control: enabled | entities: ${count} | last refresh: ${last ?? 'never'}`;
  }

  private async setHbEntities(
    entities: HbEntity[],
    patch: { on?: boolean; brightness?: number },
  ): Promise<string[]> {
    if (!this.hbControl) {
      throw new Error('Homebridge control is not initialized.');
    }

    const results: string[] = [];
    for (const entity of entities) {
      try {
        const updated = await this.hbControl.setEntity(entity.id, patch);
        const brightText =
          updated.type === 'light' && typeof updated.state.brightness === 'number' ? ` (${updated.state.brightness}%)` : '';
        results.push(`Set ${updated.name}: ${updated.state.on ? 'ON' : 'OFF'}${brightText}`);
      } catch (error) {
        results.push(`Failed to set ${entity.name}: ${(error as Error).message}`);
      }
    }

    return results;
  }

  private async scheduleHbEntities(
    entities: HbEntity[],
    runAt: Date,
    patch: { on?: boolean; brightness?: number },
  ): Promise<OneShotJob[]> {
    const actions: OneShotJobAction[] = entities.map((entity) => ({
      type: 'set_hb_entity',
      entityId: entity.id,
      on: patch.on,
      brightness: patch.brightness,
    }));

    return this.scheduleOneShotJobs(runAt, actions);
  }

  private async runWatchdog(): Promise<void> {
    if (!this.ready || !this.healthService || !this.automationService || !this.config) {
      return;
    }

    const snapshot = await this.healthService.collectSnapshot(
      this.automationService.listAll(),
      this.lastWatchdogTriggeredAt,
    );

    if (!this.healthService.hasCriticalSignals(snapshot)) {
      return;
    }

    this.lastWatchdogTriggeredAt = new Date().toISOString();
    this.log.warn(`[${PLATFORM_NAME}] Watchdog detected critical signals. Triggering LLM investigation.`);

    if (this.config.watchdog.autoTriggerOnCritical) {
      await this.runHealthAnalysis('watchdog-critical');
    }
  }

  private async runHealthAnalysis(
    reason: string,
    options?: { notifyMode?: 'auto' | 'always' | 'never' },
  ): Promise<string> {
    if (!this.healthService || !this.config || !this.automationService) {
      throw new Error('Plugin runtime is not initialized');
    }

    if (!this.llmClient) {
      return `LLM provider is not configured. Send /setup in Telegram or set provider.apiKey in plugin settings.`;
    }

    const snapshot = await this.healthService.collectSnapshot(
      this.automationService.listAll(),
      this.lastWatchdogTriggeredAt,
    );

    const allowedCommands = this.config.selfHealing.commands.map((item) => ({
      id: item.id,
      label: item.label,
    }));

    const systemPrompt = [
      'You are a Homebridge operations analyst.',
      'Return ONLY valid JSON with this schema:',
      '{"status":"ok|warning|critical","summary":"string","findings":["string"],"suggestedActions":[{"commandId":"string","reason":"string"}],"notify":boolean}',
      'Only suggest commandId values from allowedCommands. Never invent ids.',
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        reason,
        snapshot,
        allowedCommands,
        instruction:
          'Decide if something is wrong, summarize briefly, and suggest safe actions only when needed.',
      },
      null,
      2,
    );

    const analysis = await this.llmClient.analyzeHealth(systemPrompt, userPrompt);
    const actionResults = await this.executeHealingActions(analysis.suggestedActions);

    this.log.info(`[${PLATFORM_NAME}] Health analysis (${reason}): ${analysis.status} - ${analysis.summary}`);

    const lines = [
      `Health analysis: ${analysis.status.toUpperCase()}`,
      `Summary: ${analysis.summary}`,
    ];

    if (analysis.findings.length > 0) {
      lines.push(`Findings:\n- ${analysis.findings.join('\n- ')}`);
    }

    if (actionResults.length > 0) {
      lines.push(`Self-healing:\n- ${actionResults.join('\n- ')}`);
    }

    const message = lines.join('\n\n');

    const notifyMode = options?.notifyMode ?? 'auto';
    const shouldNotify =
      notifyMode === 'always' ? true : notifyMode === 'never' ? false : analysis.notify || analysis.status !== 'ok';

    if (shouldNotify) {
      await this.sendNotification(message);
    }

    return message;
  }

  private async executeHealingActions(
    actions: Array<{ commandId: string; reason: string }>,
  ): Promise<string[]> {
    if (!this.config || !this.config.selfHealing.enabled || actions.length === 0) {
      return [];
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.state.actionQuota.date !== today) {
      this.state.actionQuota = { date: today, count: 0 };
    }

    const results: string[] = [];
    const commandMap = new Map(this.config.selfHealing.commands.map((item) => [item.id, item]));

    for (const action of actions) {
      if (this.state.actionQuota.count >= this.config.selfHealing.maxActionsPerDay) {
        results.push('Daily self-healing quota reached; no further actions executed.');
        break;
      }

      const command = commandMap.get(action.commandId);
      if (!command) {
        results.push(`Skipped unknown command id '${action.commandId}'.`);
        continue;
      }

      const cooldownKey = `cmd:${command.id}`;
      const lastRanAt = this.state.commandCooldowns[cooldownKey];
      if (lastRanAt) {
        const elapsedMinutes = (Date.now() - new Date(lastRanAt).getTime()) / 60000;
        if (elapsedMinutes < command.cooldownMinutes) {
          results.push(
            `Skipped '${command.label}' due to cooldown (${Math.ceil(command.cooldownMinutes - elapsedMinutes)} minute(s) remaining).`,
          );
          continue;
        }
      }

      try {
        const run = await execAsync(command.command, { timeout: 30000, maxBuffer: 128 * 1024 });
        const output = `${run.stdout} ${run.stderr}`.trim();
        const truncatedOutput = output.length > 200 ? `${output.slice(0, 200)}...` : output;
        results.push(`Executed '${command.label}' (${action.reason}). Output: ${truncatedOutput || 'No output.'}`);

        this.state.commandCooldowns[cooldownKey] = new Date().toISOString();
        this.state.actionQuota.count += 1;
        await this.persistState();
      } catch (error) {
        results.push(`Command '${command.label}' failed: ${(error as Error).message}`);
      }
    }

    return results;
  }

  private async handleAutomationTrigger(rule: AutomationRule): Promise<void> {
    if (!this.llmClient || !this.healthService || !this.automationService) {
      return;
    }

    const snapshot = await this.healthService.collectSnapshot(
      this.automationService.listAll(),
      this.lastWatchdogTriggeredAt,
    );

    const systemPrompt = [
      'You are a Homebridge assistant executing a scheduled automation check.',
      'Reply with a concise operational note and action recommendation.',
      'Do not fabricate states. Base your reply only on the provided snapshot.',
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        automation: {
          id: rule.id,
          name: rule.name,
          prompt: rule.prompt,
        },
        snapshot,
      },
      null,
      2,
    );

    const response = await this.llmClient.askQuestion(systemPrompt, userPrompt);
    const message = `Automation '${rule.name}'\n\n${response}`;
    await this.sendNotification(message);
  }

  private virtualDeviceUuid(deviceId: string): string {
    return this.api.hap.uuid.generate(`homebridge-llm-control:virtual:${deviceId}`);
  }

  private getVirtualDevice(deviceId: string): VirtualDevice | undefined {
    return this.state.virtualDevices.find((item) => item.id === deviceId);
  }

  private syncVirtualDevices(): void {
    if (!this.stateStore) {
      return;
    }

    const expectedUuids = new Set<string>();
    this.virtualAccessories.clear();

    for (const device of this.state.virtualDevices) {
      const uuid = this.virtualDeviceUuid(device.id);
      expectedUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.virtualDeviceId = device.id;
        accessory.context.virtualDeviceType = device.type;
        this.configureVirtualAccessory(accessory, device);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
        this.log.info(`[${PLATFORM_NAME}] Registered virtual ${device.type}: ${device.name} (${device.id})`);
      } else {
        accessory.context.virtualDeviceId = device.id;
        accessory.context.virtualDeviceType = device.type;

        if (accessory.displayName !== device.name) {
          accessory.displayName = device.name;
          this.api.updatePlatformAccessories([accessory]);
        }

        this.configureVirtualAccessory(accessory, device);
      }

      this.virtualAccessories.set(device.id, accessory);
    }

    // Remove stale virtual accessories.
    for (const [uuid, accessory] of this.cachedAccessories.entries()) {
      const deviceId = (accessory.context as { virtualDeviceId?: string } | undefined)?.virtualDeviceId;
      if (!deviceId) {
        continue;
      }

      if (!expectedUuids.has(uuid)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
        this.log.info(`[${PLATFORM_NAME}] Unregistered virtual device: ${accessory.displayName} (${deviceId})`);
      }
    }
  }

  private configureVirtualAccessory(accessory: PlatformAccessory, device: VirtualDevice): void {
    const { Service, Characteristic } = this.api.hap;

    const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'homebridge-llm-control')
      .setCharacteristic(Characteristic.Model, 'Virtual Device')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    // Ensure only one primary service type exists.
    const removeAllOfType = (serviceType: typeof Service.Switch | typeof Service.Lightbulb): void => {
      const toRemove = accessory.services.filter((svc) => svc.UUID === serviceType.UUID);
      for (const svc of toRemove) {
        accessory.removeService(svc);
      }
    };

    let service:
      | InstanceType<typeof Service.Switch>
      | InstanceType<typeof Service.Lightbulb>;

    if (device.type === 'switch') {
      removeAllOfType(Service.Lightbulb);
      service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, device.name);
    } else {
      removeAllOfType(Service.Switch);
      service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb, device.name);
    }

    service.getCharacteristic(Characteristic.On).onGet(() => device.on).onSet(async (value) => {
      device.on = Boolean(value);
      await this.persistState();
    });

    service.updateCharacteristic(Characteristic.On, device.on);

    if (device.type === 'light') {
      const defaultBrightness = typeof device.brightness === 'number' ? device.brightness : 100;
      if (typeof device.brightness !== 'number') {
        device.brightness = defaultBrightness;
      }

      service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => (typeof device.brightness === 'number' ? device.brightness : 100))
        .onSet(async (value) => {
          const numeric = typeof value === 'number' ? value : Number(value);
          if (Number.isFinite(numeric)) {
            device.brightness = Math.max(0, Math.min(100, Math.round(numeric)));
          }
          await this.persistState();
        });

      service.updateCharacteristic(Characteristic.Brightness, device.brightness);
    }
  }

  private async setVirtualDeviceState(
    deviceId: string,
    patch: { on?: boolean; brightness?: number },
  ): Promise<VirtualDevice> {
    const device = this.getVirtualDevice(deviceId);
    if (!device) {
      throw new Error(`Virtual device not found: ${deviceId}`);
    }

    if (typeof patch.on === 'boolean') {
      device.on = patch.on;
    }
    if (typeof patch.brightness === 'number' && device.type === 'light') {
      device.brightness = Math.max(0, Math.min(100, Math.round(patch.brightness)));
    }

    await this.persistState();

    const accessory = this.virtualAccessories.get(deviceId);
    if (accessory) {
      const { Service, Characteristic } = this.api.hap;
      const service =
        device.type === 'switch' ? accessory.getService(Service.Switch) : accessory.getService(Service.Lightbulb);
      if (service) {
        service.updateCharacteristic(Characteristic.On, device.on);
        if (device.type === 'light' && typeof device.brightness === 'number') {
          service.updateCharacteristic(Characteristic.Brightness, device.brightness);
        }
      }
    }

    return device;
  }

  private async commitRuntimeConfig(nextRuntimeConfig: Record<string, unknown>, reason: string): Promise<void> {
    if (!this.baseConfig) {
      throw new Error('Base config is not initialized');
    }

    // Validate before saving.
    normalizeConfig(deepMerge(this.baseConfig, nextRuntimeConfig) as unknown as LLMControlPlatformConfig, this.log);

    this.state.runtimeConfig = nextRuntimeConfig;
    await this.persistState();
    await this.applyConfigUpdate(reason);
  }

  private async handleSetupConversation(send: (message: string) => Promise<void>, trimmed: string): Promise<boolean> {
    if (!this.pendingSetup) {
      return false;
    }

    if (trimmed.startsWith('/') && trimmed !== '/cancel') {
      return false;
    }

    if (trimmed === '/cancel') {
      this.pendingSetup = undefined;
      await send('Setup cancelled.');
      return true;
    }

    if (this.pendingSetup.step === 'preset') {
      const lower = trimmed.toLowerCase();
      if (lower === 'openai') {
        this.pendingSetup = { step: 'apiKey', preset: 'openai' };
        await send('Send your OpenAI API key (starts with sk-...).');
        return true;
      }
      if (lower === 'custom') {
        this.pendingSetup = { step: 'baseUrl', preset: 'custom' };
        await send('Send your custom base URL (example: https://api.example.com/v1).');
        return true;
      }

      await send("Reply with 'openai' or 'custom'. Send /cancel to abort.");
      return true;
    }

    if (this.pendingSetup.step === 'baseUrl') {
      try {
        // Basic URL validation.
        new URL(trimmed);
      } catch {
        await send('That does not look like a valid URL. Try again or /cancel.');
        return true;
      }

      this.pendingSetup = { step: 'apiKey', preset: 'custom', baseUrl: trimmed };
      await send('Send your API key for this provider.');
      return true;
    }

    if (this.pendingSetup.step === 'apiKey') {
      if (!trimmed) {
        await send('API key cannot be empty. Try again or /cancel.');
        return true;
      }

      this.pendingSetup = {
        step: 'model',
        preset: this.pendingSetup.preset,
        baseUrl: this.pendingSetup.baseUrl,
        apiKey: trimmed,
      };

      await send("Send a model name (example: gpt-4.1-mini) or reply 'skip' to keep the default.");
      return true;
    }

    if (this.pendingSetup.step === 'model') {
      const model = trimmed.toLowerCase() === 'skip' ? undefined : trimmed;
      const nextRuntime = (globalThis as unknown as { structuredClone?: <V>(input: V) => V }).structuredClone
        ? structuredClone(this.state.runtimeConfig)
        : (JSON.parse(JSON.stringify(this.state.runtimeConfig)) as Record<string, unknown>);

      setAtPath(nextRuntime, ['provider', 'preset'], this.pendingSetup.preset);
      setAtPath(nextRuntime, ['provider', 'apiKey'], this.pendingSetup.apiKey);
      if (this.pendingSetup.preset === 'custom') {
        setAtPath(nextRuntime, ['provider', 'baseUrl'], this.pendingSetup.baseUrl);
      }
      if (model) {
        setAtPath(nextRuntime, ['provider', 'model'], model);
      }

      await this.commitRuntimeConfig(nextRuntime, 'setup');
      this.pendingSetup = undefined;

      await send([
        "Provider configured. You're good to go.",
        'Try: /hb list',
        "Try saying: 'turn off the lights in 30 minutes'",
        'Try: /health',
      ].join('\n'));
      return true;
    }

    return false;
  }

  private async handleConfigCommand(commandText: string): Promise<string> {
    if (!this.config || !this.baseConfig) {
      return 'Config is not initialized yet.';
    }

    const args = commandText.split(' ');
    const op = args[1] ?? 'help';

    if (op === 'paths') {
      return `Config paths you can set:\n- ${Array.from(ALLOWED_RUNTIME_CONFIG_PATHS).sort().join('\n- ')}`;
    }

    if (op === 'show') {
      const effective = redactSecrets(this.config, SECRET_PATHS);
      const runtime = redactSecrets(this.state.runtimeConfig, SECRET_PATHS);
      return `Effective config (secrets redacted):\n${JSON.stringify(effective, null, 2)}\n\nRuntime overrides:\n${JSON.stringify(runtime, null, 2)}`;
    }

    if (op === 'get') {
      const path = args[2];
      if (!path) {
        return 'Usage: /config get <path>';
      }
      if (SECRET_PATH_STRINGS.has(path)) {
        return `${path} = "***"`;
      }
      const parts = path.split('.').filter(Boolean);
      const redacted = redactSecrets(this.config, SECRET_PATHS);
      const value = getAtPath(redacted, parts);
      return `${path} = ${JSON.stringify(value, null, 2)}`;
    }

    if (op === 'set') {
      const path = args[2];
      if (!path) {
        return 'Usage: /config set <path> <value>';
      }
      if (!ALLOWED_RUNTIME_CONFIG_PATHS.has(path)) {
        return `Path not allowed. Use /config paths to see allowed paths.`;
      }

      const rawValue = commandText.split(' ').slice(3).join(' ').trim();
      if (!rawValue) {
        return 'Usage: /config set <path> <value>';
      }

      const nextRuntime = (globalThis as unknown as { structuredClone?: <V>(input: V) => V }).structuredClone
        ? structuredClone(this.state.runtimeConfig)
        : (JSON.parse(JSON.stringify(this.state.runtimeConfig)) as Record<string, unknown>);

      const parts = path.split('.').filter(Boolean);
      try {
        setAtPath(nextRuntime, parts, parseUserValue(rawValue));
        await this.commitRuntimeConfig(nextRuntime, `config:${path}`);
      } catch (error) {
        return `Config update failed: ${(error as Error).message}`;
      }

      return `Updated ${path}.`;
    }

    if (op === 'reset') {
      const path = args[2];
      if (!path) {
        return 'Usage: /config reset <path>';
      }
      if (!ALLOWED_RUNTIME_CONFIG_PATHS.has(path)) {
        return `Path not allowed. Use /config paths to see allowed paths.`;
      }

      const nextRuntime = (globalThis as unknown as { structuredClone?: <V>(input: V) => V }).structuredClone
        ? structuredClone(this.state.runtimeConfig)
        : (JSON.parse(JSON.stringify(this.state.runtimeConfig)) as Record<string, unknown>);

      try {
        unsetAtPath(nextRuntime, path.split('.').filter(Boolean));
        await this.commitRuntimeConfig(nextRuntime, `config-reset:${path}`);
      } catch (error) {
        return `Config reset failed: ${(error as Error).message}`;
      }
      return `Reset ${path}.`;
    }

    if (op === 'reset-all') {
      try {
        await this.commitRuntimeConfig({}, 'config-reset-all');
      } catch (error) {
        return `Config reset failed: ${(error as Error).message}`;
      }
      return 'Reset all runtime overrides.';
    }

    return [
      'Config commands:',
      '/config show',
      '/config get <path>',
      '/config set <path> <value>',
      '/config reset <path>',
      '/config reset-all',
      '/config paths',
      'Note: changes are saved in Homebridge storage (they do not modify config.json).',
    ].join('\n');
  }

  private async handleDeviceCommand(commandText: string): Promise<string> {
    const args = commandText.split(' ');
    const op = args[1] ?? 'help';

    if (op === 'list') {
      if (this.state.virtualDevices.length === 0) {
        return 'No virtual devices yet. Add one with: /device add light <name>';
      }

      const lines = this.state.virtualDevices
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((device) => {
          const state = device.on ? 'on' : 'off';
          const bright = device.type === 'light' ? ` | ${device.brightness ?? 100}%` : '';
          return `${device.id} | ${device.type} | ${device.name} | ${state}${bright}`;
        });

      return `Virtual devices:\n${lines.join('\n')}`;
    }

    if (op === 'add') {
      const typeRaw = args[2] as VirtualDeviceType | undefined;
      const type: VirtualDeviceType | undefined = typeRaw === 'switch' || typeRaw === 'light' ? typeRaw : undefined;
      const name = commandText.split(' ').slice(3).join(' ').trim();

      if (!type || !name) {
        return 'Usage: /device add <switch|light> <name>';
      }

      const device: VirtualDevice = {
        id: randomUUID(),
        type,
        name,
        on: false,
        brightness: type === 'light' ? 100 : undefined,
      };

      this.state.virtualDevices.push(device);
      await this.persistState();
      this.syncVirtualDevices();

      return [
        `Added virtual ${type}: ${name}`,
        `ID: ${device.id}`,
        "Tip: In the Home app, create an automation that mirrors this virtual device to your real light. Then you can control it from chat.",
      ].join('\n');
    }

    if (op === 'remove') {
      const id = args[2];
      if (!id) {
        return 'Usage: /device remove <id>';
      }

      const index = this.state.virtualDevices.findIndex((item) => item.id === id);
      if (index === -1) {
        return 'Virtual device not found.';
      }

      const [removed] = this.state.virtualDevices.splice(index, 1);
      await this.persistState();
      this.syncVirtualDevices();
      return `Removed virtual device: ${removed.name} (${removed.id})`;
    }

    if (op === 'rename') {
      const id = args[2];
      const name = commandText.split(' ').slice(3).join(' ').trim();
      if (!id || !name) {
        return 'Usage: /device rename <id> <new name>';
      }

      const device = this.getVirtualDevice(id);
      if (!device) {
        return 'Virtual device not found.';
      }

      device.name = name;
      await this.persistState();
      this.syncVirtualDevices();
      return `Renamed virtual device ${id} to '${name}'.`;
    }

    return [
      'Device commands:',
      '/device list',
      '/device add <switch|light> <name>',
      '/device remove <id>',
      '/device rename <id> <new name>',
      '/set <id> <on|off>',
      '/set <id> brightness <0-100>',
    ].join('\n');
  }

  private async handleSetCommand(commandText: string): Promise<string> {
    const args = commandText.split(' ');
    const id = args[1];
    const op = args[2];
    if (!id || !op) {
      return 'Usage: /set <id> <on|off> OR /set <id> brightness <0-100>';
    }

    if (op === 'on' || op === 'off') {
      const device = await this.setVirtualDeviceState(id, { on: op === 'on' });
      return `Set ${device.name}: ${device.on ? 'ON' : 'OFF'}`;
    }

    if (op === 'brightness') {
      const raw = args[3];
      if (!raw) {
        return 'Usage: /set <id> brightness <0-100>';
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return 'Brightness must be a number 0-100.';
      }

      const device = await this.setVirtualDeviceState(id, { brightness: value });
      if (device.type !== 'light') {
        return 'This virtual device does not support brightness.';
      }
      return `Set ${device.name} brightness: ${device.brightness ?? 100}%`;
    }

    return 'Usage: /set <id> <on|off> OR /set <id> brightness <0-100>';
  }

  private async handleHbCommand(commandText: string): Promise<string> {
    if (!this.config) {
      return 'Config is not initialized yet.';
    }

    if (!this.config.homebridgeControl.enabled) {
      return 'Homebridge control is disabled. Enable it with: /config set homebridgeControl.enabled true';
    }

    if (!this.hbControl) {
      return 'Homebridge control is starting. Try again in a few seconds.';
    }

    const args = commandText.split(' ');
    const op = (args[1] ?? 'help').toLowerCase();

    const allEntities = (): HbEntity[] => this.hbControl?.listEntities() ?? [];
    const groupEntities = (group: 'lights' | 'switches' | 'outlets' | 'all'): HbEntity[] => {
      const list = allEntities();
      if (group === 'all') {
        return list;
      }
      if (group === 'lights') {
        return list.filter((e) => e.type === 'light');
      }
      if (group === 'switches') {
        return list.filter((e) => e.type === 'switch');
      }
      return list.filter((e) => e.type === 'outlet');
    };

    const parseTargets = (raw: string): HbEntity[] | { group: 'lights' | 'switches' | 'outlets' | 'all' } => {
      const q = raw.trim().toLowerCase();
      if (q === 'lights' || q === 'all lights') {
        return { group: 'lights' };
      }
      if (q === 'switches' || q === 'all switches') {
        return { group: 'switches' };
      }
      if (q === 'outlets' || q === 'all outlets') {
        return { group: 'outlets' };
      }
      if (q === 'all') {
        return { group: 'all' };
      }

      const exact = this.hbControl?.getEntity(raw.trim());
      if (exact) {
        return [exact];
      }

      return this.hbControl?.listEntities(raw) ?? [];
    };

    if (op === 'status') {
      return this.hbControlStatusText();
    }

    if (op === 'refresh') {
      await this.hbControl.refresh('manual');
      return this.hbControlStatusText();
    }

    if (op === 'list') {
      const query = commandText.split(' ').slice(2).join(' ').trim();
      const entities = this.hbControl.listEntities(query);
      if (entities.length === 0) {
        return query ? 'No matching entities.' : 'No controllable entities found.';
      }

      const shown = entities.slice(0, 50);
      const lines = shown.map((e) => {
        const state = e.state.on ? 'on' : 'off';
        const bright = e.type === 'light' && typeof e.state.brightness === 'number' ? ` | ${Math.round(e.state.brightness)}%` : '';
        return `${e.id} | ${e.type} | ${e.name} | ${state}${bright}`;
      });

      const more = entities.length > shown.length ? `\n\n(Showing ${shown.length}/${entities.length}. Refine your query.)` : '';
      return `Entities:\n${lines.join('\n')}${more}`;
    }

    if (op === 'on' || op === 'off') {
      const query = commandText.split(' ').slice(2).join(' ').trim();
      if (!query) {
        return `Usage: /hb ${op} <query|id|lights|switches|outlets|all>`;
      }

      const targets = parseTargets(query);
      const desired = op === 'on';

      if (!Array.isArray(targets)) {
        const entities = groupEntities(targets.group);
        const results = await this.setHbEntities(entities, { on: desired });
        return results.length > 0 ? results.join('\n') : `No entities found for group '${targets.group}'.`;
      }

      if (targets.length === 0) {
        return 'No matching entities.';
      }
      if (targets.length > 5) {
        const preview = targets.slice(0, 5).map((e) => `${e.id} | ${e.type} | ${e.name}`).join('\n');
        return `Matched ${targets.length} entities. Be more specific.\n\n${preview}`;
      }

      const results = await this.setHbEntities(targets, { on: desired });
      return results.join('\n');
    }

    if (op === 'set') {
      const id = args[2];
      const sub = (args[3] ?? '').toLowerCase();
      if (!id || !sub) {
        return 'Usage: /hb set <id> <on|off> OR /hb set <id> brightness <0-100>';
      }

      const entity = this.hbControl.getEntity(id);
      if (!entity) {
        return 'Entity not found. Use /hb list to find the id.';
      }

      if (sub === 'on' || sub === 'off') {
        const results = await this.setHbEntities([entity], { on: sub === 'on' });
        return results.join('\n');
      }

      if (sub === 'brightness') {
        const raw = args[4];
        const value = raw ? Number(raw) : NaN;
        if (!Number.isFinite(value)) {
          return 'Usage: /hb set <id> brightness <0-100>';
        }
        const results = await this.setHbEntities([entity], { brightness: value });
        return results.join('\n');
      }

      return 'Usage: /hb set <id> <on|off> OR /hb set <id> brightness <0-100>';
    }

    if (op === 'schedule') {
      const durationRaw = args[2] ?? '';
      const desiredRaw = (args[3] ?? '').toLowerCase();
      const query = commandText.split(' ').slice(4).join(' ').trim();

      const seconds = parseDurationToSeconds(durationRaw);
      if (!seconds || !['on', 'off'].includes(desiredRaw) || !query) {
        return 'Usage: /hb schedule <duration> <on|off> <query|id|lights|switches|outlets|all>\nExample: /hb schedule 30m off lights';
      }

      const targets = parseTargets(query);
      const desired = desiredRaw === 'on';
      const runAt = new Date(Date.now() + seconds * 1000);

      if (!Array.isArray(targets)) {
        const entities = groupEntities(targets.group);
        const jobs = await this.scheduleHbEntities(entities, runAt, { on: desired });
        return jobs.length > 0 ? `Scheduled ${jobs.length} job(s) for ${runAt.toISOString()}.` : `No entities found for group '${targets.group}'.`;
      }

      if (targets.length === 0) {
        return 'No matching entities.';
      }

      const jobs = await this.scheduleHbEntities(targets, runAt, { on: desired });
      return `Scheduled ${jobs.length} job(s) for ${runAt.toISOString()}.`;
    }

    return [
      'Homebridge control commands:',
      '/hb status',
      '/hb refresh',
      '/hb list [query]',
      '/hb on <query|id|lights|switches|outlets|all>',
      '/hb off <query|id|lights|switches|outlets|all>',
      '/hb set <id> on|off',
      '/hb set <id> brightness <0-100>',
      '/hb schedule <duration> <on|off> <query|id|lights|switches|outlets|all>',
    ].join('\n');
  }

  private async handleRunCommand(commandText: string): Promise<string> {
    if (!this.config) {
      return 'Config is not initialized yet.';
    }

    const args = commandText.split(' ');
    const commandId = args[1];
    if (!commandId) {
      return 'Usage: /run <commandId>';
    }

    if (!this.config.selfHealing.enabled) {
      return 'Self-healing is disabled. Enable it with /config set selfHealing.enabled true';
    }

    const results = await this.executeHealingActions([{ commandId, reason: 'manual-run' }]);
    if (results.length === 0) {
      return 'No actions executed.';
    }
    return `Run result:\n- ${results.join('\n- ')}`;
  }

  private commandsListText(): string {
    if (!this.config) {
      return 'Config is not initialized yet.';
    }

    if (this.config.selfHealing.commands.length === 0) {
      return 'No self-healing commands configured in plugin settings.';
    }

    const lines = this.config.selfHealing.commands.map((cmd) => `${cmd.id} | ${cmd.label} | cooldown ${cmd.cooldownMinutes}m`);
    return `Self-healing commands:\n${lines.join('\n')}`;
  }

  private async assistantChat(text: string): Promise<string> {
    if (!this.healthService || !this.automationService) {
      return 'Plugin runtime is not initialized yet.';
    }

    if (!this.llmClient) {
      return `LLM provider is not configured. Send /setup to configure it.`;
    }

    const snapshot = await this.healthService.collectSnapshot(
      this.automationService.listAll(),
      this.lastWatchdogTriggeredAt,
    );

    const allEntities = this.hbControl?.listEntities() ?? [];
    const entities = allEntities.slice(0, 200).map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      on: e.state.on,
      brightness: e.type === 'light' ? e.state.brightness : undefined,
      bridge: e.bridge.name,
    }));

    const scheduledJobs = this.state.oneShotJobs
      .slice()
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
      .slice(0, 50)
      .map((job) => ({
        id: job.id,
        runAt: job.runAt,
        action: job.action,
      }));

    const systemPrompt = [
      'You are a Homebridge assistant.',
      'Return ONLY valid JSON with this schema:',
      '{"reply":"string","actions":[{"type":"refresh_hb"},{"type":"set_hb_entity","entityId":"string","on":boolean,"brightness":number?},{"type":"set_hb_group","group":"all_lights|all_switches|all_outlets|all","on":boolean},{"type":"schedule_set_hb_entity","entityId":"string","delaySeconds":number,"on":boolean,"brightness":number?},{"type":"schedule_set_hb_group","group":"all_lights|all_switches|all_outlets|all","delaySeconds":number,"on":boolean},{"type":"schedule_restart_homebridge","delaySeconds":number,"reason":"string"},{"type":"set_config","path":"string","value":any},{"type":"run_health"},{"type":"run_watchdog"}]}',
      'Rules:',
      '- Only use entityId values from entities. Never invent ids.',
      '- If multiple devices could match, ask a clarifying question and do not take action.',
      '- For restarts, prefer scheduling a restart a few seconds in the future (delaySeconds >= 3).',
      '- You can directly control existing Homebridge accessories; do not mention HomeKit automations or virtual devices.',
      '- Never output secrets.',
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        message: text,
        snapshot,
        homebridgeControl: {
          enabled: this.config?.homebridgeControl.enabled ?? false,
          lastRefreshAt: this.hbControl?.getLastRefreshAt(),
          entitiesCount: allEntities.length,
        },
        entities,
        scheduledJobs,
        allowedConfigPaths: Array.from(ALLOWED_RUNTIME_CONFIG_PATHS).sort(),
      },
      null,
      2,
    );

    let payload: unknown;
    try {
      payload = await this.llmClient.chatJson(systemPrompt, userPrompt);
    } catch {
      // Fallback: plain Q&A.
      return this.answerQuestion(text);
    }

    if (!isPlainObject(payload)) {
      return this.answerQuestion(text);
    }

    const reply = typeof payload.reply === 'string' ? payload.reply : '';
    const actionsRaw = Array.isArray(payload.actions) ? payload.actions : [];

    const actionResults: string[] = [];
    for (const action of actionsRaw) {
      if (!isPlainObject(action) || typeof action.type !== 'string') {
        continue;
      }

      if (action.type === 'refresh_hb') {
        if (!this.hbControl) {
          actionResults.push('Homebridge control is not initialized.');
          continue;
        }
        await this.hbControl.refresh('assistant');
        actionResults.push(this.hbControlStatusText());
        continue;
      }

      if (action.type === 'set_hb_entity') {
        const entityId = typeof action.entityId === 'string' ? action.entityId : '';
        const on = typeof action.on === 'boolean' ? action.on : undefined;
        const brightness = typeof action.brightness === 'number' ? action.brightness : undefined;
        if (!this.hbControl || !entityId || on === undefined) {
          continue;
        }

        const entity = this.hbControl.getEntity(entityId);
        if (!entity) {
          continue;
        }

        const results = await this.setHbEntities([entity], { on, brightness });
        actionResults.push(results.join('\n'));
        continue;
      }

      if (action.type === 'set_hb_group') {
        const group = typeof action.group === 'string' ? action.group : '';
        const on = typeof action.on === 'boolean' ? action.on : undefined;
        if (!this.hbControl || !group || on === undefined) {
          continue;
        }

        const list = this.hbControl.listEntities();
        const targets =
          group === 'all_lights'
            ? list.filter((e) => e.type === 'light')
            : group === 'all_switches'
              ? list.filter((e) => e.type === 'switch')
              : group === 'all_outlets'
                ? list.filter((e) => e.type === 'outlet')
                : group === 'all'
                  ? list
                  : [];

        const results = await this.setHbEntities(targets, { on });
        actionResults.push(results.length > 0 ? results.join('\n') : `No entities in group ${group}.`);
        continue;
      }

      if (action.type === 'schedule_set_hb_entity') {
        const entityId = typeof action.entityId === 'string' ? action.entityId : '';
        const on = typeof action.on === 'boolean' ? action.on : undefined;
        const brightness = typeof action.brightness === 'number' ? action.brightness : undefined;
        const delaySeconds = typeof action.delaySeconds === 'number' ? action.delaySeconds : undefined;
        if (!this.hbControl || !entityId || on === undefined || !delaySeconds || delaySeconds <= 0) {
          continue;
        }

        const entity = this.hbControl.getEntity(entityId);
        if (!entity) {
          continue;
        }

        const runAt = new Date(Date.now() + Math.round(delaySeconds) * 1000);
        await this.scheduleOneShotJob(runAt, { type: 'set_hb_entity', entityId, on, brightness });
        actionResults.push(`Scheduled ${entity.name} for ${runAt.toISOString()}.`);
        continue;
      }

      if (action.type === 'schedule_set_hb_group') {
        const group = typeof action.group === 'string' ? action.group : '';
        const on = typeof action.on === 'boolean' ? action.on : undefined;
        const delaySeconds = typeof action.delaySeconds === 'number' ? action.delaySeconds : undefined;
        if (!this.hbControl || !group || on === undefined || !delaySeconds || delaySeconds <= 0) {
          continue;
        }

        const list = this.hbControl.listEntities();
        const targets =
          group === 'all_lights'
            ? list.filter((e) => e.type === 'light')
            : group === 'all_switches'
              ? list.filter((e) => e.type === 'switch')
              : group === 'all_outlets'
                ? list.filter((e) => e.type === 'outlet')
                : group === 'all'
                  ? list
                  : [];

        const runAt = new Date(Date.now() + Math.round(delaySeconds) * 1000);
        await this.scheduleHbEntities(targets, runAt, { on });
        actionResults.push(`Scheduled ${targets.length} device(s) for ${runAt.toISOString()}.`);
        continue;
      }

      if (action.type === 'schedule_restart_homebridge') {
        const delaySeconds = typeof action.delaySeconds === 'number' ? action.delaySeconds : undefined;
        const reason = typeof action.reason === 'string' ? action.reason : '';
        if (!delaySeconds || delaySeconds <= 0 || !reason) {
          continue;
        }
        const runAt = new Date(Date.now() + Math.round(delaySeconds) * 1000);
        await this.scheduleOneShotJob(runAt, { type: 'restart_homebridge', reason });
        actionResults.push(`Scheduled Homebridge restart for ${runAt.toISOString()}.`);
        continue;
      }

      if (action.type === 'set_config') {
        const pathStr = typeof action.path === 'string' ? action.path : '';
        if (!pathStr || !ALLOWED_RUNTIME_CONFIG_PATHS.has(pathStr)) {
          continue;
        }

        const nextRuntime = (globalThis as unknown as { structuredClone?: <V>(input: V) => V }).structuredClone
          ? structuredClone(this.state.runtimeConfig)
          : (JSON.parse(JSON.stringify(this.state.runtimeConfig)) as Record<string, unknown>);

        try {
          setAtPath(nextRuntime, pathStr.split('.').filter(Boolean), action.value);
          await this.commitRuntimeConfig(nextRuntime, `assistant:${pathStr}`);
          actionResults.push(`Updated ${pathStr}.`);
        } catch (error) {
          actionResults.push(`Failed to update ${pathStr}: ${(error as Error).message}`);
        }
        continue;
      }

      if (action.type === 'run_health') {
        const result = await this.runHealthAnalysis('assistant-health', { notifyMode: 'never' });
        actionResults.push(result);
        continue;
      }

      if (action.type === 'run_watchdog') {
        const result = await this.runHealthAnalysis('assistant-watchdog', { notifyMode: 'never' });
        actionResults.push(result);
        continue;
      }
    }

    if (actionResults.length === 0) {
      return reply || this.answerQuestion(text);
    }

    if (!reply) {
      return actionResults.join('\n\n');
    }

    return `${reply}\n\n${actionResults.join('\n\n')}`;
  }

  private async handleTelegramMessage(chatId: string, text: string): Promise<void> {
    if (!this.config || !this.telegramService) {
      return;
    }

    const trimmed = text.trim();

    if (!this.state.linkedChatId) {
      const mode = this.config.messaging.pairingMode;

      if (mode === 'first_message') {
        this.state.linkedChatId = chatId;
        this.state.setupHelloSent = true;
        await this.persistState();
        await this.telegramService.sendMessage(
          chatId,
          `Hey it's set up. This chat is now linked to Homebridge LLM Control. Send /help to see commands.`,
        );
        return;
      }

      if (mode === 'secret') {
        const match = trimmed.match(/^\/(link|start)\s+(.+)$/i);
        const suppliedSecret = match?.[2]?.trim();
        if (suppliedSecret && suppliedSecret === this.config.messaging.pairingSecret) {
          this.state.linkedChatId = chatId;
          this.state.setupHelloSent = true;
          await this.persistState();
          await this.telegramService.sendMessage(
            chatId,
            `Hey it's set up. This chat is now linked to Homebridge LLM Control. Send /help to see commands.`,
          );
          return;
        }

        await this.telegramService.sendMessage(
          chatId,
          `Not linked yet. Send /link <secret> to link this chat. Your chat id is ${chatId}.`,
        );
        return;
      }

      // onboarding code mode
      if (trimmed.toLowerCase().startsWith('/start') || trimmed.toLowerCase().startsWith('/link')) {
        const suppliedCode = trimmed.split(/\s+/)[1];
        if (suppliedCode && suppliedCode === this.state.onboardingCode) {
          this.state.linkedChatId = chatId;
          this.state.setupHelloSent = true;
          await this.persistState();
          await this.telegramService.sendMessage(
            chatId,
            `Hey it's set up. This chat is now linked to Homebridge LLM Control. Send /help to see commands.`,
          );
          return;
        }
      }

      await this.telegramService.sendMessage(
        chatId,
        `Not linked yet. Send /start ${this.state.onboardingCode} to link this chat. Your chat id is ${chatId}.`,
      );
      return;
    }

    if (!this.isAuthorizedChat(chatId)) {
      this.log.warn(`[${PLATFORM_NAME}] Ignoring message from unauthorized chat ${chatId}`);
      return;
    }

    await this.handleAuthorizedMessage(
      'telegram',
      async (reply) => {
        await this.telegramService?.sendMessage(chatId, reply);
      },
      trimmed,
    );
  }

  private async handleAuthorizedMessage(
    source: 'telegram' | 'ntfy',
    send: (message: string) => Promise<void>,
    trimmed: string,
  ): Promise<void> {
    if (!this.config) {
      return;
    }

    if (await this.handleSetupConversation(send, trimmed)) {
      return;
    }

    if (trimmed === '/cancel') {
      await send('Nothing to cancel.');
      return;
    }

    if (trimmed.toLowerCase().startsWith('/link')) {
      if (source === 'telegram') {
        await send('This bot is already linked. Use /unlink to re-pair.');
      } else {
        await send('Linking is not used for ntfy. The topic acts as the shared secret.');
      }
      return;
    }

    if (trimmed === '/setup') {
      this.pendingSetup = { step: 'preset' };
      await send("Setup: reply with 'openai' or 'custom'. Send /cancel to abort.");
      return;
    }

    if (trimmed === '/status') {
      const llm = this.llmClient ? 'configured' : 'not configured';
      const restartStatus = this.config.operations.scheduledRestartEnabled
        ? `enabled (every ${this.config.operations.restartEveryHours}h)`
        : 'disabled';

      const ntfyStatus = this.config.ntfy.enabled
        ? `enabled (${this.config.ntfy.serverUrl}/${this.state.ntfyTopic ?? this.config.ntfy.topic ?? 'topic'})`
        : 'disabled';
      const discordStatus = this.config.discordWebhook.enabled ? 'enabled' : 'disabled';

      await send([
        source === 'telegram' ? `Linked chat: ${this.state.linkedChatId}` : `Channel: ntfy`,
        `LLM provider: ${llm}`,
        this.hbControlStatusText(),
        `Scheduled restart: ${restartStatus}`,
        `Scheduled jobs: ${this.state.oneShotJobs.length}`,
        `ntfy: ${ntfyStatus}`,
        `Discord webhook: ${discordStatus}`,
      ].join('\n'));
      return;
    }

    if (trimmed === '/unlink') {
      if (source !== 'telegram') {
        await send('Unlink is only supported for Telegram.');
        return;
      }

      this.state.linkedChatId = undefined;
      this.state.setupHelloSent = false;
      await this.persistState();
      await send('Unlinked. To link again, follow the pairing mode in Homebridge plugin settings.');
      return;
    }

    if (trimmed === '/help') {
      await send(this.helpText());
      return;
    }

    if (trimmed.startsWith('/config')) {
      const response = await this.handleConfigCommand(trimmed);
      await send(response);
      return;
    }

    if (trimmed === '/commands' || trimmed === '/commands list') {
      await send(this.commandsListText());
      return;
    }

    if (trimmed.startsWith('/run ')) {
      const response = await this.handleRunCommand(trimmed);
      await send(response);
      return;
    }

    if (trimmed === '/hb' || trimmed.startsWith('/hb ')) {
      const response = await this.handleHbCommand(trimmed);
      await send(response);
      return;
    }

    if (trimmed === '/jobs' || trimmed.startsWith('/jobs ')) {
      const response = await this.handleJobsCommand(trimmed);
      await send(response);
      return;
    }

    if (trimmed === '/devices') {
      const response = await this.handleHbCommand('/hb list');
      await send(response);
      return;
    }

    if (trimmed.startsWith('/device')) {
      await send('Virtual devices are deprecated. Use /hb list, /hb on, /hb off, /hb schedule.');
      return;
    }

    if (trimmed.startsWith('/set ')) {
      await send('Use /hb set <id> on|off or /hb set <id> brightness <0-100>.');
      return;
    }

    if (trimmed === '/health') {
      const result = await this.runHealthAnalysis('manual-health-command', { notifyMode: 'never' });
      await send(result);
      return;
    }

    if (trimmed === '/watchdog' || trimmed.toLowerCase() === 'watchdog') {
      const result = await this.runHealthAnalysis('manual-watchdog-command', { notifyMode: 'never' });
      await send(result);
      return;
    }

    if (trimmed.startsWith('/ask ')) {
      const question = trimmed.replace('/ask', '').trim();
      if (!question) {
        await send('Usage: /ask <question>');
        return;
      }

      const answer = await this.answerQuestion(question);
      await send(answer);
      return;
    }

    if (trimmed.startsWith('/automation ')) {
      const response = await this.handleAutomationCommand(trimmed);
      await send(response);
      return;
    }

    if (!trimmed.startsWith('/')) {
      const handled = await this.tryHandleNaturalLanguageShortcuts(send, trimmed);
      if (handled) {
        return;
      }
    }

    const answer = await this.assistantChat(trimmed);
    await send(answer);
  }

  private async tryHandleNaturalLanguageShortcuts(send: (message: string) => Promise<void>, text: string): Promise<boolean> {
    const lower = text.toLowerCase();

    const hasOffIntent = /\b(turn|switch|shut|power)\b[\s\S]*\boff\b/.test(lower);
    const hasOnIntent = /\b(turn|switch|power)\b[\s\S]*\bon\b/.test(lower);
    const desiredOn = hasOnIntent && !hasOffIntent ? true : hasOffIntent && !hasOnIntent ? false : null;
    if (desiredOn === null) {
      return false;
    }

    type Group = 'all_lights' | 'all_switches' | 'all_outlets' | 'all';
    const group: Group | null =
      (/\ball\b/.test(lower) && /\blight(s)?\b/.test(lower)) ? 'all_lights'
        : (/\ball\b/.test(lower) && /\bswitch(es)?\b/.test(lower)) ? 'all_switches'
          : (/\ball\b/.test(lower) && /(\boutlet(s)?\b|\bplug(s)?\b)/.test(lower)) ? 'all_outlets'
            : (/\beverything\b/.test(lower) || /\ball devices\b/.test(lower)) ? 'all'
              : null;

    if (!group) {
      return false;
    }

    const delaySeconds = extractDelaySecondsFromText(lower);
    const runAt = typeof delaySeconds === 'number' && delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : undefined;

    if (!this.config?.homebridgeControl.enabled) {
      await send('Homebridge control is disabled. Enable it with: /config set homebridgeControl.enabled true');
      return true;
    }

    if (!this.hbControl) {
      await send('Homebridge control is starting. Try again in a few seconds or run: /hb status');
      return true;
    }

    const list = this.hbControl.listEntities();
    const targets =
      group === 'all_lights'
        ? list.filter((e) => e.type === 'light')
        : group === 'all_switches'
          ? list.filter((e) => e.type === 'switch')
          : group === 'all_outlets'
            ? list.filter((e) => e.type === 'outlet')
            : list;

    if (targets.length === 0) {
      await send(
        [
          "I don't see any controllable devices yet.",
          'Try:',
          '- /hb refresh',
          '- /hb list',
          '',
          'If it still shows 0 entities, make sure Homebridge is running with -I and your bridge ports are fixed in config.json.',
        ].join('\n'),
      );
      return true;
    }

    const actionLabel =
      group === 'all_lights'
        ? 'lights'
        : group === 'all_switches'
          ? 'switches'
          : group === 'all_outlets'
            ? 'outlets'
            : 'devices';

    if (runAt) {
      await this.scheduleHbEntities(targets, runAt, { on: desiredOn });
      const inText = typeof delaySeconds === 'number' ? formatDelayShort(delaySeconds) : 'later';
      await send(
        `Scheduled ${desiredOn ? 'ON' : 'OFF'} for ${targets.length} ${actionLabel} in ${inText} (${runAt.toISOString()}).`,
      );
      return true;
    }

    let ok = 0;
    const failures: string[] = [];
    for (const entity of targets) {
      try {
        await this.hbControl.setEntity(entity.id, { on: desiredOn });
        ok += 1;
      } catch (error) {
        failures.push(`${entity.name}: ${(error as Error).message}`);
      }
    }

    const summary = `Turned ${desiredOn ? 'ON' : 'OFF'} ${ok}/${targets.length} ${actionLabel}.`;
    if (failures.length === 0) {
      await send(summary);
      return true;
    }

    const shown = failures.slice(0, 5);
    const more = failures.length > shown.length ? `\n(+${failures.length - shown.length} more)` : '';
    await send(`${summary}\nFailures:\n- ${shown.join('\n- ')}${more}`);
    return true;
  }

  private async handleAutomationCommand(commandText: string): Promise<string> {
    if (!this.automationService) {
      return 'Automation service is not initialized.';
    }

    const args = commandText.split(' ');
    const operation = args[1];

    if (operation === 'list') {
      const rules = this.automationService.listAll();
      if (rules.length === 0) {
        return 'No automations configured.';
      }

      const lines = rules.map((item) => {
        const status = item.enabled ? 'enabled' : 'disabled';
        return `${item.id} | ${item.name} | ${item.scheduleCron} | ${status} | ${item.source}`;
      });

      return `Automations:\n${lines.join('\n')}`;
    }

    if (operation === 'add') {
      const payload = commandText.replace('/automation add', '').trim();
      const parts = payload.split('|').map((part) => part.trim());
      if (parts.length !== 3) {
        return 'Usage: /automation add <name> | <cron> | <prompt>';
      }

      const [name, scheduleCron, prompt] = parts;
      const created = this.automationService.addRuntime(name, scheduleCron, prompt);
      this.state.runtimeAutomations = this.automationService.toPersistentState();
      await this.persistState();
      return `Added automation ${created.id} (${created.name})`;
    }

    if (operation === 'remove') {
      const id = args[2];
      if (!id) {
        return 'Usage: /automation remove <id>';
      }

      const removed = this.automationService.removeRuntime(id);
      if (!removed) {
        return 'Automation not found or defined in config (config automations cannot be removed from chat).';
      }

      this.state.runtimeAutomations = this.automationService.toPersistentState();
      await this.persistState();
      return `Removed automation ${id}`;
    }

    if (operation === 'toggle') {
      const id = args[2];
      const value = args[3];
      if (!id || !value || !['on', 'off'].includes(value)) {
        return 'Usage: /automation toggle <id> <on|off>';
      }

      try {
        const updated = this.automationService.toggleRuntime(id, value === 'on');
        this.state.runtimeAutomations = this.automationService.toPersistentState();
        await this.persistState();
        return `Automation ${updated.id} is now ${updated.enabled ? 'enabled' : 'disabled'}.`;
      } catch (error) {
        return (error as Error).message;
      }
    }

    return 'Automation commands: list, add, remove, toggle';
  }

  private async handleJobsCommand(commandText: string): Promise<string> {
    const args = commandText.split(' ');
    const op = args[1] ?? 'help';

    if (op === 'list') {
      if (this.state.oneShotJobs.length === 0) {
        return 'No scheduled jobs.';
      }

      const jobs = this.state.oneShotJobs
        .slice()
        .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());

      const lines = jobs.map((job) => {
        const runAtMs = Date.parse(job.runAt);
        const inMinutes = Number.isFinite(runAtMs) ? Math.max(0, Math.round((runAtMs - Date.now()) / 60000)) : undefined;

        if (job.action.type === 'set_hb_entity') {
          const entity = this.hbControl?.getEntity(job.action.entityId);
          const target = entity ? `${entity.name}` : job.action.entityId;
          const state = typeof job.action.on === 'boolean' ? (job.action.on ? 'ON' : 'OFF') : 'UNCHANGED';
          const bright =
            typeof job.action.brightness === 'number' ? ` | ${Math.round(job.action.brightness)}%` : '';
          const rel = typeof inMinutes === 'number' ? ` (in ${inMinutes}m)` : '';
          return `${job.id} | ${job.runAt}${rel} | set ${target}: ${state}${bright}`;
        }

        if (job.action.type === 'restart_homebridge') {
          const rel = typeof inMinutes === 'number' ? ` (in ${inMinutes}m)` : '';
          return `${job.id} | ${job.runAt}${rel} | restart Homebridge (${job.action.reason})`;
        }

        return `${job.id} | ${job.runAt} | unknown`;
      });

      return `Scheduled jobs:\n${lines.join('\n')}`;
    }

    if (op === 'cancel') {
      const id = args[2];
      if (!id) {
        return 'Usage: /jobs cancel <jobId>';
      }

      const index = this.state.oneShotJobs.findIndex((j) => j.id === id);
      if (index === -1) {
        return 'Job not found.';
      }

      this.state.oneShotJobs.splice(index, 1);
      await this.persistState();
      this.syncOneShotJobs();
      return `Cancelled job ${id}.`;
    }

    if (op === 'clear') {
      this.state.oneShotJobs = [];
      await this.persistState();
      this.syncOneShotJobs();
      return 'Cleared all scheduled jobs.';
    }

    return ['Job commands:', '/jobs list', '/jobs cancel <jobId>', '/jobs clear'].join('\n');
  }

  private async answerQuestion(question: string): Promise<string> {
    if (!this.healthService || !this.automationService) {
      throw new Error('Plugin runtime is not initialized');
    }

    if (!this.llmClient) {
      return `LLM provider is not configured. Send /setup in Telegram or set provider.apiKey in plugin settings.`;
    }

    const snapshot = await this.healthService.collectSnapshot(
      this.automationService.listAll(),
      this.lastWatchdogTriggeredAt,
    );

    const systemPrompt = [
      'You are a Homebridge assistant.',
      'Answer questions about health, automations, and operations.',
      'If unsure, say what data is missing.',
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        question,
        snapshot,
      },
      null,
      2,
    );

    return this.llmClient.askQuestion(systemPrompt, userPrompt);
  }

  private async maybeSendStartupNotification(previousStartupAt: string | undefined, now: string): Promise<void> {
    if (!this.config) {
      return;
    }
    if (!this.config.operations.notifyOnHomebridgeStartup && !this.config.operations.notifyOnHomebridgeRestart) {
      return;
    }
    if (!this.telegramService || !this.state.linkedChatId) {
      return;
    }

    if (!previousStartupAt) {
      if (!this.config.operations.notifyOnHomebridgeStartup) {
        return;
      }
      await this.sendNotification(`Homebridge started at ${now}.`);
      return;
    }

    if (!this.config.operations.notifyOnHomebridgeRestart) {
      return;
    }
    await this.sendNotification(`Homebridge restarted at ${now}. Previous start was ${previousStartupAt}.`);
  }

  private async restartHomebridge(reason: string): Promise<void> {
    this.log.warn(`[${PLATFORM_NAME}] Restarting Homebridge (${reason}).`);
    await this.sendNotification(`Restarting Homebridge now (${reason}).`);

    // Give the notification a moment to leave the process before shutdown.
    await new Promise<void>((resolve) => setTimeout(resolve, 750));

    process.kill(process.pid, 'SIGTERM');
  }

  private async sendNotification(message: string): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    if (this.telegramService && this.state.linkedChatId) {
      tasks.push(
        this.telegramService.sendMessage(this.state.linkedChatId, message).catch((error) => {
          this.log.warn(`[${PLATFORM_NAME}] Failed to send Telegram message: ${(error as Error).message}`);
        }),
      );
    }

    if (this.ntfyService && this.config?.ntfy.publishEnabled) {
      tasks.push(
        this.ntfyService.sendMessage(message).catch((error) => {
          this.log.warn(`[${PLATFORM_NAME}] Failed to send ntfy message: ${(error as Error).message}`);
        }),
      );
    }

    if (this.discordWebhookService && this.config?.discordWebhook.enabled) {
      tasks.push(
        this.discordWebhookService.sendMessage(message).catch((error) => {
          this.log.warn(`[${PLATFORM_NAME}] Failed to send Discord webhook message: ${(error as Error).message}`);
        }),
      );
    }

    await Promise.all(tasks);
  }

  private isAuthorizedChat(chatId: string): boolean {
    if (chatId === this.state.linkedChatId) {
      return true;
    }

    return this.config?.messaging.allowedChatIds.includes(chatId) ?? false;
  }

  private generateOnboardingCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  private generateNtfyTopic(): string {
    // Topic acts as the shared secret; keep it long and unguessable.
    const raw = randomUUID().replace(/-/g, '');
    return `hbllm-${raw}`;
  }

  private async persistState(): Promise<void> {
    if (!this.stateStore) {
      return;
    }

    await this.stateStore.save({
      ...this.state,
      runtimeAutomations: this.automationService?.toPersistentState() ?? this.state.runtimeAutomations,
    });
  }

  private helpText(): string {
    return [
      'Homebridge LLM Control commands:',
      '/status - Show link status',
      '/unlink - Unlink this chat',
      '/link <secret> - Link chat (only used before linking in Secret mode)',
      '/setup - Guided LLM provider setup',
      '/cancel - Cancel a guided setup',
      '/help - Show this message',
      '/hb - Homebridge device control help',
      '/hb list [query] - List controllable devices',
      '/hb on <query|id|lights|switches|outlets|all>',
      '/hb off <query|id|lights|switches|outlets|all>',
      '/hb schedule <duration> <on|off> <query|id|lights|switches|outlets|all>',
      '/jobs list - List scheduled one-shot jobs',
      '/jobs cancel <jobId> - Cancel a scheduled job',
      '/health - Run health analysis now',
      '/watchdog - Trigger watchdog investigation',
      '/ask <question> - Ask about Homebridge state',
      '/config - View/modify runtime config',
      '/commands - List self-healing command IDs',
      '/run <commandId> - Run an allowed self-healing command',
      '/automation list',
      '/automation add <name> | <cron> | <prompt>',
      '/automation remove <id>',
      '/automation toggle <id> <on|off>',
    ].join('\n');
  }
}
