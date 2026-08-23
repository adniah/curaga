import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  Scanner,
  SyntaxKind,
  dedupeMatches,
  getAccessPath,
  matchesCallPath,
  scanSourceFile,
} from '../src/core/scanner.js';
import { Rewriter, buildUserPrompt, parseRewriteResponse } from '../src/core/rewriter.js';
import { stripCodeFences, validateSnippet } from '../src/core/validator.js';
import { applyPatches, buildPatches, reindentSnippet, selectApplicable } from '../src/core/patcher.js';
import { createUnifiedDiff, diffStats, renderDiff } from '../src/utils/diff.js';
import { getRule, listRules, resolveRules, resolveMatch, UnknownRuleError } from '../src/rules/index.js';
import { stripeRule } from '../src/rules/stripe.js';
import type {
  ChatCompletionClient,
  ChatCompletionRequest,
  MigrationRule,
  RewriteResult,
  ScanMatch,
} from '../src/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/outdated-stripe.ts', import.meta.url));
const FIXTURE_DIR = path.dirname(FIXTURE);
const RULES: MigrationRule[] = [stripeRule];

function scanFixture(): { scanner: Scanner; matches: ScanMatch[] } {
  const scanner = new Scanner({ cwd: FIXTURE_DIR, paths: [FIXTURE] });
  return { scanner, matches: scanner.scan(RULES) };
}

function inMemoryScanner(code: string, filePath = '/src/payments.ts'): { scanner: Scanner; matches: ScanMatch[] } {
  const scanner = new Scanner({ inMemory: true, cwd: '/' });
  scanner.addSource(filePath, code);
  return { scanner, matches: scanner.scan(RULES) };
}

/* -------------------------------------------------------------------------- */
/*  Call path matching                                                         */
/* -------------------------------------------------------------------------- */

describe('matchesCallPath', () => {
  it('matches an exact path', () => {
    expect(matchesCallPath(['stripe', 'charges', 'create'], 'stripe.charges.create')).toBe(true);
  });

  it('matches by suffix so receivers can be nested', () => {
    expect(matchesCallPath(['this', 'stripe', 'charges', 'create'], 'stripe.charges.create')).toBe(true);
  });

  it('rejects a different method on the same namespace', () => {
    expect(matchesCallPath(['stripe', 'charges', 'update'], 'stripe.charges.create')).toBe(false);
    expect(matchesCallPath(['stripe', 'paymentIntents', 'create'], 'stripe.charges.create')).toBe(false);
  });

  it('accepts any receiver for a wildcard pattern', () => {
    expect(matchesCallPath(['client', 'charges', 'create'], '*.charges.create')).toBe(true);
    expect(matchesCallPath(['a', 'b', 'charges', 'create'], '*.charges.create')).toBe(true);
  });

  it('requires a receiver to exist for a wildcard pattern', () => {
    expect(matchesCallPath(['charges', 'create'], '*.charges.create')).toBe(false);
  });

  it('rejects a shorter chain than the pattern', () => {
    expect(matchesCallPath(['create'], 'stripe.charges.create')).toBe(false);
  });
});

describe('getAccessPath', () => {
  it('reads static chains and bails on dynamic ones', () => {
    const { scanner } = inMemoryScanner(
      [
        'declare const stripe: any;',
        'declare const key: string;',
        'stripe.charges.create({});',
        'stripe[key].create({});',
      ].join('\n'),
      '/src/paths.ts',
    );
    const sourceFile = scanner.project.getSourceFileOrThrow('/src/paths.ts');
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    const paths = calls.map((call) => getAccessPath(call.getExpression()));
    expect(paths).toContain('stripe.charges.create');
    expect(paths).toContain(null);
  });
});

/* -------------------------------------------------------------------------- */
/*  Scanner                                                                    */
/* -------------------------------------------------------------------------- */

