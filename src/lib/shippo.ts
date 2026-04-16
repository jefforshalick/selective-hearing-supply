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

export interface ShippoValidationResult {
  valid: boolean;
  address: ShippoAddress;
  messages: string[];
}

export async function validateAddress(address: ShippoAddress): Promise<ShippoValidationResult> {
  const key = getShippoKey();

  const res = await fetch('https://api.goshippo.com/addresses/', {
    method: 'POST',
    headers: {
      Authorization: `ShippoToken ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...address, validate: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shippo address validation error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
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
    validation_results?: {
      is_valid: boolean;
      messages: Array<{ text: string; type: string }>;
    };
  };

  const valid = data.validation_results?.is_valid ?? true;
  const messages = (data.validation_results?.messages ?? []).map((m) => m.text);

  const corrected: ShippoAddress = {
    name: data.name,
    company: data.company,
    street1: data.street1,
    street2: data.street2 || undefined,
    city: data.city,
    state: data.state,
    zip: data.zip,
    country: data.country,
    phone: data.phone,
    email: data.email,
  };

  return { valid, address: corrected, messages };
}

// ── Address parser ────────────────────────────────────────────────────────────
// Accepts common single-line formats:
//   "123 Main St, Austin, TX 78701"
//   "123 Main St, Austin, TX 78701, US"
//   "Flat 5, 10 Downing St, London, SW1A 2AA, GB"
export function parseAddressString(raw: string): ShippoAddress {
  const normalized = raw.replace(/\r?\n/g, ', ').replace(/\s{2,}/g, ' ').trim();
  const parts = normalized.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length < 2) throw new Error(`Cannot parse address: "${raw}"`);

  let remaining = [...parts];

  // Detect country at end
  let country = 'US';
  const countryCode = normalizeCountry(remaining[remaining.length - 1]);
  if (countryCode) {
    country = countryCode;
    remaining = remaining.slice(0, -1);
  }

  if (remaining.length < 2) throw new Error(`Cannot parse address (too few parts after country): "${raw}"`);

  // Detect state+zip or just zip at end
  const lastPart = remaining[remaining.length - 1];
  let state = '';
  let zip = '';

  // US/CA: "TX 78701" or "TX 78701-1234" or "ON M5V 2T6"
  const usMatch = lastPart.match(/^([A-Z]{2})\s+([\w-]{4,10})$/i);
  if (usMatch) {
    state = usMatch[1].toUpperCase();
    zip = usMatch[2].toUpperCase();
    remaining = remaining.slice(0, -1);
  } else {
    // International zip with no state prefix, e.g. "SW1A 2AA" or "2000"
    zip = lastPart;
    remaining = remaining.slice(0, -1);
  }

  if (remaining.length < 1) throw new Error(`Cannot parse address (no city): "${raw}"`);

  // City is now the last of remaining
  const city = remaining[remaining.length - 1];
  remaining = remaining.slice(0, -1);

  // Everything left is street
  const street = remaining.join(', ');
  if (!street) throw new Error(`Cannot parse address (no street): "${raw}"`);

  // Split street into street1 + optional street2 if it has a unit indicator
  // e.g. "Apt 2 123 Main St" or "123 Main St Apt 2" — keep as street1 for Shippo
  return { street1: street, city, state, zip, country };
}

const COUNTRY_MAP: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'canada': 'CA', 'australia': 'AU', 'new zealand': 'NZ',
  'germany': 'DE', 'deutschland': 'DE',
  'france': 'FR', 'spain': 'ES', 'italy': 'IT',
  'netherlands': 'NL', 'sweden': 'SE', 'norway': 'NO',
  'denmark': 'DK', 'finland': 'FI', 'switzerland': 'CH',
  'austria': 'AT', 'belgium': 'BE', 'portugal': 'PT',
  'poland': 'PL', 'japan': 'JP', 'china': 'CN',
  'south korea': 'KR', 'korea': 'KR',
  'brazil': 'BR', 'mexico': 'MX', 'argentina': 'AR',
  'india': 'IN', 'singapore': 'SG', 'hong kong': 'HK',
};

function normalizeCountry(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (COUNTRY_MAP[lower]) return COUNTRY_MAP[lower];
  // Accept bare 2-letter ISO codes
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return null;
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
