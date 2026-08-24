<div align="center">

# Curaga

### Ship the upgrade. Skip the grunt work.

**Curaga migrates your codebase across third-party API breaking changes — automatically, safely, and with a diff you actually review.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933.svg)](#requirements)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6.svg)](#requirements)
[![Tests](https://img.shields.io/badge/tests-63%20passing-success.svg)](#development)

[Quickstart](#quickstart) · [See it work](#see-it-work) · [How it stays safe](#how-it-stays-safe) · [Write your own rule](#write-your-own-rule) · [CI](#use-it-in-ci)

</div>

---

## The problem

Stripe removes the Charges API. AWS SDK v2 goes end-of-life. Your ORM renames every
method. The migration guide is forty pages long and your codebase has three hundred call
sites.

So the upgrade sits in the backlog for two quarters, and you pay for it in security
advisories and workarounds.

**Regex can't do it** — the request body changes shape, not just the method name.
**Codemods can't do it** — every call site is a slightly different judgment call.
**Pasting files into a chatbot can't do it** — it silently rewrites code you never asked it
to touch, and you can't diff three hundred of those.

## The solution

Curaga splits the job between the two tools that are actually good at their half of it:

| | Handles |
| --- | --- |
| **AST (ts-morph)** | Finding every call site, exactly. Splicing the result back in, exactly. |
| **LLM (structured output)** | The judgment call on each snippet: what the new API shape should be. |

The model sees one snippet at a time and returns one snippet at a time. It never gets
write access to your files — the AST does the writing, at character offsets it computed
itself. Every rewrite is re-parsed and rejected if it doesn't hold up.

You get a reviewable diff and a confirmation prompt. Not a surprise commit.

---

## Quickstart

```bash
git clone https://github.com/adniah/curaga.git
cd curaga
npm install && npm run build
npm link                      # puts `curaga` on your PATH
```

```bash
# 1. See what needs migrating — no API key, no network, no writes
curaga scan src/

# 2. Preview the rewrites
export OPENAI_API_KEY=sk-...
curaga migrate src/ --dry-run

# 3. Apply them (prompts before writing)
curaga migrate src/
```

> **Not on npm yet.** Install from source as above. `curaga scan` works offline and
> needs no API key — only `migrate` calls a model.

---

## See it work

A Stripe Charges → Payment Intents migration, start to finish.

### Step 1 — Find the call sites

```console
$ curaga scan src/
Scanned 84 file(s) with 1 rule(s): stripe/charges-to-payment-intents

src/payments/checkout.ts
  24:3  stripe.charges.create  [charges-create]
      `charges.create` was removed in favour of `paymentIntents.create`.
      const charge = await stripe.charges.create({ …
  46:10  stripe.charges.retrieve  [charges-retrieve]
      `charges.retrieve` was removed in favour of `paymentIntents.retrieve`.
      await stripe.charges.retrieve(chargeId)
  50:16  stripe.charges.list  [charges-list]
      `charges.list` was removed in favour of `paymentIntents.list`.
      await stripe.charges.list({ limit: 10, customer: customerId })

src/billing/service.ts
  77:20  this.stripe.charges.retrieve  [charges-retrieve]
      `charges.retrieve` was removed in favour of `paymentIntents.retrieve`.
      await this.stripe.charges.retrieve(chargeId)

! 7 match(es) in 2 file(s). Run curaga migrate to rewrite them.
```

Note the fourth hit: `this.stripe.charges.retrieve`. Call-path matching is **suffix
based**, so a client stashed on a class field, a factory, or a DI container is found just
the same — and `stripe.paymentIntents.create` right next to it is *not* flagged.

### Step 2 — Review the rewrites

```console
$ curaga migrate src/ --dry-run
Scanned 84 file(s) — 7 match(es) in 2 file(s).
Model: gpt-4o-mini  ·  concurrency: 4
✔ Rewrote 7/7 match(es).

src/payments/checkout.ts:24:3  rewritten [charges-create]
  Mapped `source` to `payment_method` and added `confirm: true`, since the legacy
  Charges API captured funds on creation.
  - const charge = await stripe.charges.create({
  -     amount: input.amount,
  -     currency: input.currency,
  -     source: input.token,
  -     description: `Order ${input.orderId}`,
  -   });
  + const charge = await stripe.paymentIntents.create({
  +     amount: input.amount,
  +     currency: input.currency,
  +     payment_method: input.token,
  +     confirm: true,
  +     description: `Order ${input.orderId}`,
  +   });

src/payments/checkout.ts:50:16  needs review [charges-list]
  Payment Intents has no `source` filter; the closest equivalent drops it.
  todo: Confirm the dropped `source` filter is not load-bearing for this report.
  - await stripe.charges.list({ limit: 10, source: 'card' })
  + await stripe.paymentIntents.list({ limit: 10 })

Pending file changes

src/payments/checkout.ts  +9 -9
@@ -21,10 +21,10 @@
 export async function checkout(input: CheckoutInput): Promise<string> {
-  const charge = await stripe.charges.create({
+  const charge = await stripe.paymentIntents.create({
     amount: input.amount,
     currency: input.currency,
-    source: input.token,
+    payment_method: input.token,
     description: `Order ${input.orderId}`,
   });

Dry run — 2 file(s) would be written. No changes made.
```

Two things worth pointing out:

- **The `needs review` hit is not applied.** The model couldn't preserve semantics — there
  is no `source` filter on Payment Intents — so it flagged it, explained why, and left a
  to-do. It stays out of the patch unless you pass `--include-review`.
- **The `charge` binding wasn't renamed**, even though `paymentIntent` would read better,
  because other lines reference it and Curaga only rewrites the matched snippet. It tells
  you rather than silently breaking the file.

### Step 3 — Apply

```console
$ curaga migrate src/

Apply 2 file change(s)? [y/N] y
✔ Applied 2 file change(s).
1 rewrite(s) were flagged for manual review and left untouched.
Re-run with --include-review to apply them.
```

Then the usual: `tsc`, tests, review the diff, commit.

---

## What you get

| | |
| --- | --- |
| **Finds every call site** | AST matching with suffix paths and `*` wildcards. Catches `this.stripe.charges.create`, `client.charges.create`, aliased clients — without false-positiving on unrelated `.create()` calls. |
| **Never guesses silently** | Every rewrite comes with an explanation, a confidence score, and follow-up notes. Low-confidence work is quarantined, not applied. |
| **Refuses to break your build** | Snippets are re-parsed in position; merged files are re-parsed whole. A patch that doesn't parse is dropped, not written. |
| **Self-corrects** | A rejected rewrite goes back to the model *with the validator's complaint attached*, up to `--max-attempts` times. |
| **Reviewable by default** | Colored per-snippet and per-file diffs, plus a confirmation prompt. `--dry-run` writes nothing, ever. |
| **Free to look** | `curaga scan` is pure AST — no API key, no network, no cost. Run it on every PR. |
| **Works on your APIs too** | Rules are plain data. Migrate your own internal SDK the same way you migrate Stripe. |
| **Runs in parallel** | Concurrent rewrites with a configurable cap; one small request per call site. |

---

## Command reference

```bash
curaga scan     [paths...]   # find deprecated usages (offline, free)
curaga migrate  [paths...]   # scan → rewrite → validate → patch
curaga rules    [ruleId]     # inspect the rule catalogue
```

| Option | Applies to | Description |
| --- | --- | --- |
| `-r, --rule <id...>` | scan, migrate | Rule ids or package names. Defaults to every built-in rule. |
| `--rule-file <path>` | all | Load extra rules from a JS/JSON module. |
| `-p, --project <tsconfig>` | scan, migrate | Take the file list from a tsconfig instead of globbing. |
| `--cwd <dir>` | all | Root for path resolution and reported relative paths. |
| `--json` | all | Machine-readable output for scripting. |
| `--fail-on-match` | scan | Exit 1 when anything is found. Turns `scan` into a CI gate. |
| `-d, --dry-run` | migrate | Show the full patch, write nothing. |
| `-y, --yes` | migrate | Skip the confirmation prompt (scripted runs). |
| `--include-review` | migrate | Also apply rewrites flagged for manual review. |
| `--no-diff` | migrate | Summary only, no diff rendering. |
| `--model`, `--concurrency`, `--max-attempts`, `--temperature` | migrate | Override LLM settings. |

### More examples

```bash
# One rule, one directory
curaga migrate src/payments --rule stripe/charges-to-payment-intents

# Every rule for a package
curaga migrate src/ --rule stripe

# Use the file list from a tsconfig instead of globbing
curaga migrate --project tsconfig.build.json

# Target a single file, no prompt, higher throughput
curaga migrate src/payments/checkout.ts --yes --concurrency 8

# Be stricter about retries, and quarantine less
curaga migrate src/ --max-attempts 5 --include-review

# Pipe the findings into a report
curaga scan src/ --json > deprecations.json

# Count what's left, by rule
curaga scan src/ --json | jq -r '.matches[].matcherId' | sort | uniq -c

# Point at a proxy or an OpenAI-compatible endpoint
OPENAI_BASE_URL=https://my-gateway.internal/v1 curaga migrate src/
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for `migrate`. |
| `CURAGA_MODEL` | `gpt-4o-mini` | Rewrite model. |
| `OPENAI_BASE_URL` | — | Proxy or compatible endpoint. |
| `CURAGA_TEMPERATURE` | `0` | Sampling temperature. |
| `CURAGA_CONCURRENCY` | `4` | Parallel rewrite requests. |
| `CURAGA_MAX_ATTEMPTS` | `3` | Attempts per call site before giving up. |
| `CURAGA_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `CURAGA_DEBUG` | — | Stack traces and the resolved `.env` path. |

A `.env` in the working directory (or any parent, up to 8 levels up) is loaded
automatically and never overrides variables already in your environment.

---

## How it stays safe

```
scan (ts-morph)  →  rewrite (LLM, strict JSON schema)  →  validate (re-parse)  →  patch (offsets)
```

1. **Scan.** Walks every source file, matching call expressions and property accesses
   against a rule's dotted `callPath`. Records exact character offsets, the enclosing
   function as context, and the line's indentation. Nested matches are deduped.
2. **Rewrite.** One request per call site, with `response_format: json_schema,
   strict: true` — so the reply is always
   `{ rewrittenCode, explanation, confidence, requiresManualReview, followUpNotes }`,
   never prose, never a half-file.
3. **Validate.** The snippet is re-parsed *in a wrapper mirroring its position in the
   file*. Rejected if it doesn't parse, if it's the wrong kind of syntactic unit, or if it
   still mentions the API you're migrating off. Rejections are fed back to the model as a
   retry turn.
4. **Patch.** Snippets are re-indented, edits applied back-to-front so offsets stay valid,
   offsets re-verified against the scanned text, and the merged file re-parsed. If the
   result doesn't parse, the whole patch is dropped.

**Nothing is written** unless the rewrite parses, no longer uses the deprecated API,
leaves the whole file syntactically valid, and you say yes.

---

## Write your own rule

The built-in Stripe rule is just data — so your internal SDK gets the same treatment.
A rule file can be JS or JSON, validated by a Zod schema on load:

```js
// my-rules.mjs
export default {
  id: 'acme/v2',
  package: '@acme/client',
  title: 'Acme client v1 → v2',
  description: 'v1 positional arguments were replaced by an options object.',
  fromVersion: '<2',
  toVersion: '>=2',
  docsUrl: 'https://wiki.internal/acme-v2-migration',
  guidance: [
    'Migration facts:',
    '- `send(to, body)` becomes `deliver({ to, body })`.',
    '- The `priority` third argument becomes `options.priority`, unchanged in units.',
    '- v2 returns a `Receipt`, not a boolean; `ok` becomes `receipt.status === "sent"`.',
  ].join('\n'),
  matchers: [
    {
      id: 'send',
      callPath: '*.mailer.send',   // suffix match, any receiver
      kind: 'call',                // or 'property' for bare property access
      replace: 'node',             // or 'statement' for wider rewrites
      description: '`mailer.send` was removed in v2.',
      replacementHint: 'Use `mailer.deliver({ to, body, priority })`.',
      forbidden: ['mailer.send'],  // must not survive in the rewrite
      examples: [
        { before: 'mailer.send(user.email, body)', after: 'mailer.deliver({ to: user.email, body })' },
      ],
    },
  ],
};
```

```bash
curaga rules --rule-file ./my-rules.mjs           # check it loaded
curaga scan src/ --rule-file ./my-rules.mjs --rule acme/v2
curaga migrate src/ --rule-file ./my-rules.mjs --rule acme/v2 --dry-run
```

**Tips that pay off.** `guidance` is where the migration knowledge lives — the more
concrete the facts, the fewer `needs review` results. `forbidden` is your safety net: any
rewrite still containing those strings is rejected and retried. Prefer
`replace: 'node'`; reach for `'statement'` only when the migration genuinely needs to
restructure the surrounding statement.

---

## Use it in CI

Gate new deprecated usage on every PR — free, offline, no API key in your secrets:

```yaml
# .github/workflows/deprecations.yml
name: deprecations
on: pull_request

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install Curaga
        run: npm install --global github:adniah/curaga
      - name: Fail on deprecated API usage
        run: curaga scan src/ --fail-on-match
```

Installing from git works because `prepare` builds on install. Once Curaga is published
to npm this collapses to `npx curaga scan src/ --fail-on-match`. If the repo is private,
the runner needs a token with read access.

Then run the actual migration locally, on a branch, where you can review the diff.

---

## Programmatic use

```ts
import { runMigration } from 'curaga';

const report = await runMigration({
  paths: ['src/'],
  ruleSelectors: ['stripe'],
  dryRun: true,
});

console.log(`${report.matches} found, ${report.rewritten} clean, ${report.needsReview} to review`);
for (const patch of report.patches) {
  console.log(patch.relativePath, `${patch.edits} edit(s)`);
}
```

Every stage is exported on its own — `Scanner`, `Rewriter`, `validateSnippet`,
`buildPatches`, `renderDiff` — so you can swap out any part of the pipeline. `Rewriter`
accepts anything with a `chat.completions.create` method, which makes injecting a gateway,
a cache, or a stub a one-liner:

```ts
import { Scanner, Rewriter, buildPatches, renderDiff, stripeRule } from 'curaga';

const scanner = new Scanner({ paths: ['src/'] });
const matches = scanner.scan([stripeRule]);

const results = await new Rewriter({ client: myGatewayClient, rules: [stripeRule] }).rewriteAll(matches);

for (const patch of buildPatches(scanner.project, results)) {
  console.log(renderDiff(patch.original, patch.updated, { label: patch.relativePath }));
}
```

---

## Requirements

- Node ≥ 18.17
- TypeScript sources (`.ts`, `.tsx`, `.mts`, `.cts`)
- An OpenAI API key — or any OpenAI-compatible endpoint via `OPENAI_BASE_URL` — for
  `migrate` only

Cost scales with call sites, not repository size: one small request per match, on
`gpt-4o-mini` by default. `scan` is free.

## Good to know

- **Review the diff.** The validator guarantees syntax, not semantics. It cannot know that
  a renamed response field is read three files away.
- **Rewrites are snippet-local.** Migrations that need coordinated edits in several places
  come back as `needs review` rather than a half-applied patch.
- **Imports are not touched**, and your type checker is not run. Do `tsc` and your test
  suite after migrating — that's the point of the confirmation prompt.
- **Commit or stash first** before running `migrate` without `--dry-run`.
- **TypeScript only** today. JavaScript, Python and multi-file rewrites are not supported.

## Development

```bash
npm test                              # 63 tests, vitest
npm run typecheck
npm run build
npm run dev -- scan tests/fixtures    # run the CLI from source
```

The test suite covers path matching, scanning, validation, patching, diffing and the
retry loop, plus an end-to-end scan → rewrite → patch run against an injected fake client
and a dependency-free fixture — so the whole pipeline is testable without a network call.

Contributions welcome, especially new migration rules.

## License

MIT
