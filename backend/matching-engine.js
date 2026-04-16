// ═══════════════════════════════════════════════════════════════
//  HASSABE — AI Matching Engine  (Step  5)
//  File: matching-engine.js
//
//  This is the heart of Hassabe. Run as a scheduled nightly job
//  (cron: 0 2 * * *) via Bull queue or a simple node-cron call.
//
//  What it does for each user in the matching pool:
//   1. Apply hard filters (gender, age, religion, deal-breakers)
//   2. Run pgvector ANN search to get top 50 embedding candidates
//   3. Compute weighted compatibility score across 8 dimensions
//   4. Filter candidates below the 72% threshold
//   5. Rank remaining candidates by score
//   6. Respect the max 3 active matches per user limit
//   7. Call GPT-4o to generate:
//        - Compatibility summary paragraph
//        - Shared values list
//        - 3 AI-generated icebreaker questions
//        - Friction points (admin-only, never shown to users)
//   8. Create match records in the database
//   9. Queue push notifications for both users
//
//  Exports:
//   runMatchingEngine()     — process all users in the pool
//   scoreMatchPair(a, b)    — score a specific user pair
//   generateMatchSummary()  — GPT-4o summary for a match
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

// ── Load notification service (with self-contained fallback) ──
let notifyPair;
try {
  let notifModule;
  try { notifModule = require('./notification-service'); }
  catch { notifModule = require('./routes/notification-service'); }

  notifyPair = notifModule.notifyPair;
  if (typeof notifyPair !== 'function') {
    throw new Error(`notifyPair is ${typeof notifyPair}, keys: ${Object.keys(notifModule)}`);
  }
  console.log('[Engine] notifyPair loaded from notification-service ✓');
} catch (err) {
  console.warn('[Engine] notification-service failed:', err.message);
  console.warn('[Engine] Using direct-email fallback for match notifications');

  // ── Self-contained fallback: send emails + in-app directly ──
  const { Resend } = require('resend');
  const fallbackResend = new Resend(process.env.RESEND_API_KEY);
  const { Pool: FBPool } = require('pg');
  const fallbackPool = new FBPool({ connectionString: process.env.DATABASE_URL });

  notifyPair = async (userAId, userBId, type, dataA = {}, dataB = {}) => {
    console.log(`[Fallback-Notify] ${type} → users ${userAId.slice(0,8)} & ${userBId.slice(0,8)}`);

    for (const { userId, data } of [
      { userId: userAId, data: dataA },
      { userId: userBId, data: dataB },
    ]) {
      try {
        // 1. In-app notification
        const title = type === 'new_match'
          ? '✦ You have a new compatibility match'
          : type === 'match_approved'
            ? '★ Your match has been confirmed'
            : 'A match update from Hassabe';
        const body = type === 'new_match'
          ? `Hassabe found someone with ${data.score}% compatibility. Complete Round 2 within 72 hours.`
          : type === 'match_approved'
            ? `Congratulations — combined score of ${data.combinedScore}%. Unlock your conversation now.`
            : 'This match was not advanced. We continue working to find the right person for you.';

        await fallbackPool.query(
          `INSERT INTO notifications (user_id, type, title, body, data)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, type, title, body, JSON.stringify(data)]
        );
        console.log(`  [Fallback] in-app notification saved for ${userId.slice(0,8)}`);

        // 2. Email notification
        const userResult = await fallbackPool.query(
          `SELECT u.email, p.first_name FROM public.users u
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.id = $1`, [userId]
        );
        const user = userResult.rows[0];
        if (!user?.email) {
          console.warn(`  [Fallback] No email found for user ${userId.slice(0,8)}`);
          continue;
        }

        const matchUrl = data.matchId
          ? `https://hassabe.com/${type === 'match_approved' ? 'payment' : 'round2'}.html?matchId=${data.matchId}`
          : 'https://hassabe.com/matches.html';

        await fallbackResend.emails.send({
          from:    'Hassabe <admin@hassabe.com>',
          to:      user.email,
          subject: type === 'new_match'
            ? `✦ Hassabe found a ${data.score}% compatibility match for you`
            : type === 'match_approved'
              ? `★ ${data.combinedScore}% — Your Hassabe match is confirmed`
              : 'A match update from Hassabe',
          html: `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FDF8F0;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FDF8F0;padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:0.5px solid rgba(201,168,76,0.2);border-radius:6px;overflow:hidden">
  <tr><td style="background:#0C0902;padding:28px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:28px;color:#FAF0DC;letter-spacing:0.02em">Hassabe</div>
    <div style="font-size:11px;color:rgba(232,213,163,0.4);letter-spacing:0.16em;text-transform:uppercase;margin-top:4px">ሃሳቤ · ሓሳቤ</div>
  </td></tr>
  <tr><td style="padding:36px 32px">
    <p style="font-size:15px;color:#2A1C06;margin:0 0 6px 0">Hello ${user.first_name || 'there'},</p>
    <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2A1C06;line-height:1.2;margin:0 0 16px 0">${title}</h1>
    <p style="font-size:14px;color:#5A4A2E;line-height:1.75;margin:0 0 20px 0">${body}</p>
    ${data.score || data.combinedScore ? `
    <div style="text-align:center;margin:24px 0">
      <div style="display:inline-block;background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:16px 28px">
        <div style="font-family:Georgia,serif;font-size:52px;color:#C9A84C;line-height:1">${data.combinedScore || data.score}%</div>
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(201,168,76,0.5);margin-top:4px">Compatibility Score</div>
      </div>
    </div>` : ''}
    <table cellpadding="0" cellspacing="0" style="margin:28px auto">
    <tr><td align="center" style="border-radius:3px;background:#C9A84C">
      <a href="${matchUrl}" style="display:block;padding:14px 32px;font-size:13px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:#0C0902;text-decoration:none">${type === 'match_approved' ? 'Unlock Conversation →' : 'Begin Round 2 →'}</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#F7F1E8;padding:16px 32px;text-align:center;border-top:0.5px solid rgba(139,105,20,0.1)">
    <p style="font-size:11px;color:#B5A88C;margin:0">© 2025 Hassabe Inc.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`,
          text: `${title}\n\n${body}\n\nOpen Hassabe: ${matchUrl}`,
        });
        console.log(`  [Fallback] email sent to ${user.email}`);

      } catch (innerErr) {
        console.error(`  [Fallback] Failed for user ${userId.slice(0,8)}:`, innerErr.message);
      }
    }
  };
}

const { Pool }  = require('pg');
const OpenAI    = require('openai');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Configuration ─────────────────────────────────────────────
const CONFIG = {
  MATCH_THRESHOLD:         72,    // Minimum R1 score (%) to surface a match
  FINAL_THRESHOLD:         68,    // Minimum combined R1+R2 score to approve
  MAX_ACTIVE_MATCHES:       3,    // Max simultaneous active matches per user
  CANDIDATE_POOL:          50,    // ANN search returns this many candidates
  R2_EXPIRY_HOURS:         72,    // Hours before R2 deadline expires
  MESSAGING_WINDOW_DAYS:   30,    // Days conversation stays open after unlock

  // R1 dimension weights (must sum to 1.0)
  R1_WEIGHTS: {
    values:        0.25,
    culture:       0.20,
    faith:         0.20,
    family:        0.10,
    communication: 0.10,
    goals:         0.10,
    lifestyle:     0.05,
    // dealbreakers = hard filter only, no weight
  },

  // Final score: R1 contributes 40%, R2 contributes 60%
  R1_FINAL_WEIGHT: 0.40,
  R2_FINAL_WEIGHT: 0.60,

  // Hard filter field mappings
  HARD_FILTERS: [
    'faith_match_importance',   // If 5, same religion required
    'deal_breakers',            // Array — any overlap = excluded
    'seeking',                  // Gender preference
    'partner_age_min',
    'partner_age_max',
    'children_preference',      // 'no' ↔ 'want_*' = exclude
  ],
};

// ══════════════════════════════════════════════════════════════
//  HARD FILTER ENGINE
//  Returns true if two users are compatible at the filter level.
//  Any failed filter = immediate exclusion (no scoring).
// ══════════════════════════════════════════════════════════════

function passesHardFilters(userA, userB) {
  const a = { ...userA.profile, ...userA.questionnaire };
  const b = { ...userB.profile, ...userB.questionnaire };

  // ── 1. Gender / seeking preference ──
  const genderOk = (
    (a.seeking === 'men'   && b.gender === 'male')   ||
    (a.seeking === 'women' && b.gender === 'female') ||
    a.seeking === 'all'
  ) && (
    (b.seeking === 'men'   && a.gender === 'male')   ||
    (b.seeking === 'women' && a.gender === 'female') ||
    b.seeking === 'all'
  );
  if (!genderOk) return { pass: false, reason: 'gender_mismatch' };

  // ── 2. Age range preference ──
  const ageA = getAge(a.date_of_birth);
  const ageB = getAge(b.date_of_birth);
  const ageOk = (
    ageB >= (a.partner_age_min || 18) && ageB <= (a.partner_age_max || 99) &&
    ageA >= (b.partner_age_min || 18) && ageA <= (b.partner_age_max || 99)
  );
  if (!ageOk) return { pass: false, reason: 'age_out_of_range' };

  // ── 3. Religion hard requirement ──
  if (a.faith_match_importance >= 5 || b.faith_match_importance >= 5) {
    const sameReligion = normalizeReligion(a.religion) === normalizeReligion(b.religion);
    if (!sameReligion) return { pass: false, reason: 'religion_mismatch' };
  }

  // ── 4. Deal-breaker cross-check ──
  const dbA = Array.isArray(a.deal_breakers) ? a.deal_breakers : [];
  const dbB = Array.isArray(b.deal_breakers) ? b.deal_breakers : [];

  const DEALBREAKER_MAP = {
    smoking:       () => a.smokes || b.smokes,  // profile flag (future)
    diff_religion: () => normalizeReligion(a.religion) !== normalizeReligion(b.religion),
    divorced:      () => b.marital_history === 'divorced' || a.marital_history === 'divorced',
    has_children:  () => b.marital_history === 'has_children' || a.marital_history === 'has_children',
    no_children:   () => b.children_preference === 'no' || a.children_preference === 'no',
    no_relocation: () => b.open_to_relocation === 'no' || a.open_to_relocation === 'no',
    no_culture:    () => false, // scored, not hard-filtered
  };

  for (const db of dbA) {
    const check = DEALBREAKER_MAP[db];
    if (check && check()) return { pass: false, reason: `dealbreaker_a:${db}` };
  }
  for (const db of dbB) {
    const check = DEALBREAKER_MAP[db];
    if (check && check()) return { pass: false, reason: `dealbreaker_b:${db}` };
  }

  // ── 5. Children compatibility ──
  const childrenConflict = (
    (a.children_preference === 'no' && b.children_preference?.startsWith('want')) ||
    (b.children_preference === 'no' && a.children_preference?.startsWith('want'))
  );
  if (childrenConflict) return { pass: false, reason: 'children_incompatible' };

  return { pass: true, reason: null };
}

function getAge(dob) {
  if (!dob) return 30;
  return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000));
}

