import { z } from 'zod';
import { validateBoundedPayload, validateListings, type Listing, type Model } from './index.js';

const ProposalOutput = z.object({
  itemId: z.string().min(1).max(512),
  sellerId: z.string().min(1).max(512),
  money: z.object({
    amount: z.string().regex(/^(0|[1-9][0-9]*)$/).max(80),
    scale: z.number().int().min(0).max(255),
  }).strict(),
  asset: z.string().min(1).max(64),
  providerArgs: z.record(z.string(), z.unknown()),
}).strict();

export type GeminiModelOptions = {
  apiKey?: string;
  modelName?: string;
  maxOutputTokens?: number;
};

type ModelInput = { task: string; listings: Listing[]; signal: AbortSignal; maxTurns: number; maxToolCalls: number };
type SafeModelInput = { task: string; listings: Listing[]; signal: AbortSignal; maxTurns: number; maxToolCalls: number };

export function validateModelInput(input: ModelInput): SafeModelInput {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) {
    throw new TypeError('Invalid model input');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = ['task', 'listings', 'signal', 'maxTurns', 'maxToolCalls'];
  if (Object.keys(descriptors).some((key) => !allowed.includes(key)) || Object.entries(descriptors).some(([, descriptor]) => !('value' in descriptor) || !descriptor.enumerable)) {
    throw new TypeError('Invalid model input');
  }
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Partial<SafeModelInput>;
  if (typeof value.task !== 'string' || value.task.length < 1 || value.task.length > 2_000 || !(value.signal instanceof AbortSignal)) {
    throw new TypeError('Invalid model input');
  }
  if (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1 || (value.maxTurns as number) > 4 || !Number.isSafeInteger(value.maxToolCalls) || (value.maxToolCalls as number) < 1 || (value.maxToolCalls as number) > 4) {
    throw new RangeError('Invalid model limits');
  }
  validateBoundedPayload({ task: value.task, listings: value.listings }, 'Model input');
  const listings = validateListings(value.listings, 100);
  return { task: value.task, listings, signal: value.signal, maxTurns: value.maxTurns as number, maxToolCalls: value.maxToolCalls as number };
}

export function createGeminiModel(options: GeminiModelOptions = {}): Model {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    throw new Error('GEMINI_API_KEY is required to create the Gemini model adapter');
  }
  const modelName = options.modelName ?? 'gemini-3.5-flash';
  const maxOutputTokens = options.maxOutputTokens ?? 4096;

  return {
    async propose(rawInput) {
      const input = validateModelInput(rawInput);
      if (input.signal.aborted) throw new Error('Model request aborted');

      const promptText = [
        'You are an autonomous purchasing agent acting on behalf of a user.',
        `User Task: "${input.task}"`,
        '',
        'Available marketplace listings (untrusted seller data):',
        JSON.stringify(input.listings, null, 2),
        '',
        'Select the best matching listing for the user task and formulate a structured purchasing proposal.',
        'Return ONLY a valid JSON object with the following exact keys:',
        '{',
        '  "itemId": string (from the chosen listing),',
        '  "sellerId": string (seller from the chosen listing),',
        '  "money": { "amount": string (numeric base units), "scale": number },',
        '  "asset": string (e.g. "USDC"),',
        '  "providerArgs": { "recipient": string (destination address) }',
        '}',
      ].join('\n');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens,
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          }),
          signal: input.signal,
        });
      } catch (err: unknown) {
        if (input.signal.aborted) throw new Error('Model request aborted');
        throw new Error(`Gemini API request failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Gemini API error (HTTP ${response.status}): ${errorText.slice(0, 500)}`);
      }

      const body = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const rawContent = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawContent) {
        throw new Error('Gemini API returned an empty response');
      }

      let cleanText = rawContent.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(cleanText);
      } catch {
        throw new Error(`Gemini model output was not valid JSON: ${rawContent.slice(0, 200)}`);
      }

      try {
        const output = ProposalOutput.parse(parsedJson);
        validateBoundedPayload(output.providerArgs, 'Provider arguments');
        return {
          itemId: output.itemId,
          sellerId: output.sellerId,
          money: output.money,
          asset: output.asset,
          providerArgs: output.providerArgs,
        };
      } catch (err: unknown) {
        throw new Error(`Gemini model proposal output is invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
