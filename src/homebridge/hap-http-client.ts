import { Logger } from 'homebridge';

export type HapCharacteristic = {
  iid: number;
  type: string;
  perms?: string[];
  format?: string;
  description?: string;
  value?: unknown;
};

export type HapService = {
  iid: number;
  type: string;
  characteristics: HapCharacteristic[];
};

export type HapAccessory = {
  aid: number;
  services: HapService[];
};

export type HapAccessoriesResponse = {
  accessories: HapAccessory[];
};

export type HapWrite = {
  aid: number;
  iid: number;
  value: unknown;
};

export class HapHttpClient {
  constructor(
    private readonly log: Logger,
    private readonly baseUrl: string,
    private readonly pin: string,
  ) {}

  async getAccessories(): Promise<HapAccessoriesResponse> {
    const response = await fetch(`${this.baseUrl}/accessories`, {
      headers: { Accept: 'application/hap+json' },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET /accessories failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as unknown;
    if (!json || typeof json !== 'object' || !Array.isArray((json as { accessories?: unknown }).accessories)) {
      throw new Error('Malformed /accessories response');
    }

    return json as HapAccessoriesResponse;
  }

  async setCharacteristics(writes: HapWrite[]): Promise<void> {
    const payload = { characteristics: writes };

    const response = await fetch(`${this.baseUrl}/characteristics`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/hap+json',
        // HAP-NodeJS allows insecure writes when allowInsecureRequest=true and Authorization matches the pin.
        Authorization: this.pin,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) {
      return;
    }

    if (response.status === 207) {
      const json = (await response.json()) as { characteristics?: Array<{ status?: number; aid?: number; iid?: number }> };
      const failures = (json.characteristics ?? []).filter((item) => typeof item.status === 'number' && item.status !== 0);
      if (failures.length === 0) {
        return;
      }
      throw new Error(`Characteristic write returned errors: ${JSON.stringify(failures)}`);
    }

    const body = await response.text();
    throw new Error(`PUT /characteristics failed (${response.status}): ${body}`);
  }

  async ping(): Promise<boolean> {
    try {
      await this.getAccessories();
      return true;
    } catch (error) {
      this.log.debug(`[LLMControl] HAP server ping failed (${this.baseUrl}): ${(error as Error).message}`);
      return false;
    }
  }
}

