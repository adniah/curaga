import {
  REWRITE_JSON_SCHEMA,
  RewriteResponseSchema,
  type ChatCompletionClient,
  type ChatMessage,
  type MigrationRule,
  type RewriteResponse,
  type RewriteResult,
  type RuleMatcher,
  type ScanMatch,
} from '../types.js';
import { DEFAULT_MODEL, DEFAULT_TEMPERATURE } from '../config.js';
import { resolveMatch } from '../rules/index.js';
import { formatIssuesForRetry, validateSnippet } from './validator.js';

/** Below this confidence a rewrite is flagged for review instead of auto-applied. */
export const CONFIDENCE_THRESHOLD = 0.6;

export interface RewriteProgressEvent {
  match: ScanMatch;
  index: number;
  total: number;
  attempt: number;
  phase: 'start' | 'retry' | 'done';
  status?: RewriteResult['status'];
}

export interface RewriterOptions {
  client: ChatCompletionClient;
  model?: string;
  temperature?: number;
  maxAttempts?: number;
  concurrency?: number;
  /** Rule set used to resolve matchers. Defaults to the built-in registry. */
  rules?: MigrationRule[];
  onProgress?: (event: RewriteProgressEvent) => void;
}

/* -------------------------------------------------------------------------- */
/*  Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are Curaga, a precise TypeScript refactoring engine that migrates code across',
  'breaking third-party API changes.',
  '',
  'Hard requirements:',
  '1. Return ONLY the replacement source for the snippet you are given — no markdown',
  '   fences, no prose, no surrounding function or import statements.',
  '2. Preserve everything unrelated to the migration: variable names that still make',
  '   sense, comments, `await`/`return` keywords, type annotations, generics, and the',
  '   trailing semicolon style of the original snippet.',
  '3. Never invent parameters, endpoints or helper functions that were not implied by the',
  '   migration guidance. If information is genuinely missing, keep the closest faithful',
  '   translation, set requiresManualReview to true and describe the gap in followUpNotes.',
  '4. The replacement must be a drop-in substitute for the original snippet: same kind of',
  '   syntactic unit, same indentation base, usable at the exact position it came from.',
  '5. Only the snippet is replaced — the surrounding context is read-only. Never rename a',
  '   binding, parameter or export that the context references outside the snippet, because',
  '   those references cannot be updated for you.',
  '6. Do not add explanatory comments to the code unless the original had them.',
].join('\n');

function renderExamples(matcher: RuleMatcher): string {
  if (matcher.examples.length === 0) return '';
  const rendered = matcher.examples
    .map((example, index) => `Example ${index + 1} — before:\n${example.before}\n\nExample ${index + 1} — after:\n${example.after}`)
    .join('\n\n');
  return `\n\n${rendered}`;
}

export function buildUserPrompt(match: ScanMatch, rule: MigrationRule, matcher: RuleMatcher): string {
  const unit =
    match.replace === 'statement'
      ? 'a complete statement (your rewrite must also be one or more complete statements)'
      : 'a single expression (your rewrite must also be a single expression)';

  return [
    `Migration: ${rule.title}`,
    `Package: ${rule.package} (${rule.fromVersion} → ${rule.toVersion})`,
    rule.docsUrl ? `Docs: ${rule.docsUrl}` : '',
    '',
    `Deprecated usage: ${matcher.description}`,
    `Required change: ${matcher.replacementHint}`,
    '',
    rule.guidance ? `${rule.guidance}\n` : '',
    renderExamples(matcher).trim(),
    '',
    `File: ${match.relativePath}:${match.line}:${match.column}`,
    `Matched call path: ${match.callPath}`,
    `The snippet below is ${unit}.`,
    '',
    'Surrounding context (read-only, do not reproduce it):',
    '```typescript',
    match.contextText,
    '```',
    '',
    'Snippet to rewrite (replace exactly this):',
    '```typescript',
    match.originalText,
    '```',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function buildMessages(
  match: ScanMatch,
  rule: MigrationRule,
  matcher: RuleMatcher,
  history: ChatMessage[] = [],
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(match, rule, matcher) },
    ...history,
  ];
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

export class RewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewriteError';
  }
}

export function parseRewriteResponse(raw: unknown): RewriteResponse {
  const response = raw as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } | null }> };
  const message = response?.choices?.[0]?.message;

  if (message?.refusal) throw new RewriteError(`Model refused the rewrite: ${message.refusal}`);

  const content = message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new RewriteError('Model returned an empty completion.');
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new RewriteError('Model response was not valid JSON.');
  }

  const parsed = RewriteResponseSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new RewriteError(`Model response did not match the rewrite schema — ${details}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Concurrency                                                                */
