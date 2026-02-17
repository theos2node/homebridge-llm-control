import { exec as execCallback } from 'node:child_process';
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
  PLATFORM_NAME,
  normalizeConfig,
} from './settings';
import { OpenAIClient } from './llm/openai-client';
import { StateStore, PersistentState } from './state/state-store';
import { HealthService } from './monitoring/health-service';
import { TelegramService } from './messaging/telegram-service';
import { AutomationService } from './automation/automation-service';

const execAsync = promisify(execCallback);

export class LLMControlPlatform implements DynamicPlatformPlugin {
  private readonly config?: LLMControlNormalizedConfig;
  private readonly stateStore?: StateStore;
  private readonly llmClient?: OpenAIClient;
  private readonly healthService?: HealthService;

  private telegramService?: TelegramService;
  private automationService?: AutomationService;
  private dailyMonitorTask?: ScheduledTask;
  private watchdogTimer?: NodeJS.Timeout;

  private ready = false;
  private state: PersistentState = {
    runtimeAutomations: [],
    commandCooldowns: {},
    actionQuota: {
      date: new Date().toISOString().slice(0, 10),
      count: 0,
    },
  };
  private lastWatchdogTriggeredAt?: string;

  constructor(
    private readonly log: Logger,
    rawConfig: LLMControlPlatformConfig,
    private readonly api: API,
  ) {
    this.log.info(`[${PLATFORM_NAME}] Initializing plugin...`);

    try {
      this.config = normalizeConfig(rawConfig, this.log);
    } catch (error) {
      this.log.error(`[${PLATFORM_NAME}] Invalid config. Plugin disabled: ${(error as Error).message}`);
      return;
    }

    this.stateStore = new StateStore(log, api.user.storagePath());
    this.healthService = new HealthService(log, this.config, api.serverVersion);

    if (this.config.provider.apiKey && (this.config.provider.preset !== 'custom' || this.config.provider.baseUrl)) {
      this.llmClient = new OpenAIClient(log, { ...this.config.provider, apiKey: this.config.provider.apiKey });
    } else {
      this.log.warn(
        `[${PLATFORM_NAME}] LLM provider is not fully configured (set provider.apiKey and baseUrl for custom). AI features will be disabled until configured.`,
      );
    }

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
    void accessory;
    // This plugin runs background services and does not expose accessories.
  }

  private async bootstrap(): Promise<void> {
    if (!this.config || !this.stateStore || !this.healthService) {
      return;
    }

    this.state = await this.stateStore.load();
    if (!this.state.linkedChatId) {
      this.state.setupHelloSent = false;
    }

    if (!this.state.onboardingCode) {
      this.state.onboardingCode = this.config.messaging.onboardingCode ?? this.generateOnboardingCode();
      await this.persistState();
    }

    this.automationService = new AutomationService(
      this.log,
      this.config.automations,
      this.state,
      this.config.monitoring.timezone,
      async (rule) => {
        await this.handleAutomationTrigger(rule);
      },
    );
    this.automationService.start();

    if (this.config.messaging.enabled && !this.config.messaging.botToken) {
      this.log.warn(`[${PLATFORM_NAME}] Telegram messaging is enabled but no bot token is set. Messaging is disabled.`);
    }

    if (this.config.messaging.enabled && this.config.messaging.botToken) {
      this.telegramService = new TelegramService(
        this.log,
        this.config.messaging.botToken,
        this.config.messaging.pollIntervalMs,
        async (message) => {
          await this.handleTelegramMessage(message.chatId, message.text);
        },
      );

      try {
        await this.telegramService.start();
        if (this.state.linkedChatId) {
          this.log.info(`[${PLATFORM_NAME}] Telegram is enabled and already linked to chat ${this.state.linkedChatId}.`);
          if (!this.state.setupHelloSent) {
            await this.telegramService.sendMessage(
              this.state.linkedChatId,
              `Hey it's set up. Homebridge LLM Control is online. Send /help to see commands.`,
            );
            this.state.setupHelloSent = true;
            await this.persistState();
          }
        } else if (this.config.messaging.pairingMode === 'first_message') {
          this.log.info(
            `[${PLATFORM_NAME}] Telegram pairing mode: auto-link first chat. Send any message to your bot to link.`,
          );
        } else if (this.config.messaging.pairingMode === 'secret') {
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

    this.startSchedulers();
    this.ready = true;
    this.log.info(`[${PLATFORM_NAME}] Plugin started.`);
  }

  private startSchedulers(): void {
    if (!this.config) {
      return;
    }

    this.stopSchedulers();

    if (this.config.monitoring.dailyMonitoringEnabled) {
      if (!this.llmClient) {
        this.log.warn(`[${PLATFORM_NAME}] Daily monitoring is enabled but LLM is not configured. Skipping schedule.`);
        return;
      }
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

    if (this.config.watchdog.enabled) {
      if (!this.llmClient) {
        this.log.warn(`[${PLATFORM_NAME}] Watchdog is enabled but LLM is not configured. Skipping watchdog timer.`);
        return;
      }
      const intervalMs = this.config.watchdog.checkIntervalMinutes * 60_000;
      this.watchdogTimer = setInterval(() => {
        void this.runWatchdog();
      }, intervalMs);
      this.log.info(`[${PLATFORM_NAME}] Watchdog interval set to ${this.config.watchdog.checkIntervalMinutes} minute(s).`);
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
      return `LLM provider is not configured. Set provider.apiKey in the plugin settings and restart Homebridge.`;
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

    if (trimmed.toLowerCase().startsWith('/link')) {
      await this.telegramService.sendMessage(chatId, 'This bot is already linked. Use /unlink to re-pair.');
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

    const answer = await this.answerQuestion(trimmed);
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
      return `LLM provider is not configured. Set provider.apiKey in the plugin settings and restart Homebridge.`;
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
      '/help - Show this message',
      '/health - Run health analysis now',
      '/watchdog - Trigger watchdog investigation',
      '/ask <question> - Ask about Homebridge state',
      '/automation list',
      '/automation add <name> | <cron> | <prompt>',
      '/automation remove <id>',
      '/automation toggle <id> <on|off>',
    ].join('\n');
  }
}
