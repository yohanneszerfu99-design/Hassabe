// ═══════════════════════════════════════════════════════════════
//  HASSABE — Notification Service  (Step 6)
//  File: notification-service.js
//
//  Handles ALL notifications across every channel:
//    - Push:   Firebase Cloud Messaging (FCM) via Admin SDK
//    - Email:  Resend (already configured in Step 2)
//    - In-app: PostgreSQL notifications table (Step 5 schema)
//    - SMS:    Twilio (for critical alerts — optional)
//
//  Notification types:
//    new_match          → match found by AI engine
//    r2_reminder        → 48h before Round 2 expires
//    r2_partner_done    → partner completed Round 2 first
//    match_approved     → both passed, ready to unlock
//    match_declined     → did not meet threshold
//    match_expiring     → 7 days before conversation expires
//    messaging_unlocked → payment confirmed, chat open
//    message_received   → new chat message
//    profile_incomplete → nudge to finish profile
//    community_event    → habesha events announcement
//
//  Exports:
//    notify(userId, type, data)        — single user notification
//    notifyPair(userAId, userBId, ...) — both users simultaneously
//    notificationService               — the full service object
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const admin     = require('firebase-admin');
const { Pool }  = require('pg');
const { Resend } = require('resend');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Firebase Admin SDK init ───────────────────────────────────
// Uses service account JSON from environment variable
let firebaseApp;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[FCM] Firebase Admin SDK initialized');
  } else {
    console.warn('[FCM] No FIREBASE_SERVICE_ACCOUNT_JSON found — push notifications disabled');
  }
} catch (err) {
  console.error('[FCM] Firebase init error:', err.message);
}

// ═══════════════════════════════════════════════════════════════
//  NOTIFICATION TEMPLATES
//  All copy and channel configuration per notification type.
// ═══════════════════════════════════════════════════════════════
const NOTIFICATION_TEMPLATES = {

  new_match: {
    title:    (d) => '✦ You have a new compatibility match',
    body:     (d) => `Hassabe found someone with ${d.score}% compatibility. Complete Round 2 within ${d.expiryHours || 72} hours to keep this match.`,
    emailSubject: (d) => `✦ Hassabe found a ${d.score}% compatibility match for you`,
    channels: ['push', 'email', 'in_app'],
    priority: 'high',
    sound:    'default',
  },

  r2_reminder: {
    title:    (d) => 'Your match expires soon',
    body:     (d) => `You have ${d.hoursLeft} hours left to complete Round 2 and keep your ${d.score}% match.`,
    emailSubject: (d) => `⏳ ${d.hoursLeft} hours left to complete your Round 2`,
    channels: ['push', 'email', 'in_app'],
    priority: 'high',
    sound:    'default',
  },

  r2_partner_done: {
    title:    (d) => 'Your match completed Round 2',
    body:     (d) => `${d.partnerFirstName} completed their Round 2. Complete yours to unlock the final result.`,
    emailSubject: (d) => `Your match is waiting — complete Round 2 now`,
    channels: ['push', 'in_app'],
    priority: 'high',
    sound:    'default',
  },

  match_approved: {
    title:    (d) => '★ Your match has been confirmed',
    body:     (d) => `Congratulations — you and your match passed both rounds with a combined score of ${d.combinedScore}%. Unlock your conversation now.`,
    emailSubject: (d) => `★ ${d.combinedScore}% — Your Hassabe match is confirmed`,
    channels: ['push', 'email', 'in_app'],
    priority: 'high',
    sound:    'default',
  },

  match_declined: {
    title:    (d) => 'A match update from Hassabe',
    body:     (d) => 'This match was not advanced based on compatibility criteria. We continue working to find the right person for you.',
    emailSubject: (d) => 'A match update from Hassabe',
    channels: ['push', 'in_app'],
    // No email — too sensitive, in-app only is gentler
    priority: 'normal',
    sound:    null,
  },

  match_expiring: {
    title:    (d) => 'Your conversation closes in 7 days',
    body:     (d) => `Your conversation will close if there is no activity. Don't let this connection pass.`,
    emailSubject: (d) => `Your Hassabe conversation closes in 7 days`,
    channels: ['push', 'email', 'in_app'],
    priority: 'normal',
    sound:    null,
  },

  messaging_unlocked: {
    title:    (d) => '💬 Your conversation is now open',
    body:     (d) => `Your conversation with ${d.partnerFirstName} is unlocked. Say hello — your AI icebreaker is waiting.`,
    emailSubject: (d) => `Your Hassabe conversation with ${d.partnerFirstName} is open`,
    channels: ['push', 'email', 'in_app'],
    priority: 'high',
    sound:    'default',
  },

  message_received: {
    title:    (d) => `New message from ${d.senderFirstName}`,
    body:     (d) => d.messagePreview ? `"${d.messagePreview.slice(0, 80)}${d.messagePreview.length > 80 ? '…' : ''}"` : 'You have a new message.',
    emailSubject: (d) => `New message from ${d.senderFirstName} on Hassabe`,
    channels: ['push', 'in_app'],
    // Email only if user hasn't opened app in 24h (handled by delivery logic)
    priority: 'high',
    sound:    'default',
    collapseKey: (d) => `message_${d.matchId}`, // collapse multiple messages
  },

  profile_incomplete: {
    title:    (d) => 'Complete your profile to get matched',
    body:     (d) => `Your profile is ${d.profileScore}/100. Add ${d.missingItems?.join(' and ') || 'more details'} to become visible to matches.`,
    emailSubject: (d) => `Your Hassabe profile needs attention`,
    channels: ['push', 'email', 'in_app'],
    priority: 'normal',
    sound:    null,
  },

  community_event: {
    title:    (d) => `Hassabe Event — ${d.eventName}`,
    body:     (d) => `${d.eventDate} · ${d.eventLocation}. ${d.eventDescription}`,
    emailSubject: (d) => `Hassabe Community Event: ${d.eventName}`,
    channels: ['push', 'email', 'in_app'],
    priority: 'normal',
    sound:    null,
  },
};

