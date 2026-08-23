#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { Command, Option } from 'commander';
import {
  MissingApiKeyError,
  createChatClient,
  getDotEnvPath,
  loadConfig,
  loadDotEnv,
  type ConfigOverrides,
} from './config.js';
import { Scanner } from './core/scanner.js';
import { Rewriter, type RewriteProgressEvent } from './core/rewriter.js';
import { applyPatches, buildPatches } from './core/patcher.js';
import { listRules, loadRuleFile, resolveRules } from './rules/index.js';
import { renderDiff, renderSnippetChange } from './utils/diff.js';
import type { FilePatch, MigrationRule, RewriteResult, ScanMatch } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; description: string };

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

interface CommonOptions {
  rule?: string[];
  ruleFile?: string;
  project?: string;
  cwd?: string;
  json?: boolean;
}

async function collectRules(options: CommonOptions): Promise<MigrationRule[]> {
  const custom = options.ruleFile ? await loadRuleFile(options.ruleFile, options.cwd ?? process.cwd()) : [];
  const available = [...listRules(), ...custom];
  return resolveRules(options.rule ?? [], available);
}

function createScanner(options: CommonOptions, paths: string[]): Scanner {
  return new Scanner({
    cwd: options.cwd ?? process.cwd(),
    ...(options.project ? { tsConfigFilePath: options.project } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  });
}

function groupByFile(matches: ScanMatch[]): Map<string, ScanMatch[]> {
  const grouped = new Map<string, ScanMatch[]>();
  for (const match of matches) {
    const existing = grouped.get(match.relativePath);
    if (existing) existing.push(match);
    else grouped.set(match.relativePath, [match]);
  }
  return grouped;
}

function firstLine(text: string, max = 100): string {
  const line = text.replace(/\r\n/g, '\n').split('\n')[0] ?? '';
  const suffix = text.includes('\n') || line.length > max ? ' …' : '';
  return `${line.slice(0, max).trim()}${suffix}`;
}

function printMatches(matches: ScanMatch[], rules: MigrationRule[]): void {
  const describe = (match: ScanMatch): string => {
    const rule = rules.find((candidate) => candidate.id === match.ruleId);
    const matcher = rule?.matchers.find((candidate) => candidate.id === match.matcherId);
    return matcher?.description ?? match.matcherId;
  };

  for (const [file, fileMatches] of groupByFile(matches)) {
    console.log(`\n${chalk.bold.underline(file)}`);
    for (const match of fileMatches) {
      const location = chalk.dim(`${match.line}:${match.column}`);
      console.log(`  ${location}  ${chalk.yellow(match.callPath)}  ${chalk.dim(`[${match.matcherId}]`)}`);
      console.log(`      ${chalk.dim(describe(match))}`);
      console.log(`      ${chalk.dim(firstLine(match.originalText))}`);
    }
  }
}

function statusLabel(status: RewriteResult['status']): string {
  if (status === 'rewritten') return chalk.green('rewritten');
  if (status === 'needs-review') return chalk.yellow('needs review');
  return chalk.red('failed');
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${chalk.dim('[y/N]')} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function fail(message: string): never {
  console.error(`${chalk.red('✖')} ${message}`);
  process.exitCode = 1;
  throw new ExitSignal();
}

/** Thrown to unwind out of a command after a handled error. */
class ExitSignal extends Error {}

/* -------------------------------------------------------------------------- */
/*  Program                                                                    */
/* -------------------------------------------------------------------------- */

const program = new Command();

program
  .name('curaga')
  .description(pkg.description)
  .version(pkg.version, '-v, --version')
  .showHelpAfterError();

const withCommonOptions = (command: Command): Command =>
  command
    .option('-r, --rule <id...>', 'rule ids or package names to run (default: all built-in rules)')
    .option('--rule-file <path>', 'load additional rules from a JS/JSON module')
    .option('-p, --project <tsconfig>', 'load files from a tsconfig.json instead of globbing')
    .option('--cwd <dir>', 'root directory for path resolution', process.cwd())
    .option('--json', 'emit machine readable JSON instead of formatted output', false);

/* ------------------------------- scan ------------------------------------- */

withCommonOptions(
  program
    .command('scan')
    .description('Find deprecated third-party API usages with AST analysis (no LLM calls, no API key)')
    .argument('[paths...]', 'files, directories or globs to scan', []),
)
  .option('--fail-on-match', 'exit with code 1 when matches are found (useful in CI)', false)
  .action(async (paths: string[], options: CommonOptions & { failOnMatch?: boolean }) => {
    const rules = await collectRules(options);
    const spinner = options.json ? null : ora('Scanning source files…').start();

    const scanner = createScanner(options, paths);
    const matches = scanner.scan(rules);
    spinner?.stop();

    if (options.json) {
      console.log(
        JSON.stringify({ rules: rules.map((rule) => rule.id), filesScanned: scanner.fileCount, matches }, null, 2),
      );
    } else {
      console.log(
        chalk.dim(
          `Scanned ${scanner.fileCount} file(s) with ${rules.length} rule(s): ${rules.map((r) => r.id).join(', ')}`,
        ),
      );
      if (matches.length === 0) {
        console.log(`${chalk.green('✔')} No deprecated usages found.`);
      } else {
        printMatches(matches, rules);
        console.log(
          `\n${chalk.yellow('!')} ${matches.length} match(es) in ${groupByFile(matches).size} file(s). ` +
            `Run ${chalk.cyan('curaga migrate')} to rewrite them.`,
        );
      }
    }

    if (options.failOnMatch && matches.length > 0) process.exitCode = 1;
  });

/* ------------------------------ migrate ----------------------------------- */

interface MigrateOptions extends CommonOptions {
  dryRun?: boolean;
  yes?: boolean;
  model?: string;
  concurrency?: string;
  maxAttempts?: string;
  temperature?: string;
  includeReview?: boolean;
  diff?: boolean;
}

withCommonOptions(
  program
    .command('migrate')
    .alias('apply')
    .description('Scan, rewrite with the LLM, validate, and patch the matched files')
    .argument('[paths...]', 'files, directories or globs to migrate', []),
)
  .option('-d, --dry-run', 'show the diff without writing any file', false)
  .option('-y, --yes', 'apply changes without the confirmation prompt', false)
  .option('--include-review', 'also apply rewrites the model flagged for manual review', false)
  .option('--no-diff', 'skip diff rendering, print a summary only')
  .addOption(new Option('--model <name>', 'model to use for rewrites').default(undefined))
  .addOption(new Option('--concurrency <n>', 'parallel rewrite requests'))
  .addOption(new Option('--max-attempts <n>', 'rewrite attempts per match before giving up'))
  .addOption(new Option('--temperature <n>', 'sampling temperature'))
  .action(async (paths: string[], options: MigrateOptions) => {
    const cwd = options.cwd ?? process.cwd();
    const rules = await collectRules(options);

    const overrides: ConfigOverrides = {};
    if (options.model) overrides.model = options.model;
    if (options.concurrency) overrides.concurrency = Number(options.concurrency);
    if (options.maxAttempts) overrides.maxAttempts = Number(options.maxAttempts);
    if (options.temperature) overrides.temperature = Number(options.temperature);
    const config = loadConfig(overrides);

    if (!config.apiKey) fail(new MissingApiKeyError().message);

    const scanSpinner = options.json ? null : ora('Scanning source files…').start();
    const scanner = createScanner(options, paths);
    const matches = scanner.scan(rules);
    scanSpinner?.stop();

    if (matches.length === 0) {
      if (options.json) console.log(JSON.stringify({ matches: 0, patches: [] }, null, 2));
      else console.log(`${chalk.green('✔')} No deprecated usages found — nothing to migrate.`);
      return;
    }

    if (!options.json) {
      console.log(
        chalk.dim(
          `Scanned ${scanner.fileCount} file(s) — ${matches.length} match(es) in ${groupByFile(matches).size} file(s).`,
        ),
      );
      console.log(chalk.dim(`Model: ${config.model}  ·  concurrency: ${config.concurrency}`));
    }

    let completed = 0;
    const spinner: Ora | null = options.json
      ? null
      : ora(`Rewriting 0/${matches.length}…`).start();
    const onProgress = (event: RewriteProgressEvent): void => {
      if (!spinner) return;
      if (event.phase === 'done') completed += 1;
      const retry = event.phase === 'retry' ? chalk.dim(` (retry ${event.attempt})`) : '';
      spinner.text = `Rewriting ${completed}/${matches.length}${retry} — ${event.match.relativePath}:${event.match.line}`;
    };

    const rewriter = new Rewriter({
      client: createChatClient(config),
      model: config.model,
      temperature: config.temperature,
      maxAttempts: config.maxAttempts,
      concurrency: config.concurrency,
      rules,
      onProgress,
    });

    let results: RewriteResult[];
    try {
      results = await rewriter.rewriteAll(matches);
    } catch (error) {
      spinner?.fail('Rewrite step failed.');
      fail(error instanceof Error ? error.message : String(error));
    }

    spinner?.succeed(`Rewrote ${results.filter((r) => r.status !== 'failed').length}/${matches.length} match(es).`);

    const patches = buildPatches(scanner.project, results, {
      cwd,
      includeNeedsReview: options.includeReview ?? false,
    });

    if (options.json) {
      console.log(JSON.stringify({ results, patches, dryRun: options.dryRun ?? false }, null, 2));
    } else {
      printResults(results, options.diff !== false);
      printPatches(patches, options.diff !== false);
    }

    const writable = patches.filter((patch) => patch.edits > 0 && !patch.issues.some((i) => i.level === 'error'));

    if (options.dryRun) {
      if (!options.json) {
        console.log(chalk.dim(`\nDry run — ${writable.length} file(s) would be written. No changes made.`));
      }
      return;
    }

    if (writable.length === 0) {
      if (!options.json) console.log(chalk.yellow('\nNothing to write.'));
      return;
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.log(
          chalk.yellow(
            `\nNon-interactive terminal — not writing. Re-run with ${chalk.cyan('--yes')} to apply, ` +
              `or ${chalk.cyan('--dry-run')} to silence this notice.`,
          ),
        );
        return;
      }
      const ok = await confirm(`\nApply ${writable.length} file change(s)?`);
      if (!ok) {
        console.log(chalk.dim('Aborted — no files written.'));
        return;
      }
    }

    const applied = await applyPatches(scanner.project, patches);
    if (!options.json) {
      console.log(`${chalk.green('✔')} Applied ${applied.length} file change(s).`);
      const review = results.filter((result) => result.status === 'needs-review');
      if (review.length > 0 && !options.includeReview) {
        console.log(
          chalk.yellow(
            `${review.length} rewrite(s) were flagged for manual review and left untouched. ` +
              `Re-run with --include-review to apply them.`,
          ),
        );
      }
    }
  });

function printResults(results: RewriteResult[], showDiff: boolean): void {
  for (const result of results) {
    const { match } = result;
    console.log(
      `\n${chalk.bold(`${match.relativePath}:${match.line}:${match.column}`)}  ` +
        `${statusLabel(result.status)} ${chalk.dim(`[${match.matcherId}]`)}`,
    );

    if (result.response?.explanation) console.log(`  ${chalk.dim(result.response.explanation)}`);
    if (result.error) console.log(`  ${chalk.red(result.error)}`);

    for (const issue of result.validation?.issues ?? []) {
      const color = issue.level === 'error' ? chalk.red : chalk.yellow;
      console.log(`  ${color(`${issue.level}: ${issue.message}`)}`);
    }
    for (const note of result.response?.followUpNotes ?? []) {
      console.log(`  ${chalk.yellow(`todo: ${note}`)}`);
    }

    if (showDiff && result.code) console.log(renderSnippetChange(match.originalText, result.code));
  }
}

function printPatches(patches: FilePatch[], showDiff: boolean): void {
  if (patches.length === 0) return;
  console.log(`\n${chalk.bold('Pending file changes')}`);
  for (const patch of patches) {
    for (const issue of patch.issues) {
      const color = issue.level === 'error' ? chalk.red : chalk.yellow;
      console.log(`  ${color(`${issue.level}: ${issue.message}`)}`);
    }
    if (patch.edits === 0) continue;
    if (showDiff) console.log(`\n${renderDiff(patch.original, patch.updated, { label: patch.relativePath })}`);
    else console.log(`  ${patch.relativePath} ${chalk.dim(`(${patch.edits} edit(s))`)}`);
  }
}

/* ------------------------------- rules ------------------------------------ */

program
  .command('rules')
  .description('List the available migration rules')
  .argument('[ruleId]', 'show the matchers of a single rule')
  .option('--rule-file <path>', 'include rules from a JS/JSON module')
  .option('--json', 'emit machine readable JSON', false)
  .action(async (ruleId: string | undefined, options: { ruleFile?: string; json?: boolean }) => {
    const custom = options.ruleFile ? await loadRuleFile(options.ruleFile) : [];
    const rules = [...listRules(), ...custom].filter((rule) => !ruleId || rule.id === ruleId);

    if (ruleId && rules.length === 0) fail(`Unknown rule "${ruleId}".`);

    if (options.json) {
      console.log(JSON.stringify(rules, null, 2));
      return;
    }

    for (const rule of rules) {
      console.log(`\n${chalk.bold.cyan(rule.id)}  ${chalk.dim(`${rule.fromVersion} → ${rule.toVersion}`)}`);
      console.log(`  ${rule.title}`);
      console.log(`  ${chalk.dim(rule.description)}`);
      if (rule.docsUrl) console.log(`  ${chalk.dim(rule.docsUrl)}`);
      for (const matcher of rule.matchers) {
        console.log(
          `    ${chalk.yellow(matcher.callPath)} ${chalk.dim(`[${matcher.id}, replaces ${matcher.replace}]`)}`,
        );
        console.log(`      ${chalk.dim(matcher.description)}`);
      }
    }
    console.log('');
  });

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function main(argv: string[] = process.argv): Promise<void> {
  loadDotEnv();
  const envPath = getDotEnvPath();
  if (envPath && process.env.CURAGA_DEBUG) console.log(chalk.dim(`Loaded env from ${envPath}`));

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof ExitSignal) return;
    console.error(`${chalk.red('✖')} ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.CURAGA_DEBUG && error instanceof Error) console.error(chalk.dim(error.stack ?? ''));
    process.exitCode = 1;
  }
}

// Only auto-run when executed as a binary, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
