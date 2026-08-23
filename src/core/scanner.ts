import fs from 'node:fs';
import path from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import type { MigrationRule, RuleMatcher, ScanMatch } from '../types.js';

export const DEFAULT_IGNORE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/*.d.ts',
];

const DEFAULT_SOURCE_GLOB = '**/*.{ts,tsx,mts,cts}';

/** Characters of surrounding source handed to the model as context. */
const MAX_CONTEXT_CHARS = 1_400;

export interface ScannerOptions {
  /** Root the reported relative paths are resolved against. Defaults to cwd. */
  cwd?: string;
  /** Load files from a tsconfig instead of globbing. */
  tsConfigFilePath?: string;
  /** Files, directories or globs to scan. Directories are expanded recursively. */
  paths?: string[];
  /** Extra ignore globs, appended to {@link DEFAULT_IGNORE_GLOBS}. */
  ignore?: string[];
  /** Use an in-memory file system (tests). */
  inMemory?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Project construction                                                       */
/* -------------------------------------------------------------------------- */

/** Turns user supplied paths into ts-morph globs. */
export function expandPaths(paths: string[], cwd: string = process.cwd()): string[] {
  const globs: string[] = [];
  for (const entry of paths) {
    if (entry.includes('*')) {
      globs.push(entry);
      continue;
    }
    const absolute = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(absolute).isDirectory();
    } catch {
      // Nonexistent paths are passed through so ts-morph reports them.
      isDirectory = false;
    }
    globs.push(isDirectory ? path.join(absolute, DEFAULT_SOURCE_GLOB).replace(/\\/g, '/') : absolute.replace(/\\/g, '/'));
  }
  return globs.length > 0 ? globs : [DEFAULT_SOURCE_GLOB];
}

/**
 * Builds a ts-morph project for scanning. Type checking is skipped on purpose:
 * Curaga only needs syntax, and consumers should not be forced to have a
 * resolvable dependency graph before they can run a migration.
 */
export function createProject(options: ScannerOptions = {}): Project {
  const cwd = options.cwd ?? process.cwd();

  if (options.inMemory) {
    return new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  }

  if (options.tsConfigFilePath) {
    const tsConfigFilePath = path.isAbsolute(options.tsConfigFilePath)
      ? options.tsConfigFilePath
      : path.resolve(cwd, options.tsConfigFilePath);
    const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
    if (options.paths && options.paths.length > 0) {
      project.addSourceFilesAtPaths([...expandPaths(options.paths, cwd), ...DEFAULT_IGNORE_GLOBS]);
    }
    return project;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths([
    ...expandPaths(options.paths ?? [], cwd),
    ...DEFAULT_IGNORE_GLOBS,
    ...(options.ignore ?? []),
  ]);
  return project;
}

/* -------------------------------------------------------------------------- */
/*  Call path extraction & matching                                            */
/* -------------------------------------------------------------------------- */

function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Returns the dotted segments of a static access chain, or null when the chain
 * contains something dynamic (`a[b].c`, `a().b`) that cannot be matched safely.
 */
export function getAccessSegments(node: Node): string[] | null {
  const target = unwrap(node);

  if (Node.isIdentifier(target)) return [target.getText()];
  if (Node.isThisExpression(target)) return ['this'];

  if (Node.isPropertyAccessExpression(target)) {
    const head = getAccessSegments(target.getExpression());
    if (!head) return null;
    return [...head, target.getName()];
  }

  return null;
}

/** Convenience wrapper returning the dotted string form, e.g. `this.stripe.charges.create`. */
export function getAccessPath(node: Node): string | null {
  const segments = getAccessSegments(node);
  return segments ? segments.join('.') : null;
}

/**
 * Suffix matching with optional wildcard receiver.
 *
 * - `stripe.charges.create` matches `stripe.charges.create` and
 *   `this.stripe.charges.create` but not `stripe.paymentIntents.create`.
 * - `*.charges.create` matches any receiver, as long as one exists.
 */
export function matchesCallPath(segments: string[], pattern: string): boolean {
  const patternSegments = pattern.split('.').filter((segment) => segment.length > 0);
  if (patternSegments.length === 0) return false;

  const wildcard = patternSegments[0] === '*';
  const tail = wildcard ? patternSegments.slice(1) : patternSegments;
  if (tail.length === 0) return false;
  if (segments.length < tail.length) return false;
  if (wildcard && segments.length <= tail.length) return false;

  const offset = segments.length - tail.length;
  return tail.every((segment, index) => segments[offset + index] === segment);
}

/* -------------------------------------------------------------------------- */
/*  Scanning                                                                   */
/* -------------------------------------------------------------------------- */

function isCallee(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    return parent.getExpression() === node;
  }
  return false;
}

