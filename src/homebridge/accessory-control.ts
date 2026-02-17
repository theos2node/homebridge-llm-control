import { Logger, API } from 'homebridge';
import { loadHomebridgeConfig, discoverHapBridgeEndpoints, HapBridgeEndpoint } from './homebridge-config';
import { HapAccessoriesResponse, HapCharacteristic, HapHttpClient, HapService } from './hap-http-client';

export type HbEntityType = 'switch' | 'light' | 'outlet';

export type HbEntity = {
  id: string;
  name: string;
  type: HbEntityType;
  bridge: {
    username: string;
    name: string;
    port: number;
  };
  hap: {
    aid: number;
    serviceIid: number;
    onIid: number;
    brightnessIid?: number;
  };
  state: {
    on: boolean;
    brightness?: number;
  };
};

type HbEntityPatch = {
  on?: boolean;
  brightness?: number;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const getStringValue = (characteristic: HapCharacteristic): string | undefined =>
  isNonEmptyString(characteristic.value) ? characteristic.value.trim() : undefined;

const getBoolValue = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'on' || lower === '1') {
      return true;
    }
    if (lower === 'false' || lower === 'off' || lower === '0') {
      return false;
    }
  }
  return false;
};

const getNumberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

export class HomebridgeAccessoryControl {
  private readonly serviceUuids: Record<HbEntityType, string>;
  private readonly characteristicUuids: {
    name: string;
    on: string;
    brightness: string;
    accessoryInformation: string;
  };

