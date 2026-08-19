// Minimal OpenRouter chat client, dependency-free — the repo has no OpenAI SDK.
//
// OpenRouter returns real spend on every response in usage.cost (USD charged to the account), so
// cost here is measured rather than estimated from a price table.
import fs from 'node:fs';
import path from 'node:path';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Reads KEY=VALUE pairs from a .env file into process.env without overwriting existing values. */
export function loadEnv(root) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      let value = m[2].trim();
      if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  }
}

export function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set. Put it in .env (see .env.example).');
  return key;
}

/**
 * One chat completion. Returns { text, usage, raw, ms }, where usage carries OpenRouter's
 * measured cost in USD plus token counts.
 */
export async function chat({
  model,
  messages,
  schema,
  schemaName = 'output',
  maxTokens,
  temperature = 0,
  plugins,
  reasoning,
  timeoutMs = 15 * 60 * 1000,
  retries = 2,
}) {
  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (plugins) body.plugins = plugins;
  if (reasoning) body.reasoning = reasoning;
  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    };
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.aiequityreports.com',
          'X-Title': 'Valuatum report-content extraction',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new Error(`OpenRouter ${response.status}: ${text.slice(0, 800)}`);
        if (!retryable || attempt === retries) throw error;
        lastError = error;
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const json = JSON.parse(text);
      if (json.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 800)}`);
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (!content) throw new Error(`OpenRouter returned no content: ${text.slice(0, 800)}`);

      return {
        text: content,
        finishReason: choice.finish_reason,
        usage: normalizeUsage(json.usage, json.model || model),
        provider: json.provider ?? null,
        ms: Date.now() - started,
      };
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

function normalizeUsage(usage = {}, model) {
  return {
    model,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    // usd is what OpenRouter charged the account, including any file-parser or cache surcharge.
    usd: typeof usage.cost === 'number' ? usage.cost : null,
    upstreamUsd: usage.cost_details?.upstream_inference_cost ?? null,
  };
}

/** Pulls the JSON object out of a model response that may be fenced or prefaced with prose. */
export function parseJsonResponse(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`Response was not JSON: ${text.slice(0, 400)}`);
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

export const fmtUsd = (n) => (typeof n === 'number' ? `$${n.toFixed(4)}` : 'n/a');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
