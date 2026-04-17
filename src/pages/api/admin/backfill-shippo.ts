export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { createShippoOrder, parseAddressString } from '../../../lib/shippo';
import { getEmailLog } from '../../../lib/email-log';
import type { ShippoAddress, ShippoLineItem } from '../../../lib/shippo';

function getStripe(): Stripe {
  const key = (env as any)?.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const stripe = getStripe();

    // 1. Get email log (has address + email)
    const log = await getEmailLog();
    // Build map: email -> sorted log entries (newest first)
    const logByEmail = new Map<string, typeof log>();
    for (const entry of log) {
      if (!entry.to) continue;
      const key = entry.to.toLowerCase();
      if (!logByEmail.has(key)) logByEmail.set(key, []);
      logByEmail.get(key)!.push(entry);
    }

    // 2. List recent completed Stripe sessions with line items expanded
    const sessions = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: 100,
      expand: ['data.line_items', 'data.line_items.data.price.product'],
    } as any);

    let created = 0;
    let skipped = 0;
    const errors: { session: string; error: string }[] = [];

    for (const session of sessions.data) {
      // Cap at 45 Shippo creates to stay within 50 subrequest limit
      if (created >= 45) break;

      // Skip if already has address metadata (webhook already handled it)
      if (session.metadata?.delivery_address) { skipped++; continue; }

      const email = (session.customer_email ?? '').toLowerCase();
      if (!email) { skipped++; continue; }

      const logEntries = logByEmail.get(email);
      if (!logEntries || logEntries.length === 0) { skipped++; continue; }

      // Match closest by date
      const sessionMs = session.created * 1000;
      const best = logEntries.reduce((a, b) => {
        const da = Math.abs(new Date(a.sentAt).getTime() - sessionMs);
        const db = Math.abs(new Date(b.sentAt).getTime() - sessionMs);
        return da <= db ? a : b;
      });

      // Only use matches within 7 days
      const diff = Math.abs(new Date(best.sentAt).getTime() - sessionMs);
      if (diff > 7 * 24 * 60 * 60 * 1000) { skipped++; continue; }

      try {
        const parsed = parseAddressString(best.address);
        const toAddress: ShippoAddress = {
          name: best.name || undefined,
          street1: parsed.street1,
          street2: parsed.street2,
          city: parsed.city,
          state: parsed.state,
          zip: parsed.zip,
          country: parsed.country,
          email: session.customer_email ?? undefined,
        };

        // Build line items from Stripe session
        const allItems = (session as any).line_items?.data ?? [];
        const isShippingItem = (item: Stripe.LineItem) =>
          (item.description ?? '').toLowerCase().startsWith('shipping');

        const productItems = allItems.filter((i: Stripe.LineItem) => !isShippingItem(i));
        const shippingItem = allItems.find((i: Stripe.LineItem) => isShippingItem(i));

        const lineItems: ShippoLineItem[] = productItems.map((item: Stripe.LineItem) => ({
          title: item.description ?? 'Product',
          quantity: item.quantity ?? 1,
          total_price: ((item.amount_total ?? 0) / 100).toFixed(2),
          currency: 'USD',
        }));

        const shippingCost = shippingItem
          ? ((shippingItem.amount_total ?? 0) / 100).toFixed(2)
          : '0.00';

        await createShippoOrder({
          stripeSessionId: session.id,
          placedAt: new Date(session.created * 1000).toISOString(),
          toAddress,
          lineItems,
          shippingCost,
          shippingService: best.shippingService !== 'Flat rate' ? best.shippingService : undefined,
        });

        created++;
      } catch (err: any) {
        errors.push({ session: session.id, error: err.message ?? 'Unknown error' });
      }
    }

    return new Response(JSON.stringify({ created, skipped, errors }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message ?? 'Unknown error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
