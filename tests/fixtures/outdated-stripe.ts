/**
 * Fixture: a payments module written against the legacy Stripe Charges API.
 *
 * Deliberately dependency-free — the scanner is purely syntactic, so a local
 * stand-in for the Stripe client is enough to exercise every matcher.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function createStripeClient(_apiKey: string): any {
  return {} as any;
}

const stripe = createStripeClient(process.env.STRIPE_SECRET_KEY ?? '');

export interface CheckoutInput {
  amount: number;
  currency: string;
  token: string;
  customerId: string;
  orderId: string;
}

export async function checkout(input: CheckoutInput): Promise<string> {
  const charge = await stripe.charges.create({
    amount: input.amount,
    currency: input.currency,
    source: input.token,
    customer: input.customerId,
    description: `Order ${input.orderId}`,
    metadata: { orderId: input.orderId },
  });

  return charge.id;
}

export async function authorizeOnly(amount: number, token: string) {
  return stripe.charges.create({
    amount,
    currency: 'usd',
    source: token,
    capture: false,
  });
}

export async function fetchCharge(chargeId: string) {
  return await stripe.charges.retrieve(chargeId);
}

export async function recentCharges(customerId: string) {
  const page = await stripe.charges.list({ limit: 10, customer: customerId });
  return page.data;
}

export async function settle(chargeId: string, amount: number) {
  return stripe.charges.capture(chargeId, { amount });
}

export async function saveCard(token: string) {
  return stripe.sources.create({ type: 'card', token });
}

/** Already migrated — the scanner must not flag this one. */
export async function modernCheckout(amount: number, paymentMethod: string) {
  return stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    payment_method: paymentMethod,
    confirm: true,
  });
}

/** Exercises suffix matching through a class field receiver. */
export class BillingService {
  private readonly stripe = createStripeClient('sk_test');

  async refundable(chargeId: string) {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return charge.amount_refunded === 0;
  }
}

/** Unrelated API that happens to share a method name — must not match. */
const analytics: any = {};
export function trackCreate() {
  return analytics.events.create({ name: 'charge' });
}
