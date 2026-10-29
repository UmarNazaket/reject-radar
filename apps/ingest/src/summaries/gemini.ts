import type { SummaryEnv } from '@rejectradar/contracts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 120_000;

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

/** A Gemini `generateContent` client with structured JSON output. The key travels in a header, never in the URL. */
export function createGemini(env: SummaryEnv, fetchImpl: typeof fetch = fetch): { model: string; generateJson: GenerateJson } {
  const generateJson: GenerateJson = async ({ system, prompt, schema }) => {
    const res = await fetchImpl(`${ENDPOINT}/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
