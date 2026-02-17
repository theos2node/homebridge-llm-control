import OpenAI from 'openai';
import { Logger } from 'homebridge';
import { ProviderConfig } from '../settings';

export type LLMAnalysisResult = {
  status: 'ok' | 'warning' | 'critical';
  summary: string;
  findings: string[];
  suggestedActions: Array<{ commandId: string; reason: string }>;
  notify: boolean;
};

export class OpenAIClient {
  private readonly client: OpenAI;

  constructor(private readonly log: Logger, private readonly config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.preset === 'custom' ? config.baseUrl : undefined,
      organization: config.organization,
      timeout: config.requestTimeoutMs,
    });
  }

  async askQuestion(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? 'No response from model.';
  }

  async analyzeHealth(systemPrompt: string, userPrompt: string): Promise<LLMAnalysisResult> {
    let raw: string | null | undefined;

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        temperature: 0,
        max_tokens: this.config.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      raw = response.choices[0]?.message?.content;
    } catch (error) {
      // Some OpenAI-compatible APIs don't support json_object mode; retry without it.
      this.log.warn(`Health analysis JSON mode failed; retrying: ${(error as Error).message}`);
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        temperature: 0,
        max_tokens: this.config.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      raw = response.choices[0]?.message?.content;
    }

    if (!raw) {
      throw new Error('Model returned an empty health analysis response');
    }

    try {
      const jsonCandidate = this.extractJsonCandidate(raw);
      const parsed = JSON.parse(jsonCandidate) as Partial<LLMAnalysisResult>;
      return {
        status: parsed.status === 'critical' || parsed.status === 'warning' ? parsed.status : 'ok',
        summary: parsed.summary ?? 'No summary.',
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
        suggestedActions: Array.isArray(parsed.suggestedActions)
          ? parsed.suggestedActions
              .map((item) => ({
                commandId: String((item as { commandId?: string }).commandId ?? ''),
                reason: String((item as { reason?: string }).reason ?? 'No reason supplied.'),
              }))
              .filter((item) => item.commandId)
          : [],
        notify: Boolean(parsed.notify),
      };
    } catch (error) {
      this.log.error(`Failed to parse health analysis JSON: ${(error as Error).message}`);
      throw new Error(`Invalid JSON from model: ${raw}`);
    }
  }

  private extractJsonCandidate(text: string): string {
    const trimmed = text.trim();
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      return trimmed.slice(first, last + 1);
    }
    return trimmed;
  }
}
