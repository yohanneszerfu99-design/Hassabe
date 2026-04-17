// ═══════════════════════════════════════════════════════════════
//  HASSABE — Match API Routes + Scheduler  (Step 5)
//  File: match-routes.js
//
//  Routes:
//   GET  /api/matches                  — get my active matches
//   GET  /api/matches/:id              — match detail + compatibility breakdown
//   GET  /api/matches/:id/compatibility — full score breakdown
//   POST /api/matches/:id/trigger-scoring — admin: re-score a match
//   POST /api/matches/:id/report       — report a match
//   POST /api/matches/:id/archive      — archive / withdraw from match
//   GET  /api/matches/admin/queue      — admin: full match queue
//   POST /api/matches/admin/override   — admin: approve or decline manually
//   GET  /api/matches/admin/stats      — admin: engine statistics
//
//  Scheduler:
//   Sets up a nightly cron job at 2 AM to run the matching engine.
//   Also exposes a manual trigger endpoint for admin use.
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const cron       = require('node-cron');
const rateLimit  = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');

const {
  runMatchingEngine,
  scoreMatchPair,
  computeFinalScore,
  CONFIG,
} = require('../matching-engine');

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
    const result = await pool.query('SELECT id, name, email, status FROM users WHERE id = $1', [payload.sub]);
    if (!result.rows[0] || result.rows[0].status !== 'active') {
      return res.status(401).json({ error: 'Account not found' });
    }
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Admin auth middleware ──
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0]?.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function checkValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