/* -------------------------------------------------------------------------- */

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/* -------------------------------------------------------------------------- */
/*  Rewriter                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turns scan matches into validated replacement snippets.
 *
 * Each match gets its own conversation. When the validator rejects a rewrite,
 * the failure is fed back to the model as an additional turn, up to
 * `maxAttempts` times — cheaper and far more reliable than a single shot.
 */
export class Rewriter {
  private readonly client: ChatCompletionClient;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly rules: MigrationRule[] | undefined;
  private readonly onProgress: ((event: RewriteProgressEvent) => void) | undefined;

  constructor(options: RewriterOptions) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_MODEL;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.rules = options.rules;
    this.onProgress = options.onProgress;
  }

  private async complete(messages: ChatMessage[]): Promise<RewriteResponse> {
    const raw = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'curaga_rewrite',
          strict: true,
          schema: REWRITE_JSON_SCHEMA,
        },
      },
    });
    return parseRewriteResponse(raw);
  }

  /** Rewrites a single match, retrying with validator feedback when needed. */
  async rewriteOne(match: ScanMatch, index = 0, total = 1): Promise<RewriteResult> {
    const { rule, matcher } = resolveMatch(match, this.rules);
    const history: ChatMessage[] = [];

    let lastError: string | null = null;
    let lastResponse: RewriteResponse | null = null;
    let lastValidation: RewriteResult['validation'] = null;
    let attempt = 0;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      this.onProgress?.({ match, index, total, attempt, phase: attempt === 1 ? 'start' : 'retry' });

      let response: RewriteResponse;
      try {
        response = await this.complete(buildMessages(match, rule, matcher, history));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Transport/parse failures are worth one more shot, but there is no
        // useful feedback to add to the conversation.
        continue;
      }

      lastResponse = response;
      lastError = null;

      const validation = validateSnippet(response.rewrittenCode, {
        scope: match.replace,
        forbidden: matcher.forbidden,
        originalText: match.originalText,
      });
      lastValidation = validation;

      if (validation.valid) {
        const status: RewriteResult['status'] =
          response.requiresManualReview || response.confidence < CONFIDENCE_THRESHOLD
            ? 'needs-review'
            : 'rewritten';
        this.onProgress?.({ match, index, total, attempt, phase: 'done', status });
        return {
          match,
          status,
          code: validation.normalized,
          response,
          validation,
          attempts: attempt,
          error: null,
        };
      }

      history.push(
        { role: 'assistant', content: JSON.stringify(response) },
        {
          role: 'user',
          content: [
            'That rewrite was rejected by the validator:',
            formatIssuesForRetry(validation),
            '',
            'Return a corrected rewrite that fixes every issue above. Same output format.',
          ].join('\n'),
        },
      );
    }

    this.onProgress?.({ match, index, total, attempt, phase: 'done', status: 'failed' });
    return {
      match,
      status: 'failed',
      code: null,
      response: lastResponse,
      validation: lastValidation,
      attempts: attempt,
      error: lastError ?? 'Rewrite failed validation after all attempts.',
    };
  }

  /** Rewrites every match, bounded by the configured concurrency. */
  async rewriteAll(matches: ScanMatch[]): Promise<RewriteResult[]> {
    return mapWithConcurrency(matches, this.concurrency, (match, index) =>
      this.rewriteOne(match, index, matches.length),
    );
  }
}
