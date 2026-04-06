// ═══════════════════════════════════════════════════════════════
//  HASSABE — Questionnaire API Routes (Step 4)
//
//  Routes:
//   POST /api/questionnaire/round1         — submit R1 answers + generate embeddings
//   GET  /api/questionnaire/round1         — get own R1 responses
//   GET  /api/questionnaire/round1/status  — is R1 complete?
//   POST /api/questionnaire/round1/draft   — auto-save draft
//   GET  /api/questionnaire/round1/draft   — restore draft
//   POST /api/questionnaire/round2/:matchId — submit R2 answers
//   GET  /api/questionnaire/questions      — get question list (for mobile clients)
//
//  AI Pipeline (triggered on Round 1 submit ):
//   1. Validate & store structured responses in PostgreSQL
//   2. Build a rich text narrative from responses
//   3. Send to OpenAI text-embedding-3-large (1536 dimensions)
//   4. Store embedding vector in pgvector column
//   5. Mark user as ready for matching (r1_complete = true)
//   6. Queue background matching job
//
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express   = require('express');
const { Pool }  = require('pg');
const OpenAI    = require('openai');
const jwt       = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Rate limiter ──
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many questionnaire submissions. Please try again later.' },
});

// ── Auth middleware ──
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
      issuer: 'hassabe.com', audience: 'hassabe-api',
    });
    const result = await pool.query(
      'SELECT id, name, email, status FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!result.rows[0] || result.rows[0].status !== 'active') {
      return res.status(401).json({ error: 'Account not found or suspended' });
    }
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Validation helper ──
function checkValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  return null;
}

// ══════════════════════════════════════════════════════════════
//  THE EMBEDDING PIPELINE
//  Converts structured questionnaire responses into a rich text
//  narrative, then generates a 1536-dimension embedding vector
//  using OpenAI text-embedding-3-large.
// ══════════════════════════════════════════════════════════════

const DIMENSIONS = {
  values:        'Core Values & Character',
  culture:       'Cultural Identity & Heritage',
  faith:         'Faith & Religious Life',
  family:        'Family & Community',
  communication: 'Communication & Emotional Style',
  goals:         'Life Goals & Direction',
  lifestyle:     'Daily Lifestyle & Habits',
  dealbreakers:  'Priorities & Non-Negotiables',
};

/**
 * buildEmbeddingNarrative
 * Converts structured responses into a rich paragraph-form narrative
 * that OpenAI can embed into a meaningful vector space.
 * The text is designed to surface semantic compatibility signals —
 * not just keyword matching.
 */
function buildEmbeddingNarrative(responses, userProfile) {
  const sections = [];

  // Group responses by dimension
  const byDim = {};
  for (const r of responses) {
    if (!byDim[r.dimension]) byDim[r.dimension] = [];
    if (r.answer_text && !r.skipped) byDim[r.dimension].push(r.answer_text);
  }

  // Add profile context (from Step 3) for richer semantic signal
  if (userProfile) {
    const profileContext = [
      userProfile.religion && `Religion: ${userProfile.religion}`,
      userProfile.practice_level && `Religious practice: ${userProfile.practice_level}`,
      userProfile.relationship_goal && `Relationship goal: ${userProfile.relationship_goal}`,
      userProfile.children_preference && `Children: ${userProfile.children_preference}`,
      userProfile.open_to_relocation && `Relocation: ${userProfile.open_to_relocation}`,
      userProfile.career_balance && `Career/life balance: ${userProfile.career_balance}`,
      userProfile.ethnicity?.length && `Cultural background: ${userProfile.ethnicity.join(', ')}`,
      userProfile.languages?.length && `Languages: ${userProfile.languages.join(', ')}`,
    ].filter(Boolean).join('. ');

    if (profileContext) sections.push(`Profile context: ${profileContext}.`);
  }

  // Build dimension paragraphs
  for (const [dimId, dimLabel] of Object.entries(DIMENSIONS)) {
    const answers = byDim[dimId];
    if (!answers || answers.length === 0) continue;
    sections.push(`${dimLabel}: ${answers.join('. ')}.`);
  }

  return sections.join('\n\n');
}

