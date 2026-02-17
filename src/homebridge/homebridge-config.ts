import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from 'homebridge';

export type HomebridgeBridgeConfig = {
  name?: string;
  username?: string;
  pin?: string;
  port?: number;
  bind?: string;
};

export type HomebridgeChildBridgeConfig = {
  username: string;
  port?: number;
  pin?: string;
  name?: string;
};

export type HomebridgeConfigJson = {
  bridge?: HomebridgeBridgeConfig;
  accessories?: Array<Record<string, unknown> & { _bridge?: HomebridgeChildBridgeConfig }>;
  platforms?: Array<Record<string, unknown> & { _bridge?: HomebridgeChildBridgeConfig }>;
};

export type HapBridgeEndpoint = {
  username: string;
  port: number;
  pin: string;
  name: string;
  source: 'main' | 'child';
};

type AccessoryInfoJson = {
  username?: string;
  pincode?: string;
  port?: number;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined => {
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

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export const loadHomebridgeConfig = async (
  log: Logger,
  storagePath: string,
): Promise<HomebridgeConfigJson | null> => {
  const configPath = path.join(storagePath, 'config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      log.warn(`[LLMControl] config.json is not an object; cannot load Homebridge bridge details.`);
      return null;
    }
    return parsed as HomebridgeConfigJson;
  } catch (error) {
    log.warn(`[LLMControl] Failed to read Homebridge config.json for control features: ${(error as Error).message}`);
    return null;
  }
};

const normalizeAccessoryInfoId = (username: string): string => username.replace(/:/g, '').toUpperCase();

const loadAccessoryInfo = async (
  log: Logger,
  storagePath: string,
  username: string,
): Promise<{ pin?: string; port?: number }> => {
  const persistDir = path.join(storagePath, 'persist');
  const normalized = normalizeAccessoryInfoId(username);

  const tryLoadFile = async (filePath: string): Promise<{ pin?: string; port?: number } | undefined> => {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed)) {
        return undefined;
      }

      const record = parsed as AccessoryInfoJson;
      const pincode = asString(record.pincode);
      const port = asNumber(record.port);
      if (!pincode && !port) {
        return undefined;
      }
      return { pin: pincode, port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.debug(`[LLMControl] Failed to read ${filePath}: ${(error as Error).message}`);
      }
      return undefined;
    }
  };

  // Fast-path: the common naming convention used by HAP-NodeJS.
  const directPath = path.join(persistDir, `AccessoryInfo.${normalized}.json`);
  const directInfo = await tryLoadFile(directPath);
  if (directInfo) {
    return directInfo;
  }

  // Fallback: scan persist dir for matching AccessoryInfo.*.json.
  try {
    const files = await readdir(persistDir);
    const candidates = files.filter((f) => f.startsWith('AccessoryInfo.') && f.endsWith('.json'));
    for (const file of candidates) {
      if (!file.toUpperCase().includes(normalized)) {
        continue;
      }
      const info = await tryLoadFile(path.join(persistDir, file));
      if (info) {
        return info;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.debug(`[LLMControl] Failed to scan persist dir for AccessoryInfo: ${(error as Error).message}`);
    }
  }

  return {};
};

export const discoverHapBridgeEndpoints = async (
  log: Logger,
  storagePath: string,
  config: HomebridgeConfigJson,
): Promise<HapBridgeEndpoint[]> => {
  const endpoints: HapBridgeEndpoint[] = [];

  const mainBridge = config.bridge;
  const mainUsername = asString(mainBridge?.username);
  const mainName = asString(mainBridge?.name) ?? 'Homebridge';

  const mainAccessoryInfo = mainUsername ? await loadAccessoryInfo(log, storagePath, mainUsername) : undefined;
  const mainPin = mainUsername ? (asString(mainBridge?.pin) ?? mainAccessoryInfo?.pin) : undefined;
  const mainPort = asNumber(mainBridge?.port) ?? mainAccessoryInfo?.port ?? 51826;

  if (mainUsername && mainPin) {
    endpoints.push({
      username: mainUsername.toUpperCase(),
      pin: mainPin,
      port: mainPort,
      name: mainName,
      source: 'main',
    });
  } else {
    log.warn(
      `[LLMControl] Homebridge main bridge username/pin not found. ` +
        `Accessory control may not work until bridge.username and bridge.pin are set (or AccessoryInfo is present).`,
    );
  }

  const seen = new Set(endpoints.map((item) => item.username));

  const addChildBridge = async (bridge: HomebridgeChildBridgeConfig | undefined): Promise<void> => {
    const username = asString(bridge?.username);
    const name = asString(bridge?.name) ?? username ?? 'Child Bridge';

    if (!username) {
      return;
    }

    const accessoryInfo = await loadAccessoryInfo(log, storagePath, username);
    const port = asNumber(bridge?.port) ?? accessoryInfo.port;
    const pin = asString(bridge?.pin) ?? accessoryInfo.pin ?? mainPin;
    if (!port) {
      return;
    }
    if (!pin) {
      return;
    }

    const upper = username.toUpperCase();
    if (seen.has(upper)) {
      return;
    }

    seen.add(upper);
    endpoints.push({
      username: upper,
      pin,
      port,
      name,
      source: 'child',
    });
  };

  for (const item of config.platforms ?? []) {
    await addChildBridge(item?._bridge);
  }
  for (const item of config.accessories ?? []) {
    await addChildBridge(item?._bridge);
  }

  return endpoints;
};
