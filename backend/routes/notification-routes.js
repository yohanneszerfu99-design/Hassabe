// ═══════════════════════════════════════════════════════════════
//  HASSABE — Notification API Routes  (Step 6)
//  File: notification-routes.js
//
//  Routes:
//   POST /api/notifications/token          — register FCM device token
//   DELETE /api/notifications/token        — unregister device token
//   GET  /api/notifications                — get in-app notifications
//   PUT  /api/notifications/:id/read       — mark one as read
//   PUT  /api/notifications/read-all       — mark all as read
//   GET  /api/notifications/unread-count   — badge count
//   GET  /api/notifications/preferences    — get notification prefs
//   PUT  /api/notifications/preferences    — update prefs
//   POST /api/notifications/test           — admin: send test notification
//   POST /api/notifications/broadcast      — admin: broadcast to all/segment
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { notify, notifyPair, NOTIFICATION_TEMPLATES } = require('../notification-service');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Auth middleware ──
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
      issuer: 'hassabe.com', audience: 'hassabe-api',
    });
    const result = await pool.query(
      'SELECT id, name, email, status FROM users WHERE id = $1', [payload.sub]
    );
    if (!result.rows[0] || result.rows[0].status !== 'active') {
      return res.status(401).json({ error: 'Account not found' });
    }
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const r = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows[0]?.is_admin) return res.status(403).json({ error: 'Admin required' });
    next();
  });
}

function checkValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

const notifLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// ══════════════════════════════════════════════════════════════
//  POST /api/notifications/token — Register device token
// ══════════════════════════════════════════════════════════════
router.post('/token',
  requireAuth,
  [
    body('token').notEmpty().withMessage('FCM token required').isLength({ max: 500 }),
    body('platform').isIn(['ios', 'android', 'web']).withMessage('platform must be ios, android, or web'),
    body('deviceId').optional().isString().isLength({ max: 200 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { token, platform, deviceId, appVersion } = req.body;

    try {
      // Upsert device token (one per device)
      await pool.query(`
        INSERT INTO device_tokens (user_id, token, platform, device_id, app_version, is_active, last_seen)
        VALUES ($1, $2, $3, $4, $5, true, now())
        ON CONFLICT (token) DO UPDATE SET
          user_id     = EXCLUDED.user_id,
          platform    = EXCLUDED.platform,
          device_id   = EXCLUDED.device_id,
          app_version = EXCLUDED.app_version,
          is_active   = true,
          last_seen   = now()
      `, [req.user.id, token, platform, deviceId || null, appVersion || null]);

      // Deactivate tokens for same device_id on other accounts (device switched user)
      if (deviceId) {
        await pool.query(`
          UPDATE device_tokens SET is_active = false
          WHERE device_id = $1 AND user_id != $2 AND token != $3
        `, [deviceId, req.user.id, token]);
      }

      res.json({ registered: true });
    } catch (err) {
      console.error('Token register error:', err);
      res.status(500).json({ error: 'Token registration failed' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  DELETE /api/notifications/token — Unregister on logout
// ══════════════════════════════════════════════════════════════
router.delete('/token',
  requireAuth,
  [body('token').notEmpty()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    await pool.query(
      `UPDATE device_tokens SET is_active = false
       WHERE token = $1 AND user_id = $2`,
      [req.body.token, req.user.id]
    );
    res.json({ unregistered: true });
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/notifications — Fetch in-app notifications
// ══════════════════════════════════════════════════════════════
router.get('/',
  requireAuth,
  notifLimiter,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('unread').optional().isBoolean(),
  ],
  async (req, res) => {
    const page   = parseInt(req.query.page  || 1);
    const limit  = parseInt(req.query.limit || 20);
    const unread = req.query.unread === 'true';
    const offset = (page - 1) * limit;

    try {
      const whereUnread = unread ? 'AND n.read = false' : '';
      const result = await pool.query(`
        SELECT
          n.id, n.type, n.title, n.body, n.data,
          n.read, n.read_at, n.created_at
        FROM notifications n
        WHERE n.user_id = $1 ${whereUnread}
        ORDER BY n.created_at DESC
        LIMIT $2 OFFSET $3
      `, [req.user.id, limit, offset]);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false`,
        [req.user.id]
      );

      res.json({
        notifications: result.rows,
        unreadCount:   parseInt(countResult.rows[0].count),
        page,
        hasMore:       result.rows.length === limit,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/notifications/unread-count — Badge number
// ══════════════════════════════════════════════════════════════
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read = false`,
      [req.user.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch {
    res.status(500).json({ error: 'Failed to get count' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/notifications/:id/read — Mark one notification read
// ══════════════════════════════════════════════════════════════
router.put('/:id/read',
  requireAuth,
  [param('id').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    await pool.query(`
      UPDATE notifications SET read = true, read_at = now()
      WHERE id = $1 AND user_id = $2 AND read = false
    `, [req.params.id, req.user.id]);

    res.json({ read: true });
  }
);

// ══════════════════════════════════════════════════════════════
//  PUT /api/notifications/read-all — Mark all read
// ══════════════════════════════════════════════════════════════
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE notifications SET read = true, read_at = now()
      WHERE user_id = $1 AND read = false
      RETURNING id
    `, [req.user.id]);

    res.json({ markedRead: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/notifications/preferences — User notification prefs
// ══════════════════════════════════════════════════════════════
router.get('/preferences', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT preferences FROM notification_preferences WHERE user_id = $1`,
      [req.user.id]
    );

    // Return defaults if no preferences set yet
    const defaults = {
      push_new_match:          true,
      push_r2_reminder:        true,
      push_r2_partner_done:    true,
      push_match_approved:     true,
      push_match_declined:     true,
      push_messaging_unlocked: true,
      push_message_received:   true,
      push_match_expiring:     true,
      push_community_event:    true,
      email_new_match:         true,
      email_r2_reminder:       true,
      email_match_approved:    true,
      email_match_expiring:    false,
      email_messaging_unlocked:true,
      email_community_event:   false,
      email_marketing:         false,
      quiet_hours_enabled:     false,
      quiet_hours_start:       '22:00',
      quiet_hours_end:         '08:00',
    };

    res.json({
      preferences: result.rows[0]?.preferences || defaults,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/notifications/preferences — Update preferences
// ══════════════════════════════════════════════════════════════
router.put('/preferences',
  requireAuth,
  [body('preferences').isObject()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      await pool.query(`
        INSERT INTO notification_preferences (user_id, preferences)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET
          preferences = EXCLUDED.preferences,
          updated_at  = now()
      `, [req.user.id, JSON.stringify(req.body.preferences)]);

      res.json({ updated: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/notifications/test — Admin: send test notification
// ══════════════════════════════════════════════════════════════
router.post('/test',
  requireAdmin,
  [
    body('userId').optional().isUUID(),
    body('type').isIn(Object.keys(NOTIFICATION_TEMPLATES)),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const targetId = req.body.userId || req.user.id;
    const type     = req.body.type;

    const testData = {
      score: 87, combinedScore: 91, matchId: '00000000-0000-0000-0000-000000000000',
      hoursLeft: 48, partnerFirstName: 'Sara', senderFirstName: 'Yonas',
      messagePreview: 'What does a meaningful Sunday morning look like to you?',
      profileScore: 65, missingItems: ['3 more photos'],
      eventName: 'Habesha Professionals Mixer', eventDate: 'March 28',
      eventLocation: 'Toronto', eventDescription: 'Monthly networking event',
      sharedValues: ['Faith-centered life', 'Family first', 'Ethiopian cultural pride'],
    };

    const result = await notify(targetId, type, testData);
    res.json({ sent: true, result });
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/notifications/broadcast — Admin: broadcast message
// ══════════════════════════════════════════════════════════════
router.post('/broadcast',
  requireAdmin,
  [
    body('type').isIn(Object.keys(NOTIFICATION_TEMPLATES)),
    body('data').isObject(),
    body('segment').optional().isIn(['all', 'active', 'r1_complete', 'matching_pool', 'city']),
    body('city').optional().isString(),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { type, data, segment = 'all', city } = req.body;

    // Non-blocking: return immediately, process in background
    res.json({
      message: `Broadcast queued for segment: ${segment}`,
      type,
      startedAt: new Date().toISOString(),
    });

    // Background processing
    setImmediate(async () => {
      try {
        let whereClause = 'WHERE u.status = $1';
        const params = ['active'];

        if (segment === 'r1_complete') {
          whereClause += ' AND u.r1_complete = true';
        } else if (segment === 'matching_pool') {
          whereClause += ' AND p.matching_pool = true';
        } else if (segment === 'city' && city) {
          whereClause += ` AND p.city ILIKE $${params.length + 1}`;
          params.push(`%${city}%`);
        }

        const usersResult = await pool.query(
          `SELECT u.id FROM users u
           LEFT JOIN profiles p ON p.user_id = u.id
           ${whereClause} LIMIT 5000`,
          params
        );

        console.log(`[Broadcast] Sending ${type} to ${usersResult.rows.length} users...`);
        let sent = 0;
        for (const user of usersResult.rows) {
          await notify(user.id, type, data).catch(() => {});
          sent++;
          // Rate limit: don't hammer the DB
          if (sent % 50 === 0) await new Promise(r => setTimeout(r, 100));
        }
        console.log(`[Broadcast] Complete — sent to ${sent} users`);
      } catch (err) {
        console.error('[Broadcast] Error:', err);
      }
    });
  }
);

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const notifRoutes = require('./notification-routes');
//  app.use('/api/notifications', notifRoutes);
//
//  ALSO integrate into match-routes.js after creating a match:
//  const { notify, notifyPair } = require('../notification-service');
//
//  // After creating a match in processUserMatching():
//  await notifyPair(userAId, userBId, 'new_match',
//    { matchId, score: match.score, expiryHours: 72, sharedValues: summary.shared_values },
//    { matchId, score: match.score, expiryHours: 72, sharedValues: summary.shared_values }
//  );
//
//  // After final scoring (approved):
//  if (approved) {
//    await notifyPair(userAId, userBId, 'match_approved',
//      { matchId, combinedScore, sharedValues: summary.shared_values },
//      { matchId, combinedScore, sharedValues: summary.shared_values }
//    );
//  } else {
//    await notifyPair(userAId, userBId, 'match_declined', { matchId }, { matchId });
//  }
//
//  // After Stripe payment (Step 8):
//  await notify(payingUserId, 'messaging_unlocked', { matchId, partnerFirstName });
//  await notify(otherUserId,  'messaging_unlocked', { matchId, partnerFirstName: myFirstName });
// ══════════════════════════════════════════════════════════════
