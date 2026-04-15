export const prerender = false;
import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { createShippoOrder } from '../../../lib/shippo';

export const POST: APIRoute = async ({ request }) => {
  const key = (env as any)?.STRIPE_SECRET_KEY;
  const webhookSecret = (env as any)?.STRIPE_WEBHOOK_SECRET;

  if (!key || !webhookSecret) {
    return new Response('Not configured', { status: 500 });
  }

  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err: any) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = await stripe.checkout.sessions.retrieve(
      (event.data.object as Stripe.Checkout.Session).id,
      { expand: ['line_items', 'line_items.data.price.product'] }
    );

    try {
      await createShippoOrder(session as any);
    } catch (err: any) {
      // Log but return 200 — don't trigger Stripe retries for Shippo failures
      console.error('Shippo order creation failed:', err.message);
    }
  }

  return new Response('ok', { status: 200 });
};
