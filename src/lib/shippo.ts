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
// Handles formats like:
//   "123 Main St, Austin, TX 78701"           — city then ST ZIP combined
//   "123 Main St, Austin, TX, 78701"           — city then ST and ZIP separate
//   "609 Graham St, Cleburne TX 76033"         — city+state+zip in last segment
//   "2 NW 79th St, Kansas City, Missouri 64128" — full state name
//   "Flat 5, 10 Downing St, London, SW1A 2AA, GB" — international
export function parseAddressString(raw: string): ShippoAddress {
  const normalized = raw.replace(/\r?\n/g, ', ').replace(/\s{2,}/g, ' ').trim();
  const parts = normalized.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length < 2) throw new Error(`Cannot parse address: "${raw}"`);

  let remaining = [...parts];

  // Strip country from end
  let country = 'US';
  const countryCode = normalizeCountry(remaining[remaining.length - 1]);
  if (countryCode) {
    country = countryCode;
    remaining = remaining.slice(0, -1);
  }

  if (remaining.length < 2) throw new Error(`Cannot parse address (too few parts after country): "${raw}"`);

  const lastPart = remaining[remaining.length - 1];
  const secondLastPart = remaining.length >= 2 ? remaining[remaining.length - 2] : '';
  let state = '';
  let zip = '';
  let city = '';

  // Strategy 1: last segment is "ST ZIP" — "TX 78701", "OH. 44221", "ON M5V 2T6"
  const combinedMatch = lastPart.match(/^([A-Z]{2}\.?)\s+([\w\s-]{3,10})$/i);

  // Strategy 2: last two segments are "ST" and "ZIP" — "TX", "78701"
  const separateStateMatch = /^[A-Z]{2}\.?$/i.test(secondLastPart);

  // Strategy 3: last segment is "City ST ZIP" — "Cleburne TX 76033", "San Diego CA 92129"
  const cityStateZipMatch = lastPart.match(/^(.+?)\s+([A-Z]{2})\s+([\w-]{4,10})$/i);

  // Strategy 4: last segment is "StateName ZIP" — "Missouri 64128", "Massachusetts 01970"
  const stateNameZipMatch = lastPart.match(/^([A-Za-z][A-Za-z\s]{3,}?)\s+([\w-]{4,10})$/);
  const fullStateAbbr = stateNameZipMatch ? US_STATE_NAMES[stateNameZipMatch[1].trim().toLowerCase()] : undefined;

  if (combinedMatch) {
    state = combinedMatch[1].replace(/\./g, '').toUpperCase();
    zip = combinedMatch[2].trim().toUpperCase();
    remaining = remaining.slice(0, -1);
    city = remaining[remaining.length - 1];
    remaining = remaining.slice(0, -1);
  } else if (separateStateMatch) {
    state = secondLastPart.replace(/\./g, '').toUpperCase();
    zip = lastPart.toUpperCase();
    remaining = remaining.slice(0, -2);
    city = remaining[remaining.length - 1];
    remaining = remaining.slice(0, -1);
  } else if (cityStateZipMatch) {
    city = cityStateZipMatch[1].trim();
    state = cityStateZipMatch[2].toUpperCase();
    zip = cityStateZipMatch[3].toUpperCase();
    remaining = remaining.slice(0, -1); // remove the whole "City ST ZIP" segment
  } else if (fullStateAbbr && stateNameZipMatch) {
    state = fullStateAbbr;
    zip = stateNameZipMatch[2].toUpperCase();
    remaining = remaining.slice(0, -1);
    city = remaining[remaining.length - 1];
    remaining = remaining.slice(0, -1);
  } else {
    // International: treat last segment as zip, no state
    zip = lastPart;
    remaining = remaining.slice(0, -1);
    city = remaining[remaining.length - 1];
    remaining = remaining.slice(0, -1);
  }

  if (!city) throw new Error(`Cannot parse address (no city): "${raw}"`);

  const street = remaining.join(', ');
  if (!street) throw new Error(`Cannot parse address (no street): "${raw}"`);

  return { street1: street, city, state, zip, country };
}

const US_STATE_NAMES: Record<string, string> = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
  // Canadian provinces
  'ontario': 'ON', 'quebec': 'QC', 'british columbia': 'BC', 'alberta': 'AB',
  'manitoba': 'MB', 'saskatchewan': 'SK', 'nova scotia': 'NS',
  'new brunswick': 'NB', 'newfoundland': 'NL', 'prince edward island': 'PE',
};

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