  private refreshTimer?: NodeJS.Timeout;
  private bridges: HapBridgeEndpoint[] = [];
  private clients = new Map<string, HapHttpClient>();
  private entities = new Map<string, HbEntity>();
  private lastRefreshAt?: string;

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly storagePath: string,
    private readonly options: {
      enabled: boolean;
      includeChildBridges: boolean;
      refreshIntervalSeconds: number;
    },
  ) {
    const { Service, Characteristic } = api.hap;

    this.serviceUuids = {
      switch: Service.Switch.UUID,
      light: Service.Lightbulb.UUID,
      outlet: Service.Outlet.UUID,
    };

    this.characteristicUuids = {
      name: Characteristic.Name.UUID,
      on: Characteristic.On.UUID,
      brightness: Characteristic.Brightness.UUID,
      accessoryInformation: Service.AccessoryInformation.UUID,
    };
  }

  start(): void {
    if (!this.options.enabled) {
      return;
    }

    void this.refresh('startup');

    this.refreshTimer = setInterval(() => {
      void this.refresh('interval');
    }, this.options.refreshIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  getLastRefreshAt(): string | undefined {
    return this.lastRefreshAt;
  }

  listEntities(query?: string): HbEntity[] {
    const all = Array.from(this.entities.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (!query || !query.trim()) {
      return all;
    }

    const needle = query.trim().toLowerCase();
    return all.filter((item) => item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle));
  }

  getEntity(entityId: string): HbEntity | undefined {
    return this.entities.get(entityId);
  }

  async refresh(reason: string): Promise<void> {
    if (!this.options.enabled) {
      return;
    }

    const config = await loadHomebridgeConfig(this.log, this.storagePath);
    if (!config) {
      return;
    }

    const discovered = await discoverHapBridgeEndpoints(this.log, this.storagePath, config);

    this.bridges = this.options.includeChildBridges ? discovered : discovered.filter((b) => b.source === 'main');

    // Reset clients
    this.clients.clear();
    for (const bridge of this.bridges) {
      const baseUrl = `http://127.0.0.1:${bridge.port}`;
      this.clients.set(bridge.username, new HapHttpClient(this.log, baseUrl, bridge.pin));
    }

    const nextEntities = new Map<string, HbEntity>();
    for (const bridge of this.bridges) {
      const client = this.clients.get(bridge.username);
      if (!client) {
        continue;
      }

      let accessories: HapAccessoriesResponse;
      try {
        accessories = await client.getAccessories();
      } catch (error) {
        this.log.warn(
          `[LLMControl] Failed to refresh accessories from bridge ${bridge.username} (${bridge.port}): ${(error as Error).message}`,
        );
        continue;
      }

      const entities = this.buildEntitiesFromAccessories(bridge, accessories);
      for (const entity of entities) {
        nextEntities.set(entity.id, entity);
      }
    }

    this.entities = nextEntities;
    this.lastRefreshAt = new Date().toISOString();
    this.log.debug(`[LLMControl] Refreshed ${this.entities.size} controllable entities (${reason}).`);
  }

  async setEntity(entityId: string, patch: HbEntityPatch): Promise<HbEntity> {
    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new Error(`Entity not found: ${entityId}`);
    }

    const client = this.clients.get(entity.bridge.username);
    if (!client) {
      throw new Error(`Bridge client not available: ${entity.bridge.username}`);
    }

    const writes: Array<{ aid: number; iid: number; value: unknown }> = [];
    if (typeof patch.on === 'boolean') {
      writes.push({ aid: entity.hap.aid, iid: entity.hap.onIid, value: patch.on });
    }
    if (typeof patch.brightness === 'number') {
      if (entity.type !== 'light' || !entity.hap.brightnessIid) {
        throw new Error('Brightness not supported for this entity');
      }
      writes.push({
        aid: entity.hap.aid,
        iid: entity.hap.brightnessIid,
        value: Math.max(0, Math.min(100, Math.round(patch.brightness))),
      });
    }

    if (writes.length === 0) {
      return entity;
    }

    await client.setCharacteristics(writes);

    // Best-effort local state update (values may still differ until next refresh).
    if (typeof patch.on === 'boolean') {
      entity.state.on = patch.on;
    }
    if (typeof patch.brightness === 'number' && entity.type === 'light') {
      entity.state.brightness = Math.max(0, Math.min(100, Math.round(patch.brightness)));
    }

    this.entities.set(entityId, entity);
    return entity;
  }

  private buildEntitiesFromAccessories(bridge: HapBridgeEndpoint, accessories: HapAccessoriesResponse): HbEntity[] {
    const results: HbEntity[] = [];

    for (const accessory of accessories.accessories) {
      const accessoryName = this.getAccessoryName(accessory.services) ?? `Accessory ${accessory.aid}`;

      for (const entityType of Object.keys(this.serviceUuids) as HbEntityType[]) {
        const serviceUuid = this.serviceUuids[entityType];
        const services = accessory.services.filter((svc) => svc.type === serviceUuid);
        for (const service of services) {
          const entity = this.buildEntityFromService(bridge, accessory.aid, accessoryName, entityType, service);
          if (entity) {
            results.push(entity);
          }
        }
      }
    }

    // If we have duplicates by name, suffix with bridge or iid to reduce ambiguity.
    const byName = new Map<string, HbEntity[]>();
    for (const item of results) {
      const list = byName.get(item.name) ?? [];
      list.push(item);
      byName.set(item.name, list);
    }

    for (const [name, items] of byName.entries()) {
      if (items.length <= 1) {
        continue;
      }

      for (const item of items) {
        item.name = `${name} (${item.bridge.name})`;
      }
    }

    return results;
  }

  private buildEntityFromService(
    bridge: HapBridgeEndpoint,
    aid: number,
    accessoryName: string,
    entityType: HbEntityType,
    service: HapService,
  ): HbEntity | undefined {
    const onChar = service.characteristics.find((c) => c.type === this.characteristicUuids.on);
    if (!onChar) {
      return undefined;
    }
    if (!Array.isArray(onChar.perms) || !onChar.perms.includes('pw')) {
      // Not writable.
      return undefined;
    }

    const serviceNameChar = service.characteristics.find((c) => c.type === this.characteristicUuids.name);
    const serviceName = serviceNameChar ? getStringValue(serviceNameChar) : undefined;
    const name = serviceName && serviceName !== accessoryName ? `${accessoryName} - ${serviceName}` : accessoryName;

    const brightnessChar =
      entityType === 'light'
        ? service.characteristics.find((c) => c.type === this.characteristicUuids.brightness)
        : undefined;

    const id = `${bridge.username}:${aid}:${service.iid}`;

    return {
      id,
      name,
      type: entityType,
      bridge: {
        username: bridge.username,
        name: bridge.name,
        port: bridge.port,
      },
      hap: {
        aid,
        serviceIid: service.iid,
        onIid: onChar.iid,
        brightnessIid: brightnessChar?.iid,
      },
      state: {
        on: getBoolValue(onChar.value),
        brightness: entityType === 'light' ? getNumberValue(brightnessChar?.value) : undefined,
      },
    };
  }

  private getAccessoryName(services: HapService[]): string | undefined {
    const info = services.find((svc) => svc.type === this.characteristicUuids.accessoryInformation);
    if (!info) {
      return undefined;
    }
    const nameChar = info.characteristics.find((c) => c.type === this.characteristicUuids.name);
    if (!nameChar) {
      return undefined;
    }
    return getStringValue(nameChar);
  }
}
