// ═══════════════════════════════════════════════════════════════
//  HASSABE — Main Server  (server.js)
//  Run: npm start   (production)
//  Run: npm run dev (development with nodemon)
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

// ── Route modules ──────────────────────────────────────────────
const authRoutes         = require('./routes/auth-routes');
const profileRoutes      = require('./routes/profile-routes');
const questionnaireRoutes= require('./routes/questionnaire-routes');
const matchRoutes        = require('./routes/match-routes');
const round2Routes       = require('./routes/round2-routes');
const notifRoutes        = require('./routes/notification-routes');
const chatRoutes         = require('./routes/chat-routes');
const adminRoutes        = require('./routes/admin-routes');

// ── Payment webhook needs raw body — mount BEFORE express.json ─
const paymentRoutes      = require('./routes/payment-routes');

// ── Chat server (Socket.IO) ────────────────────────────────────
const { initChatServer } = require('./chat-server');

// ── Scheduler (nightly engine + cron jobs) ────────────────────
const { setupScheduler } = require('./routes/match-routes');

// ──────────────────────────────────────────────────────────────
const app  = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 4000;

// ── Security middleware ────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin:      process.env.FRONTEND_URL || '*',
  credentials: true,
  methods:     ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Global rate limiter ────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  message:  { error: 'Too many requests. Please try again later.' },
  skip:     (req) => req.path === '/health',
}));

// ① Stripe webhook FIRST (needs raw body — not JSON parsed)
app.use('/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  paymentRoutes
);

// ② JSON body parser for all other routes
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Mount all API routes ───────────────────────────────────────
app.use('/api/auth',           authRoutes);
app.use('/api/profile',        profileRoutes);
app.use('/api/questionnaire',  questionnaireRoutes);
app.use('/api/matches',        matchRoutes);
app.use('/api/round2',         round2Routes);
app.use('/api/notifications',  notifRoutes);
app.use('/api/chat',           chatRoutes);
app.use('/api/payments',       paymentRoutes);
app.use('/api/admin',          adminRoutes);

// ── Health check ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '1.0.0',
    app:     'Hassabe',
    time:    new Date().toISOString(),
  });
});

// ── 404 handler ────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ───────────────────────────────────────────────
initChatServer(httpServer);     // Attach Socket.IO

httpServer.listen(PORT, () => {
  console.log(`\n✦  Hassabe server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
  setupScheduler();             // Start cron jobs
});

module.exports = { app, httpServer };
