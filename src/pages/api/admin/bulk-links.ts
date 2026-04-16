export const prerender = false;
import type { APIRoute } from 'astro';
import { getProducts } from '../../../lib/products';
import { getSettings } from '../../../lib/settings';
import { getCheapestRate } from '../../../lib/shippo';
import { createCheckoutSession } from '../../../lib/stripe';
import type { ShippoAddress, ShippoParcel } from '../../../lib/shippo';

// Minimal CSV parser — handles quoted fields
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let val = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else { val += line[i++]; }
        }
        fields.push(val);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i).trim()); break; }
        fields.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
    return fields;
  };

  const headers = parseRow(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim() ?? '']));
  });
}

function toCSV(rows: Record<string, string>[], headers: string[]): string {
  const escape = (v: string) => (v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h] ?? '')).join(','))].join('\n');
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const file = form.get('csv') as File | null;
    if (!file) return new Response('No file', { status: 400 });

    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length === 0) return new Response('Empty CSV', { status: 400 });

    const [products, settings] = await Promise.all([getProducts(), getSettings()]);
    const productMap = new Map(products.map((p) => [p.id, p]));
    const addressMap = new Map(settings.shipFromAddresses.map((a) => [a.name.toLowerCase(), a]));

    // Detect product columns (any header matching a product id)
    const headers = Object.keys(rows[0]);
    const productCols = headers.filter((h) => productMap.has(h));

    const outputHeaders = [
      ...headers,
      'shipping_carrier',
      'shipping_service',
      'shipping_cost',
      'payment_link',
      'error',
    ];

    const outputRows: Record<string, string>[] = [];

    for (const row of rows) {
      const out: Record<string, string> = { ...row, shipping_carrier: '', shipping_service: '', shipping_cost: '', payment_link: '', error: '' };

      try {
        // Build line items
        const items: { stripePriceId: string; quantity: number }[] = [];
        for (const col of productCols) {
          const qty = parseInt(row[col] ?? '0', 10);
          if (qty > 0) {
            const product = productMap.get(col);
            if (!product?.stripe_price_id) throw new Error(`Product "${col}" has no Stripe price`);
            items.push({ stripePriceId: product.stripe_price_id, quantity: qty });
          }
        }
        if (items.length === 0) throw new Error('No items with quantity > 0');

        // Ship-from address
        const fromKey = (row['from'] ?? '').toLowerCase();
        const fromAddr = addressMap.get(fromKey);
        if (!fromAddr) throw new Error(`Ship-from address "${row['from']}" not found in settings`);

        const from: ShippoAddress = {
          name: fromAddr.company ?? fromAddr.name,
          company: fromAddr.company,
          street1: fromAddr.street1,
          street2: fromAddr.street2,
          city: fromAddr.city,
          state: fromAddr.state,
          zip: fromAddr.zip,
          country: fromAddr.country,
          phone: fromAddr.phone,
        };

        // Ship-to address
        const to: ShippoAddress = {
          name: row['name'] ?? '',
          street1: row['street1'] ?? '',
          street2: row['street2'] || undefined,
          city: row['city'] ?? '',
          state: row['state'] ?? '',
          zip: row['zip'] ?? '',
          country: (row['country'] ?? 'US').toUpperCase(),
          email: row['email'] || undefined,
        };

        // Parcel
        const massUnit = (row['weight_unit'] ?? 'oz') as 'oz' | 'lb' | 'g' | 'kg';
        const parcel: ShippoParcel = {
          length: parseFloat(row['box_l'] ?? '0'),
          width: parseFloat(row['box_w'] ?? '0'),
          height: parseFloat(row['box_h'] ?? '0'),
          distance_unit: 'in',
          weight: parseFloat(row['weight'] ?? '0'),
          mass_unit: massUnit,
        };

        // Get cheapest rate from Shippo
        const rate = await getCheapestRate(from, to, parcel);
        const shippingCost = parseFloat(rate.amount);

        // Create Stripe checkout session
        const email = row['email'] ?? '';
        if (!email) throw new Error('Missing email');

        const url = await createCheckoutSession(items, email, {
          amount: shippingCost,
          label: `${rate.provider} ${rate.servicelevel.name}`,
        });

        out.shipping_carrier = rate.provider;
        out.shipping_service = rate.servicelevel.name;
        out.shipping_cost = shippingCost.toFixed(2);
        out.payment_link = url;
      } catch (e: any) {
        out.error = e.message ?? 'Unknown error';
      }

      outputRows.push(out);
    }

    const csv = toCSV(outputRows, outputHeaders);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="payment-links.csv"`,
      },
    });
  } catch (e: any) {
    return new Response(e.message ?? 'Error', { status: 500 });
  }
};
