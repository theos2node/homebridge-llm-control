import { Logger } from 'homebridge';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
};

export type TelegramMessageHandler = (message: {
  chatId: string;
  text: string;
  fromUserId?: string;
  username?: string;
}) => Promise<void>;

export class TelegramService {
  private running = false;
  private pollLoopPromise: Promise<void> | undefined;
  private updateOffset = 0;

  constructor(
    private readonly log: Logger,
    private readonly token: string,
    private readonly pollIntervalMs: number,
    private readonly onMessage: TelegramMessageHandler,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.pollLoopPromise = this.pollLoop();
    this.log.info('Telegram bot polling started.');
  }

  stop(): void {
    this.running = false;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    for (const chunk of this.chunkMessage(text, 3900)) {
      const payload = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };

      const response = await fetch(this.telegramUrl('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
      }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.pollOnce();
      } catch (error) {
        this.log.warn(`Telegram poll error: ${(error as Error).message}`);
      }

      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(0, this.pollIntervalMs - elapsed);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) {
      return;
    }

    const url = this.telegramUrl(
      `getUpdates?offset=${this.updateOffset}&timeout=25&allowed_updates=${encodeURIComponent('["message"]')}`,
    );

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram getUpdates failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok || !Array.isArray(data.result)) {
      throw new Error('Telegram returned malformed updates payload');
    }

    for (const update of data.result) {
      this.updateOffset = update.update_id + 1;
      if (!update.message?.text) {
        continue;
      }

      const chatId = String(update.message.chat.id);
      const fromUserId = update.message.from ? String(update.message.from.id) : undefined;
      const username = update.message.from?.username;

      await this.onMessage({
        chatId,
        text: update.message.text,
        fromUserId,
        username,
      });
    }
  }

  private chunkMessage(message: string, maxLen: number): string[] {
    if (message.length <= maxLen) {
      return [message];
    }

    const chunks: string[] = [];
    let remaining = message;
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.5) {
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private telegramUrl(pathPart: string): string {
    return `https://api.telegram.org/bot${this.token}/${pathPart}`;
  }
}
