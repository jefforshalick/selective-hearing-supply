import Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import type { Product } from '../data/products';

function getStripe(): Stripe {
  const key = (env as any)?.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function syncProductToStripe(
  product: Product
): Promise<{ stripe_product_id: string; stripe_price_id: string | null }> {
  const stripe = getStripe();

  const metadata: Record<string, string> = {
    sh_id: product.id,
    status: product.status,
  };
  if (product.dim_l != null && product.dim_w != null && product.dim_h != null) {
    const u = product.dim_unit ?? 'in';
    metadata.dimensions = `${product.dim_l} x ${product.dim_w} x ${product.dim_h} ${u}`;
  }
  if (product.weight != null) {
    metadata.weight = `${product.weight} ${product.weight_unit ?? 'oz'}`;
  }

  // Create or update the Stripe product
  let stripeProductId = product.stripe_product_id;

  const images = product.image ? [product.image] : undefined;

  if (stripeProductId) {
    await stripe.products.update(stripeProductId, {
      name: product.name,
      description: product.description || undefined,
      images,
      metadata,
    });
  } else {
    const created = await stripe.products.create({
      name: product.name,
      description: product.description || undefined,
      images,
      metadata,
    });
    stripeProductId = created.id;
  }

  // No price for coming_soon with no price set
  if (product.price === null) {
    return { stripe_product_id: stripeProductId, stripe_price_id: null };
  }

  const priceInCents = Math.round(product.price * 100);

  // Check if existing price still matches — prices are immutable in Stripe
  if (product.stripe_price_id) {
    try {
      const existing = await stripe.prices.retrieve(product.stripe_price_id);
      if (!existing.deleted && existing.unit_amount === priceInCents) {
        return { stripe_product_id: stripeProductId, stripe_price_id: product.stripe_price_id };
      }
      // Price changed — archive the old one
      await stripe.prices.update(product.stripe_price_id, { active: false });
    } catch {
      // Price not found, fall through to create
    }
  }

  const newPrice = await stripe.prices.create({
    product: stripeProductId,
    unit_amount: priceInCents,
    currency: 'usd',
  });

  return { stripe_product_id: stripeProductId, stripe_price_id: newPrice.id };
}

export async function createCheckoutSession(
  items: { stripePriceId: string; quantity: number }[],
  customerEmail: string,
  shipping?: { amount: number; label: string }
): Promise<string> {
  const stripe = getStripe();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = items.map(
    ({ stripePriceId, quantity }) => ({ price: stripePriceId, quantity })
  );

  // Add shipping as a separate line item so no address collection is needed in Stripe
  if (shipping && shipping.amount > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: `Shipping (${shipping.label})` },
        unit_amount: Math.round(shipping.amount * 100),
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: customerEmail,
    line_items: lineItems,
    success_url: 'https://supply.selectivehear.ing/success',
    cancel_url: 'https://supply.selectivehear.ing',
  });

  return session.url!;
}

export async function archiveStripeProduct(stripeProductId: string): Promise<void> {
  const stripe = getStripe();
  // Archive all active prices first, then archive the product
  const prices = await stripe.prices.list({ product: stripeProductId, active: true });
  await Promise.all(prices.data.map((p) => stripe.prices.update(p.id, { active: false })));
  await stripe.products.update(stripeProductId, { active: false });
}

export async function createPaymentLink(
  items: { stripePriceId: string; quantity: number }[],
  shippingCost?: number
): Promise<string> {
  const stripe = getStripe();

  let shippingOptions: { shipping_rate: string }[] | undefined;
  if (shippingCost != null && shippingCost > 0) {
    const rate = await stripe.shippingRates.create({
      display_name: 'Shipping',
      type: 'fixed_amount',
      fixed_amount: { amount: Math.round(shippingCost * 100), currency: 'usd' },
    });
    shippingOptions = [{ shipping_rate: rate.id }];
  }

  const link = await stripe.paymentLinks.create({
    line_items: items.map(({ stripePriceId, quantity }) => ({ price: stripePriceId, quantity })),
    shipping_address_collection: { allowed_countries: ['US'] },
    phone_number_collection: { enabled: true },
    ...(shippingOptions ? { shipping_options: shippingOptions } : {}),
  });
  return link.url;
}