function normalizeReligion(r) {
  if (!r) return 'unknown';
  if (r.includes('orthodox')) return 'orthodox_christian';
  if (r.includes('protestant') || r.includes('evangelical')) return 'protestant';
  if (r.includes('catholic')) return 'catholic';
  if (r.includes('islam') || r.includes('sunni') || r.includes('muslim')) return 'islam';
  if (r.includes('secular') || r.includes('non')) return 'secular';
  return r.toLowerCase().trim();
}

// ══════════════════════════════════════════════════════════════
//  DIMENSION COMPATIBILITY SCORER
//  Takes two users' dimension scores (0–100 each, from Step 4)
//  and computes a weighted compatibility score.
//
//  The embedding cosine similarity gives us a global signal.
//  Per-dimension scoring gives us the breakdown shown to users.
//  The final R1 score = 60% embedding similarity + 40% dimension.
// ══════════════════════════════════════════════════════════════

function computeWeightedScore(embeddingSimilarity, dimScoresA, dimScoresB) {
  const dims   = CONFIG.R1_WEIGHTS;
  let dimTotal = 0;
  let weightSum = 0;
  const breakdown = {};

  for (const [dim, weight] of Object.entries(dims)) {
    const scoreA = dimScoresA[dim] ?? 50;
    const scoreB = dimScoresB[dim] ?? 50;

    // Dimension compatibility = 100 - |scoreA - scoreB| × penalty
    // Scores close together = high compatibility on that dimension
    const diff       = Math.abs(scoreA - scoreB);
    const dimCompat  = Math.max(0, 100 - diff * 1.2);
    breakdown[dim]   = Math.round(dimCompat);

    dimTotal  += dimCompat * weight;
    weightSum += weight;
  }

  const dimScore   = weightSum > 0 ? dimTotal / weightSum : 50;
  const embedScore = Math.max(0, Math.min(100, embeddingSimilarity * 100));

  // Combined: 60% embedding (semantic) + 40% dimension (structural)
  const combined = (embedScore * 0.60) + (dimScore * 0.40);

  return {
    score:      Math.round(Math.min(100, Math.max(0, combined))),
    breakdown,
    embedScore: Math.round(embedScore),
    dimScore:   Math.round(dimScore),
  };
}

