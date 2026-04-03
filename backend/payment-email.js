// ═══════════════════════════════════════════════════════════════
//  HASSABE — Payment Email Templates  (Step 8)
//  File: payment-email.js
//
//  Exports:
//   sendReceiptEmail(opts)         — payment receipt after unlock
//   sendRefundEmail(opts)          — refund confirmation
//   sendGoldWelcomeEmail(opts)     — Gold subscription welcome
//   sendGoldCancelledEmail(opts)   — Gold cancellation notice
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = 'Hassabe ሃሳቤ <admin@hassabe.com>';
const BASE   = process.env.FRONTEND_URL || 'https://hassabe.com';

// ── Shared brand shell ────────────────────────────────────────
function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#FDF8F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FDF8F0;padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0"
  style="max-width:520px;background:#fff;border:0.5px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden">

  <!-- Header -->
  <tr><td style="background:#0C0902;padding:28px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:28px;color:#FAF0DC;letter-spacing:.02em">Hassabe</div>
    <div style="font-size:10px;color:rgba(232,213,163,.35);letter-spacing:.18em;text-transform:uppercase;margin-top:4px">ሃሳቤ · ሓሳቤ</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:36px 32px 28px">
    ${bodyHtml}
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#F7F1E8;padding:16px 32px;text-align:center;border-top:.5px solid rgba(139,105,20,.1)">
    <p style="font-size:11px;color:#B5A88C;margin:0">
      © 2025 Hassabe Inc. &nbsp;·&nbsp;
      <a href="${BASE}/settings" style="color:#B5A88C;text-decoration:none">Settings</a> &nbsp;·&nbsp;
      <a href="${BASE}/privacy" style="color:#B5A88C;text-decoration:none">Privacy</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── CTA button ────────────────────────────────────────────────
function ctaButton(text, url) {
  return `
  <table cellpadding="0" cellspacing="0" style="margin:24px auto 0">
  <tr><td align="center" style="border-radius:3px;background:#C9A84C">
    <a href="${url}"
       style="display:block;padding:14px 32px;font-size:13px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:#0C0902;text-decoration:none"
    >${text}</a>
  </td></tr>
  </table>`;
}

// ── Divider ────────────────────────────────────────────────
function divider() {
  return `<div style="border-top:.5px solid rgba(139,105,20,.12);margin:22px 0"></div>`;
}

// ── Row helper (for receipt line items) ──────────────────────
function row(label, value, bold = false) {
  const style = bold
    ? 'font-weight:600;color:#2A1C06'
    : 'font-weight:400;color:#5A4A2E';
  return `
  <tr>
    <td style="padding:7px 0;font-size:13px;color:#7A6A4F">${label}</td>
    <td style="padding:7px 0;font-size:13px;text-align:right;${style}">${value}</td>
  </tr>`;
}

// ══════════════════════════════════════════════════════════════
//  PAYMENT RECEIPT EMAIL
// ══════════════════════════════════════════════════════════════
async function sendReceiptEmail({ email, firstName, partnerName, amount, currency,
  paymentIntentId, matchId, receiptUrl }) {

  const amountFormatted = `$${(amount / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  const now = new Date().toLocaleDateString('en-US', {
    weekday:'long', year:'numeric', month:'long', day:'numeric'
  });
  const shortId = (paymentIntentId || '').slice(-8).toUpperCase();

  const body = `
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px">Hi ${firstName},</p>
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2A1C06;line-height:1.2;margin:0 0 16px">
      Your conversation with ${partnerName} is now open
    </h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 22px">
      Your payment was successful. Your private conversation is unlocked for 30 days.
      Three AI-generated icebreakers are waiting for you inside.
    </p>

    <!-- Receipt box -->
    <div style="background:#F7F1E8;border-radius:6px;padding:18px 20px;margin-bottom:22px">
      <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#9A8A72;margin-bottom:12px">Payment Receipt</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row('Date', now)}
        ${row('Description', `Conversation unlock — ${partnerName}`)}
        ${row('Receipt ID', `#${shortId}`)}
        ${divider().replace('margin:22px 0','margin:6px 0')}
        ${row('Total charged', amountFormatted, true)}
      </table>
    </div>

    ${receiptUrl ? `<p style="font-size:12px;color:#9A8A72;margin:0 0 8px">
      <a href="${receiptUrl}" style="color:#8B6914;text-decoration:none">View full Stripe receipt →</a>
    </p>` : ''}

    <!-- What's included -->
    <div style="border:.5px solid rgba(201,168,76,.25);border-radius:6px;padding:16px 18px;margin-bottom:22px">
      <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(201,168,76,.5);margin-bottom:10px">What you have access to</div>
      ${['30-day private messaging window', '3 AI-generated icebreaker questions', 'Voice note support (coming soon)', 'Full profile access for ${partnerName}']
        .map(f => `<div style="font-size:13px;color:#5A4A2E;padding:4px 0;display:flex;gap:8px"><span style="color:#C9A84C">✓</span> ${f}</div>`)
        .join('')}
    </div>

    ${ctaButton('Open Your Conversation →', `${BASE}/messages?matchId=${matchId}`)}

    ${divider()}
    <p style="font-size:12px;color:#9A8A72;line-height:1.7;margin:0">
      Questions about your payment?
      <a href="mailto:support@hassabe.com" style="color:#8B6914;text-decoration:none">Contact support</a>.
      If you did not make this purchase, please contact us immediately.
    </p>`;

  await resend.emails.send({
    from,
    to:      email,
    subject: `✓ Receipt — Hassabe conversation unlock ($${(amount / 100).toFixed(2)})`,
    html:    shell('Hassabe Payment Receipt', body),
    text:    `Your Hassabe conversation with ${partnerName} is unlocked. Receipt #${shortId} — ${amountFormatted}. Open your conversation: ${BASE}/messages?matchId=${matchId}`,
  });

  console.log(`[PaymentEmail] Receipt sent to ${email}`);
}

