export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { createShippoOrder, parseAddressString } from '../../../lib/shippo';
import { getSettings } from '../../../lib/settings';
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
      const [full, settings] = await Promise.all([
        stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items', 'line_items.data.price.product'],
        }),
        getSettings(),
      ]);

      const metadata = full.metadata ?? {};
      const rawAddress = metadata.delivery_address;
      if (!rawAddress) return new Response('ok', { status: 200 });

      // Build from address using first ship-from, branded as Selective Hearing Supply
      const shipFrom = settings.shipFromAddresses[0];
      const fromAddress: ShippoAddress | undefined = shipFrom ? {
        name: 'Selective Hearing Supply',
        company: 'Selective Hearing Supply',
        street1: shipFrom.street1,
        street2: shipFrom.street2,
        city: shipFrom.city,
        state: shipFrom.state,
        zip: shipFrom.zip,
        country: shipFrom.country,
        phone: shipFrom.phone,
      } : undefined;

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

      const lineItems: ShippoLineItem[] = productItems.map((item) => {
        // Weight is stored in Stripe product metadata as "32 oz", "2.5 lb", etc.
        const productMeta = ((item.price?.product as any)?.metadata ?? {}) as Record<string, string>;
        const weightStr = productMeta.weight ?? '';
        const weightParts = weightStr.trim().split(/\s+/);
        const weight = weightParts[0] && !isNaN(parseFloat(weightParts[0])) ? weightParts[0] : undefined;
        const weight_unit = weightParts[1] as ShippoLineItem['weight_unit'] | undefined;
        return {
          title: item.description ?? 'Product',
          quantity: item.quantity ?? 1,
          total_price: ((item.amount_total ?? 0) / 100).toFixed(2),
          currency: 'USD',
          ...(weight ? { weight, weight_unit: weight_unit ?? 'oz' } : {}),
        };
      });

      const shippingCost = shippingItem
        ? ((shippingItem.amount_total ?? 0) / 100).toFixed(2)
        : (metadata.shipping_cost ?? '0.00');

      await createShippoOrder({
        stripeSessionId: session.id,
        placedAt: new Date(session.created * 1000).toISOString(),
        fromAddress,
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
