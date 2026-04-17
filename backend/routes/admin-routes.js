// ═══════════════════════════════════════════════════════════════
//  HASSABE — Admin API Routes  (Step 10)
//  File: admin-routes.js
//
//  All routes require is_admin = true on the user record.
//
//  Routes:
//  Users
//   GET  /api/admin/users              — paginated user list
//   GET  /api/admin/users/:id          — user detail
//   PUT  /api/admin/users/:id/suspend  — suspend account
//   PUT  /api/admin/users/:id/reinstate— reinstate account
//   PUT  /api/admin/users/:id/admin    — toggle admin flag
//   DELETE /api/admin/users/:id        — hard delete (GDPR)
//
//  Matches
//   GET  /api/admin/matches            — full match queue
//   GET  /api/admin/matches/:id        — match detail with full AI data
//   POST /api/admin/matches/:id/override — approve / decline / rescore
//   POST /api/admin/matches/:id/flag   — flag for review
//
//  Moderation
//   GET  /api/admin/reports            — unreviewed reports
//   PUT  /api/admin/reports/:id        — resolve report
//   GET  /api/admin/conversations      — active conversations
//   POST /api/admin/conversations/:id/close — force-close
//
//  Revenue
//   GET  /api/admin/revenue/summary    — totals and breakdown
//   GET  /api/admin/revenue/payments   — payment list
//   POST /api/admin/revenue/refund/:id — process refund
//
//  System
//   GET  /api/admin/stats              — dashboard stats
//   GET  /api/admin/engine/runs        — engine run history
//   POST /api/admin/engine/run         — trigger engine
//   GET  /api/admin/audit              — admin action audit log
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const Stripe   = require('stripe');
const jwt      = require('jsonwebtoken');
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { runMatchingEngine } = require('../matching-engine');
const { notify }            = require('../notification-service');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ── Admin auth middleware ──────────────────────────────────────
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
      issuer: 'hassabe.com', audience: 'hassabe-api',
    });
    const result = await pool.query(
      'SELECT id, name, email, status, is_admin FROM public.users WHERE id = $1', [payload.sub]
    );
    if (!result.rows[0]) return res.status(401).json({ error: 'Account not found' });
    if (!result.rows[0].is_admin) return res.status(403).json({ error: 'Admin access required' });
    req.admin = result.rows[0];
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── Rate limiter (admin routes don't need to be too strict) ──
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 200 });
router.use(requireAdmin, adminLimiter);

