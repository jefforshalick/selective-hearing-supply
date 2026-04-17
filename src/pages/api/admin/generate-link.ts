export const prerender = false;
import type { APIRoute } from 'astro';
import { getProducts } from '../../../lib/products';
import { getSettings } from '../../../lib/settings';
import { createPaymentLink, createCheckoutSession } from '../../../lib/stripe';
import { getCheapestRate, parseAddressString } from '../../../lib/shippo';
import { sendPaymentLinkEmail } from '../../../lib/resend';
import type { OrderLineItem } from '../../../lib/resend';
import { appendEmailLog } from '../../../lib/email-log';
import type { ShippoAddress, ShippoParcel } from '../../../lib/shippo';

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();

    const shippingMode = form.get('shipping_mode')?.toString() ?? 'flat';
    const email = form.get('email')?.toString().trim() ?? '';
    const name = form.get('name')?.toString().trim() ?? '';
    const sendEmail = form.get('send_email') === 'yes';

    const [products, settings] = await Promise.all([getProducts(), getSettings()]);
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Build line items
    const items: { stripePriceId: string; quantity: number }[] = [];
    const emailLineItems: OrderLineItem[] = [];

    for (const product of products) {
      const qty = parseInt(form.get(`qty_${product.id}`)?.toString() ?? '0', 10);
      if (qty > 0 && product.stripe_price_id) {
        items.push({ stripePriceId: product.stripe_price_id, quantity: qty });
        emailLineItems.push({ name: product.name, quantity: qty, unitPrice: product.price ?? 0 });
      }
    }

    if (items.length === 0) {
      return new Response(JSON.stringify({ error: 'Add at least one item.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    let url = '';
    let shippingCostNum = 0;
    let shippingService = '';
    let deliveryAddress = '';

    if (shippingMode === 'dynamic') {
      // Dynamic: calculate via Shippo
      const rawAddress = form.get('address')?.toString().trim() ?? '';
      if (!rawAddress) return new Response(JSON.stringify({ error: 'Address is required for dynamic shipping.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

      const fromKey = form.get('from')?.toString().trim().toLowerCase() ?? '';
      const fromAddr = settings.shipFromAddresses.find((a) => a.name.toLowerCase() === fromKey);
      if (!fromAddr) return new Response(JSON.stringify({ error: `Ship-from address "${form.get('from')}" not found.` }), { status: 400, headers: { 'Content-Type': 'application/json' } });

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

      const parsed = parseAddressString(rawAddress);
      const to: ShippoAddress = {
        name: name || undefined,
        street1: parsed.street1,
        street2: parsed.street2,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
        country: parsed.country,
        email: email || undefined,
      };

      const massUnit = (form.get('weight_unit')?.toString() ?? 'lb') as 'oz' | 'lb' | 'g' | 'kg';
      const parcel: ShippoParcel = {
        length: parseFloat(form.get('box_l')?.toString() ?? '0'),
        width: parseFloat(form.get('box_w')?.toString() ?? '0'),
        height: parseFloat(form.get('box_h')?.toString() ?? '0'),
        distance_unit: 'in',
        weight: parseFloat(form.get('weight')?.toString() ?? '0'),
        mass_unit: massUnit,
      };

      const rate = await getCheapestRate(from, to, parcel);
      shippingCostNum = parseFloat(rate.amount);
      shippingService = `${rate.provider} ${rate.servicelevel.name}`;
      deliveryAddress = rawAddress;

      if (email) {
        url = await createCheckoutSession(items, email, { amount: shippingCostNum, label: shippingService }, {
          delivery_address: rawAddress,
          shipping_service: shippingService,
          shipping_cost: shippingCostNum.toFixed(2),
          box_dims: `${form.get('box_l')} × ${form.get('box_w')} × ${form.get('box_h')} in`,
          box_weight: `${form.get('weight')} ${form.get('weight_unit') ?? 'lb'}`,
        });
      } else {
        url = await createPaymentLink(items, shippingCostNum);
      }

    } else {
      // Flat rate
      const flatShipping = parseFloat(form.get('shipping')?.toString() ?? '0') || 0;
      shippingCostNum = flatShipping;

      if (email) {
        // Use checkout session so email is pre-filled
        url = await createCheckoutSession(items, email, flatShipping > 0 ? { amount: flatShipping, label: 'Shipping' } : undefined);
      } else {
        url = await createPaymentLink(items, flatShipping);
      }
    }

    // Send email if requested
    if (sendEmail && email && url) {
      await sendPaymentLinkEmail({
        to: email,
        name: name || undefined,
        paymentLink: url,
        lineItems: emailLineItems,
        shippingCost: shippingCostNum.toFixed(2),
        shippingService: shippingService || 'Shipping',
        deliveryAddress: deliveryAddress || '(not provided)',
      });

      await appendEmailLog({
        to: email,
        name,
        items: emailLineItems.map((li) => li.quantity > 1 ? `${li.quantity}× ${li.name}` : li.name).join(', '),
        total: `$${(emailLineItems.reduce((s, li) => s + li.unitPrice * li.quantity, 0) + shippingCostNum).toFixed(2)}`,
        address: deliveryAddress,
        shippingService: shippingService || 'Flat rate',
      });
    }

    return new Response(JSON.stringify({
      url,
      shippingCost: shippingCostNum > 0 ? `$${shippingCostNum.toFixed(2)}` : null,
      shippingService: shippingService || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message ?? 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
