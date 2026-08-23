import chalk from 'chalk';
import { createTwoFilesPatch, structuredPatch } from 'diff';

export interface DiffOptions {
  /** Lines of unchanged context around each hunk. Default: 3. */
  context?: number;
  /** Label used for both sides of the patch header. */
  label?: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** Produces a plain unified diff (no colors), suitable for files or snippets. */
export function createUnifiedDiff(original: string, updated: string, options: DiffOptions = {}): string {
  const label = options.label ?? 'snippet';
  const patch = createTwoFilesPatch(
    `a/${label}`,
    `b/${label}`,
    normalize(original),
    normalize(updated),
    undefined,
    undefined,
    { context: options.context ?? 3 },
  );
  // Drop the `Index:` / `====` preamble createTwoFilesPatch prepends.
  return patch.replace(/^Index:[^\n]*\n/, '').replace(/^=+\n/, '');
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Counts added and removed lines between two revisions. */
export function diffStats(original: string, updated: string): DiffStats {
  const patch = structuredPatch('a', 'b', normalize(original), normalize(updated), undefined, undefined, {
    context: 0,
  });
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Applies terminal colors to an existing unified diff. */
export function colorizeDiff(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return chalk.dim(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      if (line.startsWith('\\')) return chalk.dim(line);
      return chalk.dim(line);
    })
    .join('\n');
}

/**
 * Renders a colored, header-annotated diff for a single file or snippet.
 * Returns an empty string when nothing changed.
 */
export function renderDiff(original: string, updated: string, options: DiffOptions = {}): string {
  if (normalize(original) === normalize(updated)) return '';

  const label = options.label ?? 'snippet';
  const { additions, deletions } = diffStats(original, updated);
  const body = createUnifiedDiff(original, updated, options)
    .split('\n')
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .join('\n')
    .replace(/\n+$/, '');

  const header = `${chalk.bold.underline(label)}  ${chalk.green(`+${additions}`)} ${chalk.red(`-${deletions}`)}`;
  return `${header}\n${colorizeDiff(body)}`;
}

/**
 * Compact before/after view for a single rewritten snippet, used when a full
 * unified diff would be more noise than signal.
 */
export function renderSnippetChange(before: string, after: string, indent = '  '): string {
  const prefixLines = (text: string, color: (value: string) => string, marker: string): string =>
    normalize(text)
      .split('\n')
      .map((line) => `${indent}${color(`${marker} ${line}`)}`)
      .join('\n');

  return [prefixLines(before, chalk.red, '-'), prefixLines(after, chalk.green, '+')].join('\n');
}
