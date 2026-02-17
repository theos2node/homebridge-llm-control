import { Logger } from 'homebridge';

type NtfyEvent =
  | {
      event: 'open' | 'keepalive';
      topic?: string;
    }
  | {
      event: 'message';
      id?: string;
      time?: number;
      topic: string;
      message: string;
      title?: string;
      tags?: string[];
    };

export type NtfyMessageHandler = (message: { topic: string; text: string }) => Promise<void>;

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

const normalizeServerUrl = (serverUrl: string): string => serverUrl.replace(/\/+$/, '');

export class NtfyService {
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private abort?: AbortController;

  constructor(
    private readonly log: Logger,
    private readonly serverUrl: string,
    private readonly topic: string,
    private readonly options: {
      subscribeEnabled: boolean;
      publishEnabled: boolean;
      outgoingTag: string;
    },
    private readonly onMessage: NtfyMessageHandler,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    if (this.options.subscribeEnabled) {
      this.loopPromise = this.subscribeLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.options.publishEnabled) {
      return;
    }

    const payload = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
    const url = `${normalizeServerUrl(this.serverUrl)}/${encodeURIComponent(this.topic)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // Mark outgoing messages so the subscriber can ignore them.
        Tags: this.options.outgoingTag,
        Title: 'Homebridge LLM Control',
      },
      body: payload,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ntfy publish failed (${response.status}): ${body}`);
    }
  }

  private async subscribeLoop(): Promise<void> {
    const url = `${normalizeServerUrl(this.serverUrl)}/${encodeURIComponent(this.topic)}/json`;
    let backoffMs = 1000;

    while (this.running) {
      this.abort = new AbortController();

      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/x-ndjson' },
          signal: this.abort.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`ntfy subscribe failed (${response.status}): ${body}`);
        }

        const bodyStream = response.body;
        if (!bodyStream) {
          throw new Error('ntfy subscribe response has no body stream');
        }

        backoffMs = 1000;
        await this.readNdjsonStream(bodyStream);
      } catch (error) {
        if (!this.running) {
          return;
        }
        this.log.warn(`[LLMControl] ntfy subscribe error: ${(error as Error).message}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      } finally {
        this.abort = undefined;
      }
    }
  }

  private async readNdjsonStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (this.running) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // ndjson: one JSON object per line.
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) {
          break;
        }

        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          continue;
        }

        let event: NtfyEvent | undefined;
        try {
          event = JSON.parse(line) as NtfyEvent;
        } catch {
          continue;
        }

        if (!event || typeof event !== 'object' || !('event' in event)) {
          continue;
        }

        if (event.event !== 'message') {
          continue;
        }

        const topic = typeof event.topic === 'string' ? event.topic : '';
        const message = typeof event.message === 'string' ? event.message : '';
        const tags = Array.isArray(event.tags) ? event.tags.filter((t) => typeof t === 'string') : [];
        if (!topic || !message) {
          continue;
        }

        // Ignore our own outgoing messages.
        if (this.options.outgoingTag && tags.includes(this.options.outgoingTag)) {
          continue;
        }

        await this.onMessage({ topic, text: message });
      }
    }
  }
}
