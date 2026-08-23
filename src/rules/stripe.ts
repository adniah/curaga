import { MigrationRuleSchema, type MigrationRule, type MigrationRuleInput } from '../types.js';

/**
 * Stripe removed the legacy Charges API in favour of Payment Intents. The
 * migration is not a rename: the request body changes shape (`source` becomes
 * `payment_method` plus an explicit confirmation step) and the response object
 * carries a different status field, which is exactly the kind of change an
 * AST-only codemod cannot handle on its own.
 */
const stripeChargesToPaymentIntents: MigrationRuleInput = {
  id: 'stripe/charges-to-payment-intents',
  package: 'stripe',
  title: 'Stripe Charges API → Payment Intents API',
  description:
    'Rewrites legacy `charges.*` calls to their Payment Intents equivalents, including the ' +
    'request body reshaping required by SCA (Strong Customer Authentication).',
  fromVersion: '<10',
  toVersion: '>=10',
  docsUrl: 'https://docs.stripe.com/payments/payment-intents/migration/charges',
  guidance: [
    'Migration facts:',
    '- `charges.create` becomes `paymentIntents.create`. A Payment Intent is not charged on',
    '  creation, so pass `confirm: true` when the legacy call charged immediately.',
    '- The legacy `source` / `card` parameter becomes `payment_method`.',
    '- `capture: false` becomes `capture_method: "manual"`.',
    '- `amount` and `currency` keep their names and units (smallest currency unit).',
    '- `description`, `metadata`, `receipt_email`, `statement_descriptor`, `customer`,',
    '  `transfer_data`, `application_fee_amount` and `on_behalf_of` carry over unchanged.',
    '- The legacy `charge.paid` boolean becomes `paymentIntent.status === "succeeded"`, and',
    '  `charge.failure_message` becomes `paymentIntent.last_payment_error?.message`.',
    '- Payment Intents created off-session need `off_session: true` alongside `confirm: true`.',
    '- Idempotency keys stay in the second request-options argument, unchanged.',
    'Never invent parameters that were not present in the original call, and never drop a',
    'parameter that has a direct Payment Intents equivalent.',
  ].join('\n'),
  matchers: [
    {
      id: 'charges-create',
      callPath: '*.charges.create',
      kind: 'call',
      // A statement-level rewrite lets the model rename the result binding
      // (`charge` -> `paymentIntent`) together with the call itself.
      replace: 'statement',
      description: '`charges.create` was removed in favour of `paymentIntents.create`.',
      replacementHint: [
        'Rewrite to `paymentIntents.create`. Map `source`/`card` to `payment_method`, add',
        '`confirm: true` because the legacy Charges API captured funds immediately, and map',
        '`capture: false` to `capture_method: "manual"`. Rename the result binding from',
        '`charge` to `paymentIntent` only when the surrounding context shows no reference to',
        'it outside this statement; otherwise keep the original name and mention the rename in',
        'followUpNotes.',
      ].join(' '),
      forbidden: ['charges.create'],
      examples: [
        {
          before: [
            'const charge = await stripe.charges.create({',
            '  amount: 2000,',
            '  currency: "usd",',
            '  source: token,',
            '  description: "Order 42",',
            '});',
          ].join('\n'),
          after: [
            'const paymentIntent = await stripe.paymentIntents.create({',
            '  amount: 2000,',
            '  currency: "usd",',
            '  payment_method: token,',
            '  confirm: true,',
            '  description: "Order 42",',
            '});',
          ].join('\n'),
        },
      ],
    },
    {
      id: 'charges-retrieve',
      callPath: '*.charges.retrieve',
      kind: 'call',
      replace: 'node',
      description: '`charges.retrieve` was removed in favour of `paymentIntents.retrieve`.',
      replacementHint:
        'Rewrite to `paymentIntents.retrieve` with the same identifier argument and the same ' +
        'expand/options argument, if present.',
      forbidden: ['charges.retrieve'],
      examples: [
        {
          before: 'await stripe.charges.retrieve(chargeId)',
          after: 'await stripe.paymentIntents.retrieve(chargeId)',
        },
      ],
    },
    {
      id: 'charges-list',
      callPath: '*.charges.list',
      kind: 'call',
      replace: 'node',
      description: '`charges.list` was removed in favour of `paymentIntents.list`.',
      replacementHint:
        'Rewrite to `paymentIntents.list`. Keep `limit`, `customer`, `created` and pagination ' +
        'cursors as they are; there is no `source` filter on Payment Intents, so preserve any ' +
        'other filter only when it exists on the Payment Intents list endpoint.',
      forbidden: ['charges.list'],
      examples: [
        {
          before: 'await stripe.charges.list({ limit: 10, customer: customerId })',
          after: 'await stripe.paymentIntents.list({ limit: 10, customer: customerId })',
        },
      ],
    },
    {
      id: 'charges-capture',
      callPath: '*.charges.capture',
      kind: 'call',
      replace: 'node',
      description: '`charges.capture` was removed in favour of `paymentIntents.capture`.',
      replacementHint:
        'Rewrite to `paymentIntents.capture`. The legacy `amount` option becomes ' +
        '`amount_to_capture`.',
      forbidden: ['charges.capture'],
      examples: [
        {
          before: 'await stripe.charges.capture(chargeId, { amount: 500 })',
          after: 'await stripe.paymentIntents.capture(chargeId, { amount_to_capture: 500 })',
        },
      ],
    },
    {
      id: 'sources-create',
      callPath: '*.sources.create',
      kind: 'call',
      replace: 'node',
      description: '`sources.create` was removed in favour of `paymentMethods.create`.',
      replacementHint:
        'Rewrite to `paymentMethods.create`. The Sources `type: "card"` payload maps to ' +
        '`{ type: "card", card: { ... } }` on Payment Methods; attach it to a customer with a ' +
        'follow-up note rather than inventing an extra call.',
      forbidden: ['sources.create'],
      examples: [
        {
          before: 'await stripe.sources.create({ type: "card", token })',
          after: 'await stripe.paymentMethods.create({ type: "card", card: { token } })',
        },
      ],
    },
  ],
};

export const stripeRule: MigrationRule = MigrationRuleSchema.parse(stripeChargesToPaymentIntents);

export default stripeRule;
