export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { createShippoOrder, listShippoOrders, parseAddressString, shippoOrderNumber } from '../../../lib/shippo';
import { getEmailLog } from '../../../lib/email-log';
import { getProducts } from '../../../lib/products';
import { getSettings } from '../../../lib/settings';
import type { ShippoAddress, ShippoLineItem } from '../../../lib/shippo';

function getStripe(): Stripe {
  const key = (env as any)?.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const stripe = getStripe();

    // 1. Load products, settings, email log, and existing Shippo order numbers
    const [log, products, settings, existingShippoOrders] = await Promise.all([
      getEmailLog(),
      getProducts(),
      getSettings(),
      listShippoOrders(),
    ]);

    // Build from address branded as Selective Hearing Supply
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
    // Map product name (lowercase) → { weight, weight_unit }
    const weightByName = new Map(
      products
        .filter((p) => p.weight != null)
        .map((p) => [p.name.toLowerCase(), { weight: String(p.weight), weight_unit: p.weight_unit ?? 'oz' }])
    );
    // Map product name (lowercase) → dimension notes string
    const dimsByName = new Map(
      products
        .filter((p) => (p as any).dim_l != null)
        .map((p) => {
          const pp = p as any;
          const unit = pp.dim_unit ?? 'in';
          const dims = `${pp.dim_l} × ${pp.dim_w} × ${pp.dim_h} ${unit}`;
          const wt = pp.weight != null ? `${pp.weight} ${pp.weight_unit ?? 'oz'}` : undefined;
          const notes = wt ? `Box: ${dims} | Weight: ${wt}` : `Box: ${dims}`;
          return [p.name.toLowerCase(), notes];
        })
    );
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
      expand: ['data.line_items'],
    } as any);

    let created = 0;
    let skipped = 0;
    const errors: { session: string; error: string }[] = [];

    for (const session of sessions.data) {
      // Cap at 43 Shippo creates to stay within 50 subrequest limit
      // (5 fixed subrequests: email log, products, settings, Stripe list, Shippo list)
      if (created >= 43) break;

      // Skip sessions that have delivery_address metadata — webhook handles those
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
        // Prefer the name the customer entered in Stripe checkout over the email log name
        const shippingNameField = ((session as any).custom_fields ?? []).find((f: any) => f.key === 'shipping_name');
        const shippingName = shippingNameField?.text?.value || best.name || undefined;
        const toAddress: ShippoAddress = {
          name: shippingName,
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

        const lineItems: ShippoLineItem[] = productItems.map((item: Stripe.LineItem) => {
          const title = item.description ?? 'Product';
          const w = weightByName.get(title.toLowerCase());
          return {
            title,
            quantity: item.quantity ?? 1,
            total_price: ((item.amount_total ?? 0) / 100).toFixed(2),
            currency: 'USD',
            ...(w ? { weight: w.weight, weight_unit: w.weight_unit } : {}),
          };
        });

        const shippingCost = shippingItem
          ? ((shippingItem.amount_total ?? 0) / 100).toFixed(2)
          : '0.00';

        // Build notes + parcel dims from first product's dimensions
        const firstProductTitle = productItems[0]?.description ?? '';
        const notes = dimsByName.get(firstProductTitle.toLowerCase());

        if (existingShippoOrders.has(shippoOrderNumber(session.id))) { skipped++; continue; }

        await createShippoOrder({
          stripeSessionId: session.id,
          placedAt: new Date(session.created * 1000).toISOString(),
          fromAddress,
          toAddress,
          lineItems,
          shippingCost,
          shippingService: best.shippingService !== 'Flat rate' ? best.shippingService : undefined,
          notes,
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