describe('Scanner', () => {
  it('loads the fixture file', () => {
    const { scanner } = scanFixture();
    expect(scanner.fileCount).toBe(1);
  });

  it('finds every deprecated Stripe usage in the fixture', () => {
    const { matches } = scanFixture();
    const ids = matches.map((match) => match.matcherId).sort();

    expect(ids).toEqual(
      [
        'charges-capture',
        'charges-create',
        'charges-create',
        'charges-list',
        'charges-retrieve',
        'charges-retrieve',
        'sources-create',
      ].sort(),
    );
  });

  it('does not flag already migrated or unrelated calls', () => {
    const { matches } = scanFixture();
    const text = matches.map((match) => match.originalText).join('\n');
    expect(text).not.toContain('paymentIntents.create');
    expect(text).not.toContain('analytics.events.create');
  });

  it('records file, position and matched call path', () => {
    const { matches } = scanFixture();
    const list = matches.find((match) => match.matcherId === 'charges-list');

    expect(list).toBeDefined();
    expect(list?.relativePath).toBe('outdated-stripe.ts');
    expect(list?.callPath).toBe('stripe.charges.list');
    expect(list?.line).toBeGreaterThan(0);
    expect(list?.column).toBeGreaterThan(0);
    expect(list?.originalText).toContain('stripe.charges.list({ limit: 10, customer: customerId })');
  });

  it('matches through a `this` receiver', () => {
    const { matches } = scanFixture();
    const viaThis = matches.filter((match) => match.callPath === 'this.stripe.charges.retrieve');
    expect(viaThis).toHaveLength(1);
    expect(viaThis[0]?.matcherId).toBe('charges-retrieve');
  });

  it('widens statement-scoped matches to the whole statement', () => {
    const { matches } = scanFixture();
    const create = matches.find(
      (match) => match.matcherId === 'charges-create' && match.originalText.startsWith('const charge'),
    );

    expect(create?.replace).toBe('statement');
    expect(create?.originalText.startsWith('const charge = await stripe.charges.create({')).toBe(true);
    expect(create?.originalText.trimEnd().endsWith('});')).toBe(true);
  });

  it('includes a wrapping await for node-scoped matches', () => {
    const { matches } = scanFixture();
    const retrieve = matches.find((match) => match.callPath === 'stripe.charges.retrieve');
    expect(retrieve?.originalText).toBe('await stripe.charges.retrieve(chargeId)');
  });

  it('captures the enclosing function as prompt context', () => {
    const { matches } = scanFixture();
    const capture = matches.find((match) => match.matcherId === 'charges-capture');
    expect(capture?.contextText).toContain('export async function settle');
  });

  it('records the indentation of the matched line', () => {
    const { matches } = scanFixture();
    const viaThis = matches.find((match) => match.callPath === 'this.stripe.charges.retrieve');
    expect(viaThis?.indent).toBe('    ');
  });

  it('offsets point at the exact original text', () => {
    const { scanner, matches } = scanFixture();
    const contents = scanner.project.getSourceFileOrThrow(FIXTURE).getFullText();
    for (const match of matches) {
      expect(contents.slice(match.start, match.end)).toBe(match.originalText);
    }
  });

  it('matches property accesses for property-kind matchers', () => {
    const rule: MigrationRule = {
      ...stripeRule,
      id: 'test/property',
      matchers: [
        {
          id: 'charge-source',
          callPath: '*.charge.source',
          kind: 'property',
          replace: 'node',
          description: 'charge.source is gone',
          replacementHint: 'use payment_method',
          forbidden: [],
          examples: [],
        },
      ],
    };

    const scanner = new Scanner({ inMemory: true, cwd: '/' });
    scanner.addSource('/src/prop.ts', 'declare const result: any;\nconst id = result.charge.source;\n');
    const matches = scanner.scan([rule]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.originalText).toBe('result.charge.source');
  });

  it('scanSourceFile works on a single file without a project scan', () => {
    const { scanner } = inMemoryScanner('declare const stripe: any;\nstripe.charges.list({});\n');
    const sourceFile = scanner.project.getSourceFileOrThrow('/src/payments.ts');
    expect(scanSourceFile(sourceFile, RULES, '/')).toHaveLength(1);
  });
});

