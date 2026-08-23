import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { ChatCompletionClient, ChatCompletionRequest, ChatCompletionResponse } from './types.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface CuragaConfig {
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  temperature: number;
  /** Rewrite attempts per match, including the first one. */
  maxAttempts: number;
  /** How many matches are rewritten in parallel. */
  concurrency: number;
  requestTimeoutMs: number;
}

export type ConfigOverrides = Partial<Omit<CuragaConfig, 'apiKey'>> & { apiKey?: string };

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'OPENAI_API_KEY is not set. Export it in your shell or add it to a .env file ' +
        '(see .env.example). Use `curaga scan` for AST-only analysis without an API key.',
    );
    this.name = 'MissingApiKeyError';
  }
}

/* -------------------------------------------------------------------------- */
/*  .env loading                                                               */
/* -------------------------------------------------------------------------- */

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses a `.env` payload. Supports `export` prefixes, quotes and `#` comments. */
export function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = ENV_LINE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = (match[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

let dotEnvLoadedFrom: string | null = null;

/**
 * Loads `.env` from `cwd` (or the nearest parent containing one) into
 * `process.env` without overwriting variables that are already set.
 */
export function loadDotEnv(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      const parsed = parseDotEnv(fs.readFileSync(candidate, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      dotEnvLoadedFrom = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getDotEnvPath(): string | null {
  return dotEnvLoadedFrom;
}

/* -------------------------------------------------------------------------- */
/*  Config resolution                                                          */
/* -------------------------------------------------------------------------- */

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Resolves configuration from CLI overrides, then the environment, then defaults. */
export function loadConfig(overrides: ConfigOverrides = {}): CuragaConfig {
  const apiKey = overrides.apiKey ?? process.env.OPENAI_API_KEY;
  return {
    apiKey: apiKey && apiKey.trim() !== '' ? apiKey : undefined,
    model: overrides.model ?? process.env.CURAGA_MODEL ?? DEFAULT_MODEL,
    baseUrl: overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? undefined,
    temperature: overrides.temperature ?? numberFromEnv('CURAGA_TEMPERATURE', DEFAULT_TEMPERATURE),
    maxAttempts: Math.max(
      1,
      Math.trunc(overrides.maxAttempts ?? numberFromEnv('CURAGA_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS)),
    ),
    concurrency: Math.max(
      1,
      Math.trunc(overrides.concurrency ?? numberFromEnv('CURAGA_CONCURRENCY', DEFAULT_CONCURRENCY)),
    ),
    requestTimeoutMs: Math.max(
      1_000,
      Math.trunc(overrides.requestTimeoutMs ?? numberFromEnv('CURAGA_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/*  OpenAI client                                                              */
/* -------------------------------------------------------------------------- */

export function createOpenAIClient(config: CuragaConfig): OpenAI {
  if (!config.apiKey) throw new MissingApiKeyError();
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    timeout: config.requestTimeoutMs,
    maxRetries: 2,
  });
}

/**
 * Wraps an OpenAI instance in the narrow {@link ChatCompletionClient} shape the
 * rewriter depends on. The adapter also keeps the SDK's overloaded signatures
 * from leaking into the rest of the codebase.
 */
export function createChatClient(config: CuragaConfig, client?: OpenAI): ChatCompletionClient {
  const openai = client ?? createOpenAIClient(config);
  return {
    chat: {
      completions: {
        create: (request: ChatCompletionRequest): Promise<ChatCompletionResponse> =>
          openai.chat.completions.create(request as never) as Promise<ChatCompletionResponse>,
      },
    },
  };
}
