import { PlatformConfig } from 'homebridge';
import { z } from 'zod';

export const PLUGIN_NAME = 'homebridge-llm-control';
export const PLATFORM_NAME = 'LLMControl';

const providerSchema = z.object({
  preset: z.enum(['openai', 'custom']).default('openai'),
  apiKey: z.string().min(1, 'provider.apiKey is required'),
  model: z.string().min(1, 'provider.model is required'),
  baseUrl: z.string().url().optional(),
  organization: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(32).max(8192).default(600),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const telegramSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  pairingMode: z.enum(['first_message', 'secret', 'code']).default('first_message'),
  pairingSecret: z.string().min(4).optional(),
  onboardingCode: z.string().optional(),
  allowedChatIds: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).max(10000).default(2000),
});

const monitoringSchema = z.object({
  dailyMonitoringEnabled: z.boolean().default(false),
  dailyMonitoringTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('09:00'),
  timezone: z.string().default('America/New_York'),
  includeLogs: z.boolean().default(false),
  logFilePath: z.string().optional(),
  maxLogLines: z.number().int().min(50).max(5000).default(300),
});

const watchdogSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMinutes: z.number().int().min(1).max(120).default(10),
  criticalPatterns: z.array(z.string()).default([
    'UnhandledPromiseRejection',
    'FATAL',
    'out of memory',
    'bridge is not running',
  ]),
  autoTriggerOnCritical: z.boolean().default(true),
});

const healingCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
  cooldownMinutes: z.number().int().min(0).max(1440).default(60),
});

const selfHealingSchema = z.object({
  enabled: z.boolean().default(false),
  maxActionsPerDay: z.number().int().min(1).max(50).default(5),
  commands: z.array(healingCommandSchema).default([]),
});

const automationSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  scheduleCron: z.string().min(5),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
});

const rootSchema = z.object({
  name: z.string().default('LLM Control'),
  provider: providerSchema,
  messaging: telegramSchema.default({ enabled: false }),
  monitoring: monitoringSchema.default({}),
  watchdog: watchdogSchema.default({}),
  selfHealing: selfHealingSchema.default({}),
  automations: z.array(automationSchema).default([]),
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type MessagingConfig = z.infer<typeof telegramSchema>;
export type MonitoringConfig = z.infer<typeof monitoringSchema>;
export type WatchdogConfig = z.infer<typeof watchdogSchema>;
export type SelfHealingConfig = z.infer<typeof selfHealingSchema>;
export type AutomationConfig = z.infer<typeof automationSchema>;
export type LLMControlNormalizedConfig = z.infer<typeof rootSchema>;

export type LLMControlPlatformConfig = PlatformConfig & {
  provider?: unknown;
  messaging?: unknown;
  monitoring?: unknown;
  watchdog?: unknown;
  selfHealing?: unknown;
  automations?: unknown;
};

export const normalizeConfig = (config: LLMControlPlatformConfig): LLMControlNormalizedConfig => {
  const parsed = rootSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const normalized = parsed.data;

  if (normalized.provider.preset === 'custom' && !normalized.provider.baseUrl) {
    throw new Error('provider.baseUrl is required when provider.preset is custom');
  }

  if (normalized.messaging.enabled && !normalized.messaging.botToken) {
    throw new Error('messaging.botToken is required when messaging.enabled is true');
  }

  if (normalized.messaging.enabled && normalized.messaging.pairingMode === 'secret' && !normalized.messaging.pairingSecret) {
    throw new Error('messaging.pairingSecret is required when messaging.pairingMode is secret');
  }

  return normalized;
};

export type HealingCommandConfig = z.infer<typeof healingCommandSchema>;
export type AutomationRule = {
  id: string;
  name: string;
  scheduleCron: string;
  prompt: string;
  enabled: boolean;
  source: 'config' | 'runtime';
};
