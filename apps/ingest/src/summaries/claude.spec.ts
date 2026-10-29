import type Anthropic from '@anthropic-ai/sdk';
import { EnvValidationError } from '@rejectradar/contracts';
import { createClaude } from './claude';
import { loadSummaryEnv } from './summary-env';

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-api03-test-key', ANTHROPIC_MODEL: 'claude-opus-5-5' };
const request = { system: 'Be brief.', prompt: 'Summarise.', schema: { type: 'object' } };

/** A stand-in for the SDK client whose `beta.messages.create` answers with `stop_reason` and `text`. */
function fakeClient(answer: { stop_reason: string; text: string } | Error) {
  const create = jest.fn().mockImplementation(async () => {
    if (answer instanceof Error) throw answer;
    return { stop_reason: answer.stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: answer.text }] };
  });
  return { create, client: { beta: { messages: { create } } } as unknown as Anthropic };
}

describe('createClaude', () => {
  it('asks for JSON in the schema, at low effort, with the default refusal fallback, and returns it parsed', async () => {
    const { create, client } = fakeClient({ stop_reason: 'end_turn', text: '{"summary":"ok"}' });
    const claude = createClaude(ENV, client);
    expect(claude.model).toBe('claude-opus-5-5');
    expect(await claude.generateJson(request)).toEqual({ summary: 'ok' });
    expect(create).toHaveBeenCalledWith({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Summarise.' }],
    });
  });

  it('a refusal, a cut-off or text that is not JSON is an unusable answer', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await createClaude(ENV, fakeClient({ stop_reason: 'refusal', text: '' }).client).generateJson(request)).toBeNull();
    expect(await createClaude(ENV, fakeClient({ stop_reason: 'max_tokens', text: '{"summary":' }).client).generateJson(request)).toBeNull();
    expect(warn.mock.calls).toEqual([['summaries: Claude stopped with refusal'], ['summaries: Claude stopped with max_tokens']]);
    warn.mockRestore();
    expect(await createClaude(ENV, fakeClient({ stop_reason: 'end_turn', text: 'not json' }).client).generateJson(request)).toBeNull();
  });

  it('a call that fails after the SDK retries throws', async () => {
    const { client } = fakeClient(new Error('503 overloaded'));
    await expect(createClaude(ENV, client).generateJson(request)).rejects.toThrow('503 overloaded');
  });
});

describe('loadSummaryEnv', () => {
  it('reads the key and model', () => {
    expect(loadSummaryEnv(ENV)).toEqual(ENV);
  });

  it('refuses a missing or placeholder key and a model id that is not one', () => {
    expect(() => loadSummaryEnv({ ANTHROPIC_MODEL: ENV.ANTHROPIC_MODEL })).toThrow(EnvValidationError);
    expect(() => loadSummaryEnv({ ...ENV, ANTHROPIC_API_KEY: 'replace-me' })).toThrow(/placeholder/);
    expect(() => loadSummaryEnv({ ...ENV, ANTHROPIC_MODEL: 'gpt-5' })).toThrow(/ANTHROPIC_MODEL/);
    expect(() => loadSummaryEnv({ ANTHROPIC_API_KEY: ENV.ANTHROPIC_API_KEY })).toThrow(/ANTHROPIC_MODEL/);
  });
});
