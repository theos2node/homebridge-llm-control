import { randomUUID } from 'node:crypto';
import cron, { ScheduledTask } from 'node-cron';
import { Logger } from 'homebridge';
import { AutomationConfig, AutomationRule } from '../settings';
import { PersistentState } from '../state/state-store';

export type AutomationCallback = (rule: AutomationRule) => Promise<void>;

type RuntimeAutomation = {
  id: string;
  name: string;
  scheduleCron: string;
  prompt: string;
  enabled: boolean;
};

export class AutomationService {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly stateAutomations = new Map<string, RuntimeAutomation>();
  private readonly configAutomations: AutomationRule[];

  constructor(
    private readonly log: Logger,
    configAutomations: AutomationConfig[],
    persistedState: PersistentState,
    private readonly timezone: string,
    private readonly onTrigger: AutomationCallback,
  ) {
    this.configAutomations = configAutomations.map((item, index) => ({
      id: item.id ?? `cfg-${index + 1}`,
      name: item.name,
      scheduleCron: item.scheduleCron,
      prompt: item.prompt,
      enabled: item.enabled,
      source: 'config',
    }));

    for (const item of persistedState.runtimeAutomations) {
      this.stateAutomations.set(item.id, item);
    }
  }

  start(): void {
    for (const rule of this.listAll()) {
      this.scheduleRule(rule);
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
      task.destroy();
    }
    this.tasks.clear();
  }

  listAll(): AutomationRule[] {
    const runtime: AutomationRule[] = Array.from(this.stateAutomations.values()).map((item) => ({
      ...item,
      source: 'runtime',
    }));

    return [...this.configAutomations, ...runtime].sort((a, b) => a.name.localeCompare(b.name));
  }

  addRuntime(name: string, scheduleCron: string, prompt: string): AutomationRule {
    if (!cron.validate(scheduleCron)) {
      throw new Error(`Invalid cron expression: ${scheduleCron}`);
    }

    const rule: AutomationRule = {
      id: randomUUID(),
      name,
      scheduleCron,
      prompt,
      enabled: true,
      source: 'runtime',
    };

    this.stateAutomations.set(rule.id, {
      id: rule.id,
      name: rule.name,
      scheduleCron: rule.scheduleCron,
      prompt: rule.prompt,
      enabled: rule.enabled,
    });

    this.scheduleRule(rule);
    return rule;
  }

  removeRuntime(id: string): boolean {
    if (!this.stateAutomations.has(id)) {
      return false;
    }

    this.stateAutomations.delete(id);
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      task.destroy();
      this.tasks.delete(id);
    }

    return true;
  }

  toggleRuntime(id: string, enabled: boolean): AutomationRule {
    const rule = this.stateAutomations.get(id);
    if (!rule) {
      throw new Error('Runtime automation not found');
    }

    rule.enabled = enabled;
    this.stateAutomations.set(id, rule);

    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      task.destroy();
      this.tasks.delete(id);
    }

    this.scheduleRule({ ...rule, source: 'runtime' });
    return { ...rule, source: 'runtime' };
  }

  toPersistentState(): RuntimeAutomation[] {
    return Array.from(this.stateAutomations.values());
  }

  private scheduleRule(rule: AutomationRule): void {
    if (!rule.enabled) {
      return;
    }

    if (!cron.validate(rule.scheduleCron)) {
      this.log.warn(`Skipping automation '${rule.name}' because cron is invalid: ${rule.scheduleCron}`);
      return;
    }

    const task = cron.schedule(
      rule.scheduleCron,
      async () => {
        try {
          await this.onTrigger(rule);
        } catch (error) {
          this.log.error(`Automation '${rule.name}' failed: ${(error as Error).message}`);
        }
      },
      { timezone: this.timezone },
    );

    this.tasks.set(rule.id, task);
  }
}
