import { loadConfig, createChatClient, type ConfigOverrides } from './config.js';
import { Scanner, type ScannerOptions } from './core/scanner.js';
import { Rewriter, type RewriteProgressEvent } from './core/rewriter.js';
import { buildPatches, applyPatches } from './core/patcher.js';
import { resolveRules } from './rules/index.js';
import type {
  ChatCompletionClient,
  MigrationReport,
  MigrationRule,
  RewriteResult,
  ScanMatch,
} from './types.js';

export * from './types.js';
export * from './config.js';
export * from './rules/index.js';
export { stripeRule } from './rules/stripe.js';
export * from './core/scanner.js';
export * from './core/rewriter.js';
export * from './core/validator.js';
export * from './core/patcher.js';
export * from './utils/diff.js';

export interface MigrateOptions extends ScannerOptions {
  /** Rule ids, package names, or `all`. Defaults to every built-in rule. */
  ruleSelectors?: string[];
  /** Explicit rule objects, e.g. loaded from a user rule file. */
  rules?: MigrationRule[];
  /** Model/temperature/concurrency overrides. */
  config?: ConfigOverrides;
  /** Inject a client (tests, proxies). Defaults to an OpenAI client from config. */
  client?: ChatCompletionClient;
  /** Compute patches without writing them. Default: false. */
  dryRun?: boolean;
  /** Apply rewrites the model flagged for manual review too. Default: false. */
  includeNeedsReview?: boolean;
  onScan?: (matches: ScanMatch[], filesScanned: number) => void;
  onProgress?: (event: RewriteProgressEvent) => void;
}

/**
 * Runs the full pipeline: scan → rewrite → validate → patch.
 *
 * This is the programmatic entry point behind `curaga migrate`; the CLI only
 * adds spinners, diffs and confirmation prompts on top of it.
 */
export async function runMigration(options: MigrateOptions = {}): Promise<MigrationReport> {
  const cwd = options.cwd ?? process.cwd();
  const rules = options.rules ?? resolveRules(options.ruleSelectors ?? []);

  const scanner = new Scanner({ ...options, cwd });
  const matches = scanner.scan(rules);
  options.onScan?.(matches, scanner.fileCount);

  const baseReport: MigrationReport = {
    rules: rules.map((rule) => rule.id),
    filesScanned: scanner.fileCount,
    matches: matches.length,
    rewritten: 0,
    needsReview: 0,
    failed: 0,
    patches: [],
    results: [],
    dryRun: options.dryRun ?? false,
  };

  if (matches.length === 0) return baseReport;

  const config = loadConfig(options.config);
  const client = options.client ?? createChatClient(config);
  const rewriter = new Rewriter({
    client,
    model: config.model,
    temperature: config.temperature,
    maxAttempts: config.maxAttempts,
    concurrency: config.concurrency,
    rules,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const results: RewriteResult[] = await rewriter.rewriteAll(matches);
  const patches = buildPatches(scanner.project, results, {
    cwd,
    includeNeedsReview: options.includeNeedsReview ?? false,
  });

  if (!options.dryRun) await applyPatches(scanner.project, patches);

  return {
    ...baseReport,
    rewritten: results.filter((result) => result.status === 'rewritten').length,
    needsReview: results.filter((result) => result.status === 'needs-review').length,
    failed: results.filter((result) => result.status === 'failed').length,
    patches,
    results,
  };
}
