import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Rules                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What kind of AST node a matcher targets.
 * - `call`     — a call expression such as `stripe.charges.create({ ... })`
 * - `property` — a bare property access such as `charge.source` (never invoked)
 */
export const MatcherKindSchema = z.enum(['call', 'property']);
export type MatcherKind = z.infer<typeof MatcherKindSchema>;

/**
 * How much source text is handed to the LLM and replaced afterwards.
 * - `node`      — only the matched expression (plus a wrapping `await`, if any)
 * - `statement` — the whole enclosing statement, which lets the model rename
 *                 destructured bindings or split one call into several.
 */
export const ReplaceScopeSchema = z.enum(['node', 'statement']);
export type ReplaceScope = z.infer<typeof ReplaceScopeSchema>;

export const RuleExampleSchema = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
});
export type RuleExample = z.infer<typeof RuleExampleSchema>;

export const RuleMatcherSchema = z.object({
  /** Stable id, unique within the rule. Used in reports and `--only` filters. */
  id: z.string().min(1),
  /**
   * Dotted access path to match, e.g. `stripe.charges.create`.
   *
   * Matching is suffix based, so `stripe.charges.create` also matches
   * `this.stripe.charges.create`. Use a leading `*` segment to accept any
   * receiver (`*.charges.create` matches `client.charges.create` too).
   */
  callPath: z.string().min(1),
  kind: MatcherKindSchema.default('call'),
  replace: ReplaceScopeSchema.default('node'),
  /** Human readable description of what is deprecated. */
  description: z.string().min(1),
  /** Instructions handed to the model describing the target API shape. */
  replacementHint: z.string().min(1),
  /**
   * Substrings that must not survive in the rewritten code. A rewrite that
   * still contains one of these is rejected before it can be applied.
   */
  forbidden: z.array(z.string()).default([]),
  examples: z.array(RuleExampleSchema).default([]),
});
export type RuleMatcher = z.infer<typeof RuleMatcherSchema>;

export const MigrationRuleSchema = z.object({
  id: z.string().min(1),
  /** npm package the rule migrates, e.g. `stripe`. */
  package: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  docsUrl: z.string().url().optional(),
  /** Free-form migration notes injected into the system prompt. */
  guidance: z.string().default(''),
  matchers: z.array(RuleMatcherSchema).min(1),
});
export type MigrationRule = z.infer<typeof MigrationRuleSchema>;

/** Authoring shape (defaults still optional) — use this when writing rules. */
export type MigrationRuleInput = z.input<typeof MigrationRuleSchema>;

/* -------------------------------------------------------------------------- */
/*  Scanner                                                                    */
/* -------------------------------------------------------------------------- */

export interface ScanMatch {
  ruleId: string;
  matcherId: string;
  /** Absolute path of the file containing the match. */
  filePath: string;
  /** Path relative to the scan root, for display. */
  relativePath: string;
  line: number;
  column: number;
  /** The dotted path as written in source, e.g. `this.stripe.charges.create`. */
  callPath: string;
  replace: ReplaceScope;
  /** Exact source text that will be replaced. */
  originalText: string;
  /** Surrounding source used as prompt context (never replaced). */
  contextText: string;
  /** Character offsets of `originalText` within the file. */
  start: number;
  end: number;
  /** Leading whitespace of the line the match starts on. */
  indent: string;
}

/* -------------------------------------------------------------------------- */
/*  LLM rewrite contract                                                       */
/* -------------------------------------------------------------------------- */

export const RewriteResponseSchema = z.object({
  rewrittenCode: z.string().min(1),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  requiresManualReview: z.boolean(),
  followUpNotes: z.array(z.string()),
});
export type RewriteResponse = z.infer<typeof RewriteResponseSchema>;

/**
 * JSON Schema mirror of {@link RewriteResponseSchema}, used for OpenAI
 * structured outputs (`response_format: { type: 'json_schema', strict: true }`).
 * Structured outputs require every property to be listed in `required` and
 * `additionalProperties: false`, so the two definitions are kept side by side.
 */
export const REWRITE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rewrittenCode', 'explanation', 'confidence', 'requiresManualReview', 'followUpNotes'],
  properties: {
    rewrittenCode: {
      type: 'string',
      description: 'The replacement TypeScript source. No markdown fences, no commentary.',
    },
    explanation: {
      type: 'string',
      description: 'One or two sentences describing what changed and why.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence between 0 and 1 that the rewrite is behaviour preserving.',
    },
    requiresManualReview: {
      type: 'boolean',
      description: 'True when semantics could not be preserved without a human decision.',
    },
    followUpNotes: {
      type: 'array',
      description: 'Follow-up actions for the developer, empty when there are none.',
      items: { type: 'string' },
    },
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type ValidationLevel = 'error' | 'warning';

export type ValidationCode =
  | 'empty-snippet'
  | 'syntax-error'
  | 'forbidden-pattern'
  | 'unchanged'
  | 'placeholder'
  | 'scope-mismatch';

export interface ValidationIssue {
  level: ValidationLevel;
  code: ValidationCode;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Snippet after fence stripping / trimming. Empty when unusable. */
  normalized: string;
}

/* -------------------------------------------------------------------------- */
/*  Rewrite results & reports                                                  */
/* -------------------------------------------------------------------------- */

export type RewriteStatus = 'rewritten' | 'needs-review' | 'failed';

export interface RewriteResult {
  match: ScanMatch;
  status: RewriteStatus;
  /** Validated replacement code, or null when the rewrite failed. */
  code: string | null;
  response: RewriteResponse | null;
  validation: ValidationResult | null;
  attempts: number;
  error: string | null;
}

export interface FilePatch {
  filePath: string;
  relativePath: string;
  original: string;
  updated: string;
  /** Number of rewrites folded into this patch. */
  edits: number;
  applied: boolean;
  /** Problems found while merging edits, e.g. the patched file no longer parses. */
  issues: ValidationIssue[];
}

export interface MigrationReport {
  rules: string[];
  filesScanned: number;
  matches: number;
  rewritten: number;
  needsReview: number;
  failed: number;
  patches: FilePatch[];
  results: RewriteResult[];
  dryRun: boolean;
}

/* -------------------------------------------------------------------------- */
/*  LLM client                                                                 */
/* -------------------------------------------------------------------------- */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  response_format?: unknown;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message?: { content?: string | null; refusal?: string | null } | null;
    finish_reason?: string | null;
  }>;
}

/**
 * Minimal structural slice of the OpenAI client used by the rewriter. Keeping
 * it narrow means tests can inject a fake without pulling in the SDK.
 */
export interface ChatCompletionClient {
  chat: {
    completions: {
      create(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
    };
  };
}
