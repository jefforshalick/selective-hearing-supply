export const prerender = false;
import type { APIRoute } from 'astro';
import { getProducts } from '../../../lib/products';
import { sendPaymentLinkEmail } from '../../../lib/resend';
import type { OrderLineItem } from '../../../lib/resend';
import { getEmailLog } from '../../../lib/email-log';
import type { EmailLogEntry } from '../../../lib/email-log';
import { env } from 'cloudflare:workers';

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

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const file = form.get('csv') as File | null;
    if (!file) return new Response('No file', { status: 400 });

    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length === 0) return new Response('Empty CSV', { status: 400 });

    // Need product info for prices
    const products = await getProducts();
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Detect product columns
    const headers = Object.keys(rows[0]);
    const productCols = headers.filter((h) => productMap.has(h));

    const results: { email: string; success: boolean; error?: string }[] = [];
    const newLogEntries: EmailLogEntry[] = [];

    // Send one email per row that has a payment_link and an email address
    for (const row of rows) {
      const email = row['email'] ?? '';
      const paymentLink = row['payment_link'] ?? '';
      if (!email || !paymentLink) continue;

      try {
        const lineItems: OrderLineItem[] = productCols
          .filter((col) => parseInt(row[col] ?? '0', 10) > 0)
          .map((col) => {
            const qty = parseInt(row[col], 10);
            const product = productMap.get(col);
            return {
              name: product?.name ?? col,
              quantity: qty,
              unitPrice: product?.price ?? 0,
            };
          });

        const shippingCost = row['shipping_cost'] ?? '0';
        const shippingService = `${row['shipping_carrier'] ?? ''} ${row['shipping_service'] ?? ''}`.trim();

        await sendPaymentLinkEmail({
          to: email,
          name: row['name'] || undefined,
          paymentLink,
          lineItems,
          shippingCost,
          shippingService,
          deliveryAddress: row['address'] ?? '',
        });

        const itemSummary = lineItems
          .map((li) => li.quantity > 1 ? `${li.quantity}× ${li.name}` : li.name)
          .join(', ');
        const totalAmount = lineItems.reduce((s, li) => s + li.unitPrice * li.quantity, 0) + parseFloat(shippingCost);

        newLogEntries.push({
          id: crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          to: email,
          name: row['name'] ?? '',
          items: itemSummary,
          total: `$${totalAmount.toFixed(2)}`,
          address: row['address'] ?? '',
          shippingService,
        });

        results.push({ email, success: true });
      } catch (e: any) {
        results.push({ email, success: false, error: e.message ?? 'Unknown error' });
      }
    }

    // Single KV write for all log entries
    if (newLogEntries.length > 0) {
      const kv = (env as any).INVENTORY as KVNamespace | null;
      if (kv) {
        const existing = await getEmailLog();
        const updated = [...newLogEntries, ...existing].slice(0, 500);
        await kv.put('email_log', JSON.stringify(updated));
      }
    }

    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    return new Response(JSON.stringify({ sent, failed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(e.message ?? 'Error', { status: 500 });
  }
};
