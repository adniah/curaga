# Curaga

Automated codemods for third-party API breaking changes.

Curaga finds deprecated API usages with a **ts-morph AST scan**, asks an LLM for a
**structured, schema-validated rewrite** of each matched snippet, **re-parses** every
rewrite before it is allowed near your source, and patches the files in place with a
colored diff and a confirmation prompt.

The AST does the finding and the splicing; the model only ever sees — and only ever
returns — one snippet at a time. Nothing is written unless the rewrite parses, no longer
mentions the deprecated API, and leaves the whole file syntactically valid.

## Install

```bash
npm install
npm run build
npm link           # optional: puts `curaga` on your PATH
```

Set your API key (only the `migrate` command needs one):

```bash
cp .env.example .env   # then edit it, or just export OPENAI_API_KEY
```

## Usage

```bash
# AST-only analysis — no API key, no network, safe in CI
curaga scan src/
curaga scan src/ --fail-on-match          # exit 1 when anything is found
curaga scan src/ --json                   # machine readable

# See what would change, without writing
curaga migrate src/ --dry-run

# Rewrite for real (prompts before writing)
curaga migrate src/
curaga migrate src/ --yes                 # no prompt, for scripted runs

# Inspect the rule catalogue
curaga rules
curaga rules stripe/charges-to-payment-intents
```

### Common options

| Option | Applies to | Description |
| --- | --- | --- |
| `-r, --rule <id...>` | scan, migrate | Rule ids or package names. Defaults to every built-in rule. |
| `--rule-file <path>` | all | Load extra rules from a JS/JSON module. |
| `-p, --project <tsconfig>` | scan, migrate | Take the file list from a tsconfig instead of globbing. |
| `--cwd <dir>` | all | Root for path resolution and reported relative paths. |
| `--json` | all | Emit JSON instead of formatted output. |
| `-d, --dry-run` | migrate | Compute and show patches, write nothing. |
| `-y, --yes` | migrate | Skip the confirmation prompt. |
| `--include-review` | migrate | Also apply rewrites the model flagged for manual review. |
| `--no-diff` | migrate | Summary only, no diff rendering. |
| `--model`, `--concurrency`, `--max-attempts`, `--temperature` | migrate | Override the LLM settings. |

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for `migrate`. |
| `CURAGA_MODEL` | `gpt-4o-mini` | Rewrite model. |
| `OPENAI_BASE_URL` | — | Point at a proxy or compatible endpoint. |
| `CURAGA_TEMPERATURE` | `0` | Sampling temperature. |
| `CURAGA_CONCURRENCY` | `4` | Parallel rewrite requests. |
| `CURAGA_MAX_ATTEMPTS` | `3` | Rewrite attempts per match before giving up. |
| `CURAGA_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `CURAGA_DEBUG` | — | Print stack traces and the resolved `.env` path. |

A `.env` in the working directory (or any parent, up to 8 levels) is loaded
automatically and never overrides variables already present in the environment.

## How it works

```
scan (ts-morph)  →  rewrite (LLM, JSON schema)  →  validate (re-parse)  →  patch (offsets)
```

1. **`core/scanner.ts`** walks every source file and matches call expressions and property
   accesses against a rule's dotted `callPath`. Matching is suffix based, so
   `stripe.charges.create` also catches `this.stripe.charges.create`, and a leading `*`
   accepts any receiver. Each match records exact character offsets, the enclosing
   function as prompt context, and the line's indentation. Nested matches are deduped.
2. **`core/rewriter.ts`** builds a per-match prompt from the rule (description, migration
   guidance, before/after examples) and calls the model with
   `response_format: json_schema, strict: true`, so the reply is always
   `{ rewrittenCode, explanation, confidence, requiresManualReview, followUpNotes }`.
   Matches are rewritten concurrently.
3. **`core/validator.ts`** re-parses the snippet in a wrapper that mirrors its position in
   the file, and rejects anything that fails to parse, still mentions the deprecated API,
   or is the wrong kind of syntactic unit. A rejection is fed back into the same
   conversation as a retry turn — up to `--max-attempts` times.
4. **`core/patcher.ts`** re-indents each snippet, applies edits back-to-front so offsets
   stay valid, verifies the merged file still parses, and only then writes.

Rewrites the model flagged (`requiresManualReview`) or that came back below the
confidence threshold are reported but **not** applied unless you pass `--include-review`.

## Writing a rule

A rule is plain data validated by a Zod schema, so a rule file can be JS or JSON:

```ts
// my-rules.mjs
export default {
  id: 'acme/v2',
  package: 'acme',
  title: 'Acme v1 → v2',
  description: 'The v1 client methods were replaced in v2.',
  fromVersion: '<2',
  toVersion: '>=2',
  guidance: 'v2 takes a single options object instead of positional arguments.',
  matchers: [
    {
      id: 'send',
      callPath: '*.mailer.send',          // suffix match, any receiver
      kind: 'call',                        // or 'property'
      replace: 'node',                     // or 'statement' for wider rewrites
      description: '`mailer.send` was removed.',
      replacementHint: 'Use `mail.deliver({ to, subject, body })`.',
      forbidden: ['mailer.send'],          // must not survive in the rewrite
      examples: [{ before: 'mailer.send(a, b)', after: 'mail.deliver({ to: a, body: b })' }],
    },
  ],
};
```

```bash
curaga migrate src/ --rule-file ./my-rules.mjs --rule acme/v2
```

`replace: 'statement'` hands the model the whole enclosing statement, which lets it split
one call into several — at the cost of a larger blast radius, so prefer `'node'` unless
the migration genuinely needs it.

## Programmatic use

```ts
import { runMigration } from 'curaga';

const report = await runMigration({
  paths: ['src/'],
  ruleSelectors: ['stripe'],
  dryRun: true,
});

console.log(report.matches, report.rewritten, report.patches.map((p) => p.relativePath));
```

Every module is exported individually too (`Scanner`, `Rewriter`, `validateSnippet`,
`buildPatches`, `renderDiff`, …), and `Rewriter` accepts any object with a
`chat.completions.create` method, which makes it straightforward to inject a proxy or a
stub.

## Caveats

- **Review the diff.** The validator guarantees syntax, not semantics. It cannot know that
  a renamed response field is used three files away.
- Rewrites are snippet-local. A statement-scoped rewrite is told not to rename bindings
  that the surrounding code references, but a migration needing edits in several places at
  once will come back as `needs review` rather than a clean patch.
- Curaga does not add, remove or update imports, and it does not run your type checker.
  Run `tsc` and your tests after migrating.
- Commit (or stash) before running `migrate` without `--dry-run`.

## Development

```bash
npm test           # vitest
npm run typecheck
npm run build
npm run dev -- scan tests/fixtures    # run the CLI from source
```

## License

MIT
