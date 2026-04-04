// ═══════════════════════════════════════════════════════════════
//  HASSABE — Auth Routes  (mounted at /api/auth in server.js)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const speakeasy  = require('speakeasy');
const qrcode     = require('qrcode');
const { Resend } = require('resend');
const rateLimit  = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const router  = express.Router();
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const resend  = new Resend(process.env.RESEND_API_KEY);
const SECRET  = process.env.JWT_SECRET;
const FROM    = 'Hassabe <admin@hassabe.com>';
const JWT_OPT = { issuer: 'hassabe.com', audience: 'hassabe-api' };

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Try again soon.' } });
const otpLimiter  = rateLimit({ windowMs: 60 * 1000, max: 10 });

function signAccess(id)  { return jwt.sign({ sub: id }, SECRET, { ...JWT_OPT, expiresIn: '15m' }); }
function signRefresh(id) { return jwt.sign({ sub: id }, SECRET, { ...JWT_OPT, expiresIn: '30d' }); }
function hashToken(t)    { return crypto.createHash('sha256').update(t).digest('hex'); }

async function storeRefresh(userId, token) {
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days') ON CONFLICT DO NOTHING`,
    [userId, hashToken(token)]
  );
}

async function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    const p = jwt.verify(h.slice(7), SECRET, JWT_OPT);
    const r = await pool.query('SELECT id, email, status FROM users WHERE id = $1', [p.sub]);
    if (!r.rows[0] || r.rows[0].status !== 'active') return res.status(401).json({ error: 'Account not found' });
    req.user = r.rows[0]; next();
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ error: e.array()[0].msg }); return false; }
  return true;
}

