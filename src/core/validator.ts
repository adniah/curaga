import { Project, ScriptTarget, type Diagnostic } from 'ts-morph';
import type { ReplaceScope, ValidationIssue, ValidationResult } from '../types.js';

const FENCE = /^\s*```(?:[a-zA-Z]*)?\s*\n?([\s\S]*?)\n?```\s*$/;

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/, label: 'TODO' },
  { pattern: /\bFIXME\b/, label: 'FIXME' },
  { pattern: /…/, label: 'ellipsis character' },
  { pattern: /<your[\s_-]?[a-z]+>/i, label: 'placeholder value' },
  { pattern: /\/\*\s*\.\.\.\s*(?:rest|unchanged|same)?[^*]*\*\//i, label: 'elided code comment' },
];

/** A single in-memory project is reused for every validation pass. */
const validationProject = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { target: ScriptTarget.ESNext, allowJs: false, noLib: true },
});

const CHECK_FILE = '/__curaga_validation__.ts';

/** Removes markdown fences and trailing whitespace the model may have added. */
export function stripCodeFences(code: string): string {
  const fenced = FENCE.exec(code);
  const body = fenced?.[1] ?? code;
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '').replace(/^\n+/, '');
}

function parseDiagnostics(code: string): Diagnostic[] {
  const sourceFile = validationProject.createSourceFile(CHECK_FILE, code, { overwrite: true });
  return validationProject.getProgram().getSyntacticDiagnostics(sourceFile);
}

function describe(diagnostic: Diagnostic): string {
  const message = diagnostic.getMessageText();
  return typeof message === 'string' ? message : message.getMessageText();
}

/**
 * Wrappers tried in order for the given scope. The snippet is syntactically
 * valid as soon as one of them parses, which keeps expression fragments,
 * multi-statement rewrites and `export`-prefixed statements all acceptable in
 * the position they were extracted from.
 */
function candidatesFor(scope: ReplaceScope, snippet: string): string[] {
  if (scope === 'statement') {
    return [`async function __curaga() {\n${snippet}\n}`, snippet];
  }
  return [`async function __curaga() {\nreturn (\n${snippet}\n);\n}`];
}

export interface ValidateOptions {
  /** Where the snippet will be spliced in — decides how it is wrapped for parsing. */
  scope?: ReplaceScope;
  /** Substrings that must not appear in the rewrite (deprecated APIs). */
  forbidden?: string[];
  /** Original source text, used to detect no-op rewrites. */
  originalText?: string;
}

/**
 * Validates an LLM produced snippet before it is allowed anywhere near a file:
 * it must be non-empty, parse in its target position, and no longer mention the
 * deprecated API the rule is migrating away from.
 */
export function validateSnippet(code: string, options: ValidateOptions = {}): ValidationResult {
  const scope: ReplaceScope = options.scope ?? 'node';
  const issues: ValidationIssue[] = [];
  const normalized = stripCodeFences(code ?? '').trim();

  if (normalized === '') {
    return {
      valid: false,
      issues: [{ level: 'error', code: 'empty-snippet', message: 'The model returned an empty rewrite.' }],
      normalized: '',
    };
  }

  const candidates = candidatesFor(scope, normalized);
  let diagnostics: Diagnostic[] = [];
  let parsed = false;
  for (const candidate of candidates) {
    diagnostics = parseDiagnostics(candidate);
    if (diagnostics.length === 0) {
      parsed = true;
      break;
    }
  }

  if (!parsed) {
    const detail = diagnostics.slice(0, 3).map(describe).join('; ');
    // A node-scoped snippet that only fails as an expression is a scope error,
    // not a syntax error — the distinction matters for the retry prompt.
    const asStatements = scope === 'node' ? parseDiagnostics(`async function __curaga() {\n${normalized}\n}`) : [];
    if (scope === 'node' && asStatements.length === 0) {
      issues.push({
        level: 'error',
        code: 'scope-mismatch',
        message:
          'Expected a single expression to splice in place of the original call, but received ' +
          'one or more statements.',
      });
    } else {
      issues.push({
        level: 'error',
        code: 'syntax-error',
        message: `Rewrite is not syntactically valid TypeScript: ${detail || 'unknown parse error'}.`,
      });
    }
  }

  for (const forbidden of options.forbidden ?? []) {
    if (forbidden && normalized.includes(forbidden)) {
      issues.push({
        level: 'error',
        code: 'forbidden-pattern',
        message: `Rewrite still uses the deprecated API "${forbidden}".`,
      });
    }
  }

  if (options.originalText !== undefined && normalized === options.originalText.trim()) {
    issues.push({
      level: 'warning',
      code: 'unchanged',
      message: 'Rewrite is identical to the original code.',
    });
  }

  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(normalized)) {
      issues.push({
        level: 'warning',
        code: 'placeholder',
        message: `Rewrite contains a ${label}; review before applying.`,
      });
    }
  }

  return {
    valid: !issues.some((issue) => issue.level === 'error'),
    issues,
    normalized,
  };
}

/** Formats validator issues for a retry prompt. */
export function formatIssuesForRetry(result: ValidationResult): string {
  return result.issues
    .filter((issue) => issue.level === 'error')
    .map((issue) => `- ${issue.message}`)
    .join('\n');
}

/** True when the whole file still parses after a set of edits was applied. */
export function validateFileContents(filePath: string, contents: string): ValidationResult {
  const sourceFile = validationProject.createSourceFile(`/__curaga_file__${filePath.replace(/[^\w.-]/g, '_')}.ts`, contents, {
    overwrite: true,
  });
  const diagnostics = validationProject.getProgram().getSyntacticDiagnostics(sourceFile);
  const issues: ValidationIssue[] = diagnostics.slice(0, 5).map((diagnostic) => ({
    level: 'error' as const,
    code: 'syntax-error' as const,
    message: `${filePath}: ${describe(diagnostic)}`,
  }));
  return { valid: issues.length === 0, issues, normalized: contents };
}
