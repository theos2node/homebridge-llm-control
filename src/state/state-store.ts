import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from 'homebridge';
import type { OneShotJob } from '../scheduler/job-scheduler';

type RuntimeAutomation = {
  id: string;
  name: string;
  scheduleCron: string;
  prompt: string;
  enabled: boolean;
};

export type VirtualDeviceType = 'switch' | 'light';

export type VirtualDevice = {
  id: string;
  name: string;
  type: VirtualDeviceType;
  on: boolean;
  brightness?: number;
};

export type PersistentState = {
  onboardingCode?: string;
  linkedChatId?: string;
  setupHelloSent?: boolean;
  lastStartupAt?: string;
  runtimeConfig: Record<string, unknown>;
  virtualDevices: VirtualDevice[];
  oneShotJobs: OneShotJob[];
  runtimeAutomations: RuntimeAutomation[];
  commandCooldowns: Record<string, string>;
  actionQuota: {
    date: string;
    count: number;
  };
};

const defaultState = (): PersistentState => ({
  runtimeConfig: {},
  virtualDevices: [],
  oneShotJobs: [],
  runtimeAutomations: [],
  commandCooldowns: {},
  setupHelloSent: false,
  actionQuota: {
    date: new Date().toISOString().slice(0, 10),
    count: 0,
  },
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeOneShotJobs = (value: unknown): OneShotJob[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: OneShotJob[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id : '';
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
    const runAt = typeof item.runAt === 'string' ? item.runAt : '';
    const actionRaw = isPlainObject(item.action) ? item.action : undefined;
    const type = typeof actionRaw?.type === 'string' ? actionRaw.type : '';

    if (!id || !createdAt || !runAt || !actionRaw || !type) {
      continue;
    }

    if (type === 'set_hb_entity') {
      const entityId = typeof actionRaw.entityId === 'string' ? actionRaw.entityId : '';
      const on = typeof actionRaw.on === 'boolean' ? actionRaw.on : undefined;
      const brightness = typeof actionRaw.brightness === 'number' && Number.isFinite(actionRaw.brightness) ? actionRaw.brightness : undefined;
      if (!entityId) {
        continue;
      }
      result.push({
        id,
        createdAt,
        runAt,
        action: { type, entityId, on, brightness },
      });
      continue;
    }

    if (type === 'restart_homebridge') {
      const reason = typeof actionRaw.reason === 'string' ? actionRaw.reason : '';
      if (!reason) {
        continue;
      }
      result.push({
        id,
        createdAt,
        runAt,
        action: { type, reason },
      });
      continue;
    }

    // Unknown action type.
    continue;
  }
  return result;
};

const sanitizeVirtualDevices = (value: unknown): VirtualDevice[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: VirtualDevice[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }

    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const type = item.type === 'switch' || item.type === 'light' ? item.type : undefined;
    if (!id || !name || !type) {
      continue;
    }

    const on = typeof item.on === 'boolean' ? item.on : false;
    const brightnessRaw = typeof item.brightness === 'number' ? item.brightness : undefined;
    const brightness =
      typeof brightnessRaw === 'number' && Number.isFinite(brightnessRaw)
        ? Math.max(0, Math.min(100, Math.round(brightnessRaw)))
        : undefined;

    result.push({ id, name, type, on, brightness });
  }

  return result;
};

export class StateStore {
  private readonly stateFilePath: string;

  constructor(private readonly log: Logger, storagePath: string) {
    this.stateFilePath = path.join(storagePath, 'homebridge-llm-control', 'state.json');
  }

  async load(): Promise<PersistentState> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistentState>;

      return {
        onboardingCode: parsed.onboardingCode,
        linkedChatId: parsed.linkedChatId,
        setupHelloSent: parsed.setupHelloSent ?? false,
        lastStartupAt: typeof parsed.lastStartupAt === 'string' ? parsed.lastStartupAt : undefined,
        runtimeConfig: isPlainObject(parsed.runtimeConfig) ? parsed.runtimeConfig : {},
        virtualDevices: sanitizeVirtualDevices(parsed.virtualDevices),
        oneShotJobs: sanitizeOneShotJobs(parsed.oneShotJobs),
        runtimeAutomations: Array.isArray(parsed.runtimeAutomations) ? parsed.runtimeAutomations : [],
        commandCooldowns: parsed.commandCooldowns ?? {},
        actionQuota: parsed.actionQuota ?? defaultState().actionQuota,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Failed to load persisted state: ${(error as Error).message}`);
      }

      return defaultState();
    }
  }

  async save(state: PersistentState): Promise<void> {
    const dirPath = path.dirname(this.stateFilePath);
    await mkdir(dirPath, { recursive: true });
    await writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  }
}
