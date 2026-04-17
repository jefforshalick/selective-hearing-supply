export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { createShippoOrder, parseAddressString } from '../../../lib/shippo';
import type { ShippoAddress, ShippoLineItem } from '../../../lib/shippo';

function getStripe(): Stripe {
  const key = (env as any)?.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';
  const secret = (env as any)?.STRIPE_WEBHOOK_SECRET;

  if (!secret) return new Response('Webhook secret not configured', { status: 500 });

  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret);
  } catch (err: any) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    try {
      const full = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'line_items.data.price.product'],
      });

      const metadata = full.metadata ?? {};
      const rawAddress = metadata.delivery_address;
      if (!rawAddress) return new Response('ok', { status: 200 });

      const parsed = parseAddressString(rawAddress);

      // Get shipping name from custom field, then customer details
      const shippingNameField = (full.custom_fields ?? []).find((f: any) => f.key === 'shipping_name');
      const shippingName = (shippingNameField as any)?.text?.value
        ?? full.customer_details?.name
        ?? metadata.shipping_name
        ?? '';

      const toAddress: ShippoAddress = {
        name: shippingName,
        street1: parsed.street1,
        street2: parsed.street2,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
        country: parsed.country,
        email: full.customer_email ?? undefined,
      };

      const allItems = full.line_items?.data ?? [];
      const isShippingItem = (item: Stripe.LineItem) =>
        (item.description ?? '').toLowerCase().startsWith('shipping');

      const productItems = allItems.filter((i) => !isShippingItem(i));
      const shippingItem = allItems.find((i) => isShippingItem(i));

      const lineItems: ShippoLineItem[] = productItems.map((item) => ({
        title: item.description ?? 'Product',
        quantity: item.quantity ?? 1,
        total_price: ((item.amount_total ?? 0) / 100).toFixed(2),
        currency: 'USD',
      }));

      const shippingCost = shippingItem
        ? ((shippingItem.amount_total ?? 0) / 100).toFixed(2)
        : (metadata.shipping_cost ?? '0.00');

      await createShippoOrder({
        stripeSessionId: session.id,
        placedAt: new Date(session.created * 1000).toISOString(),
        toAddress,
        lineItems,
        shippingCost,
        shippingService: metadata.shipping_service,
      });
    } catch (err: any) {
      // Log but return 200 so Stripe doesn't keep retrying
      console.error('Shippo order creation failed:', err.message);
    }
  }

  return new Response('ok', { status: 200 });
};