// ── Rate limiter ──
const matchLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// ══════════════════════════════════════════════════════════════
//  GET /api/matches — Get my active matches
// ══════════════════════════════════════════════════════════════
router.get('/', requireAuth, matchLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id,
        m.r1_score,
        m.combined_score,
        m.status,
        m.score_breakdown,
        m.compatibility_summary,
        m.shared_values,
        m.icebreakers,
        m.r2_expires_at,
        m.messaging_unlocked_at,
        m.unlocked_by_user_id,
        m.expires_at,
        m.created_at,

        -- Identify which user is the "other" person
        CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END AS other_user_id,

        -- Limited profile fields for match card (full revealed after R2)
        p.first_name,
        p.city, p.country,
        p.profession,
        p.religion,
        p.practice_level,
        p.relationship_goal,
        p.profile_score,
        p.is_verified,
        date_part('year', age(p.date_of_birth))::int AS age,

        -- No photos in this version
        NULL AS photo_url,

        -- R2 completion status
        CASE WHEN m.user_a_id = $1 THEN m.r2_a_completed_at ELSE m.r2_b_completed_at END AS my_r2_completed_at,
        CASE WHEN m.user_a_id = $1 THEN m.r2_b_completed_at ELSE m.r2_a_completed_at END AS their_r2_completed_at

      FROM matches m
      JOIN profiles p ON p.user_id = (
        CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
      )
      WHERE
        (m.user_a_id = $1 OR m.user_b_id = $1)
        AND m.status NOT IN ('expired')
      ORDER BY
        CASE m.status
          WHEN 'messaging_unlocked' THEN 1
          WHEN 'approved'           THEN 2
          WHEN 'scoring_r2'         THEN 3
          WHEN 'pending_r2'         THEN 4
          WHEN 'notified'           THEN 5
          WHEN 'declined'           THEN 6
          ELSE 7
        END,
        m.r1_score DESC
    `, [req.user.id]);

    // Map response — hide full name until messaging unlocked
    const matches = result.rows.map(m => ({
      id:                  m.id,
      score:               m.r1_score,
      combinedScore:       m.combined_score,
      status:              m.status,
      scoreBreakdown:      m.score_breakdown,
      compatibilitySummary:m.compatibility_summary,
      sharedValues:        m.shared_values,
      icebreakers:         m.status === 'messaging_unlocked' ? m.icebreakers : [],
      r2ExpiresAt:         m.r2_expires_at,
      messagingUnlockedAt: m.messaging_unlocked_at,
      unlockedBy:          m.unlocked_by_user_id,
      expiresAt:           m.expires_at,
      matchedAt:           m.created_at,
      myR2Complete:        !!m.my_r2_completed_at,
      theirR2Complete:     !!m.their_r2_completed_at,
      person: {
        userId:           m.other_user_id,
        // First name only until unlocked; never expose last name before messaging
        firstName:        m.first_name,
        age:              m.age,
        city:             m.city,
        country:          m.country,
        profession:       m.profession,
        religion:         m.religion,
        practiceLevel:    m.practice_level,
        relationshipGoal: m.relationship_goal,
        profileScore:     m.profile_score,
        isVerified:       m.is_verified,
        photoUrl:         m.photo_url,
      },
    }));

    res.json({ matches, count: matches.length });
  } catch (err) {
    console.error('Get matches error:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/matches/:id — Full match detail
// ══════════════════════════════════════════════════════════════
router.get('/:id',
  requireAuth,
  [param('id').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const result = await pool.query(`
        SELECT m.*,
          CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END AS other_user_id,
          p.first_name, p.last_name, p.date_of_birth, p.city, p.country,
          p.profession, p.industry, p.education_level,
          p.religion, p.practice_level, p.relationship_goal,
          p.ethnicity, p.languages, p.children_preference,
          p.heritage_strength, p.open_to_relocation,
          p.bio, p.profile_score, p.is_verified,
          ARRAY[]::text[] AS photos,
          CASE WHEN m.user_a_id = $2 THEN m.r2_a_completed_at ELSE m.r2_b_completed_at END AS my_r2_at,
          CASE WHEN m.user_a_id = $2 THEN m.r2_b_completed_at ELSE m.r2_a_completed_at END AS their_r2_at
        FROM matches m
        JOIN profiles p ON p.user_id = (
          CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
        )
        WHERE m.id = $1
          AND (m.user_a_id = $2 OR m.user_b_id = $2)
        GROUP BY m.id, p.id
      `, [req.params.id, req.user.id]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Match not found' });
      const m = result.rows[0];

      // Reveal full profile only after approved/unlocked
      const isUnlocked    = m.status === 'messaging_unlocked';
      const isApproved    = ['approved', 'messaging_unlocked'].includes(m.status);
      const myR2Complete  = !!m.my_r2_at;
      const age           = m.date_of_birth
        ? Math.floor((Date.now() - new Date(m.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000))
        : null;

      res.json({
        match: {
          id:                   m.id,
          score:                m.r1_score,
          combinedScore:        m.combined_score,
          status:               m.status,
          scoreBreakdown:       m.score_breakdown,
          compatibilitySummary: m.compatibility_summary,
          sharedValues:         m.shared_values,
          icebreakers:          isUnlocked ? m.icebreakers : null,
          frictionPoints:       null, // never exposed to users
          r2ExpiresAt:          m.r2_expires_at,
          messagingUnlockedAt:  m.messaging_unlocked_at,
          unlockedBy:           m.unlocked_by_user_id,
          expiresAt:            m.expires_at,
          matchedAt:            m.created_at,
          myR2Complete,
          theirR2Complete:      !!m.their_r2_at,
          adminOverride:        m.admin_override,

          person: {
            userId:           m.other_user_id,
            firstName:        m.first_name,
            lastName:         isUnlocked ? m.last_name : null,
            age,
            city:             m.city,
            country:          m.country,
            profession:       m.profession,
            industry:         isApproved ? m.industry        : null,
            educationLevel:   isApproved ? m.education_level : null,
            religion:         m.religion,
            practiceLevel:    m.practice_level,
            relationshipGoal: m.relationship_goal,
            ethnicity:        m.ethnicity,
            languages:        m.languages,
            childrenPreference: isApproved ? m.children_preference  : null,
            heritageStrength:   isApproved ? m.heritage_strength     : null,
            openToRelocation:   isApproved ? m.open_to_relocation    : null,
            bio:              isApproved ? m.bio          : null,
            profileScore:     m.profile_score,
            isVerified:       m.is_verified,
            photos:           m.photos || [],
          },
        },
      });
    } catch (err) {
      console.error('Get match detail error:', err);
      res.status(500).json({ error: 'Failed to fetch match' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/matches/:id/compatibility — Full score breakdown
// ══════════════════════════════════════════════════════════════
router.get('/:id/compatibility',
  requireAuth,
  [param('id').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const result = await pool.query(`
        SELECT r1_score, r2_score, combined_score, score_breakdown,
               compatibility_summary, shared_values, status
        FROM matches
        WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
      `, [req.params.id, req.user.id]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Match not found' });
      const m = result.rows[0];

      res.json({
        r1Score:         m.r1_score,
        r2Score:         m.r2_score,
        combinedScore:   m.combined_score,
        breakdown:       m.score_breakdown,
        summary:         m.compatibility_summary,
        sharedValues:    m.shared_values,
        status:          m.status,
        thresholds: {
          r1Threshold:       CONFIG.MATCH_THRESHOLD,
          finalThreshold:    CONFIG.FINAL_THRESHOLD,
          r1Weight:          CONFIG.R1_FINAL_WEIGHT,
          r2Weight:          CONFIG.R2_FINAL_WEIGHT,
        },
        dimensionWeights:  CONFIG.R1_WEIGHTS,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch compatibility details' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/matches/:id/report — Report a match
// ══════════════════════════════════════════════════════════════
router.post('/:id/report',
  requireAuth,
  [
    param('id').isUUID(),
    body('reason').isIn(['inappropriate_content','fake_profile','harassment','other']),
    body('details').optional().isString().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      // Verify user is part of this match
      const match = await pool.query(
        'SELECT id FROM matches WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)',
        [req.params.id, req.user.id]
      );
      if (!match.rows[0]) return res.status(404).json({ error: 'Match not found' });

      await pool.query(`
        INSERT INTO match_reports (match_id, reporter_id, reason, details)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (match_id, reporter_id) DO UPDATE SET
          reason = EXCLUDED.reason, details = EXCLUDED.details, updated_at = now()
      `, [req.params.id, req.user.id, req.body.reason, req.body.details || null]);

      // Auto-flag the match for admin review
      await pool.query(
        `UPDATE matches SET status = 'flagged', updated_at = now() WHERE id = $1`,
        [req.params.id]
      );

      res.json({ message: 'Report submitted. Our team will review within 24 hours.' });
    } catch (err) {
      res.status(500).json({ error: 'Report submission failed' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/matches/:id/archive — Withdraw from a match
// ══════════════════════════════════════════════════════════════
router.post('/:id/archive', requireAuth, [param('id').isUUID()], async (req, res) => {
  const err = checkValidation(req, res);
  if (err) return;

  try {
    await pool.query(`
      UPDATE matches SET status = 'expired', updated_at = now()
      WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
        AND status NOT IN ('messaging_unlocked', 'declined', 'expired')
    `, [req.params.id, req.user.id]);

    res.json({ message: 'Match archived.' });
  } catch (err) {
    res.status(500).json({ error: 'Archive failed' });
  }
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/matches/admin/queue — Full match queue for admin
router.get('/admin/queue', requireAdmin, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const whereClause = status ? `WHERE m.status = $3` : '';
    const params = status
      ? [parseInt(limit), offset, status]
      : [parseInt(limit), offset];

    const result = await pool.query(`
      SELECT
        m.id, m.r1_score, m.r2_score, m.combined_score, m.status,
        m.score_breakdown, m.admin_override, m.admin_note, m.created_at,
        p_a.first_name AS name_a, p_a.profession AS prof_a,
        p_b.first_name AS name_b, p_b.profession AS prof_b,
        m.r2_a_completed_at, m.r2_b_completed_at,
        m.compatibility_summary,
        (SELECT COUNT(*) FROM match_reports WHERE match_id = m.id) AS report_count
      FROM matches m
      JOIN profiles p_a ON p_a.user_id = m.user_a_id
      JOIN profiles p_b ON p_b.user_id = m.user_b_id
      ${whereClause}
      ORDER BY
        CASE m.status WHEN 'flagged' THEN 1 WHEN 'scoring_r2' THEN 2 ELSE 3 END,
        m.combined_score DESC NULLS LAST,
        m.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM matches ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({
      matches:    result.rows,
      total:      parseInt(countResult.rows[0].count),
      page:       parseInt(page),
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch match queue' });
  }
});

