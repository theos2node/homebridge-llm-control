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

const execAsync = promisify(execCallback);

const SECRET_PATHS: string[][] = [
  ['provider', 'apiKey'],
  ['messaging', 'botToken'],
  ['messaging', 'pairingSecret'],
];

const ALLOWED_RUNTIME_CONFIG_PATHS = new Set<string>([
  'provider.preset',
  'provider.apiKey',
  'provider.model',
  'provider.baseUrl',
  'provider.organization',
  'provider.temperature',
  'provider.maxTokens',
  'provider.requestTimeoutMs',
  'messaging.pairingMode',
  'messaging.pairingSecret',
  'messaging.onboardingCode',
  'messaging.allowedChatIds',
  'messaging.pollIntervalMs',
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

export class LLMControlPlatform implements DynamicPlatformPlugin {
  private readonly baseConfig?: LLMControlNormalizedConfig;
  private config?: LLMControlNormalizedConfig;
  private readonly stateStore?: StateStore;
  private llmClient?: OpenAIClient;
  private healthService?: HealthService;

  private telegramService?: TelegramService;
  private automationService?: AutomationService;
  private dailyMonitorTask?: ScheduledTask;
  private watchdogTimer?: NodeJS.Timeout;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly virtualAccessories = new Map<string, PlatformAccessory>();

  private ready = false;
  private state: PersistentState = {
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
      this.automationService?.stop();
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

    await this.applyConfigUpdate('startup');

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

    // Schedulers (daily monitor + watchdog)
    this.startSchedulers();

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

  private async handleSetupConversation(chatId: string, trimmed: string): Promise<boolean> {
    if (!this.pendingSetup || !this.telegramService) {
      return false;
    }

    if (trimmed.startsWith('/') && trimmed !== '/cancel') {
      return false;
    }

    if (trimmed === '/cancel') {
      this.pendingSetup = undefined;
      await this.telegramService.sendMessage(chatId, 'Setup cancelled.');
      return true;
    }

    if (this.pendingSetup.step === 'preset') {
      const lower = trimmed.toLowerCase();
      if (lower === 'openai') {
        this.pendingSetup = { step: 'apiKey', preset: 'openai' };
        await this.telegramService.sendMessage(chatId, 'Send your OpenAI API key (starts with sk-...).');
        return true;
      }
      if (lower === 'custom') {
        this.pendingSetup = { step: 'baseUrl', preset: 'custom' };
        await this.telegramService.sendMessage(chatId, 'Send your custom base URL (example: https://api.example.com/v1).');
        return true;
      }

      await this.telegramService.sendMessage(chatId, "Reply with 'openai' or 'custom'. Send /cancel to abort.");
      return true;
    }

    if (this.pendingSetup.step === 'baseUrl') {
      try {
        // Basic URL validation.
        new URL(trimmed);
      } catch {
        await this.telegramService.sendMessage(chatId, 'That does not look like a valid URL. Try again or /cancel.');
        return true;
      }

      this.pendingSetup = { step: 'apiKey', preset: 'custom', baseUrl: trimmed };
      await this.telegramService.sendMessage(chatId, 'Send your API key for this provider.');
      return true;
    }

    if (this.pendingSetup.step === 'apiKey') {
      if (!trimmed) {
        await this.telegramService.sendMessage(chatId, 'API key cannot be empty. Try again or /cancel.');
        return true;
      }

      this.pendingSetup = {
        step: 'model',
        preset: this.pendingSetup.preset,
        baseUrl: this.pendingSetup.baseUrl,
        apiKey: trimmed,
      };

      await this.telegramService.sendMessage(
        chatId,
        "Send a model name (example: gpt-4.1-mini) or reply 'skip' to keep the default.",
      );
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

      await this.telegramService.sendMessage(
        chatId,
        [
          "Provider configured. You're good to go.",
          'Try: /health',
          "To control real lights, create a virtual device with /device add light <name>, then map it to a real accessory using a HomeKit automation.",
        ].join('\n'),
      );
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
      const parts = path.split('.').filter(Boolean);
      const value = getAtPath(this.config, parts);
      return `${path} = ${JSON.stringify(redactSecrets(value, SECRET_PATHS), null, 2)}`;
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

    const devices = this.state.virtualDevices.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      on: d.on,
      brightness: d.type === 'light' ? d.brightness ?? 100 : undefined,
    }));

    const systemPrompt = [
      'You are a Homebridge assistant with limited actions.',
      'Return ONLY valid JSON with this schema:',
      '{"reply":"string","actions":[{"type":"set_virtual_device","deviceId":"string","on":boolean,"brightness":number?},{"type":"run_health"},{"type":"run_watchdog"}]}',
      'Only use deviceId values from devices. Never invent ids.',
      "If the user asks to control a real light, prefer controlling a matching virtual device by name (if present) and explain that a HomeKit automation should mirror it.",
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        message: text,
        snapshot,
        devices,
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

      if (action.type === 'set_virtual_device') {
        const deviceId = typeof action.deviceId === 'string' ? action.deviceId : '';
        const on = typeof action.on === 'boolean' ? action.on : undefined;
        const brightness = typeof action.brightness === 'number' ? action.brightness : undefined;
        if (!deviceId || on === undefined) {
          continue;
        }

        try {
          const updated = await this.setVirtualDeviceState(deviceId, { on, brightness });
          const brightText =
            updated.type === 'light' && typeof updated.brightness === 'number' ? ` (${updated.brightness}%)` : '';
          actionResults.push(`Set ${updated.name}: ${updated.on ? 'ON' : 'OFF'}${brightText}`);
        } catch (error) {
          actionResults.push(`Failed to set device ${deviceId}: ${(error as Error).message}`);
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

    if (await this.handleSetupConversation(chatId, trimmed)) {
      return;
    }

    if (trimmed === '/cancel') {
      await this.telegramService.sendMessage(chatId, 'Nothing to cancel.');
      return;
    }

    if (trimmed.toLowerCase().startsWith('/link')) {
      await this.telegramService.sendMessage(chatId, 'This bot is already linked. Use /unlink to re-pair.');
      return;
    }

    if (trimmed === '/setup') {
      this.pendingSetup = { step: 'preset' };
      await this.telegramService.sendMessage(
        chatId,
        "Setup: reply with 'openai' or 'custom'. Send /cancel to abort.",
      );
      return;
    }

    if (trimmed === '/status') {
      await this.telegramService.sendMessage(
        chatId,
        `Linked chat: ${this.state.linkedChatId}\\nPairing mode: ${this.config.messaging.pairingMode}`,
      );
      return;
    }

    if (trimmed === '/unlink') {
      this.state.linkedChatId = undefined;
      this.state.setupHelloSent = false;
      await this.persistState();
      await this.telegramService.sendMessage(
        chatId,
        'Unlinked. To link again, follow the pairing mode in Homebridge plugin settings.',
      );
      return;
    }

    if (trimmed === '/help') {
      await this.telegramService.sendMessage(chatId, this.helpText());
      return;
    }

    if (trimmed.startsWith('/config')) {
      const response = await this.handleConfigCommand(trimmed);
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    if (trimmed === '/commands' || trimmed === '/commands list') {
      await this.telegramService.sendMessage(chatId, this.commandsListText());
      return;
    }

    if (trimmed.startsWith('/run ')) {
      const response = await this.handleRunCommand(trimmed);
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    if (trimmed === '/devices') {
      const response = await this.handleDeviceCommand('/device list');
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    if (trimmed.startsWith('/device')) {
      const response = await this.handleDeviceCommand(trimmed);
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    if (trimmed.startsWith('/set ')) {
      const response = await this.handleSetCommand(trimmed);
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    if (trimmed === '/health') {
      const result = await this.runHealthAnalysis('manual-health-command', { notifyMode: 'never' });
      await this.telegramService.sendMessage(chatId, result);
      return;
    }

    if (trimmed === '/watchdog' || trimmed.toLowerCase() === 'watchdog') {
      const result = await this.runHealthAnalysis('manual-watchdog-command', { notifyMode: 'never' });
      await this.telegramService.sendMessage(chatId, result);
      return;
    }

    if (trimmed.startsWith('/ask ')) {
      const question = trimmed.replace('/ask', '').trim();
      if (!question) {
        await this.telegramService.sendMessage(chatId, 'Usage: /ask <question>');
        return;
      }

      const answer = await this.answerQuestion(question);
      await this.telegramService.sendMessage(chatId, answer);
      return;
    }

    if (trimmed.startsWith('/automation ')) {
      const response = await this.handleAutomationCommand(trimmed);
      await this.telegramService.sendMessage(chatId, response);
      return;
    }

    const answer = await this.assistantChat(trimmed);
    await this.telegramService.sendMessage(chatId, answer);
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

  private async sendNotification(message: string): Promise<void> {
    if (!this.telegramService || !this.state.linkedChatId) {
      return;
    }

    try {
      await this.telegramService.sendMessage(this.state.linkedChatId, message);
    } catch (error) {
      this.log.warn(`[${PLATFORM_NAME}] Failed to send Telegram message: ${(error as Error).message}`);
    }
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
      '/health - Run health analysis now',
      '/watchdog - Trigger watchdog investigation',
      '/ask <question> - Ask about Homebridge state',
      '/config - View/modify runtime config',
      '/commands - List self-healing command IDs',
      '/run <commandId> - Run an allowed self-healing command',
      '/devices - List virtual devices',
      '/device add <switch|light> <name>',
      '/device remove <id>',
      '/device rename <id> <new name>',
      '/set <id> <on|off>',
      '/set <id> brightness <0-100>',
      '/automation list',
      '/automation add <name> | <cron> | <prompt>',
      '/automation remove <id>',
      '/automation toggle <id> <on|off>',
    ].join('\n');
  }
}
