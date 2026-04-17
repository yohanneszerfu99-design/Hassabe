// ═══════════════════════════════════════════════════════════════
//  HASSABE — Round 2 & Final Scoring Routes  (Step 7)
//  File: round2-routes.js
//
//  Routes:
//   POST /api/round2/:matchId          — submit R2 answers + trigger final scoring
//   GET  /api/round2/:matchId/status   — R2 completion status for both users
//   POST /api/round2/:matchId/draft    — save R2 draft
//   GET  /api/round2/:matchId/draft    — restore R2 draft
//   GET  /api/round2/:matchId/result   — get final result after scoring
//   POST /api/round2/admin/rescore/:matchId — admin: re-run final scoring
//
//  Final Scoring Pipeline (triggered when both users submit R2):
//   1. Fetch both users' R1 and R2 embeddings from PostgreSQL
//   2. Compute R2 cosine similarity via pgvector
//   3. Compute weighted R2 dimension score
//   4. Combined = R1 × 0.40 + R2 × 0.60
//   5. If combined ≥ 68 → approve, else → decline
//   6. Generate updated GPT-4o summary if approved
//   7. Update match record with final status
//   8. Send notifications to both users (Step 6)
//   9. Return result to requesting user
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const OpenAI   = require('openai');
const jwt      = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { notify, notifyPair } = require('../notification-service');
const { generateMatchSummary, computeWeightedScore, CONFIG } = require('../matching-engine');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const r2Limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many submissions.' } });

// ══════════════════════════════════════════════════════════════
//  R2 DIMENSION WEIGHTS (heavier than R1 — deeper signals)
// ══════════════════════════════════════════════════════════════
const R2_WEIGHTS = {
  marriage:  0.25,   // timeline, expectations, tradition
  finances:  0.15,   // structure, attitudes, obligations
  family:    0.20,   // roles, involvement, parenting
  conflict:  0.20,   // emotional maturity, vulnerability
  readiness: 0.20,   // availability, honesty, commitment concept
};

// ══════════════════════════════════════════════════════════════
//  EMBEDDING HELPERS
// ══════════════════════════════════════════════════════════════

function buildR2Narrative(responses, profile) {
  const byDim = {};
  for (const r of responses) {
    if (r.skipped || !r.answer_text) continue;
    if (!byDim[r.dimension]) byDim[r.dimension] = [];
    // Exclude sensitive responses from narrative text (still scored but not embedded verbatim)
    if (!r.sensitive) byDim[r.dimension].push(r.answer_text);
  }

  const sections = [];

  // Profile context for richer signal
  if (profile) {
    sections.push(`Background: ${profile.religion || ''}, ${profile.relationship_goal || ''}, heritage ${(profile.ethnicity || []).join(', ')}.`);
  }

  const dimLabels = {
    marriage:  'Marriage expectations and timing',
    finances:  'Financial attitudes and structure',
    family:    'Family roles and involvement',
    conflict:  'Conflict and emotional life',
    readiness: 'Readiness and life context',
  };

  for (const [dim, label] of Object.entries(dimLabels)) {
    const answers = byDim[dim];
    if (answers?.length) sections.push(`${label}: ${answers.join('. ')}.`);
  }

  return sections.join('\n\n');
}

async function generateEmbedding(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: 1536,
      });
      return res.data[0].embedding;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  R2 DIMENSION SCORER
// ══════════════════════════════════════════════════════════════