// ══════════════════════════════════════════════════════════════
//  REFUND EMAIL
// ══════════════════════════════════════════════════════════════
async function sendRefundEmail({ email, firstName, amount, currency, refundId, reason }) {
  const amountFormatted = `$${(amount / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  const shortId = (refundId || '').slice(-8).toUpperCase();

  const body = `
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px">Hi ${firstName},</p>
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2A1C06;line-height:1.2;margin:0 0 16px">
      Your refund has been processed
    </h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 22px">
      We have issued a full refund to your original payment method. It typically takes
      5–10 business days to appear on your statement.
    </p>
    <div style="background:#F7F1E8;border-radius:6px;padding:18px 20px;margin-bottom:22px">
      <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#9A8A72;margin-bottom:12px">Refund Details</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row('Refund ID', `#${shortId}`)}
        ${row('Amount refunded', amountFormatted, true)}
        ${row('Reason', reason || 'Requested by customer')}
        ${row('Timeline', '5–10 business days')}
      </table>
    </div>
    ${ctaButton('Go to Dashboard →', `${BASE}/dashboard`)}
    ${divider()}
    <p style="font-size:12px;color:#9A8A72;line-height:1.7;margin:0">
      If you have questions about this refund,
      <a href="mailto:support@hassabe.com" style="color:#8B6914;text-decoration:none">contact our support team</a>.
    </p>`;

  await resend.emails.send({
    from,
    to:      email,
    subject: `Refund processed — ${amountFormatted}`,
    html:    shell('Hassabe Refund Confirmation', body),
    text:    `Your Hassabe refund of ${amountFormatted} (Refund #${shortId}) has been processed. Allow 5–10 business days.`,
  });
}

// ══════════════════════════════════════════════════════════════
//  GOLD WELCOME EMAIL
// ══════════════════════════════════════════════════════════════
async function sendGoldWelcomeEmail({ email, firstName, plan }) {
  const planLabel = plan === 'annual' ? 'Annual ($149.99/yr)' : 'Monthly ($19.99/mo)';

  const body = `
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px">Hi ${firstName},</p>
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2A1C06;line-height:1.2;margin:0 0 16px">
      Welcome to <em style="font-style:italic;color:#C9A84C">Hassabe Gold</em>
    </h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 20px">
      Your Gold membership is active. Here is everything you now have access to.
    </p>
    <div style="border:.5px solid rgba(201,168,76,.25);border-radius:6px;padding:16px 18px;margin-bottom:22px">
      ${[
        'Priority placement in the match queue',
        'Up to 5 active matches (vs 3 on Free)',
        'Match insights: see which dimension drove your score',
        'Unlimited conversation re-opens within 30 days',
        'Early access to community events',
        'Gold badge on your profile',
      ].map(f => `<div style="font-size:13px;color:#5A4A2E;padding:5px 0;display:flex;gap:8px"><span style="color:#C9A84C">✦</span> ${f}</div>`).join('')}
    </div>
    <div style="background:#F7F1E8;border-radius:4px;padding:12px 16px;margin-bottom:20px">
      <span style="font-size:12px;color:#8B6914">Plan: ${planLabel}</span>
    </div>
    ${ctaButton('Go to My Dashboard →', `${BASE}/dashboard`)}`;

  await resend.emails.send({
    from,
    to:      email,
    subject: '✦ Welcome to Hassabe Gold',
    html:    shell('Hassabe Gold — Welcome', body),
    text:    `Welcome to Hassabe Gold, ${firstName}! Your ${planLabel} membership is now active. Visit ${BASE}/dashboard to get started.`,
  });
}

// ══════════════════════════════════════════════════════════════
//  GOLD CANCELLED EMAIL
// ══════════════════════════════════════════════════════════════
async function sendGoldCancelledEmail({ email, firstName, cancelAt }) {
  const cancelDate = new Date(cancelAt).toLocaleDateString('en-US', {
    month:'long', day:'numeric', year:'numeric'
  });

  const body = `
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px">Hi ${firstName},</p>
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:400;color:#2A1C06;margin:0 0 14px">
      Your Gold membership will end on ${cancelDate}
    </h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 20px">
      You will keep your Gold benefits until ${cancelDate}. After that, your account
      will return to the standard Free plan. Your matches and conversation history are
      always preserved.
    </p>
    ${ctaButton('Manage My Account →', `${BASE}/settings`)}
    ${divider()}
    <p style="font-size:12px;color:#9A8A72">
      Changed your mind?
      <a href="${BASE}/settings/subscription" style="color:#8B6914;text-decoration:none">Reactivate Gold here</a>.
    </p>`;

  await resend.emails.send({
    from,
    to:      email,
    subject: 'Your Hassabe Gold membership is being cancelled',
    html:    shell('Hassabe Gold — Cancellation', body),
    text:    `Your Hassabe Gold membership will end on ${cancelDate}. Visit ${BASE}/settings to manage your account.`,
  });
}

module.exports = {
  sendReceiptEmail,
  sendRefundEmail,
  sendGoldWelcomeEmail,
  sendGoldCancelledEmail,
};
