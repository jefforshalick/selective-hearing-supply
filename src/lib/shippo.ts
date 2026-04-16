import { env } from 'cloudflare:workers';
import type Stripe from 'stripe';

export interface ShippoAddress {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface ShippoParcel {
  length: number;
  width: number;
  height: number;
  distance_unit: 'in' | 'cm';
  weight: number;
  mass_unit: 'oz' | 'lb' | 'g' | 'kg';
}

export interface ShippoRate {
  amount: string;
  currency: string;
  provider: string;
  servicelevel: { name: string; token: string };
  estimated_days: number | null;
}

export async function getCheapestRate(
  from: ShippoAddress,
  to: ShippoAddress,
  parcel: ShippoParcel
): Promise<ShippoRate> {
  const key = getShippoKey();

  const res = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: {
      Authorization: `ShippoToken ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      address_from: from,
      address_to: to,
      parcels: [parcel],
      async: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shippo rates error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { rates: ShippoRate[] };
  const rates = (data.rates ?? []).filter((r) => parseFloat(r.amount) > 0);
  if (rates.length === 0) throw new Error('No rates returned from Shippo');

  rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
  return rates[0];
}

function getShippoKey(): string {
  const key = (env as any)?.SHIPPO_API_KEY;
  if (!key) throw new Error('SHIPPO_API_KEY not configured');
  return key;
}

export async function createShippoOrder(
  session: Stripe.Checkout.Session & { line_items?: Stripe.ApiList<Stripe.LineItem> }
): Promise<string> {
  const key = getShippoKey();

  const shipping = session.shipping_details;
  const customer = session.customer_details;

  if (!shipping?.address) {
    throw new Error('No shipping address on session');
  }

  const currency = (session.currency ?? 'usd').toUpperCase();

  const lineItems = (session.line_items?.data ?? []).map((item) => {
    const product = item.price?.product as Stripe.Product | undefined;
    return {
      title: item.description ?? product?.name ?? 'Product',
      quantity: item.quantity ?? 1,
      total_price: ((item.amount_total ?? 0) / 100).toFixed(2),
      currency,
      sku: product?.metadata?.sh_id ?? undefined,
    };
  });

  const totalPrice = ((session.amount_total ?? 0) / 100).toFixed(2);

  const body = {
    order_number: session.id,
    order_status: 'PAID',
    placed_at: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
    to_address: {
      name: shipping.name ?? customer?.name ?? '',
      street1: shipping.address.line1 ?? '',
      street2: shipping.address.line2 ?? undefined,
      city: shipping.address.city ?? '',
      state: shipping.address.state ?? '',
      zip: shipping.address.postal_code ?? '',
      country: shipping.address.country ?? 'US',
      email: customer?.email ?? undefined,
      phone: customer?.phone ?? undefined,
    },
    line_items: lineItems,
    shipping_cost: '0.00',
    shipping_cost_currency: currency,
    subtotal_price: totalPrice,
    total_price: totalPrice,
    total_tax: '0.00',
    currency,
  };

  const res = await fetch('https://api.goshippo.com/orders/', {
    method: 'POST',
    headers: {
      Authorization: `ShippoToken ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shippo API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { object_id: string };
  return data.object_id;
}