// ══════════════════════════════════════════════════════════════
//  GPT-4o MATCH SUMMARY GENERATOR
//  Called once per approved match pair.
//  Produces human-readable compatibility insights.
//  Cost: ~$0.005–0.015 per match (GPT-4o mini for cost efficiency).
// ══════════════════════════════════════════════════════════════

async function generateMatchSummary(userA, userB, scoreResult) {
  const prompt = `You are Hassabe's AI compatibility analyst. You are analyzing a match between two Ethiopian/Eritrean diaspora professionals who have both completed a detailed values and lifestyle questionnaire.

PERSON A:
- Name: ${userA.profile.first_name}, ${getAge(userA.profile.date_of_birth)} years old
- Location: ${userA.profile.city}, ${userA.profile.country}
- Profession: ${userA.profile.profession}
- Religion: ${userA.profile.religion} (${userA.profile.practice_level})
- Relationship goal: ${userA.profile.relationship_goal}
- Children: ${userA.profile.children_preference}
- Heritage: ${(userA.profile.ethnicity || []).join(', ')}
- Languages: ${(userA.profile.languages || []).join(', ')}
- Questionnaire highlights: ${userA.narrative?.slice(0, 600) || 'Not available'}

PERSON B:
- Name: ${userB.profile.first_name}, ${getAge(userB.profile.date_of_birth)} years old
- Location: ${userB.profile.city}, ${userB.profile.country}
- Profession: ${userB.profile.profession}
- Religion: ${userB.profile.religion} (${userB.profile.practice_level})
- Relationship goal: ${userB.profile.relationship_goal}
- Children: ${userB.profile.children_preference}
- Heritage: ${(userB.profile.ethnicity || []).join(', ')}
- Languages: ${(userB.profile.languages || []).join(', ')}
- Questionnaire highlights: ${userB.narrative?.slice(0, 600) || 'Not available'}

COMPATIBILITY SCORE: ${scoreResult.score}%
DIMENSION BREAKDOWN: ${JSON.stringify(scoreResult.breakdown)}

Generate a JSON response with these exact fields:
{
  "summary": "2-3 sentence compatibility summary. Warm, honest, grounded in the actual data. No generic phrases. Reference specific shared qualities. Do not use their names.",
  "shared_values": ["value 1", "value 2", "value 3", "value 4"],
  "icebreakers": [
    "A specific, personal conversation starter question rooted in what they share",
    "A second icebreaker question — deeper, more reflective",
    "A third icebreaker — lighter, cultural or lifestyle-based"
  ],
  "friction_points": ["potential tension 1", "potential tension 2"],
  "recommendation": "proceed" | "proceed_with_awareness" | "borderline"
}

Rules:
- shared_values: 3–5 specific values, not generic (e.g. "both prioritize faith above career decisions" not "shared values")
- icebreakers: grounded in their actual questionnaire answers, not generic dating questions
- friction_points: honest potential misalignments — for admin review only, never shown to users
- summary: Write for the users to read — warm but honest, no hype
- Return ONLY valid JSON, no markdown, no explanation`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cost-efficient; use gpt-4o for higher quality
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content;
    return JSON.parse(content);
  } catch (err) {
    console.error('[GPT-4o] Summary generation failed:', err.message);
    // Fallback summary when GPT-4o is unavailable
    return {
      summary: `You and your match share strong alignment across values, faith, and life goals — with an overall compatibility score of ${scoreResult.score}%. The matching engine identified meaningful common ground across multiple dimensions.`,
      shared_values: ['Faith-centered life', 'Family-oriented', 'Cultural connection', 'Serious relationship intent'],
      icebreakers: [
        'What does a meaningful Sunday look like in your household?',
        'What is one tradition from back home that you hope to carry forward?',
        'What has living in the diaspora taught you about yourself?',
      ],
      friction_points: ['Location gap may require discussion', 'Career ambition levels differ slightly'],
      recommendation: 'proceed',
    };
  }
}