/**
 * generateEmbedding
 * Calls OpenAI text-embedding-3-large and returns a 1536-dim vector.
 * Retries once on failure before throwing.
 */
async function generateEmbedding(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: 1536,
      });
      return response.data[0].embedding; // float[]
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * computeDimensionScores
 * Produces a 0–100 score per dimension based on response completeness
 * and answer richness. Used for analytics and match explanations.
 * Full AI scoring happens in Step 5 (matching engine).
 */
function computeDimensionScores(responses) {
  const scores = {};
  const byDim = {};
  for (const r of responses) {
    if (!byDim[r.dimension]) byDim[r.dimension] = [];
    if (!r.skipped && r.answer !== null) byDim[r.dimension].push(r);
  }

  for (const dimId of Object.keys(DIMENSIONS)) {
    const answers = byDim[dimId] || [];
    const total   = answers.length;
    if (total === 0) { scores[dimId] = 0; continue; }

    // Score: proportion answered × richness bonus for text answers
    let richness = 0;
    for (const r of answers) {
      richness += 1;
      if (r.type === 'text' && r.answer_text && r.answer_text.length > 60) richness += 0.5;
      if (r.type === 'multi' && Array.isArray(r.answer) && r.answer.length >= 3) richness += 0.3;
    }

    scores[dimId] = Math.min(100, Math.round((richness / total) * 80));
  }

  return scores;
}