// ═══════════════════════════════════════════════════════════════
//  CORE NOTIFY FUNCTION
//  The single entry point for all notifications.
// ═══════════════════════════════════════════════════════════════

async function notify(userId, type, data = {}, options = {}) {
  const template = NOTIFICATION_TEMPLATES[type];
  if (!template) {
    console.error(`[Notify] Unknown notification type: ${type}`);
    return { success: false, error: 'Unknown type' };
  }

  const title = template.title(data);
  const body  = template.body(data);
  const channels = options.channels || template.channels;

  const results = {
    inApp: false,
    push:  false,
    email: false,
    sms:   false,
  };

  // ── 1. In-app notification (always — primary channel) ──
  try {
    await pool.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, type, title, body, JSON.stringify({ ...data, matchId: data.matchId })]);
    results.inApp = true;
  } catch (err) {
    console.error(`[Notify] In-app insert failed for user ${userId}:`, err.message);
  }

  // ── 2. Push notification (FCM) ──
  if (channels.includes('push') && firebaseApp) {
    try {
      const tokensResult = await pool.query(
        `SELECT token FROM device_tokens
         WHERE user_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 5`,
        [userId]
      );

      if (tokensResult.rows.length > 0) {
        const tokens = tokensResult.rows.map(r => r.token);
        const pushResult = await sendFCMPush(tokens, title, body, {
          type,
          matchId:   data.matchId   || '',
          score:     String(data.score || ''),
          ...Object.fromEntries(
            Object.entries(data)
              .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
              .map(([k, v]) => [k, String(v)])
          ),
        }, template.priority, template.sound, template.collapseKey?.(data));

        results.push = pushResult.successCount > 0;

        // Clean up failed/expired tokens
        if (pushResult.failedTokens?.length) {
          await pool.query(
            `UPDATE device_tokens SET is_active = false
             WHERE token = ANY($1)`,
            [pushResult.failedTokens]
          );
        }
      }
    } catch (err) {
      console.error(`[Notify] Push failed for user ${userId}:`, err.message);
    }
  }

  // ── 3. Email notification ──
  if (channels.includes('email')) {
    try {
      const userResult = await pool.query(
        `SELECT u.email, u.name, p.first_name
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.id = $1`,
        [userId]
      );

      if (userResult.rows[0]?.email) {
        const { email, name, first_name } = userResult.rows[0];
        const displayName = first_name || name || 'there';
        const subject = template.emailSubject(data);

        await sendEmail(email, displayName, subject, type, data, title, body);
        results.email = true;
      }
    } catch (err) {
      console.error(`[Notify] Email failed for user ${userId}:`, err.message);
    }
  }

  console.log(
    `[Notify] ${type} → user ${userId.slice(0,8)}… ` +
    `[inApp:${results.inApp} push:${results.push} email:${results.email}]`
  );

  return { success: true, results };
}