/** Widens a matched node to the unit of source that will be replaced. */
function resolveTargetNode(node: Node, matcher: RuleMatcher): Node {
  if (matcher.replace === 'statement') {
    const statement = node.getFirstAncestor((ancestor) => Node.isStatement(ancestor));
    if (statement) return statement;
  }
  const parent = node.getParent();
  if (parent && Node.isAwaitExpression(parent)) return parent;
  return node;
}

/**
 * Leading whitespace of the line the match starts on. For a node that begins
 * mid-line this is still the statement's base indent, which is what
 * continuation lines of a replacement should be aligned to.
 */
function getIndent(sourceFile: SourceFile, start: number): string {
  const text = sourceFile.getFullText();
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
  return /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? '';
}

/** Grabs the enclosing function/class-member body as prompt context. */
function getContextText(node: Node): string {
  const container =
    node.getFirstAncestor(
      (ancestor) =>
        Node.isFunctionDeclaration(ancestor) ||
        Node.isMethodDeclaration(ancestor) ||
        Node.isArrowFunction(ancestor) ||
        Node.isFunctionExpression(ancestor) ||
        Node.isConstructorDeclaration(ancestor),
    ) ?? node.getFirstAncestor((ancestor) => Node.isStatement(ancestor));

  const text = (container ?? node).getText();
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n/* … truncated … */`;
}

function toMatch(
  sourceFile: SourceFile,
  node: Node,
  rule: MigrationRule,
  matcher: RuleMatcher,
  callPath: string,
  cwd: string,
): ScanMatch {
  const target = resolveTargetNode(node, matcher);
  const start = target.getStart();
  const end = target.getEnd();
  const filePath = sourceFile.getFilePath();
  const { line, column } = sourceFile.getLineAndColumnAtPos(start);

  return {
    ruleId: rule.id,
    matcherId: matcher.id,
    filePath,
    relativePath: path.relative(cwd, filePath).replace(/\\/g, '/') || filePath,
    line,
    column,
    callPath,
    replace: matcher.replace,
    originalText: target.getText(),
    contextText: getContextText(node),
    start,
    end,
    indent: getIndent(sourceFile, start),
  };
}

/**
 * Drops matches fully contained inside another match of the same file, which
 * happens when nested calls both hit a rule and a statement-scoped rewrite
 * already covers the inner one.
 */
export function dedupeMatches(matches: ScanMatch[]): ScanMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end; // outermost first
  });

  const kept: ScanMatch[] = [];
  for (const match of sorted) {
    const covered = kept.some(
      (existing) =>
        existing.filePath === match.filePath && existing.start <= match.start && existing.end >= match.end,
    );
    if (!covered) kept.push(match);
  }
  return kept;
}

export function scanSourceFile(
  sourceFile: SourceFile,
  rules: MigrationRule[],
  cwd: string = process.cwd(),
): ScanMatch[] {
  const matches: ScanMatch[] = [];

  sourceFile.forEachDescendant((node) => {
    let segments: string[] | null = null;
    let isCall = false;

    if (Node.isCallExpression(node)) {
      segments = getAccessSegments(node.getExpression());
      isCall = true;
    } else if (Node.isPropertyAccessExpression(node) && !isCallee(node)) {
      segments = getAccessSegments(node);
    }

    if (!segments) return;
    const callPath = segments.join('.');

    for (const rule of rules) {
      for (const matcher of rule.matchers) {
        const wantsCall = matcher.kind === 'call';
        if (wantsCall !== isCall) continue;
        if (!matchesCallPath(segments, matcher.callPath)) continue;
        matches.push(toMatch(sourceFile, node, rule, matcher, callPath, cwd));
      }
    }
  });

  return matches;
}

export function scanProject(
  project: Project,
  rules: MigrationRule[],
  cwd: string = process.cwd(),
): ScanMatch[] {
  const matches: ScanMatch[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    matches.push(...scanSourceFile(sourceFile, rules, cwd));
  }
  return dedupeMatches(matches);
}

/**
 * AST scanner locating deprecated API usages described by migration rules.
 *
 * The project instance is exposed so the patcher can reuse the very same
 * source files that produced the offsets, avoiding a re-parse.
 */
export class Scanner {
  readonly project: Project;
  readonly cwd: string;

  constructor(options: ScannerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.project = createProject(options);
  }

  /** Files currently loaded into the project. */
  get sourceFiles(): SourceFile[] {
    return this.project.getSourceFiles();
  }

  get fileCount(): number {
    return this.project.getSourceFiles().length;
  }

  addSource(filePath: string, contents: string): SourceFile {
    return this.project.createSourceFile(filePath, contents, { overwrite: true });
  }

  scan(rules: MigrationRule[]): ScanMatch[] {
    return scanProject(this.project, rules, this.cwd);
  }
}

export { SyntaxKind };
