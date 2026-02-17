import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from 'homebridge';

type RuntimeAutomation = {
  id: string;
  name: string;
  scheduleCron: string;
  prompt: string;
  enabled: boolean;
};

export type PersistentState = {
  onboardingCode?: string;
  linkedChatId?: string;
  setupHelloSent?: boolean;
  runtimeAutomations: RuntimeAutomation[];
  commandCooldowns: Record<string, string>;
  actionQuota: {
    date: string;
    count: number;
  };
};

const defaultState = (): PersistentState => ({
  runtimeAutomations: [],
  commandCooldowns: {},
  setupHelloSent: false,
  actionQuota: {
    date: new Date().toISOString().slice(0, 10),
    count: 0,
  },
});

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