// POST /api/matches/admin/override — Admin approve or decline
router.post('/admin/override',
  requireAdmin,
  [
    body('matchId').isUUID(),
    body('action').isIn(['approve', 'decline', 'rescore']),
    body('note').optional().isString().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { matchId, action, note } = req.body;

    try {
      if (action === 'rescore') {
        const scoreResult = await scoreMatchPair(
          (await pool.query('SELECT user_a_id FROM matches WHERE id = $1', [matchId])).rows[0]?.user_a_id,
          (await pool.query('SELECT user_b_id FROM matches WHERE id = $1', [matchId])).rows[0]?.user_b_id,
        );
        return res.json({ message: 'Match re-scored.', result: scoreResult });
      }

      const newStatus = action === 'approve' ? 'approved' : 'declined';
      await pool.query(`
        UPDATE matches SET
          status         = $1,
          admin_override = true,
          admin_note     = $2,
          updated_at     = now()
        WHERE id = $3
      `, [newStatus, note || null, matchId]);

      res.json({ message: `Match ${action}d by admin.`, matchId, status: newStatus });
    } catch (err) {
      res.status(500).json({ error: 'Override failed' });
    }
  }
);

// GET /api/matches/admin/stats — Engine statistics
router.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [statusResult, scoreResult, engineResult] = await Promise.all([
      pool.query(`
        SELECT status, COUNT(*) AS count
        FROM matches GROUP BY status ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          AVG(r1_score)::numeric(5,1)       AS avg_r1,
          AVG(combined_score)::numeric(5,1) AS avg_combined,
          MIN(r1_score)::numeric(5,1)       AS min_r1,
          MAX(r1_score)::numeric(5,1)       AS max_r1,
          COUNT(*) FILTER (WHERE status = 'messaging_unlocked') AS unlocked,
          COUNT(*) FILTER (WHERE status = 'declined')           AS declined,
          COUNT(*) FILTER (WHERE admin_override = true)         AS overridden
        FROM matches
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE matching_pool = true) AS in_pool,
          COUNT(*) FILTER (WHERE r1_complete = true)   AS r1_done,
          COUNT(*) FILTER (WHERE profile_complete = true) AS profiles_complete,
          COUNT(*) AS total
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.status = 'active'
      `),
    ]);

    res.json({
      matchesByStatus: statusResult.rows,
      scoring:         scoreResult.rows[0],
      pool:            engineResult.rows[0],
      thresholds:      { match: CONFIG.MATCH_THRESHOLD, final: CONFIG.FINAL_THRESHOLD },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/matches/admin/run-engine — Manually trigger the matching engine
router.post('/admin/run-engine', requireAdmin, async (req, res) => {
  const { dryRun = false, userId = null } = req.body;

  // Non-blocking: start engine and return immediately
  res.json({
    message: `Matching engine started (${dryRun ? 'dry run' : 'live'}).`,
    startedAt: new Date().toISOString(),
  });

  // Run in background
  runMatchingEngine({ dryRun, userId })
    .then(stats => console.log('[Admin] Engine run complete:', stats))
    .catch(err  => console.error('[Admin] Engine run failed:', err));
});

// POST /api/matches/admin/final-score/:matchId — Trigger R1+R2 combined scoring
router.post('/admin/final-score/:matchId', requireAdmin, [param('matchId').isUUID()], async (req, res) => {
  const err = checkValidation(req, res);
  if (err) return;

  try {
    const result = await computeFinalScore(req.params.matchId);
    res.json({ message: 'Final scoring complete.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  SCHEDULER SETUP
//  Call setupScheduler(app) in your server.js after mounting routes.
//  Requires: npm install node-cron
// ══════════════════════════════════════════════════════════════

function setupScheduler() {
  // Run matching engine nightly at 2:00 AM server time
  cron.schedule('0 2 * * *', async () => {
    console.log('\n[Scheduler] Nightly matching engine starting...');
    try {
      const stats = await runMatchingEngine({ dryRun: false });
      console.log('[Scheduler] Nightly run complete:', stats);
    } catch (err) {
      console.error('[Scheduler] Nightly run failed:', err);
    }
  });

  // Expire old R2 windows every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await pool.query(`
        UPDATE matches
        SET status = 'expired', updated_at = now()
        WHERE status = 'pending_r2'
          AND r2_expires_at < now()
      `);
      if (result.rowCount > 0) {
        console.log(`[Scheduler] Expired ${result.rowCount} R2 timeouts`);
      }
    } catch (err) {
      console.error('[Scheduler] Expiry job failed:', err);
    }
  });

  // Expire unlocked conversations after 30 days
  cron.schedule('0 3 * * *', async () => {
    try {
      await pool.query(`
        UPDATE matches
        SET status = 'expired', updated_at = now()
        WHERE status = 'messaging_unlocked'
          AND expires_at < now()
      `);
    } catch (err) {
      console.error('[Scheduler] Conversation expiry job failed:', err);
    }
  });

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  → Matching engine:       daily at 02:00');
  console.log('  → R2 expiry cleanup:     every hour');
  console.log('  → Conversation expiry:   daily at 03:00');
}

module.exports.setupScheduler = setupScheduler;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const matchRoutes             = require('./match-routes');
//  const { setupScheduler }      = require('./match-routes');
//  app.use('/api/matches', matchRoutes);
//  setupScheduler(); // start cron jobs
//
//  ADDITIONAL PACKAGES:
//  npm install node-cron
// ══════════════════════════════════════════════════════════════
