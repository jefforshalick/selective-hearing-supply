import { env } from 'cloudflare:workers';

function getResendKey(): string {
  const key = (env as any)?.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  return key;
}

export interface OrderLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export async function sendPaymentLinkEmail({
  to,
  name,
  paymentLink,
  lineItems,
  shippingCost,
  shippingService,
  deliveryAddress,
}: {
  to: string;
  name?: string;
  paymentLink: string;
  lineItems: OrderLineItem[];
  shippingCost: string;
  shippingService: string;
  deliveryAddress: string;
}): Promise<void> {
  const key = getResendKey();
  const displayName = name || 'there';
  const shippingCostNum = parseFloat(shippingCost);
  const subtotal = lineItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const total = subtotal + shippingCostNum;

  const fmt = (n: number) => `$${n.toFixed(2)}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background:#F5F5F0; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F0; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%;">

          <!-- Hero bar — orange, mimics storefront header -->
          <tr>
            <td style="background:#FF7136; padding:20px 28px 18px; border-radius:0 14px 0 0;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0D0D0D; width:30px; height:26px; border-radius:0 5px 0 0; text-align:center; vertical-align:middle;">
                    <span style="font-family:Arial,sans-serif; font-weight:700; font-size:12px; color:#FF7136; letter-spacing:0.04em;">SH</span>
                  </td>
                  <td style="padding-left:8px;">
                    <span style="font-family:Arial,sans-serif; font-weight:700; font-size:12px; color:#0D0D0D; letter-spacing:0.12em; text-transform:uppercase;">Supply</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Heading block -->
          <tr>
            <td style="background:#0D0D0D; padding:28px 28px 24px;">
              <p style="margin:0 0 6px; font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:0.2em; color:#FF7136; font-family:'Helvetica Neue',Arial,sans-serif;">Order Confirmation</p>
              <h1 style="margin:0; font-size:36px; font-weight:700; color:#F5F5F0; letter-spacing:-0.02em; text-transform:uppercase; line-height:1; font-family:Arial,sans-serif;">Your order<br/>is ready</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#fff; padding:28px; border:1px solid #D8D5CF; border-top:none;">

              <p style="margin:0 0 6px; font-size:15px; color:#0D0D0D; line-height:1.6; font-weight:500;">Hey ${displayName},</p>
              <p style="margin:0 0 24px; font-size:14px; color:#666; line-height:1.6;">Your order has been put together and is ready to pay for. Here's what's included:</p>

              <!-- Order summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px; border:1px solid #D8D5CF;">

                <!-- Column headers -->
                <tr style="background:#F5F5F0;">
                  <td style="padding:10px 16px; border-bottom:1px solid #D8D5CF;">
                    <span style="font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:0.16em; color:#999;">Item</span>
                  </td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid #D8D5CF;">
                    <span style="font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:0.16em; color:#999;">Price</span>
                  </td>
                </tr>

                <!-- Line items -->
                ${lineItems.map((item, i) => `
                <tr>
                  <td style="padding:12px 16px; ${i < lineItems.length - 1 ? 'border-bottom:1px solid #ECEAE6;' : ''}">
                    <span style="font-size:14px; color:#0D0D0D;">${item.name}</span>
                    ${item.quantity > 1 ? `<span style="font-size:12px; color:#999; margin-left:4px;">× ${item.quantity}</span>` : ''}
                  </td>
                  <td align="right" style="padding:12px 16px; white-space:nowrap; ${i < lineItems.length - 1 ? 'border-bottom:1px solid #ECEAE6;' : ''}">
                    <span style="font-size:14px; color:#0D0D0D;">${fmt(item.unitPrice * item.quantity)}</span>
                  </td>
                </tr>`).join('')}

                <!-- Shipping -->
                <tr>
                  <td style="padding:14px 16px; border-top:1px solid #D8D5CF; border-bottom:1px solid #D8D5CF;">
                    <span style="font-size:13px; color:#666;">Shipping</span>
                    <span style="font-size:11px; color:#999; margin-left:4px;">(${shippingService})</span>
                  </td>
                  <td align="right" style="padding:14px 16px; border-top:1px solid #D8D5CF; border-bottom:1px solid #D8D5CF; white-space:nowrap;">
                    <span style="font-size:13px; color:#666;">${fmt(shippingCostNum)}</span>
                  </td>
                </tr>

                <!-- Total -->
                <tr>
                  <td style="padding:14px 16px;">
                    <span style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.12em; color:#0D0D0D;">Total</span>
                  </td>
                  <td align="right" style="padding:14px 16px; white-space:nowrap;">
                    <span style="font-size:20px; font-weight:700; color:#FF7136; letter-spacing:-0.02em;">${fmt(total)}</span>
                  </td>
                </tr>

              </table>

              <!-- Delivering to -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px; border:1px solid #D8D5CF;">
                <tr style="background:#F5F5F0;">
                  <td style="padding:10px 16px; border-bottom:1px solid #D8D5CF;">
                    <span style="font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:0.16em; color:#999;">Delivering to</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 16px;">
                    <span style="font-size:14px; color:#0D0D0D;">${deliveryAddress}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px; font-size:14px; color:#666; line-height:1.6;">Click the button below to complete your payment. The link is unique to your order.</p>
              <p style="margin:0 0 24px; font-size:13px; color:#999; line-height:1.6;">Need to update your delivery address? Reply to this email before paying and we'll sort it out.</p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#FF7136; border-radius:0 14px 0 0;">
                    <a href="${paymentLink}"
                       style="display:inline-block; padding:15px 36px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.15em; color:#0D0D0D; text-decoration:none; font-family:'Helvetica Neue',Arial,sans-serif;">
                      Pay Now →
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 0 0;">
              <p style="margin:0; font-size:11px; color:#999; line-height:1.8;">
                Questions? Reply to this email or reach us at <a href="mailto:orders@selectivehear.ing" style="color:#666; text-decoration:none;">orders@selectivehear.ing</a>
              </p>
              <p style="margin:0; font-size:11px; color:#C0BDB7;">
                <a href="https://supply.selectivehear.ing" style="color:#C0BDB7; text-decoration:none;">supply.selectivehear.ing</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Selective Hearing Supply <orders@selectivehear.ing>',
      to: [to],
      subject: 'Your Selective Hearing Supply order is ready to pay',
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
}
