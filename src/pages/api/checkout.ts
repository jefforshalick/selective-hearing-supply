import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { getProducts } from '../../lib/products';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const secretKey: string | undefined = (env as any).STRIPE_SECRET_KEY;

  if (!secretKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Use Fetch-based HTTP client — required for Cloudflare Workers
  const stripe = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  let cart: Record<string, number>;
  try {
    const body = await request.json();
    cart = body.cart;
    if (!cart || typeof cart !== 'object') throw new Error('Invalid cart');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build Stripe line items from cart
  const products = await getProducts();
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const [id, qty] of Object.entries(cart)) {
    if (!qty || qty < 1) continue;
    const product = products.find((p) => p.id === id);
    if (!product || product.price === null || product.status !== 'in_stock') {
      return new Response(JSON.stringify({ error: `Product ${id} unavailable` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: product.name,
          description: product.description,
        },
        unit_amount: Math.round(product.price * 100), // cents
      },
      quantity: qty,
    });
  }

  if (lineItems.length === 0) {
    return new Response(JSON.stringify({ error: 'Cart is empty' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const origin = new URL(request.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,

      // Collect shipping address
      shipping_address_collection: {
        allowed_countries: ['US'],
      },

      // Flat-rate shipping options (replace with Shippo real-time rates later)
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 800, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 1500, currency: 'usd' },
            display_name: 'Priority Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 3 },
            },
          },
        },
      ],

      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const message = err?.message ?? 'Unknown error';
    console.error('Stripe error:', message);
    return new Response(
      JSON.stringify({ error: 'Failed to create checkout session', detail: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