function scoreR2Dimensions(responsesA, responsesB) {
  // Build dimension answer maps
  function buildMap(responses) {
    const map = {};
    for (const r of responses) {
      if (!r.skipped && r.answer !== null) {
        if (!map[r.dimension]) map[r.dimension] = [];
        map[r.dimension].push(r);
      }
    }
    return map;
  }

  const mapA = buildMap(responsesA);
  const mapB = buildMap(responsesB);

  const breakdown = {};
  let weightedTotal = 0;
  let weightSum = 0;

  for (const [dim, weight] of Object.entries(R2_WEIGHTS)) {
    const answersA = mapA[dim] || [];
    const answersB = mapB[dim] || [];

    if (!answersA.length || !answersB.length) {
      breakdown[dim] = 50; // neutral if either side missing
      continue;
    }

    // Per-dimension agreement scoring
    let dimScore = 0;
    let matched  = 0;

    for (const rA of answersA) {
      const rB = answersB.find(r => r.question_id === rA.question_id);
      if (!rB) continue;
      matched++;

      if (rA.type === 'scale5' && rB.type === 'scale5') {
        // Scale proximity: 5=perfect, 4=close, etc.
        const diff = Math.abs((rA.answer || 3) - (rB.answer || 3));
        dimScore += Math.max(0, 100 - diff * 25);
      } else if (rA.type === 'single' && rB.type === 'single') {
        // Exact match = 100, adjacent options = partial credit
        const diff = Math.abs((rA.answer || 0) - (rB.answer || 0));
        const optCount = 5; // typical option count
        dimScore += Math.max(0, 100 - (diff / optCount) * 80);
      } else if (rA.type === 'multi' && rB.type === 'multi') {
        // Jaccard similarity on selected options
        const setA = new Set(Array.isArray(rA.answer) ? rA.answer : []);
        const setB = new Set(Array.isArray(rB.answer) ? rB.answer : []);
        const union = new Set([...setA, ...setB]);
        const intersect = [...setA].filter(x => setB.has(x)).length;
        dimScore += union.size > 0 ? (intersect / union.size) * 100 : 50;
      } else if (rA.type === 'text') {
        // Text answers: embedding similarity handled at the combined level
        dimScore += 70; // conservative baseline for text
      }
    }

    breakdown[dim] = matched > 0 ? Math.round(dimScore / matched) : 50;
    weightedTotal += breakdown[dim] * weight;
    weightSum += weight;
  }

  const dimScore = weightSum > 0 ? Math.round(weightedTotal / weightSum) : 50;
  return { dimScore, breakdown };
}

// ══════════════════════════════════════════════════════════════
//  FINAL SCORING ENGINE
// ══════════════════════════════════════════════════════════════