// ══════════════════════════════════════════════════════════════
//  SINGLE PAIR SCORER (exported for on-demand use)
//  Useful for: re-scoring after profile updates, admin review
// ══════════════════════════════════════════════════════════════

async function scoreMatchPair(userIdA, userIdB) {
  const [dataA, dataB] = await Promise.all([
    getUserMatchData(userIdA),
    getUserMatchData(userIdB),
  ]);

  if (!dataA || !dataB) throw new Error('User data not found');

  // Hard filters first
  const filter = passesHardFilters(dataA, dataB);
  if (!filter.pass) return { compatible: false, reason: filter.reason };

  // Get embedding similarity from pgvector
  const simResult = await pool.query(
    `SELECT cosine_similarity_r1($1, $2) AS similarity`,
    [userIdA, userIdB]
  );
  const similarity = parseFloat(simResult.rows[0]?.similarity || 0);

  // Weighted score
  const scoreResult = computeWeightedScore(
    similarity,
    dataA.questionnaire.dimension_scores || {},
    dataB.questionnaire.dimension_scores || {},
  );

  return {
    compatible:  scoreResult.score >= CONFIG.MATCH_THRESHOLD,
    score:       scoreResult.score,
    breakdown:   scoreResult.breakdown,
    embedScore:  scoreResult.embedScore,
    dimScore:    scoreResult.dimScore,
    similarity,
  };
}

