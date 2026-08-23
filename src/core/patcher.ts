import path from 'node:path';
import type { Project, SourceFile } from 'ts-morph';
import type { FilePatch, RewriteResult, ValidationIssue } from '../types.js';
import { validateFileContents } from './validator.js';

export interface PatchOptions {
  /** Root used for the relative paths shown in reports. Defaults to cwd. */
  cwd?: string;
  /** Also apply rewrites the model flagged for manual review. Default: false. */
  includeNeedsReview?: boolean;
  /**
   * Drop a file's patch entirely when the merged result no longer parses.
   * Default: true — a half-migrated broken file is worse than no migration.
   */
  rejectBrokenFiles?: boolean;
}

/**
 * Re-indents a multi-line snippet for the position it is spliced into.
 *
 * The first line inherits the indentation already present in the file (the
 * replacement starts after it), so only continuation lines are re-prefixed
 * after their common leading whitespace is stripped.
 */
export function reindentSnippet(snippet: string, indent: string): string {
  const lines = snippet.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= 1) return snippet.trim();

  const rest = lines.slice(1);
  const widths = rest
    .filter((line) => line.trim() !== '')
    .map((line) => (/^\s*/.exec(line)?.[0] ?? '').length);
  const common = widths.length > 0 ? Math.min(...widths) : 0;

  const reindented = rest.map((line) => (line.trim() === '' ? '' : indent + line.slice(common)));
  return [lines[0]!.trim(), ...reindented].join('\n');
}

/** Results eligible to be written, newest edits last. */
export function selectApplicable(results: RewriteResult[], includeNeedsReview = false): RewriteResult[] {
  return results.filter(
    (result) =>
      result.code !== null && (result.status === 'rewritten' || (includeNeedsReview && result.status === 'needs-review')),
  );
}

/**
 * Merges rewrites into whole-file contents without touching disk.
 *
 * Edits are applied back-to-front so earlier offsets stay valid, and offsets
 * are taken from the same parse that produced the matches.
 */
export function buildPatches(project: Project, results: RewriteResult[], options: PatchOptions = {}): FilePatch[] {
  const cwd = options.cwd ?? process.cwd();
  const rejectBroken = options.rejectBrokenFiles ?? true;
  const applicable = selectApplicable(results, options.includeNeedsReview);

  const byFile = new Map<string, RewriteResult[]>();
  for (const result of applicable) {
    const existing = byFile.get(result.match.filePath);
    if (existing) existing.push(result);
    else byFile.set(result.match.filePath, [result]);
  }

  const patches: FilePatch[] = [];

  for (const [filePath, fileResults] of byFile) {
    const sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) continue;

    const original = sourceFile.getFullText();
    let updated = original;
    const issues: ValidationIssue[] = [];

    const ordered = [...fileResults].sort((a, b) => b.match.start - a.match.start);
    let lastStart = Number.POSITIVE_INFINITY;
    let edits = 0;

    for (const result of ordered) {
      const { start, end, indent, originalText } = result.match;

      if (end > lastStart) {
        issues.push({
          level: 'warning',
          code: 'scope-mismatch',
          message: `Skipped an overlapping rewrite at offset ${start} in ${filePath}.`,
        });
        continue;
      }

      // Guard against stale offsets (file edited between scan and patch).
      if (updated.slice(start, end) !== originalText) {
        issues.push({
          level: 'error',
          code: 'scope-mismatch',
          message: `Source at offset ${start} in ${filePath} no longer matches the scanned text; rescan required.`,
        });
        continue;
      }

      updated = updated.slice(0, start) + reindentSnippet(result.code as string, indent) + updated.slice(end);
      lastStart = start;
      edits += 1;
    }

    if (edits === 0) continue;

    if (rejectBroken) {
      const fileValidation = validateFileContents(filePath, updated);
      if (!fileValidation.valid) {
        patches.push({
          filePath,
          relativePath: path.relative(cwd, filePath).replace(/\\/g, '/') || filePath,
          original,
          updated: original,
          edits: 0,
          applied: false,
          issues: [...issues, ...fileValidation.issues],
        });
        continue;
      }
    }

    patches.push({
      filePath,
      relativePath: path.relative(cwd, filePath).replace(/\\/g, '/') || filePath,
      original,
      updated,
      edits,
      applied: false,
      issues,
    });
  }

  return patches.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

/**
 * Writes patches to disk through the ts-morph project so the in-memory AST and
 * the file system stay in sync. Patches with errors or no edits are skipped.
 */
export async function applyPatches(project: Project, patches: FilePatch[]): Promise<FilePatch[]> {
  const applied: FilePatch[] = [];

  for (const patch of patches) {
    if (patch.edits === 0 || patch.issues.some((issue) => issue.level === 'error')) continue;
    const sourceFile: SourceFile | undefined = project.getSourceFile(patch.filePath);
    if (!sourceFile) continue;

    sourceFile.replaceWithText(patch.updated);
    await sourceFile.save();
    patch.applied = true;
    applied.push(patch);
  }

  return applied;
}

/** Convenience wrapper: merge rewrites and optionally persist them. */
export async function patchProject(
  project: Project,
  results: RewriteResult[],
  options: PatchOptions & { dryRun?: boolean } = {},
): Promise<FilePatch[]> {
  const patches = buildPatches(project, results, options);
  if (!options.dryRun) await applyPatches(project, patches);
  return patches;
}