describe('dedupeMatches', () => {
  it('drops matches contained inside another match', () => {
    const base: ScanMatch = {
      ruleId: 'r',
      matcherId: 'm',
      filePath: '/a.ts',
      relativePath: 'a.ts',
      line: 1,
      column: 1,
      callPath: 'x.y',
      replace: 'node',
      originalText: 'x',
      contextText: 'x',
      start: 0,
      end: 100,
      indent: '',
    };
    const inner: ScanMatch = { ...base, start: 10, end: 20 };
    const other: ScanMatch = { ...base, filePath: '/b.ts', start: 10, end: 20 };

    const kept = dedupeMatches([inner, base, other]);
    expect(kept).toHaveLength(2);
    expect(kept.map((match) => match.filePath)).toEqual(['/a.ts', '/b.ts']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Rules                                                                      */
/* -------------------------------------------------------------------------- */

describe('rule registry', () => {
  it('exposes the built-in Stripe rule', () => {
    expect(listRules().map((rule) => rule.id)).toContain('stripe/charges-to-payment-intents');
    expect(getRule('stripe/charges-to-payment-intents').package).toBe('stripe');
  });

  it('applies schema defaults when parsing a rule', () => {
    const matcher = stripeRule.matchers.find((candidate) => candidate.id === 'charges-retrieve');
    expect(matcher?.kind).toBe('call');
    expect(matcher?.replace).toBe('node');
  });

  it('resolves selectors by id, by package and by `all`', () => {
    expect(resolveRules([]).length).toBe(listRules().length);
    expect(resolveRules(['all']).length).toBe(listRules().length);
    expect(resolveRules(['stripe']).map((rule) => rule.id)).toEqual(['stripe/charges-to-payment-intents']);
    expect(resolveRules(['stripe/charges-to-payment-intents'])).toHaveLength(1);
  });

  it('throws a helpful error for an unknown selector', () => {
    expect(() => resolveRules(['nope'])).toThrow(UnknownRuleError);
  });

  it('resolves the matcher behind a scan match', () => {
    const { matches } = scanFixture();
    const { rule, matcher } = resolveMatch(matches[0] as ScanMatch, RULES);
    expect(rule.id).toBe(stripeRule.id);
    expect(matcher.forbidden.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Validator                                                                  */
/* -------------------------------------------------------------------------- */

describe('validateSnippet', () => {
  it('accepts a valid expression rewrite', () => {
    const result = validateSnippet('await stripe.paymentIntents.retrieve(id)', { scope: 'node' });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a valid statement rewrite', () => {
    const result = validateSnippet('const paymentIntent = await stripe.paymentIntents.create({ amount });', {
      scope: 'statement',
    });
    expect(result.valid).toBe(true);
  });

  it('strips markdown fences the model may add', () => {
    const result = validateSnippet('```typescript\nawait stripe.paymentIntents.retrieve(id)\n```', {
      scope: 'node',
    });
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('await stripe.paymentIntents.retrieve(id)');
    expect(stripCodeFences('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('rejects an empty rewrite', () => {
    const result = validateSnippet('   ', { scope: 'node' });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('empty-snippet');
  });

  it('rejects a syntactically invalid rewrite', () => {
    const result = validateSnippet('await stripe.paymentIntents.create({ amount: ', { scope: 'node' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'syntax-error')).toBe(true);
  });

  it('flags statements returned where an expression was required', () => {
    const result = validateSnippet('const a = 1;\nconst b = 2;', { scope: 'node' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'scope-mismatch')).toBe(true);
  });

  it('rejects a rewrite that still uses the deprecated API', () => {
    const result = validateSnippet('await stripe.charges.create({ amount })', {
      scope: 'node',
      forbidden: ['charges.create'],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'forbidden-pattern')).toBe(true);
  });

  it('warns about an unchanged rewrite', () => {
    const original = 'await stripe.paymentIntents.retrieve(id)';
    const result = validateSnippet(original, { scope: 'node', originalText: original });
    expect(result.valid).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'unchanged')).toBe(true);
  });

  it('warns about placeholders but does not block them', () => {
    const result = validateSnippet('await stripe.paymentIntents.create({ amount }) // TODO: confirm', {
      scope: 'node',
    });
    expect(result.valid).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'placeholder')).toBe(true);
  });

  it('does not mistake spread syntax for a placeholder', () => {
    const result = validateSnippet('await stripe.paymentIntents.create({ ...params, confirm: true })', {
      scope: 'node',
    });
    expect(result.issues).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Patcher                                                                    */
/* -------------------------------------------------------------------------- */

describe('reindentSnippet', () => {
  it('leaves single-line snippets alone', () => {
    expect(reindentSnippet('  foo()  ', '    ')).toBe('foo()');
  });

  it('re-indents continuation lines to the target indent', () => {
    const snippet = ['const paymentIntent = await stripe.paymentIntents.create({', '  amount,', '});'].join('\n');
    expect(reindentSnippet(snippet, '    ')).toBe(
      ['const paymentIntent = await stripe.paymentIntents.create({', '      amount,', '    });'].join('\n'),
    );
  });

  it('strips the common indent the model emitted', () => {
    const snippet = ['if (a) {', '      b();', '    }'].join('\n');
    expect(reindentSnippet(snippet, '  ')).toBe(['if (a) {', '    b();', '  }'].join('\n'));
  });
});

describe('patcher', () => {
  const CODE = [
    'declare const stripe: any;',
    'export async function pay(amount: number, token: string) {',
    '  const charge = await stripe.charges.create({ amount, source: token });',
    '  return charge.id;',
    '}',
    '',
  ].join('\n');

  function resultFor(match: ScanMatch, code: string, status: RewriteResult['status'] = 'rewritten'): RewriteResult {
    return {
      match,
      status,
      code,
      response: {
        rewrittenCode: code,
        explanation: 'migrated',
        confidence: 0.9,
        requiresManualReview: status === 'needs-review',
        followUpNotes: [],
      },
      validation: { valid: true, issues: [], normalized: code },
      attempts: 1,
      error: null,
    };
  }

  it('merges a rewrite into the file without touching disk', () => {
    const { scanner, matches } = inMemoryScanner(CODE);
    const replacement =
      'const paymentIntent = await stripe.paymentIntents.create({ amount, payment_method: token, confirm: true });';
    const patches = buildPatches(scanner.project, [resultFor(matches[0] as ScanMatch, replacement)], { cwd: '/' });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.edits).toBe(1);
    expect(patches[0]?.applied).toBe(false);
    expect(patches[0]?.updated).toContain(replacement);
    expect(patches[0]?.updated).not.toContain('charges.create');
    expect(scanner.project.getSourceFileOrThrow('/src/payments.ts').getFullText()).toBe(CODE);
  });

  it('applies several edits to one file back-to-front', () => {
    const code = [
      'declare const stripe: any;',
      'export async function a(id: string) {',
      '  const one = await stripe.charges.retrieve(id);',
      '  const two = await stripe.charges.list({ limit: 1 });',
      '  return [one, two];',
      '}',
      '',
    ].join('\n');

    const { scanner, matches } = inMemoryScanner(code, '/src/multi.ts');
    expect(matches).toHaveLength(2);

    const results = matches.map((match) =>
      resultFor(match, match.originalText.replace('charges.', 'paymentIntents.')),
    );
    const patches = buildPatches(scanner.project, results, { cwd: '/' });

    expect(patches[0]?.edits).toBe(2);
    expect(patches[0]?.updated).toContain('await stripe.paymentIntents.retrieve(id)');
    expect(patches[0]?.updated).toContain('await stripe.paymentIntents.list({ limit: 1 })');
  });

  it('skips needs-review rewrites unless asked for them', () => {
    const { scanner, matches } = inMemoryScanner(CODE);
    const results = [resultFor(matches[0] as ScanMatch, 'const paymentIntent = 1;', 'needs-review')];

    expect(selectApplicable(results)).toHaveLength(0);
    expect(selectApplicable(results, true)).toHaveLength(1);
    expect(buildPatches(scanner.project, results, { cwd: '/' })).toHaveLength(0);
    expect(buildPatches(scanner.project, results, { cwd: '/', includeNeedsReview: true })).toHaveLength(1);
  });

  it('refuses to emit a patch that breaks the file', () => {
    const { scanner, matches } = inMemoryScanner(CODE);
    // Structurally valid as a standalone statement, broken once spliced in.
    const patches = buildPatches(scanner.project, [resultFor(matches[0] as ScanMatch, 'const x = {;')], {
      cwd: '/',
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.edits).toBe(0);
    expect(patches[0]?.updated).toBe(patches[0]?.original);
    expect(patches[0]?.issues.some((issue) => issue.level === 'error')).toBe(true);
  });

  it('detects stale offsets instead of corrupting the file', () => {
    const { scanner, matches } = inMemoryScanner(CODE);
    const stale: ScanMatch = { ...(matches[0] as ScanMatch), originalText: 'something else entirely' };
    const patches = buildPatches(scanner.project, [resultFor(stale, 'const paymentIntent = 1;')], { cwd: '/' });

    expect(patches).toHaveLength(0);
  });

  it('writes applied patches through the project file system', async () => {
    const { scanner, matches } = inMemoryScanner(CODE);
    const replacement = 'const paymentIntent = await stripe.paymentIntents.create({ amount });';
    const patches = buildPatches(scanner.project, [resultFor(matches[0] as ScanMatch, replacement)], { cwd: '/' });

    const applied = await applyPatches(scanner.project, patches);

    expect(applied).toHaveLength(1);
    expect(applied[0]?.applied).toBe(true);
    expect(scanner.project.getFileSystem().readFileSync('/src/payments.ts')).toContain(replacement);
  });
});

/* -------------------------------------------------------------------------- */
/*  Diff                                                                       */
/* -------------------------------------------------------------------------- */

describe('diff utils', () => {
  const before = 'const a = 1;\nconst b = 2;\n';
  const after = 'const a = 1;\nconst b = 3;\n';

  it('counts additions and deletions', () => {
    expect(diffStats(before, after)).toEqual({ additions: 1, deletions: 1 });
  });

  it('produces a unified diff without the Index preamble', () => {
    const patch = createUnifiedDiff(before, after, { label: 'x.ts' });
    expect(patch.startsWith('Index:')).toBe(false);
    expect(patch.startsWith('=')).toBe(false);
    expect(patch.startsWith('--- a/x.ts')).toBe(true);
    expect(patch).toContain('-const b = 2;');
    expect(patch).toContain('+const b = 3;');
  });

  it('returns an empty string when nothing changed', () => {
    expect(renderDiff(before, before, { label: 'x.ts' })).toBe('');
  });

  it('renders a labelled diff', () => {
    const rendered = renderDiff(before, after, { label: 'x.ts' });
    // eslint-disable-next-line no-control-regex
    const plain = rendered.replace(/\[[0-9;]*m/g, '');
    expect(plain).toContain('x.ts');
    expect(plain).toContain('+const b = 3;');
  });
});

/* -------------------------------------------------------------------------- */
/*  Rewriter (fake LLM client)                                                 */
/* -------------------------------------------------------------------------- */

function extractSnippet(request: ChatCompletionRequest): string {
  const prompt = request.messages.filter((message) => message.role === 'user')[0]?.content ?? '';
  const marker = 'Snippet to rewrite (replace exactly this):\n```typescript\n';
  const start = prompt.indexOf(marker);
  if (start === -1) return '';
  const rest = prompt.slice(start + marker.length);
  return rest.slice(0, rest.indexOf('\n```'));
}

function naiveMigrate(snippet: string): string {
  return snippet
    .replace(/charges\./g, 'paymentIntents.')
    .replace(/sources\./g, 'paymentMethods.')
    .replace(/source:/g, 'payment_method:')
    .replace(/\bconst charge\b/g, 'const paymentIntent')
    .replace(/\bcharge\.id\b/g, 'paymentIntent.id');
}

interface FakeOptions {
  transform?: (snippet: string, callCount: number) => string;
  confidence?: number;
  requiresManualReview?: boolean;
  throwOnce?: boolean;
}

function fakeClient(options: FakeOptions = {}): ChatCompletionClient & { calls: ChatCompletionRequest[] } {
  const calls: ChatCompletionRequest[] = [];
  let callCount = 0;

  return {
    calls,
    chat: {
      completions: {
        create: async (request: ChatCompletionRequest) => {
          calls.push(request);
          callCount += 1;
          if (options.throwOnce && callCount === 1) throw new Error('network blip');

          const snippet = extractSnippet(request);
          const rewrittenCode = (options.transform ?? naiveMigrate)(snippet, callCount);

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rewrittenCode,
                    explanation: 'Migrated to the Payment Intents API.',
                    confidence: options.confidence ?? 0.95,
                    requiresManualReview: options.requiresManualReview ?? false,
                    followUpNotes: [],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          };
        },
      },
    },
  };
}

describe('buildUserPrompt', () => {
  it('includes the rule, the snippet and the surrounding context', () => {
    const { matches } = scanFixture();
    const match = matches.find((candidate) => candidate.matcherId === 'charges-create') as ScanMatch;
    const { rule, matcher } = resolveMatch(match, RULES);
    const prompt = buildUserPrompt(match, rule, matcher);

    expect(prompt).toContain(rule.title);
    expect(prompt).toContain(matcher.replacementHint);
    expect(prompt).toContain(match.originalText);
    expect(prompt).toContain('Surrounding context');
    expect(prompt).toContain('complete statement');
  });
});

describe('parseRewriteResponse', () => {
  it('parses a well formed structured response', () => {
    const response = parseRewriteResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rewrittenCode: 'x',
              explanation: 'y',
              confidence: 1,
              requiresManualReview: false,
              followUpNotes: [],
            }),
          },
        },
      ],
    });
    expect(response.rewrittenCode).toBe('x');
  });

  it('throws on a refusal', () => {
    expect(() => parseRewriteResponse({ choices: [{ message: { refusal: 'no' } }] })).toThrow(/refused/);
  });

  it('throws on non-JSON content', () => {
    expect(() => parseRewriteResponse({ choices: [{ message: { content: 'not json' } }] })).toThrow(/valid JSON/);
  });

  it('throws when the payload does not match the schema', () => {
    expect(() =>
      parseRewriteResponse({ choices: [{ message: { content: JSON.stringify({ rewrittenCode: 'x' }) } }] }),
    ).toThrow(/schema/);
  });
});

describe('Rewriter', () => {
  it('rewrites every match with the configured client', async () => {
    const { matches } = scanFixture();
    const client = fakeClient();
    const rewriter = new Rewriter({ client, rules: RULES, concurrency: 3 });

    const results = await rewriter.rewriteAll(matches);

    expect(results).toHaveLength(matches.length);
    expect(results.every((result) => result.status === 'rewritten')).toBe(true);
    expect(client.calls).toHaveLength(matches.length);
    expect(results.every((result) => !result.code?.includes('charges.'))).toBe(true);
  });

  it('sends a strict JSON schema response format', async () => {
    const { matches } = scanFixture();
    const client = fakeClient();
    await new Rewriter({ client, rules: RULES, model: 'gpt-4o-mini' }).rewriteOne(matches[0] as ScanMatch);

    const format = client.calls[0]?.response_format as { type: string; json_schema: { strict: boolean } };
    expect(client.calls[0]?.model).toBe('gpt-4o-mini');
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
  });

  it('retries with validator feedback and succeeds on the second attempt', async () => {
    const { matches } = scanFixture();
    const match = matches.find((candidate) => candidate.matcherId === 'charges-list') as ScanMatch;
    const client = fakeClient({
      transform: (snippet, callCount) => (callCount === 1 ? snippet : naiveMigrate(snippet)),
    });

    const result = await new Rewriter({ client, rules: RULES, maxAttempts: 3 }).rewriteOne(match);

    expect(result.status).toBe('rewritten');
    expect(result.attempts).toBe(2);
    expect(client.calls).toHaveLength(2);
    // The retry turn must carry the validator's complaint back to the model.
    const retryPrompt = client.calls[1]?.messages.at(-1)?.content ?? '';
    expect(retryPrompt).toContain('rejected by the validator');
    expect(retryPrompt).toContain('charges.list');
  });

  it('gives up after maxAttempts and reports the failure', async () => {
    const { matches } = scanFixture();
    const match = matches.find((candidate) => candidate.matcherId === 'charges-list') as ScanMatch;
    const client = fakeClient({ transform: (snippet) => snippet });

    const result = await new Rewriter({ client, rules: RULES, maxAttempts: 2 }).rewriteOne(match);

    expect(result.status).toBe('failed');
    expect(result.code).toBeNull();
    expect(result.attempts).toBe(2);
    expect(client.calls).toHaveLength(2);
  });

  it('recovers from a transport error on the first attempt', async () => {
    const { matches } = scanFixture();
    const client = fakeClient({ throwOnce: true });

    const result = await new Rewriter({ client, rules: RULES, maxAttempts: 2 }).rewriteOne(matches[0] as ScanMatch);

    expect(result.status).toBe('rewritten');
    expect(result.attempts).toBe(2);
    expect(result.error).toBeNull();
  });

  it('flags low confidence rewrites for review', async () => {
    const { matches } = scanFixture();
    const client = fakeClient({ confidence: 0.2 });

    const result = await new Rewriter({ client, rules: RULES }).rewriteOne(matches[0] as ScanMatch);

    expect(result.status).toBe('needs-review');
    expect(result.code).not.toBeNull();
  });

  it('flags rewrites the model itself marks for review', async () => {
    const { matches } = scanFixture();
    const client = fakeClient({ requiresManualReview: true });

    const result = await new Rewriter({ client, rules: RULES }).rewriteOne(matches[0] as ScanMatch);
    expect(result.status).toBe('needs-review');
  });

  it('reports progress for each match', async () => {
    const { matches } = scanFixture();
    const onProgress = vi.fn();

    await new Rewriter({ client: fakeClient(), rules: RULES, onProgress }).rewriteAll(matches);

    const phases = onProgress.mock.calls.map(([event]) => event.phase);
    expect(phases.filter((phase) => phase === 'start')).toHaveLength(matches.length);
    expect(phases.filter((phase) => phase === 'done')).toHaveLength(matches.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Integration: scan → rewrite → validate → patch                             */
/* -------------------------------------------------------------------------- */

describe('integration', () => {
  it('migrates the fixture end to end without writing to disk', async () => {
    const { scanner, matches } = scanFixture();
    const original = scanner.project.getSourceFileOrThrow(FIXTURE).getFullText();

    const results = await new Rewriter({ client: fakeClient(), rules: RULES, concurrency: 4 }).rewriteAll(matches);
    const patches = buildPatches(scanner.project, results, { cwd: FIXTURE_DIR });

    expect(patches).toHaveLength(1);
    const patch = patches[0]!;
    expect(patch.relativePath).toBe('outdated-stripe.ts');
    expect(patch.edits).toBe(matches.length);
    expect(patch.issues).toHaveLength(0);

    // Deprecated calls are gone, migrated calls are in.
    expect(patch.updated).not.toMatch(/\bstripe\.charges\./);
    expect(patch.updated).not.toMatch(/\bstripe\.sources\./);
    expect(patch.updated).toContain('await stripe.paymentIntents.retrieve(chargeId)');
    expect(patch.updated).toContain('await this.stripe.paymentIntents.retrieve(chargeId)');
    expect(patch.updated).toContain('payment_method: input.token');

    // Untouched code survives verbatim.
    expect(patch.updated).toContain('export function trackCreate()');
    expect(patch.updated).toContain('analytics.events.create');

    // Indentation of a re-indented multi-line statement is preserved.
    expect(patch.updated).toContain('\n    currency: input.currency,\n');

    // The patched file still parses, and nothing was written.
    const { valid } = validateSnippet(patch.updated, { scope: 'statement' });
    expect(valid).toBe(true);
    expect(scanner.project.getSourceFileOrThrow(FIXTURE).getFullText()).toBe(original);

    // A rescan of the patched contents finds nothing left to do.
    const verifier = new Scanner({ inMemory: true, cwd: '/' });
    verifier.addSource('/migrated.ts', patch.updated);
    expect(verifier.scan(RULES)).toHaveLength(0);
  });

  it('produces a readable diff for the migrated file', async () => {
    const { scanner, matches } = scanFixture();
    const results = await new Rewriter({ client: fakeClient(), rules: RULES }).rewriteAll(matches);
    const patches = buildPatches(scanner.project, results, { cwd: FIXTURE_DIR });

    const rendered = renderDiff(patches[0]!.original, patches[0]!.updated, { label: 'outdated-stripe.ts' });
    // eslint-disable-next-line no-control-regex
    const plain = rendered.replace(/\[[0-9;]*m/g, '');

    expect(plain).toContain('outdated-stripe.ts');
    expect(plain).toContain('-  const charge = await stripe.charges.create({');
    expect(plain).toContain('+  const paymentIntent = await stripe.paymentIntents.create({');
  });
});