// ══════════════════════════════════════════════════════════════
//  MAIN MATCHING ENGINE
//  Called nightly by the scheduler.
// ══════════════════════════════════════════════════════════════

async function runMatchingEngine(options = {}) {
  const { dryRun = false, userId = null } = options;
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  HASSABE MATCHING ENGINE  ${new Date().toISOString()}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}${userId ? ` | User: ${userId}` : ''}`);
  console.log(`${'═'.repeat(60)}\n`);

  const stats = {
    usersProcessed:  0,
    candidatesEvaluated: 0,
    hardFilteredOut: 0,
    belowThreshold:  0,
    matchesCreated:  0,
    summariesGenerated: 0,
    errors:          0,
  };

  try {
    // ── Fetch users ready for matching ──
    const usersResult = await pool.query(`
      SELECT u.id, u.name, u.email
      FROM users u
      JOIN profiles p ON p.user_id = u.id
      WHERE
        p.matching_pool = true
        AND u.r1_complete = true
        AND u.status = 'active'
        ${userId ? 'AND u.id = $1' : ''}
      ORDER BY p.profile_score DESC, u.created_at ASC
    `, userId ? [userId] : []);

    const users = usersResult.rows;
    console.log(`[Engine] Found ${users.length} users in matching pool\n`);

    // ── Process each user ──
    for (const user of users) {
      try {
        await processUserMatching(user, stats, dryRun);
        stats.usersProcessed++;
      } catch (err) {
        stats.errors++;
        console.error(`[Engine] Error processing user ${user.id}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[Engine] Fatal error:', err);
    stats.errors++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  MATCHING ENGINE COMPLETE — ${duration}s`);
  console.log(`  Users processed:        ${stats.usersProcessed}`);
  console.log(`  Candidates evaluated:   ${stats.candidatesEvaluated}`);
  console.log(`  Hard filtered out:      ${stats.hardFilteredOut}`);
  console.log(`  Below threshold:        ${stats.belowThreshold}`);
  console.log(`  Matches created:        ${stats.matchesCreated}`);
  console.log(`  GPT-4o summaries:       ${stats.summariesGenerated}`);
  console.log(`  Errors:                 ${stats.errors}`);
  console.log(`${'─'.repeat(60)}\n`);

  return stats;
}

// ── Per-user matching logic ──
async function processUserMatching(user, stats, dryRun) {
  console.log(`[User ${user.id.slice(0,8)}…] Processing ${user.name || user.email}`);

  // Check how many active matches this user already has
  const activeResult = await pool.query(`
    SELECT COUNT(*) AS count FROM matches
    WHERE (user_a_id = $1 OR user_b_id = $1)
      AND status NOT IN ('declined', 'expired', 'messaging_unlocked')
  `, [user.id]);

  const activeMatches = parseInt(activeResult.rows[0].count);
  const slotsAvailable = CONFIG.MAX_ACTIVE_MATCHES - activeMatches;

  if (slotsAvailable <= 0) {
    console.log(`  → Already at max active matches (${CONFIG.MAX_ACTIVE_MATCHES}), skipping`);
    return;
  }

  // Get this user's full data
  const userData = await getUserMatchData(user.id);
  if (!userData?.questionnaire?.embedding) {
    console.log(`  → No embedding found, skipping`);
    return;
  }

  // Get candidate pool via pgvector ANN search
  const candidatesResult = await pool.query(
    `SELECT candidate_id, similarity FROM find_candidate_matches($1, $2)`,
    [user.id, CONFIG.CANDIDATE_POOL]
  );

  const candidates = candidatesResult.rows;
  console.log(`  → ${candidates.length} embedding candidates found`);

  const qualifiedMatches = [];

  // Evaluate each candidate
  for (const candidate of candidates) {
    stats.candidatesEvaluated++;

    // Get candidate's full data
    const candidateData = await getUserMatchData(candidate.candidate_id);
    if (!candidateData) continue;

    // Hard filters
    const filter = passesHardFilters(userData, candidateData);
    if (!filter.pass) {
      stats.hardFilteredOut++;
      continue;
    }

    // Weighted score
    const scoreResult = computeWeightedScore(
      candidate.similarity,
      userData.questionnaire.dimension_scores || {},
      candidateData.questionnaire.dimension_scores || {},
    );

    if (scoreResult.score < CONFIG.MATCH_THRESHOLD) {
      stats.belowThreshold++;
      continue;
    }

    qualifiedMatches.push({
      candidateId:   candidate.candidate_id,
      candidateData,
      score:         scoreResult.score,
      breakdown:     scoreResult.breakdown,
      embedScore:    scoreResult.embedScore,
      similarity:    candidate.similarity,
    });
  }

  // Sort by score descending, take top N based on available slots
  qualifiedMatches.sort((a, b) => b.score - a.score);
  const toCreate = qualifiedMatches.slice(0, slotsAvailable);

  console.log(`  → ${qualifiedMatches.length} qualified matches found, creating ${toCreate.length}`);

  // Create match records
  for (const match of toCreate) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would create match: ${user.id.slice(0,8)} ↔ ${match.candidateId.slice(0,8)} (${match.score}%)`);
      stats.matchesCreated++;
      continue;
    }

    try {
      // Generate GPT-4o summary (async, non-blocking for speed)
      const summary = await generateMatchSummary(userData, match.candidateData, match);
      stats.summariesGenerated++;

      // Determine canonical pair order (lower UUID = user_a)
      const [userAId, userBId] = [user.id, match.candidateId].sort();

      // Insert match record
      const matchResult = await pool.query(`
        INSERT INTO matches (
          user_a_id, user_b_id, r1_score, score_breakdown,
          compatibility_summary, shared_values, icebreakers, friction_points,
          status, r2_expires_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'notified',
          now() + interval '${CONFIG.R2_EXPIRY_HOURS} hours', now())
        ON CONFLICT (user_a_id, user_b_id) DO NOTHING
        RETURNING id
      `, [
        userAId,
        userBId,
        match.score,
        JSON.stringify(match.breakdown),
        summary.summary,
        summary.shared_values,
        summary.icebreakers,
        summary.friction_points,
      ]);

      if (matchResult.rows[0]) {
        const matchId = matchResult.rows[0].id;
        stats.matchesCreated++;
        console.log(`  ✓ Match created: ${matchId.slice(0,8)}… score=${match.score}%`);

        // Queue push notifications for both users
        await queueMatchNotifications(user.id, match.candidateId, matchId, match.score, summary);
      } else {
        console.log(`  → Match already exists for this pair, skipping`);
      }

    } catch (err) {
      stats.errors++;
      console.error(`  ✗ Error creating match:`, err.message);
    }
  }
}

