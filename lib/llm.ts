import { sleep } from "./jitter";

// A chat model that answers with a JSON object. Providers are tried in order;
// one that hits its daily limit is skipped for the rest of the run.
export type LlmProvider = {
  name: string;
  down: boolean;
  completeJson(system: string, user: string): Promise<unknown>;
};

class LimitReached extends Error {}

const DEFAULT_GROQ_MODELS = "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b";
// Groq checks max_tokens against a model's output-tokens-per-minute cap before running
// the request; qwen3.8-27b's free cap is 1000, so it gets a smaller ceiling.
const MAX_TOKENS: Record<string, number> = { "qwen/qwen3.8-27b": 950 };
// Groq's free tier answers 429 with retry-after: a few seconds for the
// per-minute token limit, much longer once the daily request limit is used up.
const MAX_RATE_WAIT_S = 45;

function groqProvider(key: string, model: string): LlmProvider {
  return {
    name: model,
    down: false,
    async completeJson(system, user) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: MAX_TOKENS[model] ?? 3000,
            ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        if (res.status === 429) {
          const body = await res.text();
          // "Request too large" never succeeds on retry, so skip this model for the run.
          if (/too large/i.test(body)) throw new LimitReached(`${model} request too large for its limits`);
          const wait = Number(res.headers.get("retry-after") ?? "10");
          if (attempt >= 3 || !Number.isFinite(wait) || wait > MAX_RATE_WAIT_S) {
            throw new LimitReached(`${model} rate limit (retry after ${wait}s)`);
          }
          await sleep((wait + 1) * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`${model} returned ${res.status}`);
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
      }
    },
  };
}

type OllamaState = { ok: true; model: string; url: string } | { ok: false; model: string; reason: string };

let ollamaCache: { at: number; state: OllamaState } | null = null;

export async function ollamaStatus(): Promise<OllamaState> {
  const now = Date.now();
  if (ollamaCache && now - ollamaCache.at < 30_000) return ollamaCache.state;
  const url = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
  let state: OllamaState;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) state = { ok: false, model, reason: `ollama returned ${res.status}` };
    else {
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((item) => item.name ?? "");
      const present = names.some((name) => name === model || name.startsWith(`${model}:`) || model.startsWith(name));
      state = present ? { ok: true, model, url } : { ok: false, model, reason: `${model} is not pulled` };
    }
  } catch {
    state = { ok: false, model, reason: "ollama is not running" };
  }
  ollamaCache = { at: now, state };
  return state;
}

function ollamaProvider(url: string, model: string): LlmProvider {
  return {
    name: `ollama:${model}`,
    down: false,
    async completeJson(system, user) {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama returned ${res.status}`);
      const body = (await res.json()) as { message?: { content?: string } };
      return JSON.parse(body.message?.content ?? "{}");
    },
  };
}

export async function llmProviders(): Promise<LlmProvider[]> {
  const providers: LlmProvider[] = [];
  const key = process.env.GROQ_API_KEY?.trim();
  if (key) {
    for (const model of (process.env.GROQ_MODELS || DEFAULT_GROQ_MODELS).split(",")) {
      if (model.trim()) providers.push(groqProvider(key, model.trim()));
    }
  }
  const ollama = await ollamaStatus();
  if (ollama.ok) providers.push(ollamaProvider(ollama.url, ollama.model));
  return providers;
}

// First provider that returns parseable JSON wins. Null means every provider failed.
export async function askJson(
  providers: LlmProvider[],
  system: string,
  user: string,
): Promise<{ data: unknown; model: string } | null> {
  for (const provider of providers) {
    if (provider.down) continue;
    try {
      return { data: await provider.completeJson(system, user), model: provider.name };
    } catch (err) {
      if (err instanceof LimitReached) provider.down = true;
      console.warn(`llm ${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}