// ── Validation helper ──
function checkV(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

// ── Audit log helper ──
async function auditLog(adminId, action, targetType, targetId, detail = null) {
  await pool.query(`
    INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, detail)
    VALUES ($1, $2, $3, $4, $5)
  `, [adminId, action, targetType, targetId, detail]).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/stats — Master dashboard statistics
// ══════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const [users, matches, payments, reports, pool_status, engine] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE status = 'active')     AS active,
          COUNT(*) FILTER (WHERE r1_complete = true)    AS r1_complete,
          COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS joined_today,
          COUNT(*) FILTER (WHERE subscription_tier = 'gold') AS gold_subs
        FROM public.users
      `),
      pool.query(`
        SELECT
          COUNT(*)                                                   AS total,
          COUNT(*) FILTER (WHERE status NOT IN ('expired','declined')) AS active,
          COUNT(*) FILTER (WHERE status = 'messaging_unlocked')     AS unlocked,
          COUNT(*) FILTER (WHERE status = 'flagged')                AS flagged,
          COUNT(*) FILTER (WHERE status = 'pending_r2')             AS pending_r2,
          ROUND(AVG(r1_score), 1)                                   AS avg_r1_score,
          ROUND(AVG(combined_score) FILTER (WHERE combined_score IS NOT NULL), 1) AS avg_combined
        FROM matches
      `),
      pool.query(`
        SELECT
          SUM(amount) FILTER (WHERE status = 'succeeded')  AS gross_all_time,
          SUM(amount) FILTER (WHERE status = 'succeeded'
            AND created_at >= date_trunc('month', now()))  AS gross_mtd,
          COUNT(*) FILTER (WHERE status = 'succeeded'
            AND payment_type = 'conversation_unlock')      AS total_unlocks,
          COUNT(*) FILTER (WHERE status = 'refunded')      AS total_refunds
        FROM payments
      `),
      pool.query(`
        SELECT COUNT(*) AS open FROM match_reports WHERE reviewed = false
      `),
      pool.query(`
        SELECT COUNT(*) AS in_pool FROM profiles WHERE matching_pool = true
      `),
      pool.query(`
        SELECT started_at, duration_seconds, matches_created, errors,
          CASE
            WHEN completed_at IS NOT NULL AND (errors IS NULL OR errors = 0) THEN 'success'
            WHEN completed_at IS NOT NULL AND errors > 0 THEN 'partial'
            WHEN notes IS NOT NULL THEN 'failed'
            ELSE 'running'
          END AS status
        FROM engine_runs ORDER BY started_at DESC LIMIT 1
      `),
    ]);

    const u = users.rows[0];
    const m = matches.rows[0];
    const p = payments.rows[0];

    res.json({
      users: {
        total:      parseInt(u.total),
        active:     parseInt(u.active),
        r1Complete: parseInt(u.r1_complete),
        joinedToday:parseInt(u.joined_today),
        goldSubs:   parseInt(u.gold_subs),
        inPool:     parseInt(pool_status.rows[0].in_pool),
      },
      matches: {
        total:       parseInt(m.total),
        active:      parseInt(m.active),
        unlocked:    parseInt(m.unlocked),
        flagged:     parseInt(m.flagged),
        pendingR2:   parseInt(m.pending_r2),
        avgR1Score:  parseFloat(m.avg_r1_score || 0),
        avgCombined: parseFloat(m.avg_combined || 0),
      },
      revenue: {
        grossAllTime: parseInt(p.gross_all_time || 0),
        grossMtd:     parseInt(p.gross_mtd || 0),
        totalUnlocks: parseInt(p.total_unlocks || 0),
        totalRefunds: parseInt(p.total_refunds || 0),
      },
      openReports:  parseInt(reports.rows[0].open),
      lastEngineRun: engine.rows[0] || null,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/users — Paginated user list
// ══════════════════════════════════════════════════════════════
router.get('/users',
  [query('page').optional().isInt({min:1}), query('limit').optional().isInt({min:1,max:100}), query('q').optional().isString()],
  async (req, res) => {
    const page   = parseInt(req.query.page  || 1);
    const limit  = parseInt(req.query.limit || 25);
    const q      = req.query.q?.trim() || null;
    const status = req.query.status || null;
    const offset = (page - 1) * limit;

    try {
      const where  = [];
      const params = [];
      let   pi     = 1;

      if (q) {
        where.push(`(u.email ILIKE $${pi} OR p.first_name ILIKE $${pi} OR p.last_name ILIKE $${pi} OR p.city ILIKE $${pi})`);
        params.push(`%${q}%`); pi++;
      }
      if (status) { where.push(`u.status = $${pi}`); params.push(status); pi++; }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const result = await pool.query(`
        SELECT
          u.id, u.email, u.status, u.r1_complete, u.profile_complete,
          u.subscription_tier, u.created_at, u.is_admin,
          p.first_name, p.last_name, p.city, p.country,
          p.religion, p.profile_score, p.matching_pool,
          p.relationship_goal,
          (SELECT COUNT(*) FROM matches m WHERE m.user_a_id = u.id OR m.user_b_id = u.id) AS match_count,
          (SELECT COUNT(*) FROM payments py WHERE py.user_id = u.id AND py.status = 'succeeded') AS payment_count
        FROM public.users u
        LEFT JOIN profiles p ON p.user_id = u.id
        ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT $${pi} OFFSET $${pi+1}
      `, [...params, limit, offset]);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM public.users u LEFT JOIN profiles p ON p.user_id = u.id ${whereClause}`,
        params
      );

      res.json({
        users: result.rows,
        total: parseInt(countResult.rows[0].count),
        page, limit,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/users/:id — User detail
// ══════════════════════════════════════════════════════════════
router.get('/users/:id', [param('id').isUUID()], async (req, res) => {
  const err = checkV(req, res); if (err) return;
  try {
    const [userResult, matchResult, paymentResult, qResult] = await Promise.all([
      pool.query(`
        SELECT u.*, p.*,
          date_part('year', age(p.date_of_birth))::int AS age,
          ARRAY[]::text[] AS photos
        FROM public.users u
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1 GROUP BY u.id, p.id
      `, [req.params.id]),
      pool.query(`
        SELECT m.id, m.r1_score, m.combined_score, m.status, m.created_at,
          CASE WHEN m.user_a_id = $1 THEN pb.first_name ELSE pa.first_name END AS partner_name
        FROM matches m
        JOIN profiles pa ON pa.user_id = m.user_a_id
        JOIN profiles pb ON pb.user_id = m.user_b_id
        WHERE m.user_a_id = $1 OR m.user_b_id = $1
        ORDER BY m.created_at DESC LIMIT 10
      `, [req.params.id]),
      pool.query(
        'SELECT id, amount, payment_type, status, created_at FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
        [req.params.id]
      ),
      pool.query(
        `SELECT round, completed_at, status, dimension_scores, narrative_text
         FROM questionnaire_responses WHERE user_id = $1 ORDER BY round, created_at DESC`,
        [req.params.id]
      ),
    ]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: userResult.rows[0], matches: matchResult.rows, payments: paymentResult.rows, questionnaires: qResult.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/admin/users/:id/suspend
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/suspend',
  [param('id').isUUID(), body('reason').notEmpty().isLength({max:500})],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    // Prevent self-suspension
    if (req.params.id === req.admin.id) return res.status(400).json({ error: 'Cannot suspend your own account' });
    try {
      await pool.query(
        `UPDATE public.users SET status = 'suspended', updated_at = now() WHERE id = $1 AND is_admin = false`,
        [req.params.id]
      );
      await pool.query(
        `UPDATE profiles SET matching_pool = false, is_visible = false WHERE user_id = $1`,
        [req.params.id]
      );
      await auditLog(req.admin.id, 'suspend_user', 'user', req.params.id, req.body.reason);
      res.json({ message: 'Account suspended.' });
    } catch (err) { res.status(500).json({ error: 'Suspend failed' }); }
  }
);

// ══════════════════════════════════════════════════════════════
//  PUT /api/admin/users/:id/reinstate
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/reinstate', [param('id').isUUID()], async (req, res) => {
  const err = checkV(req, res); if (err) return;
  try {
    await pool.query(
      `UPDATE public.users SET status = 'active', updated_at = now() WHERE id = $1`, [req.params.id]
    );
    await pool.query(
      `UPDATE profiles SET is_visible = true WHERE user_id = $1 AND profile_score >= 70`, [req.params.id]
    );
    await auditLog(req.admin.id, 'reinstate_user', 'user', req.params.id);
    res.json({ message: 'Account reinstated.' });
  } catch { res.status(500).json({ error: 'Reinstate failed' }); }
});

// ══════════════════════════════════════════════════════════════
//  DELETE /api/admin/users/:id — GDPR hard delete
// ══════════════════════════════════════════════════════════════
router.delete('/users/:id',
  [param('id').isUUID(), body('confirm').equals('DELETE')],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    if (req.params.id === req.admin.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    try {
      // Anonymise rather than delete (preserves match integrity for the other user)
      await pool.query(`
        UPDATE public.users SET
          email     = 'deleted-' || id || '@deleted.hassabe',
          name      = 'Deleted User',
          status    = 'deleted',
          updated_at = now()
        WHERE id = $1
      `, [req.params.id]);
      await pool.query(`
        UPDATE profiles SET
          first_name = 'Deleted', last_name = 'User',
          bio = NULL, city = NULL,
          is_visible = false, matching_pool = false
        WHERE user_id = $1
      `, [req.params.id]);
      await auditLog(req.admin.id, 'delete_user', 'user', req.params.id, 'GDPR deletion');
      res.json({ message: 'User data anonymised (GDPR compliant).' });
    } catch { res.status(500).json({ error: 'Deletion failed' }); }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/matches — Full match queue
// ══════════════════════════════════════════════════════════════
router.get('/matches',
  [query('status').optional().isString(), query('page').optional().isInt({min:1})],
  async (req, res) => {
    const page   = parseInt(req.query.page || 1);
    const limit  = 25;
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    try {
      const result = await pool.query(`
        SELECT
          m.id, m.r1_score, m.r2_score, m.combined_score, m.status,
          m.score_breakdown, m.admin_override, m.admin_note,
          m.r2_expires_at, m.created_at, m.messaging_unlocked_at,
          m.r2_a_completed_at, m.r2_b_completed_at,
          pa.first_name AS name_a, pa.city AS city_a,
          pb.first_name AS name_b, pb.city AS city_b,
          m.compatibility_summary,
          (SELECT COUNT(*) FROM match_reports mr WHERE mr.match_id = m.id AND mr.reviewed = false) AS open_reports
        FROM matches m
        JOIN profiles pa ON pa.user_id = m.user_a_id
        JOIN profiles pb ON pb.user_id = m.user_b_id
        ${status ? 'WHERE m.status = $3' : ''}
        ORDER BY
          CASE m.status WHEN 'flagged' THEN 1 WHEN 'scoring_r2' THEN 2 WHEN 'pending_r2' THEN 3 ELSE 4 END,
          m.combined_score DESC NULLS LAST, m.created_at DESC
        LIMIT $1 OFFSET $2
      `, status ? [limit, offset, status] : [limit, offset]);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM matches ${status ? 'WHERE status = $1' : ''}`,
        status ? [status] : []
      );

      res.json({ matches: result.rows, total: parseInt(countResult.rows[0].count), page });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch matches' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/matches/:id/override
// ══════════════════════════════════════════════════════════════
router.post('/matches/:id/override',
  [
    param('id').isUUID(),
    body('action').isIn(['approve','decline','flag','unflag','rescore']),
    body('note').optional().isString().isLength({max:500}),
  ],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    const { action, note } = req.body;
    try {
      const statusMap = { approve:'approved', decline:'declined', flag:'flagged', unflag:'notified' };
      if (action === 'rescore') {
        const { runFinalScoring } = require('./round2-routes');
        const result = await runFinalScoring(req.params.id, 'admin');
        await auditLog(req.admin.id, 'rescore_match', 'match', req.params.id);
        return res.json({ message: 'Final scoring complete.', result });
      }
      await pool.query(`
        UPDATE matches SET
          status         = $1,
          admin_override = true,
          admin_note     = $2,
          updated_at     = now()
        WHERE id = $3
      `, [statusMap[action], note || null, req.params.id]);
      await auditLog(req.admin.id, `match_${action}`, 'match', req.params.id, note);

      // Notify both users if approved/declined
      if (action === 'approve' || action === 'decline') {
        const m = await pool.query('SELECT user_a_id, user_b_id, r1_score, combined_score FROM matches WHERE id = $1', [req.params.id]);
        if (m.rows[0]) {
          const { user_a_id, user_b_id } = m.rows[0];
          const type = action === 'approve' ? 'match_approved' : 'match_declined';
          await Promise.all([
            notify(user_a_id, type, { matchId: req.params.id, combinedScore: m.rows[0].combined_score }),
            notify(user_b_id, type, { matchId: req.params.id, combinedScore: m.rows[0].combined_score }),
          ]);
        }
      }

      res.json({ message: `Match ${action}d.` });
    } catch (err) {
      res.status(500).json({ error: `Override failed: ${err.message}` });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/reports — Unreviewed reports
// ══════════════════════════════════════════════════════════════
router.get('/reports', async (req, res) => {
  try {
    const [msgReports, matchReports] = await Promise.all([
      pool.query(`
        SELECT mr.id, 'message' AS type, mr.reason, mr.details, mr.created_at,
          ru.email AS reporter_email, rp.first_name AS reporter_name,
          su.email AS subject_email,  sp.first_name AS subject_name,
          msg.content AS message_preview, msg.match_id
        FROM message_reports mr
        JOIN public.users ru ON ru.id = mr.reporter_id
        JOIN profiles rp ON rp.user_id = mr.reporter_id
        JOIN messages msg ON msg.id = mr.message_id
        JOIN public.users su ON su.id = msg.sender_id
        JOIN profiles sp ON sp.user_id = msg.sender_id
        WHERE mr.reviewed = false
        ORDER BY mr.created_at DESC LIMIT 50
      `),
      pool.query(`
        SELECT mr.id, 'match' AS type, mr.reason, mr.details, mr.created_at,
          ru.email AS reporter_email, rp.first_name AS reporter_name,
          m.id AS match_id
        FROM match_reports mr
        JOIN public.users ru ON ru.id = mr.reporter_id
        JOIN profiles rp ON rp.user_id = mr.reporter_id
        JOIN matches m ON m.id = mr.match_id
        WHERE mr.reviewed = false
        ORDER BY mr.created_at DESC LIMIT 50
      `),
    ]);
    res.json({ reports: [...msgReports.rows, ...matchReports.rows].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)) });
  } catch { res.status(500).json({ error: 'Failed to fetch reports' }); }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/admin/reports/:id — Resolve a report
// ══════════════════════════════════════════════════════════════
router.put('/reports/:id',
  [param('id').isUUID(), body('action').isIn(['dismiss','warn_user','suspend_user','close_match'])],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    const { action } = req.body;
    try {
      // Try both report tables
      await pool.query(
        `UPDATE message_reports SET reviewed = true, action_taken = $1 WHERE id = $2`,
        [action, req.params.id]
      );
      await pool.query(
        `UPDATE match_reports SET reviewed = true, action_taken = $1 WHERE id = $2`,
        [action, req.params.id]
      );
      await auditLog(req.admin.id, `resolve_report_${action}`, 'report', req.params.id);
      res.json({ message: `Report resolved: ${action}` });
    } catch { res.status(500).json({ error: 'Resolve failed' }); }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/revenue/summary
// ══════════════════════════════════════════════════════════════
router.get('/revenue/summary', async (req, res) => {
  try {
    const [totals, monthly] = await Promise.all([
      pool.query(`
        SELECT
          SUM(amount) FILTER (WHERE status='succeeded')                      AS gross,
          SUM(amount) FILTER (WHERE status='succeeded' AND created_at >= date_trunc('month',now())) AS mtd,
          COUNT(*) FILTER (WHERE status='succeeded' AND payment_type='conversation_unlock') AS unlocks,
          COUNT(*) FILTER (WHERE status='succeeded' AND payment_type='gold_subscription')  AS gold_subs,
          SUM(amount) FILTER (WHERE status='refunded')                       AS refunded,
          COUNT(*) FILTER (WHERE status='refunded')                          AS refund_count
        FROM payments
      `),
      pool.query(`
        SELECT date_trunc('month',created_at) AS month, SUM(amount) AS revenue, COUNT(*) AS count
        FROM payments WHERE status='succeeded' AND created_at > now() - interval '12 months'
        GROUP BY 1 ORDER BY 1 DESC
      `),
    ]);
    res.json({ totals: totals.rows[0], monthly: monthly.rows });
  } catch { res.status(500).json({ error: 'Failed to fetch revenue' }); }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/engine/runs — Engine run history
// ══════════════════════════════════════════════════════════════
router.get('/engine/runs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT 20`
    );
    res.json({ runs: result.rows });
  } catch { res.status(500).json({ error: 'Failed to fetch engine runs' }); }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/admin/engine/run — Trigger engine
// ══════════════════════════════════════════════════════════════
router.post('/engine/run',
  [body('dryRun').optional().isBoolean(), body('userId').optional().isUUID()],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    const { dryRun = false, userId = null } = req.body;

    // Insert engine run record
    const runResult = await pool.query(
      `INSERT INTO engine_runs (started_at, dry_run, triggered_by) VALUES (now(), $1, 'admin') RETURNING id`,
      [dryRun]
    );
    const runId = runResult.rows[0].id;

    res.json({ message: `Engine ${dryRun ? 'dry run' : 'live run'} started.`, runId });

    // Run in background
    runMatchingEngine({ dryRun, userId })
      .then(async stats => {
        await pool.query(`
          UPDATE engine_runs SET
            completed_at        = now(),
            users_processed     = $1,
            candidates_evaluated= $2,
            matches_created     = $3,
            errors              = $4,
            duration_seconds    = EXTRACT(EPOCH FROM (now() - started_at))
          WHERE id = $5
        `, [stats.usersProcessed, stats.candidatesEvaluated, stats.matchesCreated, stats.errors, runId]);
      })
      .catch(async err => {
        await pool.query(
          `UPDATE engine_runs SET notes = $1 WHERE id = $2`,
          [err.message, runId]
        );
      });
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/audit — Admin action audit log
// ══════════════════════════════════════════════════════════════
router.get('/audit',
  [query('page').optional().isInt({min:1})],
  async (req, res) => {
    const page   = parseInt(req.query.page || 1);
    const offset = (page - 1) * 50;
    try {
      const result = await pool.query(`
        SELECT al.*, u.name AS admin_name, u.email AS admin_email
        FROM admin_audit_log al
        JOIN public.users u ON u.id = al.admin_id
        ORDER BY al.created_at DESC LIMIT 50 OFFSET $1
      `, [offset]);
      res.json({ log: result.rows });
    } catch { res.status(500).json({ error: 'Failed to fetch audit log' }); }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/conversations/:matchId/messages
//  View messages in a specific conversation (admin only)
// ══════════════════════════════════════════════════════════════
router.get('/conversations/:matchId/messages',
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkV(req, res); if (err) return;
    try {
      const result = await pool.query(`
        SELECT msg.id, msg.sender_id, msg.content, msg.type,
               msg.sent_at, msg.is_flagged, msg.flag_reason,
               p.first_name AS sender_name
        FROM messages msg
        LEFT JOIN profiles p ON p.user_id = msg.sender_id
        WHERE msg.match_id = $1
        ORDER BY msg.sent_at ASC
        LIMIT 200
      `, [req.params.matchId]);

      // Get match info
      const matchInfo = await pool.query(`
        SELECT m.id, m.status, m.combined_score,
               pa.first_name AS name_a, pb.first_name AS name_b,
               m.user_a_id, m.user_b_id
        FROM matches m
        JOIN profiles pa ON pa.user_id = m.user_a_id
        JOIN profiles pb ON pb.user_id = m.user_b_id
        WHERE m.id = $1
      `, [req.params.matchId]);

      res.json({
        match: matchInfo.rows[0] || null,
        messages: result.rows,
        count: result.rows.length,
        flaggedCount: result.rows.filter(m => m.is_flagged).length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/admin/flagged-messages — All flagged messages
// ══════════════════════════════════════════════════════════════
router.get('/flagged-messages', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT msg.id, msg.match_id, msg.sender_id, msg.content, msg.type,
             msg.sent_at, msg.flag_reason, msg.is_flagged,
             p.first_name AS sender_name,
             pa.first_name AS name_a, pb.first_name AS name_b
      FROM messages msg
      LEFT JOIN profiles p ON p.user_id = msg.sender_id
      LEFT JOIN matches m ON m.id = msg.match_id
      LEFT JOIN profiles pa ON pa.user_id = m.user_a_id
      LEFT JOIN profiles pb ON pb.user_id = m.user_b_id
      WHERE msg.is_flagged = true
      ORDER BY msg.sent_at DESC
      LIMIT 100
    `);

    res.json({ flagged: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch flagged messages' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/admin/messages/:id/dismiss — Dismiss a flag
// ══════════════════════════════════════════════════════════════
router.put('/messages/:id/dismiss', [param('id').isUUID()], async (req, res) => {
  const err = checkV(req, res); if (err) return;
  try {
    await pool.query(
      'UPDATE messages SET is_flagged = false, flag_reason = NULL WHERE id = $1',
      [req.params.id]
    );
    await auditLog(req.admin.id, 'dismiss_flag', 'message', req.params.id);
    res.json({ message: 'Flag dismissed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss flag' });
  }
});

// ══════════════════════════════════════════════════════════════
//  DELETE /api/admin/messages/:id — Delete a message (admin)
// ══════════════════════════════════════════════════════════════
router.delete('/messages/:id', [param('id').isUUID()], async (req, res) => {
  const err = checkV(req, res); if (err) return;
  try {
    await pool.query(
      `UPDATE messages SET content = '[Removed by admin]', is_flagged = false, flag_reason = 'removed_by_admin' WHERE id = $1`,
      [req.params.id]
    );
    await auditLog(req.admin.id, 'remove_message', 'message', req.params.id);
    res.json({ message: 'Message removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove message' });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const adminRoutes = require('./admin-routes');
//  app.use('/api/admin', adminRoutes);
// ══════════════════════════════════════════════════════════════

// GET /api/admin/revenue/payments — payment list for admin
router.get('/revenue/payments',
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.id, p.amount, p.currency, p.payment_type, p.status,
               p.stripe_payment_intent, p.created_at,
               u.email AS user_email,
               pr.first_name || ' ' || COALESCE(pr.last_name,'') AS user_name
        FROM payments p
        JOIN public.users u ON u.id = p.user_id
        LEFT JOIN profiles pr ON pr.user_id = p.user_id
        ORDER BY p.created_at DESC LIMIT 100
      `);
      res.json({ payments: result.rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch payments' });
    }
  }
);