// ══════════════════════════════════════════════════════════════
//  POST /api/questionnaire/round1 — Submit + generate embedding
// ══════════════════════════════════════════════════════════════
router.post('/round1',
  requireAuth,
  submitLimiter,
  [
    body('responses').isArray({ min: 1 }).withMessage('At least 25 responses required'),
    body('responses.*.question_id').notEmpty(),
    body('responses.*.dimension').isIn(Object.keys(DIMENSIONS)),
    body('metadata.completed_at').isISO8601(),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { responses, metadata } = req.body;

    try {
      // Check if already completed (prevent duplicates)
      const existing = await pool.query(
        `SELECT id, round FROM questionnaire_responses
         WHERE user_id = $1 AND round = 1 AND status = 'complete'`,
        [req.user.id]
      );
      if (existing.rows[0]) {
        return res.status(409).json({
          error: 'Round 1 already completed.',
          submittedAt: existing.rows[0].created_at,
        });
      }

      // Get user profile for embedding context
      const profileResult = await pool.query(
        `SELECT religion, practice_level, relationship_goal, children_preference,
                open_to_relocation, career_balance, ethnicity, languages
         FROM profiles WHERE user_id = $1`,
        [req.user.id]
      );
      const userProfile = profileResult.rows[0] || null;

      // Compute dimension scores
      const dimensionScores = computeDimensionScores(responses);

      // Build narrative text for embedding
      const narrative = buildEmbeddingNarrative(responses, userProfile);
      console.log(`[Q1 Embedding] User ${req.user.id} — narrative length: ${narrative.length} chars`);

      // Generate OpenAI embedding (main operation — ~500ms)
      let embedding = null;
      let embeddingModel = 'text-embedding-3-large';
      try {
        embedding = await generateEmbedding(narrative);
        console.log(`[Q1 Embedding] Generated ${embedding.length}-dim vector for user ${req.user.id}`);
      } catch (embErr) {
        // Graceful degradation: save responses without embedding
        // Embedding can be regenerated later via /api/questionnaire/round1/regenerate-embedding
        console.error('[Q1 Embedding] Failed to generate embedding:', embErr.message);
        embeddingModel = null;
      }

      // Store in database (transaction)
      await pool.query('BEGIN');

      const qrResult = await pool.query(`
        INSERT INTO questionnaire_responses
          (user_id, round, responses, narrative_text, embedding, embedding_model,
           dimension_scores, started_at, completed_at, status)
        VALUES ($1, 1, $2, $3, $4::vector, $5, $6, $7, $8, 'complete')
        RETURNING id
      `, [
        req.user.id,
        JSON.stringify(responses),
        narrative,
        embedding ? `[${embedding.join(',')}]` : null,
        embeddingModel,
        JSON.stringify(dimensionScores),
        metadata.started_at,
        metadata.completed_at,
      ]);

      const responseId = qrResult.rows[0].id;

      // Mark user as R1 complete
      await pool.query(
        'UPDATE users SET r1_complete = true, updated_at = now() WHERE id = $1',
        [req.user.id]
      );

      // If profile is also complete (score >= 70), mark ready for matching
      await pool.query(`
        UPDATE profiles
        SET matching_pool = true, updated_at = now()
        WHERE user_id = $1 AND profile_score >= 70
      `, [req.user.id]);

      // Delete any existing draft
      await pool.query(
        `DELETE FROM questionnaire_drafts WHERE user_id = $1 AND round = 1`,
        [req.user.id]
      );

      await pool.query('COMMIT');

      // Queue background matching job (non-blocking)
      queueMatchingJob(req.user.id).catch(err =>
        console.error('[Matching Queue] Failed to queue job:', err)
      );

      res.status(201).json({
        message: 'Round 1 complete. AI matching engine will run tonight.',
        responseId,
        embeddingGenerated: !!embedding,
        dimensionScores,
        readyForMatching: !!embedding && !!userProfile,
      });

    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error('Q1 submission error:', err);
      res.status(500).json({ error: 'Submission failed. Your draft is still saved. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/questionnaire/round1 — Retrieve own R1 responses
// ══════════════════════════════════════════════════════════════
router.get('/round1', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, responses, dimension_scores, started_at, completed_at,
             embedding IS NOT NULL AS has_embedding, status
      FROM questionnaire_responses
      WHERE user_id = $1 AND round = 1
      ORDER BY created_at DESC LIMIT 1
    `, [req.user.id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Round 1 not yet completed.' });
    }

    res.json({ questionnaire: result.rows[0] });
  } catch (err) {
    console.error('Get Q1 error:', err);
    res.status(500).json({ error: 'Failed to retrieve questionnaire' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/questionnaire/round1/status
// ══════════════════════════════════════════════════════════════
router.get('/round1/status', requireAuth, async (req, res) => {
  try {
    const [userResult, draftResult] = await Promise.all([
      pool.query('SELECT r1_complete FROM users WHERE id = $1', [req.user.id]),
      pool.query(
        `SELECT answers_count, updated_at FROM questionnaire_drafts
         WHERE user_id = $1 AND round = 1`,
        [req.user.id]
      ),
    ]);

    const r1Complete = userResult.rows[0]?.r1_complete || false;
    const draft      = draftResult.rows[0] || null;

    res.json({
      round1Complete:  r1Complete,
      hasDraft:        !!draft,
      draftAnswerCount: draft?.answers_count || 0,
      draftUpdatedAt:  draft?.updated_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/questionnaire/round1/draft — Auto-save draft
// ══════════════════════════════════════════════════════════════
router.post('/round1/draft',
  requireAuth,
  [
    body('current_question').isInt({ min: 0, max: 29 }),
    body('answers').isObject(),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { current_question, answers } = req.body;
    const answersCount = Object.values(answers).filter(v => v !== null && v !== undefined).length;

    try {
      await pool.query(`
        INSERT INTO questionnaire_drafts
          (user_id, round, current_question, answers, answers_count, updated_at)
        VALUES ($1, 1, $2, $3, $4, now())
        ON CONFLICT (user_id, round) DO UPDATE SET
          current_question = EXCLUDED.current_question,
          answers          = EXCLUDED.answers,
          answers_count    = EXCLUDED.answers_count,
          updated_at       = now()
      `, [req.user.id, current_question, JSON.stringify(answers), answersCount]);

      res.json({ saved: true, answersCount });
    } catch (err) {
      console.error('Draft save error:', err);
      res.status(500).json({ error: 'Draft save failed' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/questionnaire/round1/draft — Restore draft
// ══════════════════════════════════════════════════════════════
router.get('/round1/draft', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT current_question, answers, answers_count, updated_at
       FROM questionnaire_drafts
       WHERE user_id = $1 AND round = 1`,
      [req.user.id]
    );

    if (!result.rows[0]) return res.json({ hasDraft: false });

    res.json({
      hasDraft:        true,
      currentQuestion: result.rows[0].current_question,
      answers:         result.rows[0].answers,
      answersCount:    result.rows[0].answers_count,
      updatedAt:       result.rows[0].updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Draft restore failed' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/questionnaire/round2/:matchId — Submit Round 2
//  (Scaffolded here — fully built in Step 7)
// ══════════════════════════════════════════════════════════════
router.post('/round2/:matchId',
  requireAuth,
  [
    param('matchId').isUUID(),
    body('responses').isArray({ min: 8 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { matchId } = req.params;
    const { responses, metadata } = req.body;

    try {
      // Verify match exists and user is a participant
      const matchResult = await pool.query(`
        SELECT id, user_a_id, user_b_id, status, r2_a_completed_at, r2_b_completed_at
        FROM matches WHERE id = $1
        AND (user_a_id = $2 OR user_b_id = $2)
      `, [matchId, req.user.id]);

      if (!matchResult.rows[0]) {
        return res.status(404).json({ error: 'Match not found' });
      }

      const match    = matchResult.rows[0];
      const isUserA  = match.user_a_id === req.user.id;

      if (match.status !== 'pending_r2') {
        return res.status(409).json({ error: `Match status is '${match.status}' — Round 2 is not open.` });
      }

      // Check not already submitted
      const alreadyDone = isUserA ? match.r2_a_completed_at : match.r2_b_completed_at;
      if (alreadyDone) {
        return res.status(409).json({ error: 'You have already completed Round 2 for this match.' });
      }

      // Get profile for embedding context
      const profileResult = await pool.query(
        'SELECT * FROM profiles WHERE user_id = $1',
        [req.user.id]
      );

      // Build embedding from R2 responses
      const narrative = responses.map(r => r.answer_text).filter(Boolean).join('. ');
      let embedding = null;
      try { embedding = await generateEmbedding(narrative); } catch {}

      // Save R2 response
      await pool.query('BEGIN');

      await pool.query(`
        INSERT INTO questionnaire_responses
          (user_id, round, match_id, responses, narrative_text, embedding, embedding_model,
           started_at, completed_at, status)
        VALUES ($1, 2, $2, $3, $4, $5::vector, $6, $7, $8, 'complete')
      `, [
        req.user.id, matchId,
        JSON.stringify(responses),
        narrative,
        embedding ? `[${embedding.join(',')}]` : null,
        embedding ? 'text-embedding-3-large' : null,
        metadata?.started_at || new Date().toISOString(),
        metadata?.completed_at || new Date().toISOString(),
      ]);

      // Update match record
      const col = isUserA ? 'r2_a_completed_at' : 'r2_b_completed_at';
      await pool.query(
        `UPDATE matches SET ${col} = now(), updated_at = now() WHERE id = $1`,
        [matchId]
      );

      // If both users done, trigger final scoring (Step 5 / Step 7)
      const updatedMatch = await pool.query(
        'SELECT r2_a_completed_at, r2_b_completed_at FROM matches WHERE id = $1',
        [matchId]
      );
      const both = updatedMatch.rows[0];
      if (both.r2_a_completed_at && both.r2_b_completed_at) {
        await pool.query(
          `UPDATE matches SET status = 'scoring_r2', updated_at = now() WHERE id = $1`,
          [matchId]
        );
        // Queue final scoring job (non-blocking)
        queueFinalScoringJob(matchId).catch(console.error);
      }

      await pool.query('COMMIT');

      res.status(201).json({
        message: 'Round 2 submitted.',
        bothComplete: !!(both.r2_a_completed_at && both.r2_b_completed_at),
      });

    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error('Q2 submission error:', err);
      res.status(500).json({ error: 'Submission failed. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  GET /api/questionnaire/questions — Question list for clients
// ══════════════════════════════════════════════════════════════
router.get('/questions', requireAuth, (req, res) => {
  // Return question metadata without exposing internal scoring weights
  const round = parseInt(req.query.round) || 1;
  // Question bank is defined in the frontend — this endpoint would serve
  // from a DB table in production for easy CMS management
  res.json({
    round,
    message: 'Question bank served from frontend in this build. In production, fetch from DB.',
    totalQuestions: round === 1 ? 30 : 25,
    dimensions: Object.keys(DIMENSIONS),
  });
});

// ══════════════════════════════════════════════════════════════
//  POST /api/questionnaire/round1/regenerate-embedding
//  Admin / recovery endpoint — regenerates embedding if it failed
// ══════════════════════════════════════════════════════════════
router.post('/round1/regenerate-embedding', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, narrative_text FROM questionnaire_responses
       WHERE user_id = $1 AND round = 1 AND status = 'complete'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'No completed Round 1 found' });
    if (!result.rows[0].narrative_text) return res.status(400).json({ error: 'No narrative text to embed' });

    const embedding = await generateEmbedding(result.rows[0].narrative_text);

    await pool.query(
      `UPDATE questionnaire_responses
       SET embedding = $1::vector, embedding_model = 'text-embedding-3-large', updated_at = now()
       WHERE id = $2`,
      [`[${embedding.join(',')}]`, result.rows[0].id]
    );

    // Re-mark for matching
    await pool.query(
      `UPDATE profiles SET matching_pool = true WHERE user_id = $1 AND profile_score >= 70`,
      [req.user.id]
    );

    res.json({ message: 'Embedding regenerated successfully.', vectorDimensions: embedding.length });
  } catch (err) {
    console.error('Regen embedding error:', err);
    res.status(500).json({ error: 'Embedding regeneration failed' });
  }
});

// ══════════════════════════════════════════════════════════════
//  BACKGROUND JOBS (stubs — wire to Bull/Redis in production)
// ══════════════════════════════════════════════════════════════
async function queueMatchingJob(userId) {
  // In production with Bull (Redis):
  // await matchingQueue.add('find-matches', { userId }, {
  //   delay: 0,
  //   attempts: 3,
  //   backoff: { type: 'exponential', delay: 5000 },
  // });
  console.log(`[Matching Queue] Queued match job for user ${userId}`);
}

async function queueFinalScoringJob(matchId) {
  // In production:
  // await scoringQueue.add('score-match', { matchId }, { attempts: 3 });
  console.log(`[Scoring Queue] Queued final scoring for match ${matchId}`);
}


// ══════════════════════════════════════════════════════════════
//  POST /api/questionnaire/admin/regenerate-all-embeddings
//  Admin: regenerate missing embeddings for all users
// ══════════════════════════════════════════════════════════════
router.post('/admin/regenerate-all-embeddings', requireAdmin, async (req, res) => {
  try {
    const missing = await pool.query(`
      SELECT id, user_id, narrative_text
      FROM questionnaire_responses
      WHERE round = 1
        AND status = 'complete'
        AND embedding IS NULL
        AND narrative_text IS NOT NULL
    `);

    if (!missing.rows.length) {
      return res.json({ message: 'No missing embeddings found.', processed: 0 });
    }

    const results = [];
    for (const row of missing.rows) {
      try {
        const embedding = await generateEmbedding(row.narrative_text);
        await pool.query(
          `UPDATE questionnaire_responses
           SET embedding = $1::vector, embedding_model = 'text-embedding-3-large', updated_at = now()
           WHERE id = $2`,
          [`[${embedding.join(',')}]`, row.id]
        );
        await pool.query(
          `UPDATE profiles SET matching_pool = true WHERE user_id = $1 AND profile_score >= 70`,
          [row.user_id]
        );
        results.push({ userId: row.user_id, status: 'ok', dims: embedding.length });
        console.log(`[Admin Regen] Embedding generated for user ${row.user_id}`);
      } catch (err) {
        results.push({ userId: row.user_id, status: 'failed', error: err.message });
        console.error(`[Admin Regen] Failed for user ${row.user_id}:`, err.message);
      }
    }

    res.json({ message: 'Done.', processed: results.length, results });
  } catch (err) {
    console.error('Admin regen error:', err);
    res.status(500).json({ error: 'Bulk regeneration failed' });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js:
//
//  const questionnaireRoutes = require('./questionnaire-routes');
//  app.use('/api/questionnaire', questionnaireRoutes);
//
//  ENVIRONMENT VARIABLES NEEDED:
//  OPENAI_API_KEY=sk-...
// ══════════════════════════════════════════════════════════════
