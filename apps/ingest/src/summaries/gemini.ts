import type { SummaryEnv } from '@rejectradar/contracts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 60_000;
/** Waits before each retry of a call Gemini was too busy for (429, 500, 503) or that timed out. */
const RETRY_DELAYS_MS = [5_000, 20_000];
const RETRY_STATUSES = new Set([429, 500, 503]);

/** A Gemini response schema (the OpenAPI subset `generateContent` takes). */
export type ResponseSchema = Record<string, unknown>;

/** Asks the model for JSON in `schema`'s shape and returns it parsed, not yet validated. */
export type GenerateJson = (request: { system: string; prompt: string; schema: ResponseSchema }) => Promise<unknown>;

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
}

/**
 * A Gemini `generateContent` client with structured JSON output. The key travels in a header, never in the URL. A busy
 * or timed-out call is tried three times in all.
 */
export function createGemini(
  env: SummaryEnv,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): { model: string; generateJson: GenerateJson } {
  const post = async (body: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= RETRY_DELAYS_MS.length;
      try {
        const res = await fetchImpl(`${ENDPOINT}/${env.GEMINI_MODEL}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (last || !RETRY_STATUSES.has(res.status)) return res;
      } catch (error) {
        if (last || (error as Error).name !== 'TimeoutError') throw error;
      }
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  };

  const generateJson: GenerateJson = async ({ system, prompt, schema }) => {
    const res = await post(
      JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
    );
    // The body of an error can echo the request, so only the status is reported.
    if (!res.ok) throw new GeminiError(`Gemini answered HTTP ${res.status}`, res.status);
    const body = (await res.json()) as GenerateContentResponse;
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    if (candidate?.finishReason !== 'STOP' || text === '') {
      throw new GeminiError(`Gemini returned no complete answer (finishReason ${candidate?.finishReason ?? 'none'})`, res.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GeminiError('Gemini returned text that is not JSON', res.status);
    }
  };
  return { model: env.GEMINI_MODEL, generateJson };
}
