import Anthropic from '@anthropic-ai/sdk';
import type { SummaryEnv } from '@rejectradar/contracts';

/** A JSON Schema the answer must follow (structured outputs). */
export type ResponseSchema = Record<string, unknown>;

/** Asks the model for JSON in `schema`'s shape and returns it parsed, or null when the answer is unusable (a refusal, a cut-off). */
export type GenerateJson = (request: { system: string; prompt: string; schema: ResponseSchema }) => Promise<unknown>;

/**
 * A Claude client with structured JSON output. The SDK retries a busy (429, 5xx) or timed-out call twice; a call that
 * still fails throws. A refusal goes first to Anthropic's recommended fallback model, server-side.
 */
export function createClaude(
  env: SummaryEnv,
  client: Anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000 }),
): { model: string; generateJson: GenerateJson } {
  const generateJson: GenerateJson = async ({ system, prompt, schema }) => {
    const response = await client.beta.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // A short, fully specified task: low effort keeps it quick and cheap.
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason !== 'end_turn') {
      console.warn(`summaries: Claude stopped with ${response.stop_reason}`);
      return null;
    }
    const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
  return { model: env.ANTHROPIC_MODEL, generateJson };
}
