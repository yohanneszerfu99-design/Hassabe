// ═══════════════════════════════════════════════════════════════
//  HASSABE — Chat REST Routes  (Step 9)
//  File: chat-routes.js
//
//  Routes:
//   GET  /api/chat/:matchId/messages       — paginated message history
//   GET  /api/chat/:matchId/icebreakers    — AI icebreakers for this match
//   POST /api/chat/:matchId/voice          — upload voice note (non-streaming)
//   PUT  /api/chat/:matchId/read           — mark messages read (REST fallback)
//   GET  /api/chat/:matchId/status         — conversation status + expiry info
//   POST /api/chat/messages/:msgId/report  — report a message
//   GET  /api/chat/admin/active            — admin: active conversations
//   POST /api/chat/admin/close/:matchId    — admin: force-close conversation
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { param, body, query, validationResult } = require('express-validator');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) {
      return cb(new Error('Only audio files are allowed'));
    }
    cb(null, true);
  },
});

// ── Auth middleware ──
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
      issuer: 'hassabe.com', audience: 'hassabe-api',
    });
    const r = await pool.query(
      'SELECT id, name, email, status FROM users WHERE id = $1', [payload.sub]
    );
    if (!r.rows[0] || r.rows[0].status !== 'active') {
      return res.status(401).json({ error: 'Account not found' });
    }
    req.user = r.rows[0];
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const r = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows[0]?.is_admin) return res.status(403).json({ error: 'Admin required' });
    next();
  });
}

// ── Access guard: verify user can access this conversation ──
async function requireConversationAccess(req, res, matchId, userId) {
  const result = await pool.query(`
    SELECT id, status, expires_at, user_a_id, user_b_id
    FROM matches WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
  `, [matchId, userId]);

  if (!result.rows[0]) { res.status(404).json({ error: 'Conversation not found' }); return null; }
  const m = result.rows[0];
  if (m.status !== 'messaging_unlocked') {
    res.status(403).json({ error: 'This conversation is not unlocked.', status: m.status });
    return null;
  }
  if (m.expires_at && new Date(m.expires_at) < new Date()) {
    res.status(410).json({ error: 'This conversation has expired.' });
    return null;
  }
  const partnerId = m.user_a_id === userId ? m.user_b_id : m.user_a_id;
  return { ...m, partnerId };
}

function checkValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

const msgLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120 });
const voiceLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// ══════════════════════════════════════════════════════════════
//  GET /api/chat/:matchId/messages — Paginated history
// ══════════════════════════════════════════════════════════════
router.get('/:matchId/messages',
  requireAuth,
  msgLimiter,
  [
    param('matchId').isUUID(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isUUID(),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const access = await requireConversationAccess(req, res, req.params.matchId, req.user.id);
    if (!access) return;

    const limit  = parseInt(req.query.limit || 50);
    const before = req.query.before || null;

    try {
      const result = await pool.query(`
        SELECT
          m.id, m.match_id, m.sender_id,
          m.content, m.type,
          m.voice_url, m.voice_duration_s,
          m.sent_at, m.read_at, m.client_msg_id,
          p.first_name AS sender_name
        FROM messages m
        LEFT JOIN profiles p ON p.user_id = m.sender_id
        WHERE m.match_id = $1
          AND ($2::uuid IS NULL OR m.sent_at < (
            SELECT sent_at FROM messages WHERE id = $2::uuid
          ))
        ORDER BY m.sent_at DESC
        LIMIT $3
      `, [req.params.matchId, before, limit]);

      const messages = result.rows.reverse();
      const hasMore  = result.rows.length === limit;

      // Mark partner's unread messages as read
      await pool.query(`
        UPDATE messages SET read_at = now()
        WHERE match_id = $1 AND sender_id = $2 AND read_at IS NULL
      `, [req.params.matchId, access.partnerId]);

      res.json({ messages, hasMore, partnerId: access.partnerId });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/chat/:matchId/icebreakers — AI icebreakers
// ══════════════════════════════════════════════════════════════
router.get('/:matchId/icebreakers',
  requireAuth,
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const access = await requireConversationAccess(req, res, req.params.matchId, req.user.id);
    if (!access) return;

    try {
      const result = await pool.query(
        'SELECT icebreakers, combined_score, shared_values FROM matches WHERE id = $1',
        [req.params.matchId]
      );

      const match = result.rows[0];
      res.json({
        icebreakers:  match?.icebreakers || [],
        combinedScore: match?.combined_score,
        sharedValues: match?.shared_values || [],
      });
    } catch {
      res.status(500).json({ error: 'Failed to fetch icebreakers' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/chat/:matchId/voice — Upload voice note (REST fallback)
//  Used when the WebSocket streaming approach isn't available (older clients)
// ══════════════════════════════════════════════════════════════
router.post('/:matchId/voice',
  requireAuth,
  voiceLimiter,
  upload.single('audio'),
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const durationS = parseFloat(req.body.duration_s || 0);
    if (durationS > 120) return res.status(400).json({ error: 'Voice notes must be under 2 minutes' });

    const access = await requireConversationAccess(req, res, req.params.matchId, req.user.id);
    if (!access) return;

    try {
      // Upload to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: `hassabe/voice/${req.params.matchId}`,
            format: 'mp3',
            transformation: [{ quality: 'auto:low' }],
          },
          (error, result) => error ? reject(error) : resolve(result)
        );
        stream.end(req.file.buffer);
      });

      const msg = await pool.query(`
        INSERT INTO messages
          (match_id, sender_id, content, type, voice_url, voice_duration_s)
        VALUES ($1, $2, $3, 'voice', $4, $5)
        RETURNING id, sent_at
      `, [
        req.params.matchId,
        req.user.id,
        `[Voice note — ${Math.round(durationS)}s]`,
        uploadResult.secure_url,
        Math.round(durationS),
      ]);

      res.status(201).json({
        message: {
          id:            msg.rows[0].id,
          matchId:       req.params.matchId,
          senderId:      req.user.id,
          type:          'voice',
          voiceUrl:      uploadResult.secure_url,
          voiceDuration: Math.round(durationS),
          sentAt:        msg.rows[0].sent_at,
        },
      });
    } catch (err) {
      console.error('Voice upload error:', err);
      res.status(500).json({ error: 'Voice upload failed. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  PUT /api/chat/:matchId/read — Mark messages read (REST fallback)
// ══════════════════════════════════════════════════════════════
router.put('/:matchId/read',
  requireAuth,
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const access = await requireConversationAccess(req, res, req.params.matchId, req.user.id);
    if (!access) return;

    try {
      const result = await pool.query(`
        UPDATE messages SET read_at = now()
        WHERE match_id = $1 AND sender_id = $2 AND read_at IS NULL
        RETURNING id
      `, [req.params.matchId, access.partnerId]);

      res.json({ markedRead: result.rowCount });
    } catch {
      res.status(500).json({ error: 'Failed to mark messages read' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/chat/:matchId/status — Conversation status & expiry
// ══════════════════════════════════════════════════════════════
router.get('/:matchId/status',
  requireAuth,
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const result = await pool.query(`
        SELECT
          m.status, m.expires_at, m.messaging_unlocked_at,
          m.combined_score, m.shared_values,
          EXTRACT(EPOCH FROM (m.expires_at - now())) / 86400 AS days_remaining,
          (SELECT COUNT(*) FROM messages WHERE match_id = m.id) AS message_count,
          (SELECT COUNT(*) FROM messages WHERE match_id = m.id
             AND sender_id != $2 AND read_at IS NULL) AS unread_count,
          p.first_name AS partner_name,
          p.city AS partner_city,
          p.profession AS partner_profession,
          (SELECT url FROM profile_photos ph WHERE ph.profile_id = p.id
             ORDER BY ph.position LIMIT 1) AS partner_photo
        FROM matches m
        JOIN profiles p ON p.user_id = (
          CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
        )
        WHERE m.id = $1 AND (m.user_a_id = $2 OR m.user_b_id = $2)
      `, [req.params.matchId, req.user.id]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Conversation not found' });
      const m = result.rows[0];

      res.json({
        status:              m.status,
        isActive:            m.status === 'messaging_unlocked',
        isExpired:           m.status === 'expired' || (m.expires_at && new Date(m.expires_at) < new Date()),
        expiresAt:           m.expires_at,
        daysRemaining:       m.days_remaining ? Math.max(0, Math.ceil(m.days_remaining)) : null,
        messagingUnlockedAt: m.messaging_unlocked_at,
        messageCount:        parseInt(m.message_count),
        unreadCount:         parseInt(m.unread_count),
        combinedScore:       m.combined_score,
        sharedValues:        m.shared_values || [],
        partner: {
          name:      m.partner_name,
          city:      m.partner_city,
          profession: m.partner_profession,
          photo:     m.partner_photo,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get conversation status' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/chat/messages/:msgId/report — Report a message
// ══════════════════════════════════════════════════════════════
router.post('/messages/:msgId/report',
  requireAuth,
  [
    param('msgId').isUUID(),
    body('reason').isIn(['harassment', 'inappropriate_content', 'spam', 'other']),
    body('details').optional().isString().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const msgResult = await pool.query(
        'SELECT match_id, sender_id FROM messages WHERE id = $1',
        [req.params.msgId]
      );
      if (!msgResult.rows[0]) return res.status(404).json({ error: 'Message not found' });

      const matchId = msgResult.rows[0].match_id;
      const access  = await requireConversationAccess(req, res, matchId, req.user.id);
      if (!access) return;

      await pool.query(`
        INSERT INTO message_reports (message_id, reporter_id, reason, details)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (message_id, reporter_id) DO UPDATE SET
          reason = EXCLUDED.reason, details = EXCLUDED.details
      `, [req.params.msgId, req.user.id, req.body.reason, req.body.details || null]);

      res.json({ message: 'Report submitted. Our team will review within 24 hours.' });
    } catch {
      res.status(500).json({ error: 'Report failed' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/chat/admin/active — Admin: list active conversations
// ══════════════════════════════════════════════════════════════
router.get('/admin/active', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id, m.combined_score, m.messaging_unlocked_at, m.expires_at,
        pa.first_name || ' ' || LEFT(pa.last_name,1) || '.' AS name_a,
        pb.first_name || ' ' || LEFT(pb.last_name,1) || '.' AS name_b,
        (SELECT COUNT(*) FROM messages WHERE match_id = m.id) AS message_count,
        (SELECT COUNT(*) FROM message_reports mr
           JOIN messages msg ON msg.id = mr.message_id
           WHERE msg.match_id = m.id AND mr.reviewed = false) AS unreviewed_reports,
        EXTRACT(EPOCH FROM (m.expires_at - now())) / 86400 AS days_left
      FROM matches m
      JOIN profiles pa ON pa.user_id = m.user_a_id
      JOIN profiles pb ON pb.user_id = m.user_b_id
      WHERE m.status = 'messaging_unlocked'
      ORDER BY unreviewed_reports DESC, m.messaging_unlocked_at DESC
      LIMIT 100
    `);

    res.json({ conversations: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/chat/admin/close/:matchId — Admin force-close
// ══════════════════════════════════════════════════════════════
router.post('/admin/close/:matchId',
  requireAdmin,
  [param('matchId').isUUID(), body('reason').notEmpty()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    await pool.query(
      `UPDATE matches SET status = 'expired', admin_note = $1, updated_at = now() WHERE id = $2`,
      [req.body.reason, req.params.matchId]
    );
    res.json({ message: 'Conversation closed.' });
  }
);

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const chatRoutes = require('./chat-routes');
//  app.use('/api/chat', chatRoutes);
// ══════════════════════════════════════════════════════════════