// ── Notify both users in a pair simultaneously ──
async function notifyPair(userAId, userBId, type, dataA = {}, dataB = {}, options = {}) {
  const [resultA, resultB] = await Promise.allSettled([
    notify(userAId, type, dataA, options),
    notify(userBId, type, dataB, options),
  ]);
  return { userA: resultA.value, userB: resultB.value };
}

// ═══════════════════════════════════════════════════════════════
//  FCM PUSH SENDER
// ═══════════════════════════════════════════════════════════════

async function sendFCMPush(tokens, title, body, data = {}, priority = 'high', sound = 'default', collapseKey = null) {
  if (!firebaseApp || !tokens.length) {
    return { successCount: 0, failureCount: 0, failedTokens: [] };
  }

  const message = {
    notification: { title, body },
    data,
    android: {
      priority: priority === 'high' ? 'high' : 'normal',
      notification: {
        sound: sound || 'default',
        channelId: 'hassabe_matches',
        icon: 'ic_notification',
        color: '#C9A84C',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
      ...(collapseKey ? { collapseKey } : {}),
    },
    apns: {
      headers: {
        'apns-priority': priority === 'high' ? '10' : '5',
        ...(collapseKey ? { 'apns-collapse-id': collapseKey } : {}),
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: sound || 'default',
          badge: 1,
          'mutable-content': 1,
          'content-available': 1,
        },
      },
    },
    tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    const failedTokens = [];

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          failedTokens.push(tokens[idx]);
        }
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens,
    };
  } catch (err) {
    console.error('[FCM] sendEachForMulticast error:', err.message);
    return { successCount: 0, failureCount: tokens.length, failedTokens: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL SENDER (Resend)
//  Uses branded HTML templates
// ═══════════════════════════════════════════════════════════════

async function sendEmail(toEmail, firstName, subject, type, data, fallbackTitle, fallbackBody) {
  const html = buildEmailHTML(type, firstName, data, fallbackTitle, fallbackBody);

  try {
    await resend.emails.send({
      from:    'Hassabe ሃሳቤ <admin@hassabe.com>',
      to:      toEmail,
      subject,
      html,
      text:    `${fallbackTitle}\n\n${fallbackBody}\n\nOpen Hassabe: https://hassabe.com`,
      headers: {
        'X-Entity-Ref-ID': `hassabe-${type}-${Date.now()}`,
      },
    });
  } catch (err) {
    console.error('[Email] Resend error:', err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL HTML BUILDER
//  Single template function — type-specific content injected.
// ═══════════════════════════════════════════════════════════════

function buildEmailHTML(type, firstName, data, title, body) {
  const ctaConfig = {
    new_match:          { text: 'View My Match →',      url: 'https://hassabe.com/matches' },
    r2_reminder:        { text: 'Complete Round 2 →',   url: 'https://hassabe.com/matches' },
    r2_partner_done:    { text: 'Complete Round 2 →',   url: 'https://hassabe.com/matches' },
    match_approved:     { text: 'Unlock Conversation →',url: 'https://hassabe.com/matches' },
    match_declined:     { text: 'Back to Dashboard →',  url: 'https://hassabe.com/dashboard' },
    match_expiring:     { text: 'Open Conversation →',  url: 'https://hassabe.com/messages' },
    messaging_unlocked: { text: 'Start the Conversation →', url: 'https://hassabe.com/messages' },
    message_received:   { text: 'Reply Now →',          url: 'https://hassabe.com/messages' },
    profile_incomplete: { text: 'Complete My Profile →',url: 'https://hassabe.com/profile' },
    community_event:    { text: 'RSVP Now →',           url: data.eventUrl || 'https://hassabe.com' },
  };

  const cta = ctaConfig[type] || { text: 'Open Hassabe →', url: 'https://hassabe.com' };

  // Score badge (only for match-related types)
  const scoreBadge = data.score || data.combinedScore ? `
    <div style="text-align:center;margin:24px 0">
      <div style="display:inline-block;background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:16px 28px">
        <div style="font-family:Georgia,serif;font-size:52px;font-weight:400;color:#C9A84C;line-height:1">${data.combinedScore || data.score}%</div>
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(201,168,76,0.5);margin-top:4px">${data.combinedScore ? 'Combined Score' : 'Compatibility Score'}</div>
      </div>
    </div>` : '';

  // Shared values (for match approved)
  const sharedValues = data.sharedValues?.length ? `
    <div style="margin:20px 0;padding:16px;background:#f7f1e8;border-radius:4px">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#9A8A72;margin-bottom:10px">What you share</div>
      ${data.sharedValues.map(v => `<div style="font-size:13px;color:#2A1C06;padding:3px 0;border-bottom:0.5px solid rgba(139,105,20,0.1)">◆ ${v}</div>`).join('')}
    </div>` : '';

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
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:0.5px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden">

  <!-- Header -->
  <tr><td style="background:#0C0902;padding:28px 32px;text-align:center">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#FAF0DC;letter-spacing:0.02em">Hassabe</div>
    <div style="font-size:11px;color:rgba(232,213,163,0.4);letter-spacing:0.16em;text-transform:uppercase;margin-top:4px">ሃሳቤ · ሓሳቤ</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:36px 32px">
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px 0">Hello ${firstName},</p>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;color:#2A1C06;line-height:1.2;margin:0 0 16px 0">${title}</h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 20px 0">${body}</p>

    ${scoreBadge}
    ${sharedValues}

    <!-- CTA -->
    <table cellpadding="0" cellspacing="0" style="margin:28px auto">
    <tr><td align="center" style="border-radius:3px;background:#C9A84C">
      <a href="${cta.url}" style="display:block;padding:14px 32px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:#0C0902;text-decoration:none">${cta.text}</a>
    </td></tr>
    </table>

    <p style="font-size:12px;color:#9A8A72;line-height:1.7;margin:24px 0 0 0;border-top:0.5px solid rgba(139,105,20,0.12);padding-top:20px">
      If you did not expect this notification, you can manage your preferences in <a href="https://hassabe.com/settings" style="color:#8B6914;text-decoration:none">Settings</a>.<br>
      This message was sent to you because you have an active Hassabe account.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#F7F1E8;padding:16px 32px;text-align:center;border-top:0.5px solid rgba(139,105,20,0.1)">
    <p style="font-size:11px;color:#B5A88C;margin:0;letter-spacing:0.04em">
      © 2025 Hassabe Inc. &nbsp;·&nbsp;
      <a href="https://hassabe.coom/unsubscribe" style="color:#B5A88C;text-decoration:none">Unsubscribe</a> &nbsp;·&nbsp;
      <a href="https://hassabe.com/privacy" style="color:#B5A88C;text-decoration:none">Privacy Policy</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED NOTIFICATION JOBS
//  Called by the Step 5 scheduler / cron system.
// ═══════════════════════════════════════════════════════════════

/**
 * sendR2Reminders
 * Sends reminders to users who haven't completed Round 2,
 * when there are 48h and 24h left on the deadline.
 * Called hourly by the scheduler.
 */
async function sendR2Reminders() {
  console.log('[Reminders] Checking R2 deadlines...');

  // Find matches where R2 expires in 24–50h and user hasn't completed
  const result = await pool.query(`
    SELECT
      m.id AS match_id,
      m.r1_score,
      m.r2_expires_at,
      EXTRACT(EPOCH FROM (m.r2_expires_at - now())) / 3600 AS hours_left,

      -- User A details (if they haven't completed)
      CASE WHEN m.r2_a_completed_at IS NULL THEN m.user_a_id END AS remind_user_a,
      -- User B details
      CASE WHEN m.r2_b_completed_at IS NULL THEN m.user_b_id END AS remind_user_b
    FROM matches m
    WHERE
      m.status = 'pending_r2'
      AND m.r2_expires_at IS NOT NULL
      AND m.r2_expires_at > now()
      AND EXTRACT(EPOCH FROM (m.r2_expires_at - now())) / 3600 BETWEEN 22 AND 50
      -- Only send one reminder per match (check not already sent)
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.data->>'matchId' = m.id::text
          AND n.type = 'r2_reminder'
          AND n.created_at > now() - interval '20 hours'
      )
    LIMIT 50
  `);

  let sent = 0;
  for (const row of result.rows) {
    const hoursLeft = Math.round(row.hours_left);
    const data = { matchId: row.match_id, score: row.r1_score, hoursLeft };

    if (row.remind_user_a) {
      await notify(row.remind_user_a, 'r2_reminder', data);
      sent++;
    }
    if (row.remind_user_b) {
      await notify(row.remind_user_b, 'r2_reminder', data);
      sent++;
    }
  }

  if (sent) console.log(`[Reminders] Sent ${sent} R2 reminder notifications`);
  return sent;
}

/**
 * sendExpiryWarnings
 * Warns users when their unlocked conversation will expire in 7 days.
 */
async function sendExpiryWarnings() {
  const result = await pool.query(`
    SELECT
      m.id AS match_id,
      m.user_a_id,
      m.user_b_id,
      m.expires_at
    FROM matches m
    WHERE
      m.status = 'messaging_unlocked'
      AND m.expires_at BETWEEN now() + interval '6 days 20 hours'
                            AND now() + interval '7 days 4 hours'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.data->>'matchId' = m.id::text
          AND n.type = 'match_expiring'
          AND n.created_at > now() - interval '23 hours'
      )
    LIMIT 30
  `);

  for (const row of result.rows) {
    await notifyPair(row.user_a_id, row.user_b_id, 'match_expiring',
      { matchId: row.match_id }, { matchId: row.match_id }
    );
  }

  if (result.rows.length) {
    console.log(`[Reminders] Sent ${result.rows.length * 2} expiry warnings`);
  }
}

/**
 * sendProfileNudges
 * Nudges users whose profile score is below 70 and haven't logged in recently.
 * Sent once, 3 days after signup.
 */
async function sendProfileNudges() {
  const result = await pool.query(`
    SELECT
      u.id,
      p.profile_score,
      p.first_name
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    WHERE
      u.status = 'active'
      AND p.profile_score < 70
      AND p.matching_pool = false
      AND u.created_at BETWEEN now() - interval '4 days' AND now() - interval '2 days 20 hours'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.type = 'profile_incomplete'
      )
    LIMIT 50
  `);

  for (const row of result.rows) {
    const missing = [];
    if (row.profile_score < 50) missing.push('photos and a bio');
    else if (row.profile_score < 70) missing.push('more photos or a video intro');

    await notify(row.id, 'profile_incomplete', {
      profileScore: row.profile_score,
      missingItems: missing,
    });
  }

  if (result.rows.length) {
    console.log(`[Nudges] Sent ${result.rows.length} profile completion nudges`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════

const notificationService = {
  notify,
  notifyPair,
  sendR2Reminders,
  sendExpiryWarnings,
  sendProfileNudges,
  sendFCMPush,
  NOTIFICATION_TEMPLATES,
};

module.exports = notificationService;
module.exports.notify    = notify;
module.exports.notifyPair = notifyPair;

// ══════════════════════════════════════════════════════════════
//  ADD TO Step 5 scheduler (match-routes.js setupScheduler):
//
//  const { sendR2Reminders, sendExpiryWarnings, sendProfileNudges }
//    = require('./notification-service');
//
//  // Every hour — R2 reminders
//  cron.schedule('0 * * * *', sendR2Reminders);
//
//  // Daily at 10 AM — expiry warnings
//  cron.schedule('0 10 * * *', sendExpiryWarnings);
//
//  // Daily at 11 AM — profile nudges
//  cron.schedule('0 11 * * *', sendProfileNudges);
//
//  PACKAGES NEEDED:
//  npm install firebase-admin resend
// ══════════════════════════════════════════════════════════════
