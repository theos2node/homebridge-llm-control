import { Logger } from 'homebridge';

export class DiscordWebhookService {
  constructor(
    private readonly log: Logger,
    private readonly webhookUrl: string,
  ) {}

  async sendMessage(text: string): Promise<void> {
    // Discord message limit is 2000 characters.
    const chunks = this.chunkMessage(text, 1900);
    for (const chunk of chunks) {
      const payload = { content: chunk };
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        this.log.debug(`[LLMControl] Discord webhook error body: ${body}`);
        throw new Error(`Discord webhook failed (${response.status}).`);
      }
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
}