// ── Fetch all data needed for a user's matching ──
async function getUserMatchData(userId) {
  try {
    const [profileResult, qResult] = await Promise.all([
      pool.query(`
        SELECT first_name, last_name, date_of_birth, gender, seeking,
               city, country, profession, religion, practice_level,
               faith_match_importance, relationship_goal, marital_history,
               children_preference, open_to_relocation, partner_age_min,
               partner_age_max, deal_breakers, ethnicity, languages,
               heritage_strength, career_balance, profile_score
        FROM profiles WHERE user_id = $1
      `, [userId]),

      pool.query(`
        SELECT dimension_scores, narrative_text, completed_at
        FROM questionnaire_responses
        WHERE user_id = $1 AND round = 1 AND status = 'complete'
        ORDER BY created_at DESC LIMIT 1
      `, [userId]),
    ]);

    if (!profileResult.rows[0] || !qResult.rows[0]) return null;

    return {
      userId,
      profile:       profileResult.rows[0],
      questionnaire: {
        ...qResult.rows[0],
        embedding: true, // trust pgvector has it (we use SQL function for similarity)
      },
      narrative: qResult.rows[0].narrative_text,
    };
  } catch (err) {
    console.error(`[getUserMatchData] Error for ${userId}:`, err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  FINAL SCORING (Round 1 + Round 2 combined)
//  Called after both users complete Round 2.
//  Combined score = R1 × 0.40 + R2 × 0.60
// ══════════════════════════════════════════════════════════════

async function computeFinalScore(matchId) {
  console.log(`[FinalScore] Computing for match ${matchId}`);

  const matchResult = await pool.query(`
    SELECT m.*,
      p_a.user_id AS user_a_uid, p_b.user_id AS user_b_uid
    FROM matches m
    JOIN profiles p_a ON p_a.user_id = m.user_a_id
    JOIN profiles p_b ON p_b.user_id = m.user_b_id
    WHERE m.id = $1
  `, [matchId]);

  if (!matchResult.rows[0]) throw new Error('Match not found');
  const match = matchResult.rows[0];

  // Get R2 responses for both users
  const [r2A, r2B] = await Promise.all([
    pool.query(`
      SELECT dimension_scores, narrative_text FROM questionnaire_responses
      WHERE user_id = $1 AND round = 2 AND match_id = $2 AND status = 'complete'
    `, [match.user_a_id, matchId]),
    pool.query(`
      SELECT dimension_scores, narrative_text FROM questionnaire_responses
      WHERE user_id = $1 AND round = 2 AND match_id = $2 AND status = 'complete'
    `, [match.user_b_id, matchId]),
  ]);

  if (!r2A.rows[0] || !r2B.rows[0]) {
    throw new Error('Both users must complete Round 2 before final scoring');
  }

  // R2 embedding similarity
  const r2SimResult = await pool.query(`
    SELECT 1 - (
      (SELECT embedding FROM questionnaire_responses WHERE user_id = $1 AND round = 2 AND match_id = $3)
      <=>
      (SELECT embedding FROM questionnaire_responses WHERE user_id = $2 AND round = 2 AND match_id = $3)
    ) AS similarity
  `, [match.user_a_id, match.user_b_id, matchId]);

  const r2Similarity  = parseFloat(r2SimResult.rows[0]?.similarity || 0);
  const r2ScoreResult = computeWeightedScore(
    r2Similarity,
    r2A.rows[0].dimension_scores || {},
    r2B.rows[0].dimension_scores || {},
  );

  const r1Score = parseFloat(match.r1_score || 0);
  const r2Score = r2ScoreResult.score;

  // Combined = R1 × 40% + R2 × 60%
  const combinedScore = Math.round(
    (r1Score * CONFIG.R1_FINAL_WEIGHT) + (r2Score * CONFIG.R2_FINAL_WEIGHT)
  );

  const approved = combinedScore >= CONFIG.FINAL_THRESHOLD;
  const status   = approved ? 'approved' : 'declined';

  // Generate updated GPT-4o summary if approved
  let updatedSummary = null;
  if (approved) {
    const [dataA, dataB] = await Promise.all([
      getUserMatchData(match.user_a_id),
      getUserMatchData(match.user_b_id),
    ]);
    if (dataA && dataB) {
      updatedSummary = await generateMatchSummary(dataA, dataB, {
        score:     combinedScore,
        breakdown: r2ScoreResult.breakdown,
      });
    }
  }

  // Update match record
  await pool.query(`
    UPDATE matches SET
      r2_score       = $1,
      combined_score = $2,
      status         = $3,
      ${updatedSummary ? `
        compatibility_summary = $5,
        shared_values         = $6,
        icebreakers           = $7,
        friction_points       = $8,
      ` : ''}
      updated_at     = now()
    WHERE id = $4
  `, [
    r2Score, combinedScore, status, matchId,
    ...(updatedSummary ? [
      updatedSummary.summary,
      updatedSummary.shared_values,
      updatedSummary.icebreakers,
      updatedSummary.friction_points,
    ] : []),
  ]);

  console.log(`[FinalScore] Match ${matchId}: R1=${r1Score} R2=${r2Score} Combined=${combinedScore}% → ${status.toUpperCase()}`);

  // Queue result notifications for both users
  await queueResultNotifications(
    match.user_a_id, match.user_b_id, matchId,
    combinedScore, status, updatedSummary
  );

  return {
    matchId,
    r1Score,
    r2Score,
    combinedScore,
    status,
    approved,
  };
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICATION QUEUE STUBS
//  Wired to Firebase Cloud Messaging in Step 6.
// ══════════════════════════════════════════════════════════════

async function queueMatchNotifications(userIdA, userIdB, matchId, score, summary) {
  try {
    const sharedValues = summary?.shared_values || [];
    const notifData = {
      matchId,
      score:        Math.round(score),
      expiryHours:  72,
      sharedValues,
    };
    await notifyPair(userIdA, userIdB, 'new_match', notifData, notifData);
    console.log(`  [Notify] new_match sent to users ${userIdA.slice(0,8)} & ${userIdB.slice(0,8)}`);
  } catch (err) {
    console.error('[Notify] queueMatchNotifications failed:', err.message);
  }
}

async function queueResultNotifications(userIdA, userIdB, matchId, score, status, summary) {
  try {
    const type     = status === 'approved' ? 'match_approved' : 'match_declined';
    const notifData = {
      matchId,
      combinedScore: Math.round(score),
      sharedValues:  summary?.shared_values || [],
    };
    await notifyPair(userIdA, userIdB, type, notifData, notifData);
    console.log(`[Notify] ${type} sent for match ${matchId}`);
  } catch (err) {
    console.error('[Notify] queueResultNotifications failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════

module.exports = {
  runMatchingEngine,
  scoreMatchPair,
  computeFinalScore,
  generateMatchSummary,
  passesHardFilters,
  computeWeightedScore,
  CONFIG,
};

// ── CLI entry point: node matching-engine.js [--dry-run] [--user=UUID] ──
if (require.main === module) {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const userArg = args.find(a => a.startsWith('--user='));
  const userId  = userArg ? userArg.split('=')[1] : null;

  runMatchingEngine({ dryRun, userId })
    .then(stats => {
      console.log('Engine finished:', stats);
      process.exit(0);
    })
    .catch(err => {
      console.error('Engine failed:', err);
      process.exit(1);
    });
}
