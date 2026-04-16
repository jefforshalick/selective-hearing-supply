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
<body style="margin:0; padding:0; background:#0D0D0D; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%;">

          <!-- Logo -->
          <tr>
            <td style="padding-bottom:32px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#FF7136; width:32px; height:28px; border-radius:0 6px 0 0; text-align:center; vertical-align:middle;">
                    <span style="font-family:Arial,sans-serif; font-weight:700; font-size:13px; color:#0D0D0D; letter-spacing:0.04em;">SH</span>
                  </td>
                  <td style="padding-left:8px;">
                    <span style="font-family:Arial,sans-serif; font-weight:700; font-size:13px; color:#FF7136; letter-spacing:0.08em; text-transform:uppercase;">SUPPLY</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding-bottom:24px; border-bottom:1px solid #1E1E1E;">
              <h1 style="margin:0; font-size:28px; font-weight:700; color:#F5F5F0; letter-spacing:-0.02em; text-transform:uppercase; line-height:1.1;">Your order is ready</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding-top:24px; padding-bottom:32px;">
              <p style="margin:0 0 16px; font-size:15px; color:#888; line-height:1.6;">Hey ${displayName},</p>
              <p style="margin:0 0 24px; font-size:15px; color:#888; line-height:1.6;">Your order has been put together and is ready to pay for. Here's what's included:</p>

              <!-- Order summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#141414; border:1px solid #2A2A2A; margin-bottom:24px;">

                <!-- Line items -->
                ${lineItems.map((item, i) => `
                <tr>
                  <td style="padding:${i === 0 ? '16px' : '4px'} 20px ${i === lineItems.length - 1 ? '16px' : '4px'}; border-bottom:${i === lineItems.length - 1 ? '1px solid #1E1E1E' : 'none'};">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:14px; color:#F5F5F0;">${item.name}${item.quantity > 1 ? ` <span style="color:#555;">× ${item.quantity}</span>` : ''}</td>
                        <td align="right" style="font-size:14px; color:#F5F5F0; white-space:nowrap;">${fmt(item.unitPrice * item.quantity)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>`).join('')}

                <!-- Shipping -->
                <tr>
                  <td style="padding:12px 20px; border-bottom:1px solid #1E1E1E;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:14px; color:#555;">Shipping <span style="font-size:12px;">(${shippingService})</span></td>
                        <td align="right" style="font-size:14px; color:#555; white-space:nowrap;">${fmt(shippingCostNum)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Total -->
                <tr>
                  <td style="padding:14px 20px; border-bottom:1px solid #1E1E1E;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; color:#F5F5F0;">Total</td>
                        <td align="right" style="font-size:16px; font-weight:700; color:#FF7136; white-space:nowrap;">${fmt(total)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Delivering to -->
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0; font-size:11px; text-transform:uppercase; letter-spacing:0.14em; color:#555;">Delivering to</p>
                    <p style="margin:4px 0 0; font-size:14px; color:#F5F5F0;">${deliveryAddress}</p>
                  </td>
                </tr>

              </table>

              <p style="margin:0 0 24px; font-size:15px; color:#888; line-height:1.6;">Click the button below to complete your payment. The link is unique to your order.</p>
              <p style="margin:-16px 0 24px; font-size:13px; color:#555; line-height:1.6;">Need to update your delivery address? Reply to this email before paying and we'll sort it out.</p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#FF7136; border-radius:0 10px 0 0;">
                    <a href="${paymentLink}"
                       style="display:inline-block; padding:14px 32px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.15em; color:#0D0D0D; text-decoration:none;">
                      Pay Now →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:24px; border-top:1px solid #1E1E1E;">
              <p style="margin:0; font-size:11px; color:#444; line-height:1.6;">
                Questions? Reply to this email or reach us at <a href="mailto:orders@selectivehear.ing" style="color:#555; text-decoration:none;">orders@selectivehear.ing</a>
              </p>
              <p style="margin:8px 0 0; font-size:11px; color:#333;">
                Selective Hearing Supply — <a href="https://supply.selectivehear.ing" style="color:#333; text-decoration:none;">supply.selectivehear.ing</a>
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
