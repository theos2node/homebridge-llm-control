import { Logger, PlatformConfig } from 'homebridge';
import { z } from 'zod';

export const PLUGIN_NAME = 'homebridge-llm-control';
export const PLATFORM_NAME = 'LLMControl';

const trimmedOptionalString = () =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().optional(),
  );

const trimmedStringWithDefault = (defaultValue: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().min(1).default(defaultValue),
  );

const providerSchema = z.object({
  preset: z.enum(['openai', 'custom']).default('openai'),
  apiKey: trimmedOptionalString(),
  model: trimmedStringWithDefault('gpt-4.1-mini'),
  baseUrl: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  organization: trimmedOptionalString(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(32).max(8192).default(600),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const telegramSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: trimmedOptionalString(),
  pairingMode: z.enum(['first_message', 'secret', 'code']).default('first_message'),
  pairingSecret: trimmedOptionalString(),
  onboardingCode: trimmedOptionalString(),
  allowedChatIds: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).max(10000).default(2000),
});

const monitoringSchema = z.object({
  dailyMonitoringEnabled: z.boolean().default(false),
  dailyMonitoringTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('09:00'),
  timezone: z.string().default('America/New_York'),
  includeLogs: z.boolean().default(false),
  logFilePath: trimmedOptionalString(),
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
  // Homebridge UI can save placeholder rows; we sanitize these in normalizeConfig.
  commands: z.array(z.unknown()).default([]),
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
  provider: providerSchema.default({}),
  messaging: telegramSchema.default({ enabled: false }),
  monitoring: monitoringSchema.default({}),
  watchdog: watchdogSchema.default({}),
  selfHealing: selfHealingSchema.default({}),
  // Homebridge UI can save placeholder rows; we sanitize these in normalizeConfig.
  automations: z.array(z.unknown()).default([]),
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ProviderConfigWithKey = ProviderConfig & { apiKey: string };
export type MessagingConfig = z.infer<typeof telegramSchema>;
export type MonitoringConfig = z.infer<typeof monitoringSchema>;
export type WatchdogConfig = z.infer<typeof watchdogSchema>;
export type HealingCommandConfig = z.output<typeof healingCommandSchema>;
export type AutomationConfig = z.output<typeof automationSchema>;

type ParsedRootConfig = z.infer<typeof rootSchema>;

type ParsedSelfHealing = z.infer<typeof selfHealingSchema>;
export type SelfHealingConfig = Omit<ParsedSelfHealing, 'commands'> & {
  commands: HealingCommandConfig[];
};

export type LLMControlNormalizedConfig = Omit<ParsedRootConfig, 'selfHealing' | 'automations'> & {
  selfHealing: SelfHealingConfig;
  automations: AutomationConfig[];
};

export type LLMControlPlatformConfig = PlatformConfig & {
  provider?: unknown;
  messaging?: unknown;
  monitoring?: unknown;
  watchdog?: unknown;
  selfHealing?: unknown;
  automations?: unknown;
};

const isBlankString = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

const isPlaceholderObject = (value: unknown, placeholderKeys: string[]): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return placeholderKeys.every((key) => isBlankString(record[key]));
};

const sanitizeList = <S extends z.ZodTypeAny>(
  list: unknown[],
  itemSchema: S,
  placeholderKeys: string[],
  label: string,
  log?: Logger,
): Array<z.output<S>> => {
  if (!Array.isArray(list)) {
    return [];
  }

  const result: Array<z.output<S>> = [];
  let ignoredInvalid = 0;

  for (const entry of list) {
    // Homebridge UI can save placeholder rows like {} or { enabled: true }. Ignore them.
    if (isPlaceholderObject(entry, placeholderKeys)) {
      continue;
    }

    const parsedEntry = itemSchema.safeParse(entry);
    if (parsedEntry.success) {
      result.push(parsedEntry.data);
    } else {
      ignoredInvalid += 1;
    }
  }

  if (ignoredInvalid > 0) {
    log?.warn(`[${PLATFORM_NAME}] Ignored ${ignoredInvalid} invalid item(s) from ${label}.`);
  }

  return result;
};

export const normalizeConfig = (config: LLMControlPlatformConfig, log?: Logger): LLMControlNormalizedConfig => {
  const parsed = rootSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }

  const raw = parsed.data;

  const messaging: MessagingConfig = { ...raw.messaging };
  if (messaging.enabled && !messaging.botToken) {
    log?.warn(`[${PLATFORM_NAME}] Telegram is enabled but messaging.botToken is missing.`);
  }

  if (messaging.enabled && messaging.pairingMode === 'secret' && !messaging.pairingSecret) {
    log?.warn(`[${PLATFORM_NAME}] Pairing mode is 'secret' but messaging.pairingSecret is missing. Falling back to auto-link.`);
    messaging.pairingMode = 'first_message';
  }

  const provider: ProviderConfig = { ...raw.provider };
  if (provider.preset === 'custom' && !provider.baseUrl) {
    log?.warn(`[${PLATFORM_NAME}] Provider preset is 'custom' but provider.baseUrl is missing; LLM calls will be disabled.`);
  }

  const commands = sanitizeList(
    raw.selfHealing.commands,
    healingCommandSchema,
    ['id', 'label', 'command'],
    'selfHealing.commands',
    log,
  );

  const automations = sanitizeList(
    raw.automations,
    automationSchema,
    ['name', 'scheduleCron', 'prompt'],
    'automations',
    log,
  );

  return {
    ...raw,
    provider,
    messaging,
    selfHealing: {
      ...raw.selfHealing,
      commands,
    },
    automations,
  };
};

export type AutomationRule = {
  id: string;
  name: string;
  scheduleCron: string;
  prompt: string;
  enabled: boolean;
  source: 'config' | 'runtime';
};
