import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MigrationRuleSchema, type MigrationRule, type RuleMatcher, type ScanMatch } from '../types.js';
import { stripeRule } from './stripe.js';

/** Rules shipped with Curaga, keyed by rule id. */
export const builtinRules: MigrationRule[] = [stripeRule];

export class UnknownRuleError extends Error {
  constructor(ruleId: string, known: string[]) {
    super(`Unknown rule "${ruleId}". Available rules: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownRuleError';
  }
}

export function listRules(): MigrationRule[] {
  return [...builtinRules];
}

export function getRule(ruleId: string, rules: MigrationRule[] = builtinRules): MigrationRule {
  const rule = rules.find((candidate) => candidate.id === ruleId);
  if (!rule) throw new UnknownRuleError(ruleId, rules.map((candidate) => candidate.id));
  return rule;
}

/**
 * Resolves a list of rule selectors. Each selector is either a built-in rule id,
 * a package name (selecting every rule for that package), or `all`.
 */
export function resolveRules(selectors: string[], rules: MigrationRule[] = builtinRules): MigrationRule[] {
  if (selectors.length === 0 || selectors.includes('all')) return [...rules];

  const selected = new Map<string, MigrationRule>();
  for (const selector of selectors) {
    const byId = rules.filter((rule) => rule.id === selector);
    const byPackage = rules.filter((rule) => rule.package === selector);
    const found = byId.length > 0 ? byId : byPackage;
    if (found.length === 0) throw new UnknownRuleError(selector, rules.map((rule) => rule.id));
    for (const rule of found) selected.set(rule.id, rule);
  }
  return [...selected.values()];
}

export function findMatcher(rule: MigrationRule, matcherId: string): RuleMatcher | undefined {
  return rule.matchers.find((matcher) => matcher.id === matcherId);
}

/** Looks up the rule + matcher a scan match came from. */
export function resolveMatch(
  match: ScanMatch,
  rules: MigrationRule[] = builtinRules,
): { rule: MigrationRule; matcher: RuleMatcher } {
  const rule = getRule(match.ruleId, rules);
  const matcher = findMatcher(rule, match.matcherId);
  if (!matcher) {
    throw new UnknownRuleError(`${match.ruleId}#${match.matcherId}`, rule.matchers.map((m) => m.id));
  }
  return { rule, matcher };
}

/**
 * Loads a user-authored rule from a JS/JSON module. The module may default
 * export a single rule or an array of rules; named exports `rule` / `rules`
 * are accepted too. Every rule is validated against {@link MigrationRuleSchema}.
 */
export async function loadRuleFile(filePath: string, cwd: string = process.cwd()): Promise<MigrationRule[]> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const imported: Record<string, unknown> = await import(pathToFileURL(absolute).href);
  const candidate = imported.default ?? imported.rules ?? imported.rule;

  if (candidate === undefined) {
    throw new Error(`Rule file "${filePath}" does not export a rule (expected a default export).`);
  }

  const raw = Array.isArray(candidate) ? candidate : [candidate];
  return raw.map((entry, index) => {
    const parsed = MigrationRuleSchema.safeParse(entry);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid rule at index ${index} in "${filePath}" — ${details}`);
    }
    return parsed.data;
  });
}