async function runFinalScoring(matchId, triggeredBy = 'auto') {
  console.log(`\n[FinalScoring] Starting for match ${matchId} (triggered by: ${triggeredBy})`);

  // 1. Fetch match with both users
  const matchResult = await pool.query(`
    SELECT m.*,
      pa.first_name AS name_a, pa.religion AS religion_a, pa.ethnicity AS ethnicity_a,
      pa.relationship_goal AS goal_a,
      pb.first_name AS name_b, pb.religion AS religion_b, pb.ethnicity AS ethnicity_b,
      pb.relationship_goal AS goal_b
    FROM matches m
    JOIN profiles pa ON pa.user_id = m.user_a_id
    JOIN profiles pb ON pb.user_id = m.user_b_id
    WHERE m.id = $1
  `, [matchId]);

  if (!matchResult.rows[0]) throw new Error('Match not found');
  const match = matchResult.rows[0];

  // Guard: only score once
  if (['approved', 'declined', 'messaging_unlocked'].includes(match.status) && triggeredBy !== 'admin') {
    console.log(`[FinalScoring] Match ${matchId} already scored (${match.status}), skipping`);
    return { alreadyScored: true, status: match.status };
  }

  // 2. Fetch R1 data for both
  const [r1A, r1B] = await Promise.all([
    pool.query(`SELECT dimension_scores FROM questionnaire_responses WHERE user_id = $1 AND round = 1 AND status = 'complete' ORDER BY created_at DESC LIMIT 1`, [match.user_a_id]),
    pool.query(`SELECT dimension_scores FROM questionnaire_responses WHERE user_id = $1 AND round = 1 AND status = 'complete' ORDER BY created_at DESC LIMIT 1`, [match.user_b_id]),
  ]);

  // 3. Fetch R2 responses for both
  const [r2A, r2B] = await Promise.all([
    pool.query(`SELECT responses, narrative_text, embedding FROM questionnaire_responses WHERE user_id = $1 AND round = 2 AND match_id = $2 AND status = 'complete'`, [match.user_a_id, matchId]),
    pool.query(`SELECT responses, narrative_text, embedding FROM questionnaire_responses WHERE user_id = $1 AND round = 2 AND match_id = $2 AND status = 'complete'`, [match.user_b_id, matchId]),
  ]);

  if (!r2A.rows[0] || !r2B.rows[0]) {
    throw new Error('Both users must complete Round 2 before final scoring');
  }

  const r2ResponsesA = r2A.rows[0].responses || [];
  const r2ResponsesB = r2B.rows[0].responses || [];

  // 4. R2 embedding similarity
  let r2EmbedSimilarity = 0.7; // fallback if embeddings missing
  try {
    const simResult = await pool.query(`
      SELECT 1 - (
        (SELECT embedding FROM questionnaire_responses WHERE user_id = $1 AND round = 2 AND match_id = $3)
        <=>
        (SELECT embedding FROM questionnaire_responses WHERE user_id = $2 AND round = 2 AND match_id = $3)
      ) AS similarity
    `, [match.user_a_id, match.user_b_id, matchId]);
    r2EmbedSimilarity = parseFloat(simResult.rows[0]?.similarity || 0.7);
  } catch (err) {
    console.warn('[FinalScoring] Embedding similarity query failed:', err.message);
  }

  // 5. R2 dimension score
  const { dimScore: r2DimScore, breakdown: r2Breakdown } = scoreR2Dimensions(r2ResponsesA, r2ResponsesB);

  // Combined R2 score: 60% embedding + 40% dimension
  const r2Score = Math.round((r2EmbedSimilarity * 100 * 0.60) + (r2DimScore * 0.40));

  // 6. Final combined score
  const r1Score   = parseFloat(match.r1_score || 0);
  const combined  = Math.round((r1Score * CONFIG.R1_FINAL_WEIGHT) + (r2Score * CONFIG.R2_FINAL_WEIGHT));
  const approved  = combined >= CONFIG.FINAL_THRESHOLD;
  const status    = approved ? 'approved' : 'declined';

  console.log(`[FinalScoring] R1=${r1Score}% R2=${r2Score}% Combined=${combined}% → ${status.toUpperCase()}`);

  // 7. Generate updated GPT-4o summary if approved
  let summaryData = null;
  if (approved) {
    try {
      const profileA = { first_name: match.name_a, religion: match.religion_a, ethnicity: match.ethnicity_a, relationship_goal: match.goal_a };
      const profileB = { first_name: match.name_b, religion: match.religion_b, ethnicity: match.ethnicity_b, relationship_goal: match.goal_b };
      const narrativeA = r2A.rows[0].narrative_text;
      const narrativeB = r2B.rows[0].narrative_text;

      summaryData = await generateMatchSummary(
        { userId: match.user_a_id, profile: profileA, narrative: narrativeA },
        { userId: match.user_b_id, profile: profileB, narrative: narrativeB },
        { score: combined, breakdown: r2Breakdown }
      );
      console.log('[FinalScoring] GPT-4o summary generated');
    } catch (err) {
      console.warn('[FinalScoring] GPT-4o summary failed:', err.message);
    }
  }

  // 8. Update match record — scores, status, and summary in one query
  if (summaryData) {
    await pool.query(`
      UPDATE matches SET
        r2_score              = $1,
        combined_score        = $2,
        status                = $3,
        compatibility_summary = $5,
        shared_values         = $6,
        icebreakers           = $7,
        friction_points       = $8,
        updated_at            = now()
      WHERE id = $4
    `, [
      r2Score, combined, status, matchId,
      summaryData.summary         || null,
      JSON.stringify(summaryData.shared_values   || []),
      JSON.stringify(summaryData.icebreakers     || []),
      JSON.stringify(summaryData.friction_points || []),
    ]);
  } else {
    await pool.query(`
      UPDATE matches SET
        r2_score       = $1,
        combined_score = $2,
        status         = $3,
        updated_at     = now()
      WHERE id = $4
    `, [r2Score, combined, status, matchId]);
  }

  // 9. Send notifications to both users
  const notifType = approved ? 'match_approved' : 'match_declined';
  const notifData = {
    matchId,
    combinedScore: combined,
    sharedValues: summaryData?.shared_values || [],
  };

  await notifyPair(match.user_a_id, match.user_b_id, notifType, notifData, notifData);

  console.log(`[FinalScoring] Complete. Match ${matchId} → ${status}`);

  return {
    matchId,
    r1Score,
    r2Score,
    combinedScore: combined,
    status,
    approved,
    breakdown: r2Breakdown,
    summaryGenerated: !!summaryData,
  };
}