// POST /register
router.post('/register', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').trim().isLength({ min: 2 }).withMessage('Name is required'),
], async (req, res) => {
  if (!ok(req, res)) return;
  const { email, password, name } = req.body;
  try {
    if ((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0])
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`,
      [email, hash, name]
    );
    const userId = rows[0].id;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query(`INSERT INTO verification_codes (user_id, code, type) VALUES ($1, $2, 'email')`, [userId, code]);

    resend.emails.send({ from: FROM, to: email, subject: `${code} — verify your Hassabe account`,
      html: `<p style="font-family:sans-serif;font-size:15px">Hi ${name},</p>
             <p style="font-family:sans-serif">Your verification code is:</p>
             <p style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:.15em;color:#2A1C06">${code}</p>
             <p style="font-family:sans-serif;color:#888;font-size:13px">Expires in 15 minutes. Do not share this code.</p>`,
    }).catch(e => console.warn('[Email] Register OTP failed:', e.message));

    res.status(201).json({ message: 'Account created. Check your email for a 6-digit verification code.', userId });
  } catch (e) { console.error('Register:', e); res.status(500).json({ error: 'Registration failed. Please try again.' }); }
});

// POST /verify-email
router.post('/verify-email', otpLimiter, [body('userId').isUUID(), body('code').isLength({ min:6, max:6 })], async (req, res) => {
  if (!ok(req, res)) return;
  const { userId, code } = req.body;
  try {
    const vc = await pool.query(
      `SELECT id FROM verification_codes WHERE user_id=$1 AND code=$2 AND type='email' AND used=false AND expires_at>now()`,
      [userId, code]
    );
    if (!vc.rows[0]) return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    await pool.query('UPDATE verification_codes SET used=true WHERE id=$1', [vc.rows[0].id]);
    await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [userId]);
    const access = signAccess(userId), refresh = signRefresh(userId);
    await storeRefresh(userId, refresh);
    res.json({ message: 'Email verified. Welcome to Hassabe.', accessToken: access, refreshToken: refresh, userId });
  } catch (e) { res.status(500).json({ error: 'Verification failed.' }); }
});

// POST /login
router.post('/login', authLimiter, [body('email').isEmail().normalizeEmail(), body('password').notEmpty()], async (req, res) => {
  if (!ok(req, res)) return;
  const { email, password, totpCode } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, status, email_verified, tfa_enabled, tfa_secret FROM users WHERE email=$1',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Incorrect email or password.' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended.' });
    if (!user.email_verified) return res.status(403).json({ error: 'Please verify your email first.', needsVerification: true, userId: user.id });

    if (user.tfa_enabled) {
      if (!totpCode) return res.json({ requires2FA: true, userId: user.id });
      const valid = speakeasy.totp.verify({ secret: user.tfa_secret, encoding: 'base32', token: totpCode, window: 1 });
      if (!valid) return res.status(401).json({ error: 'Invalid 2FA code.' });
    }

    await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
    const access = signAccess(user.id), refresh = signRefresh(user.id);
    await storeRefresh(user.id, refresh);
    res.json({ accessToken: access, refreshToken: refresh, userId: user.id });
  } catch (e) { res.status(500).json({ error: 'Login failed. Please try again.' }); }
});

// POST /refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const p = jwt.verify(refreshToken, SECRET, JWT_OPT);
    const stored = await pool.query(
      'SELECT id FROM refresh_tokens WHERE user_id=$1 AND token_hash=$2 AND revoked=false AND expires_at>now()',
      [p.sub, hashToken(refreshToken)]
    );
    if (!stored.rows[0]) return res.status(401).json({ error: 'Refresh token invalid or expired.' });
    await pool.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [stored.rows[0].id]);
    const access = signAccess(p.sub), refresh = signRefresh(p.sub);
    await storeRefresh(p.sub, refresh);
    res.json({ accessToken: access, refreshToken: refresh });
  } catch { res.status(401).json({ error: 'Invalid refresh token.' }); }
});

// POST /logout
router.post('/logout', requireAuth, async (req, res) => {
  if (req.body.refreshToken)
    await pool.query('UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1', [hashToken(req.body.refreshToken)]);
  res.json({ message: 'Logged out.' });
});

// POST /forgot-password
router.post('/forgot-password', authLimiter, [body('email').isEmail().normalizeEmail()], async (req, res) => {
  if (!ok(req, res)) return;
  res.json({ message: 'If an account exists with that email, a reset code has been sent.' });
  try {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE email=$1 AND email_verified=true', [req.body.email]);
    if (!rows[0]) return;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query(`INSERT INTO verification_codes (user_id, code, type) VALUES ($1, $2, 'password_reset')`, [rows[0].id, code]);
    await resend.emails.send({ from: FROM, to: req.body.email, subject: 'Reset your Hassabe password',
      html: `<p style="font-family:sans-serif">Hi ${rows[0].name},</p>
             <p style="font-family:sans-serif">Password reset code:</p>
             <p style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:.15em;color:#2A1C06">${code}</p>
             <p style="font-family:sans-serif;color:#888;font-size:13px">Expires in 15 minutes.</p>`,
    });
  } catch (e) { console.error('Forgot password:', e.message); }
});

// POST /reset-password
router.post('/reset-password', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min:6, max:6 }),
  body('newPassword').isLength({ min:8 }),
], async (req, res) => {
  if (!ok(req, res)) return;
  const { email, code, newPassword } = req.body;
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!rows[0]) return res.status(400).json({ error: 'Invalid request.' });
    const vc = await pool.query(
      `SELECT id FROM verification_codes WHERE user_id=$1 AND code=$2 AND type='password_reset' AND used=false AND expires_at>now()`,
      [rows[0].id, code]
    );
    if (!vc.rows[0]) return res.status(400).json({ error: 'Invalid or expired code.' });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), rows[0].id]);
    await pool.query('UPDATE verification_codes SET used=true WHERE id=$1', [vc.rows[0].id]);
    await pool.query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [rows[0].id]);
    res.json({ message: 'Password reset. Please log in.' });
  } catch { res.status(500).json({ error: 'Reset failed.' }); }
});

// POST /resend-verification
router.post('/resend-verification', authLimiter, [body('userId').isUUID()], async (req, res) => {
  if (!ok(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT email, name FROM users WHERE id=$1 AND email_verified=false', [req.body.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found or already verified.' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query(`UPDATE verification_codes SET used=true WHERE user_id=$1 AND type='email'`, [req.body.userId]);
    await pool.query(`INSERT INTO verification_codes (user_id, code, type) VALUES ($1, $2, 'email')`, [req.body.userId, code]);
    await resend.emails.send({ from: FROM, to: rows[0].email, subject: `${code} — your Hassabe verification code`,
      html: `<p style="font-family:sans-serif">New code: <strong style="font-size:24px;letter-spacing:.12em">${code}</strong></p>`,
    });
    res.json({ message: 'Verification code resent.' });
  } catch { res.status(500).json({ error: 'Resend failed.' }); }
});

// POST /setup-2fa
router.post('/setup-2fa', requireAuth, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `Hassabe (${req.user.email})`, length: 20 });
    await pool.query('UPDATE users SET tfa_secret=$1 WHERE id=$2', [secret.base32, req.user.id]);
    res.json({ qrCode: await qrcode.toDataURL(secret.otpauth_url), secret: secret.base32 });
  } catch { res.status(500).json({ error: '2FA setup failed.' }); }
});

// POST /confirm-2fa
router.post('/confirm-2fa', requireAuth, [body('code').isLength({ min:6, max:6 })], async (req, res) => {
  if (!ok(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT tfa_secret FROM users WHERE id=$1', [req.user.id]);
    const valid = speakeasy.totp.verify({ secret: rows[0].tfa_secret, encoding: 'base32', token: req.body.code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid code. Try again.' });
    await pool.query('UPDATE users SET tfa_enabled=true WHERE id=$1', [req.user.id]);
    res.json({ message: '2FA enabled on your account.' });
  } catch { res.status(500).json({ error: '2FA confirmation failed.' }); }
});

// GET /me
router.get('/me', requireAuth, (req, res) => res.json({ id: req.user.id, email: req.user.email }));

module.exports = router;
