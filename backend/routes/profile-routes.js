// ═══════════════════════════════════════════════════════════════
//  HASSABE — Profile API Routes  (Step 3)
//  Add these routes to your Step 2 server.js, OR run as a
//  separate service alongside it.
//
//  Routes:
//   POST   /api/profile            — create / upsert profile
//   GET    /api/profile/me         — get own profile
//   PUT    /api/profile/me         — update profile fields
//   DELETE /api/profile/photos/:id — remove photo
//   PUT    /api/profile/photos/reorder — reorder photos
//   GET    /api/profile/:id        — view another user's profile (limited)
//   GET    /api/profile/score      — recalculate completeness score
//
//  All routes require JWT auth from Step 2.
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const { body, param, validationResult } = require('express-validator');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const router     = express.Router();
const pool       = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Rate limiter for profile updates ──
const profileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
});

// ── Auth middleware (same as Step 2) ──
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
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
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Validation error handler ──
function checkValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  PROFILE SCORE CALCULATION
//  Mirrors the frontend scoring logic — single source of truth.
// ═══════════════════════════════════════════════════════════════
function calculateProfileScore(p) {
  let score = 0;
  const checks = [
    { pts: 15, pass: p.first_name && p.last_name && p.date_of_birth && p.city && p.country },
    { pts: 10, pass: p.profession && p.education_level },
    { pts: 10, pass: p.ethnicity?.length > 0 },
    { pts: 15, pass: !!p.religion },
    { pts: 10, pass: !!p.relationship_goal },
    { pts: 20, pass: p.bio && p.bio.length >= 80 },
    { pts:  5, pass: p.photos?.length >= 1 },
    { pts: 10, pass: p.photos?.length >= 3 },
    { pts:  5, pass: !!p.video_intro_url },
  ];
  checks.forEach(c => { if (c.pass) score += c.pts; });
  return score;
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/profile — Create or update the full profile
// ═══════════════════════════════════════════════════════════════
router.post('/',
  requireAuth,
  profileLimiter,
  [
    body('first_name').trim().notEmpty().withMessage('First name is required').isLength({ max: 60 }),
    body('last_name').trim().notEmpty().withMessage('Last name is required').isLength({ max: 60 }),
    body('date_of_birth').isDate().withMessage('Valid date of birth required'),
    body('gender').isIn(['male','female','other']).withMessage('Invalid gender'),
    body('city').trim().notEmpty().withMessage('City is required').isLength({ max: 100 }),
    body('profession').trim().notEmpty().withMessage('Profession is required').isLength({ max: 120 }),
    body('education_level').trim().notEmpty().withMessage('Education level is required'),
    body('religion').trim().notEmpty().withMessage('Religion is required'),
    body('relationship_goal').trim().notEmpty().withMessage('Relationship goal is required'),
    body('bio').trim().isLength({ min: 80, max: 500 }).withMessage('Bio must be 80–500 characters'),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const {
      first_name, last_name, date_of_birth, gender, seeking,
      city, country,
      profession, industry, education_level, field_of_study, residency_status,
      ethnicity, languages, heritage_strength,
      religion, practice_level, faith_match_importance,
      relationship_goal, marital_history, children_preference,
      open_to_relocation, partner_age_min, partner_age_max,
      weekend_activities, career_balance, deal_breakers,
      bio,
    } = req.body;

    const score = calculateProfileScore({ ...req.body, photos: [] });

    try {
      const result = await pool.query(`
        INSERT INTO profiles (
          user_id, first_name, last_name, date_of_birth, gender, seeking,
          city, country,
          profession, industry, education_level, field_of_study, residency_status,
          ethnicity, languages, heritage_strength,
          religion, practice_level, faith_match_importance,
          relationship_goal, marital_history, children_preference,
          open_to_relocation, partner_age_min, partner_age_max,
          weekend_activities, career_balance, deal_breakers,
          bio, profile_score, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,now()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
          date_of_birth=EXCLUDED.date_of_birth, gender=EXCLUDED.gender,
          seeking=EXCLUDED.seeking, city=EXCLUDED.city, country=EXCLUDED.country,
          profession=EXCLUDED.profession, industry=EXCLUDED.industry,
          education_level=EXCLUDED.education_level, field_of_study=EXCLUDED.field_of_study,
          residency_status=EXCLUDED.residency_status, ethnicity=EXCLUDED.ethnicity,
          languages=EXCLUDED.languages, heritage_strength=EXCLUDED.heritage_strength,
          religion=EXCLUDED.religion, practice_level=EXCLUDED.practice_level,
          faith_match_importance=EXCLUDED.faith_match_importance,
          relationship_goal=EXCLUDED.relationship_goal, marital_history=EXCLUDED.marital_history,
          children_preference=EXCLUDED.children_preference,
          open_to_relocation=EXCLUDED.open_to_relocation,
          partner_age_min=EXCLUDED.partner_age_min, partner_age_max=EXCLUDED.partner_age_max,
          weekend_activities=EXCLUDED.weekend_activities, career_balance=EXCLUDED.career_balance,
          deal_breakers=EXCLUDED.deal_breakers, bio=EXCLUDED.bio,
          profile_score=EXCLUDED.profile_score, updated_at=now()
        RETURNING id, profile_score
      `, [
        req.user.id, first_name, last_name, date_of_birth, gender, seeking,
        city, country,
        profession, industry, education_level, field_of_study, residency_status,
        ethnicity || [], languages || [], heritage_strength || 3,
        religion, practice_level, faith_match_importance || 3,
        relationship_goal, marital_history, children_preference,
        open_to_relocation, partner_age_min || 18, partner_age_max || 65,
        weekend_activities || [], career_balance, deal_breakers || [],
        bio, score,
      ]);

      // Mark profile complete on the user record if score >= 70
      if (score >= 70) {
        await pool.query(
          'UPDATE users SET profile_complete = true, updated_at = now() WHERE id = $1',
          [req.user.id]
        );
      }

      res.status(201).json({
        message: 'Profile saved successfully.',
        profileId: result.rows[0].id,
        profileScore: result.rows[0].profile_score,
        profileComplete: score >= 70,
      });
    } catch (err) {
      console.error('Profile save error:', err);
      res.status(500).json({ error: 'Failed to save profile. Please try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/profile/me — Get own full profile
// ═══════════════════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
        array_agg(
          json_build_object('id', ph.id, 'url', ph.url, 'position', ph.position, 'is_main', ph.is_main)
          ORDER BY ph.position ASC
        ) FILTER (WHERE ph.id IS NOT NULL) AS photos
      FROM profiles p
      WHERE p.user_id = $1
      GROUP BY p.id
    `, [req.user.id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Profile not found. Please complete your onboarding.' });
    }

    res.json({ profile: result.rows[0] });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  PUT /api/profile/me — Partial profile update
// ═══════════════════════════════════════════════════════════════
router.put('/me', requireAuth, profileLimiter, async (req, res) => {
  const allowed = [
    'first_name','last_name','city','country','profession','industry',
    'field_of_study','bio','religion','practice_level','faith_match_importance',
    'relationship_goal','children_preference','open_to_relocation',
    'partner_age_min','partner_age_max','weekend_activities',
    'career_balance','deal_breakers','heritage_strength',
  ];

  const updates = {};
  allowed.forEach(key => {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  });

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  if (updates.bio && updates.bio.length < 80) {
    return res.status(400).json({ error: 'Bio must be at least 80 characters' });
  }

  try {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
    setClauses.push('updated_at = now()');
    const values = [req.user.id, ...Object.values(updates)];

    await pool.query(
      `UPDATE profiles SET ${setClauses.join(', ')} WHERE user_id = $1`,
      values
    );

    // Recalculate score
    const profileResult = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [req.user.id]);
    const score = calculateProfileScore(profileResult.rows[0] || {});
    await pool.query('UPDATE profiles SET profile_score = $1 WHERE user_id = $2', [score, req.user.id]);

    res.json({ message: 'Profile updated.', profileScore: score });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Update failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/profile/photos/:photoId
// ═══════════════════════════════════════════════════════════════
router.get('/:userId',
  requireAuth,
  [param('userId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    // Don't allow viewing own profile this way
    if (req.params.userId === req.user.id) {
      return res.redirect('/api/profile/me');
    }

    try {
      // Check if a confirmed match exists between the two users
      const matchResult = await pool.query(`
        SELECT id, status FROM matches
        WHERE (user_a_id = $1 AND user_b_id = $2)
           OR (user_a_id = $2 AND user_b_id = $1)
        AND status IN ('approved','messaging_unlocked')
      `, [req.user.id, req.params.userId]);

      const isMatch = !!matchResult.rows[0];

      // Public fields — shown to anyone surfaced as a potential match
      const publicFields = `
        p.first_name, LEFT(p.last_name, 1) || '.' AS last_name,
        date_part('year', age(p.date_of_birth))::int AS age,
        p.gender, p.city, p.country,
        p.profession, p.industry, p.education_level,
        p.ethnicity, p.languages,
        p.religion, p.practice_level,
        p.relationship_goal, p.children_preference,
        p.bio, p.profile_score, p.is_verified,
        array_agg(ph.url ORDER BY ph.position) FILTER (WHERE ph.id IS NOT NULL) AS photos
      `;

      // Full fields — only for confirmed matches
      const matchFields = isMatch ? `, p.marital_history, p.open_to_relocation,
        p.weekend_activities, p.career_balance, p.heritage_strength` : '';

      const result = await pool.query(`
        SELECT ${publicFields}${matchFields}
        FROM profiles p
        WHERE p.user_id = $1
        GROUP BY p.id
      `, [req.params.userId]);

      if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found' });

      res.json({ profile: result.rows[0], isMatch });
    } catch (err) {
      console.error('View profile error:', err);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/profile/score — Recalculate and return profile score
// ═══════════════════════════════════════════════════════════════
router.get('/me/score', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, COUNT(ph.id) AS photo_count
      FROM profiles p
      WHERE p.user_id = $1
      GROUP BY p.id
    `, [req.user.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found' });

    const profile = result.rows[0];
    const fakePhotos = Array(parseInt(profile.photo_count || 0)).fill({ url: 'x' });
    const score = calculateProfileScore({ ...profile, photos: fakePhotos });

    await pool.query(
      'UPDATE profiles SET profile_score = $1 WHERE user_id = $2',
      [score, req.user.id]
    );

    const breakdown = {
      basic_info:    { pts: 15, earned: profile.first_name && profile.last_name && profile.date_of_birth && profile.city ? 15 : 0 },
      career:        { pts: 10, earned: profile.profession && profile.education_level ? 10 : 0 },
      identity:      { pts: 10, earned: profile.ethnicity?.length > 0 ? 10 : 0 },
      faith:         { pts: 15, earned: profile.religion ? 15 : 0 },
      goals:         { pts: 10, earned: profile.relationship_goal ? 10 : 0 },
      bio:           { pts: 20, earned: profile.bio?.length >= 80 ? 20 : 0 },
      first_photo:   { pts:  5, earned: parseInt(profile.photo_count) >= 1 ? 5 : 0 },
      three_photos:  { pts: 10, earned: parseInt(profile.photo_count) >= 3 ? 10 : 0 },
      video_intro:   { pts:  5, earned: profile.video_intro_url ? 5 : 0 },
    };

    res.json({ score, breakdown, readyForMatching: score >= 70 });
  } catch (err) {
    console.error('Score error:', err);
    res.status(500).json({ error: 'Score calculation failed' });
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════════
//  HOW TO MOUNT IN server.js (Step 2):
//
//  const profileRoutes = require('./profile-routes');
//  app.use('/api/profile', profileRoutes);
//
// ═══════════════════════════════════════════════════════════════
