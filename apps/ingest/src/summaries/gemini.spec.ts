import { EnvValidationError } from '@rejectradar/contracts';
import { createGemini, GeminiError } from './gemini';
import { loadSummaryEnv } from './summary-env';

const ENV = { GEMINI_API_KEY: 'AIzaSyTestKey123', GEMINI_MODEL: 'gemini-3.5-flash' };

const answer = (body: unknown, status = 200) =>
  jest.fn<Promise<Response>, Parameters<typeof fetch>>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const candidate = (text: string, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });
const request = { system: 'Be brief.', prompt: 'Summarise.', schema: { type: 'OBJECT' } };

describe('createGemini', () => {
  it('posts the prompt with the key in a header and returns the parsed JSON', async () => {
    const fetchImpl = answer(candidate('{"summary":"ok"}'));
    const gemini = createGemini(ENV, fetchImpl);
    expect(gemini.model).toBe('gemini-3.5-flash');
    expect(await gemini.generateJson(request)).toEqual({ summary: 'ok' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
    expect(String(url)).not.toContain(ENV.GEMINI_API_KEY);
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': ENV.GEMINI_API_KEY });
    expect(JSON.parse(String(init?.body))).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Summarise.' }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } },
    });
  });

  it('reports an HTTP error by its status only', async () => {
    const gemini = createGemini(ENV, answer({ error: { message: `bad key ${ENV.GEMINI_API_KEY}` } }, 403));
    const error = await gemini.generateJson(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect(error).toMatchObject({ status: 403, message: 'Gemini answered HTTP 403' });
  });

  it('tries a busy or timed-out call three times in all, waiting longer each time', async () => {
    const busy = () => new Response('{}', { status: 503 });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(busy())
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(JSON.stringify(candidate('{"summary":"ok"}'))));
    const wait = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    expect(await createGemini(ENV, fetchImpl, wait).generateJson(request)).toEqual({ summary: 'ok' });
    expect(wait.mock.calls).toEqual([[5_000], [20_000]]);

    const alwaysBusy = jest.fn<Promise<Response>, Parameters<typeof fetch>>().mockImplementation(async () => busy());
    await expect(createGemini(ENV, alwaysBusy, wait).generateJson(request)).rejects.toMatchObject({ status: 503 });
    expect(alwaysBusy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a refused request', async () => {
    const fetchImpl = answer({}, 400);
    await expect(createGemini(ENV, fetchImpl, async () => undefined).generateJson(request)).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a cut-off, empty or non-JSON answer', async () => {
    await expect(createGemini(ENV, answer(candidate('{"summary":', 'MAX_TOKENS'))).generateJson(request)).rejects.toThrow(/MAX_TOKENS/);
    await expect(createGemini(ENV, answer({ candidates: [] })).generateJson(request)).rejects.toThrow(GeminiError);
    await expect(createGemini(ENV, answer(candidate('not json'))).generateJson(request)).rejects.toThrow(/not JSON/);
  });
});

describe('loadSummaryEnv', () => {
  it('reads the key and model', () => {
    expect(loadSummaryEnv(ENV)).toEqual(ENV);
  });

  it('refuses a missing or placeholder key and a model name that is not one', () => {
    expect(() => loadSummaryEnv({ GEMINI_MODEL: ENV.GEMINI_MODEL })).toThrow(EnvValidationError);
    expect(() => loadSummaryEnv({ ...ENV, GEMINI_API_KEY: 'replace-me' })).toThrow(/placeholder/);
    expect(() => loadSummaryEnv({ ...ENV, GEMINI_MODEL: '../x' })).toThrow(/GEMINI_MODEL/);
    expect(() => loadSummaryEnv({ GEMINI_API_KEY: ENV.GEMINI_API_KEY })).toThrow(/GEMINI_MODEL/);
  });
});