// ══════════════════════════════════════════════════════════════
//  POST /api/round2/:matchId — Submit Round 2
// ══════════════════════════════════════════════════════════════
router.post('/:matchId',
  requireAuth,
  r2Limiter,
  [
    param('matchId').isUUID(),
    body('responses').isArray({ min: 15 }).withMessage('At least 15 responses required'),
    body('responses.*.question_id').notEmpty(),
    body('responses.*.dimension').isIn(Object.keys(R2_WEIGHTS)),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { matchId } = req.params;
    const { responses, metadata } = req.body;

    try {
      // Verify match exists and user is a participant
      const matchResult = await pool.query(`
        SELECT id, user_a_id, user_b_id, status,
               r2_a_completed_at, r2_b_completed_at, r2_expires_at
        FROM matches
        WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
      `, [matchId, req.user.id]);

      if (!matchResult.rows[0]) return res.status(404).json({ error: 'Match not found' });
      const match = matchResult.rows[0];

      if (!['notified', 'pending_r2'].includes(match.status)) {
        return res.status(409).json({
          error: `Match status is '${match.status}'. Round 2 is not available.`,
        });
      }

      // Check expiry
      if (match.r2_expires_at && new Date(match.r2_expires_at) < new Date()) {
        return res.status(410).json({ error: 'This Round 2 window has expired.' });
      }

      const isUserA = match.user_a_id === req.user.id;
      const alreadyDone = isUserA ? match.r2_a_completed_at : match.r2_b_completed_at;
      if (alreadyDone) {
        return res.status(409).json({ error: 'You have already submitted Round 2 for this match.' });
      }

      // Get profile for embedding context
      const profileResult = await pool.query(
        'SELECT * FROM profiles WHERE user_id = $1', [req.user.id]
      );

      // Build narrative and generate embedding
      const narrative = buildR2Narrative(responses, profileResult.rows[0]);
      let embedding   = null;
      let embedModel  = null;
      try {
        embedding  = await generateEmbedding(narrative);
        embedModel = 'text-embedding-3-large';
        console.log(`[R2] Embedding generated for user ${req.user.id}`);
      } catch (embErr) {
        console.warn('[R2] Embedding failed, saving without:', embErr.message);
      }

      // Compute own dimension scores
      const ownDimScores = {};
      for (const dim of Object.keys(R2_WEIGHTS)) {
        const dimAnswers = responses.filter(r => r.dimension === dim && !r.skipped);
        ownDimScores[dim] = dimAnswers.length > 0 ? 75 : 50; // baseline; real score at pairing
      }

      await pool.query('BEGIN');

      // Save R2 questionnaire response
      await pool.query(`
        INSERT INTO questionnaire_responses
          (user_id, round, match_id, responses, narrative_text, embedding, embedding_model,
           dimension_scores, started_at, completed_at, status)
        VALUES ($1, 2, $2, $3, $4, $5::vector, $6, $7, $8, $9, 'complete')
        ON CONFLICT (user_id, round, match_id)
        DO UPDATE SET
          responses       = EXCLUDED.responses,
          narrative_text  = EXCLUDED.narrative_text,
          embedding       = EXCLUDED.embedding,
          dimension_scores= EXCLUDED.dimension_scores,
          completed_at    = EXCLUDED.completed_at,
          updated_at      = now()
      `, [
        req.user.id, matchId,
        JSON.stringify(responses),
        narrative,
        embedding ? `[${embedding.join(',')}]` : null,
        embedModel,
        JSON.stringify(ownDimScores),
        metadata?.started_at || new Date().toISOString(),
        metadata?.completed_at || new Date().toISOString(),
      ]);

      // Update match R2 completion timestamp
      const col = isUserA ? 'r2_a_completed_at' : 'r2_b_completed_at';
      await pool.query(
        `UPDATE matches SET ${col} = now(), status = 'pending_r2', updated_at = now() WHERE id = $1`,
        [matchId]
      );

      await pool.query('COMMIT');

      // Delete draft
      await pool.query(
        `DELETE FROM questionnaire_drafts WHERE user_id = $1 AND round = 2 AND match_id = $2`,
        [req.user.id, matchId]
      ).catch(() => {});

      // Check if partner also done — if yes, trigger final scoring
      const updatedMatch = await pool.query(
        'SELECT r2_a_completed_at, r2_b_completed_at FROM matches WHERE id = $1', [matchId]
      );
      const { r2_a_completed_at, r2_b_completed_at } = updatedMatch.rows[0];
      const bothComplete = !!(r2_a_completed_at && r2_b_completed_at);

      if (bothComplete) {
        // Mark as scoring
        await pool.query(
          `UPDATE matches SET status = 'scoring_r2', updated_at = now() WHERE id = $1`, [matchId]
        );

        // Run final scoring asynchronously (non-blocking response)
        runFinalScoring(matchId, 'both_submitted')
          .then(result => console.log('[R2] Final scoring done:', result))
          .catch(err  => console.error('[R2] Final scoring error:', err));

        // Notify partner that this user completed
        const partnerId = isUserA ? match.user_b_id : match.user_a_id;
        const myName    = (profileResult.rows[0]?.first_name || req.user.name || 'Your match');
        await notify(partnerId, 'r2_partner_done', {
          matchId,
          partnerFirstName: myName,
        });
      } else {
        // Notify partner that they're being waited on
        const partnerId = isUserA ? match.user_b_id : match.user_a_id;
        await notify(partnerId, 'r2_partner_done', {
          matchId,
          score: match.r1_score,
        }).catch(() => {});
      }

      res.status(201).json({
        message:      bothComplete
          ? 'Round 2 submitted. Both users are done — calculating your final score now.'
          : 'Round 2 submitted. Waiting for your match to complete theirs.',
        bothComplete,
        embeddingGenerated: !!embedding,
      });

    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error('R2 submission error:', err);
      res.status(500).json({ error: 'Submission failed. Your draft is still saved. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/round2/:matchId/status — Check R2 status
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
          m.status,
          m.r1_score,
          m.r2_score,
          m.combined_score,
          m.r2_expires_at,
          CASE WHEN m.user_a_id = $2 THEN m.r2_a_completed_at ELSE m.r2_b_completed_at END AS my_r2_at,
          CASE WHEN m.user_a_id = $2 THEN m.r2_b_completed_at ELSE m.r2_a_completed_at END AS partner_r2_at,
          EXTRACT(EPOCH FROM (m.r2_expires_at - now())) / 3600 AS hours_remaining,
          d.current_question AS draft_question,
          d.answers_count    AS draft_answers
        FROM matches m
        LEFT JOIN questionnaire_drafts d
          ON d.user_id = $2 AND d.round = 2 AND d.match_id = m.id
        WHERE m.id = $1 AND (m.user_a_id = $2 OR m.user_b_id = $2)
      `, [req.params.matchId, req.user.id]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Match not found' });
      const m = result.rows[0];

      res.json({
        status:          m.status,
        r1Score:         m.r1_score,
        r2Score:         m.r2_score,
        combinedScore:   m.combined_score,
        myR2Complete:    !!m.my_r2_at,
        partnerR2Complete: !!m.partner_r2_at,
        hoursRemaining:  m.hours_remaining ? Math.round(m.hours_remaining) : null,
        expiresAt:       m.r2_expires_at,
        draft:           m.draft_question != null ? {
          currentQuestion: m.draft_question,
          answersCount:    m.draft_answers,
        } : null,
        thresholds: { final: CONFIG.FINAL_THRESHOLD },
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get status' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST/GET /api/round2/:matchId/draft — R2 draft save/restore
// ══════════════════════════════════════════════════════════════
router.post('/:matchId/draft',
  requireAuth,
  [param('matchId').isUUID(), body('current_question').isInt({ min: 0 }), body('answers').isObject()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const answersCount = Object.values(req.body.answers).filter(v => v !== null && v !== undefined).length;

    try {
      await pool.query(`
        INSERT INTO questionnaire_drafts
          (user_id, round, match_id, current_question, answers, answers_count, updated_at)
        VALUES ($1, 2, $2, $3, $4, $5, now())
        ON CONFLICT (user_id, round, match_id) DO UPDATE SET
          current_question = EXCLUDED.current_question,
          answers          = EXCLUDED.answers,
          answers_count    = EXCLUDED.answers_count,
          updated_at       = now()
      `, [req.user.id, req.params.matchId, req.body.current_question, JSON.stringify(req.body.answers), answersCount]);

      res.json({ saved: true, answersCount });
    } catch (err) {
      res.status(500).json({ error: 'Draft save failed' });
    }
  }
);

router.get('/:matchId/draft', requireAuth, [param('matchId').isUUID()], async (req, res) => {
  const err = checkValidation(req, res);
  if (err) return;

  try {
    const result = await pool.query(
      `SELECT current_question, answers, answers_count, updated_at FROM questionnaire_drafts
       WHERE user_id = $1 AND round = 2 AND match_id = $2`,
      [req.user.id, req.params.matchId]
    );
    if (!result.rows[0]) return res.json({ hasDraft: false });
    res.json({ hasDraft: true, ...result.rows[0] });
  } catch {
    res.status(500).json({ error: 'Draft restore failed' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/round2/:matchId/result — Get final result
// ══════════════════════════════════════════════════════════════
router.get('/:matchId/result',
  requireAuth,
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const result = await pool.query(`
        SELECT
          m.id, m.r1_score, m.r2_score, m.combined_score, m.status,
          m.score_breakdown, m.compatibility_summary, m.shared_values,
          m.icebreakers, m.messaging_unlocked_at, m.expires_at,
          p.first_name, p.date_of_birth, p.profession, p.city,
          p.religion, p.practice_level, p.relationship_goal,
          ARRAY[]::text[] AS photos
        FROM matches m
        JOIN profiles p ON p.user_id = (
          CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
        )
        WHERE m.id = $1 AND (m.user_a_id = $2 OR m.user_b_id = $2)
        GROUP BY m.id, p.id
      `, [req.params.matchId, req.user.id]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Match not found' });
      const m = result.rows[0];

      const isComplete  = ['approved','declined','messaging_unlocked'].includes(m.status);
      const isApproved  = ['approved','messaging_unlocked'].includes(m.status);
      const age = m.date_of_birth
        ? Math.floor((Date.now() - new Date(m.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000))
        : null;

      res.json({
        matchId:         m.id,
        status:          m.status,
        resultReady:     isComplete,
        approved:        isApproved,
        scores: {
          r1:       m.r1_score,
          r2:       m.r2_score,
          combined: m.combined_score,
          threshold: CONFIG.FINAL_THRESHOLD,
        },
        breakdown:             m.score_breakdown,
        compatibilitySummary:  isApproved ? m.compatibility_summary : null,
        sharedValues:          isApproved ? m.shared_values : null,
        icebreakers:           m.status === 'messaging_unlocked' ? m.icebreakers : null,
        partner: isApproved ? {
          firstName:       m.first_name,
          age,
          profession:      m.profession,
          city:            m.city,
          religion:        m.religion,
          practiceLevel:   m.practice_level,
          relationshipGoal:m.relationship_goal,
          photos:          m.photos || [],
        } : null,
        messagingUnlockedAt: m.messaging_unlocked_at,
        expiresAt:           m.expires_at,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get result' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/round2/admin/rescore/:matchId — Admin re-score
// ══════════════════════════════════════════════════════════════
router.post('/admin/rescore/:matchId', requireAdmin, [param('matchId').isUUID()], async (req, res) => {
  const err = checkValidation(req, res);
  if (err) return;

  try {
    const result = await runFinalScoring(req.params.matchId, 'admin');
    res.json({ message: 'Final scoring complete.', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runFinalScoring = runFinalScoring;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const round2Routes = require('./round2-routes');
//  app.use('/api/round2', round2Routes);
// ══════════════════════════════════════════════════════════════
