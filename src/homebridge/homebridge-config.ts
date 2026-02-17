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
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

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

const loadAccessoryInfoPin = async (log: Logger, storagePath: string, username: string): Promise<string | undefined> => {
  const persistDir = path.join(storagePath, 'persist');
  const normalized = normalizeAccessoryInfoId(username);

  const tryLoadFile = async (filePath: string): Promise<string | undefined> => {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed)) {
        return undefined;
      }

      const pincode = asString((parsed as AccessoryInfoJson).pincode);
      return pincode;
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
  const directPin = await tryLoadFile(directPath);
  if (directPin) {
    return directPin;
  }

  // Fallback: scan persist dir for matching AccessoryInfo.*.json.
  try {
    const files = await readdir(persistDir);
    const candidates = files.filter((f) => f.startsWith('AccessoryInfo.') && f.endsWith('.json'));
    for (const file of candidates) {
      if (!file.toUpperCase().includes(normalized)) {
        continue;
      }
      const pin = await tryLoadFile(path.join(persistDir, file));
      if (pin) {
        return pin;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.debug(`[LLMControl] Failed to scan persist dir for AccessoryInfo: ${(error as Error).message}`);
    }
  }

  return undefined;
};

export const discoverHapBridgeEndpoints = async (
  log: Logger,
  storagePath: string,
  config: HomebridgeConfigJson,
): Promise<HapBridgeEndpoint[]> => {
  const endpoints: HapBridgeEndpoint[] = [];

  const mainBridge = config.bridge;
  const mainUsername = asString(mainBridge?.username);
  const mainPort = asNumber(mainBridge?.port) ?? 51826;
  const mainName = asString(mainBridge?.name) ?? 'Homebridge';

  const mainPin = mainUsername
    ? (asString(mainBridge?.pin) ?? (await loadAccessoryInfoPin(log, storagePath, mainUsername)))
    : undefined;

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
    const port = asNumber(bridge?.port);
    const name = asString(bridge?.name) ?? username ?? 'Child Bridge';

    if (!username || !port) {
      return;
    }

    const pin = asString(bridge?.pin) ?? (await loadAccessoryInfoPin(log, storagePath, username)) ?? mainPin;
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
