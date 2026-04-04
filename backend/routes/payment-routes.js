// ═══════════════════════════════════════════════════════════════
//  HASSABE — Payment Routes  (Step 8)
//  File: payment-routes.js
//
//  Routes:
//   POST /api/payments/checkout/:matchId  — create Stripe checkout session
//   POST /api/payments/webhook            — Stripe webhook (raw body required)
//   GET  /api/payments/history            — user's payment history
//   GET  /api/payments/:paymentId         — single payment detail
//   POST /api/payments/refund/:paymentId  — admin: process refund
//   GET  /api/payments/admin/summary      — admin: revenue dashboard
//   POST /api/payments/subscription       — create Gold subscription (Hassabe Gold)
//   DELETE /api/payments/subscription     — cancel Gold subscription
//
//  Payment flow:
//   1. User clicks "Unlock Conversation" on match-result.html
//   2. Frontend calls POST /api/payments/checkout/:matchId
//   3. Backend creates a Stripe Checkout Session
//   4. User redirected to Stripe-hosted checkout page
//   5. User completes payment → Stripe redirects to /payment/success
//   6. Stripe sends webhook: checkout.session.completed
//   7. Webhook handler:
//      a. Verifies Stripe signature
//      b. Marks match as messaging_unlocked
//      c. Stores payment record
//      d. Sends notifications to both users
//      e. Sends receipt email
//   8. User sees chat interface (Step 9)
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const Stripe   = require('stripe');
const jwt      = require('jsonwebtoken');
const { param, body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { notify, notifyPair } = require('../notification-service');
const { sendReceiptEmail }   = require('../payment-email');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ── Price constants ──
const PRICES = {
  CONVERSATION_UNLOCK: 4999,          // $49.99 in cents
  GOLD_MONTHLY:        1999,          // $19.99/month
  GOLD_ANNUAL:         14999,         // $149.99/year (~37% off)
  CURRENCY:            'usd',
};

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
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
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

const payLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// ══════════════════════════════════════════════════════════════
//  POST /api/payments/checkout/:matchId
//  Creates a Stripe Checkout Session for a conversation unlock.
//  Returns { checkoutUrl } — frontend redirects the user there.
// ══════════════════════════════════════════════════════════════
router.post('/checkout/:matchId',
  requireAuth,
  payLimiter,
  [param('matchId').isUUID()],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    const { matchId } = req.params;

    try {
      // Verify match exists, user is a participant, and it's approved
      const matchResult = await pool.query(`
        SELECT m.id, m.status, m.user_a_id, m.user_b_id,
               m.payment_id, m.messaging_unlocked_at,
               p.first_name AS partner_first_name
        FROM matches m
        JOIN profiles p ON p.user_id = (
          CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
        )
        WHERE m.id = $1 AND (m.user_a_id = $2 OR m.user_b_id = $2)
      `, [matchId, req.user.id]);

      if (!matchResult.rows[0]) {
        return res.status(404).json({ error: 'Match not found' });
      }

      const match = matchResult.rows[0];

      if (match.status !== 'approved') {
        return res.status(400).json({
          error: `Match must be approved before unlocking. Current status: ${match.status}`,
        });
      }

      if (match.messaging_unlocked_at) {
        return res.status(409).json({
          error: 'This conversation is already unlocked.',
          unlockedAt: match.messaging_unlocked_at,
        });
      }

      // Check for existing unpaid session (idempotency)
      const existingPayment = await pool.query(`
        SELECT stripe_session_id, stripe_payment_url, status
        FROM payments
        WHERE match_id = $1 AND user_id = $2
          AND status = 'pending'
          AND created_at > now() - interval '30 minutes'
        ORDER BY created_at DESC LIMIT 1
      `, [matchId, req.user.id]);

      if (existingPayment.rows[0]?.stripe_payment_url) {
        return res.json({
          checkoutUrl:  existingPayment.rows[0].stripe_payment_url,
          sessionId:    existingPayment.rows[0].stripe_session_id,
          reused:       true,
        });
      }

      // Get or create Stripe customer for this user
      const stripeCustomerId = await getOrCreateStripeCustomer(req.user.id, req.user.email, req.user.name);

      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        customer:              stripeCustomerId,
        payment_method_types:  ['card'],
        line_items: [{
          price_data: {
            currency:     PRICES.CURRENCY,
            unit_amount:  PRICES.CONVERSATION_UNLOCK,
            product_data: {
              name:        'Hassabe — Conversation Unlock',
              description: `Unlock your private conversation with ${match.partner_first_name}. Includes 30-day messaging window and AI-generated icebreakers.`,
              images:      ['https://hassabe.com/assets/unlock-preview.png'],
              metadata:    { matchId, userId: req.user.id },
            },
          },
          quantity: 1,
        }],
        mode:        'payment',
        success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}&matchId=${matchId}`,
        cancel_url:  `${process.env.FRONTEND_URL}/matches?cancelled=true&matchId=${matchId}`,
        metadata: {
          matchId,
          userId:           req.user.id,
          partnerId:        match.user_a_id === req.user.id ? match.user_b_id : match.user_a_id,
          paymentType:      'conversation_unlock',
          partnerFirstName: match.partner_first_name,
        },
        payment_intent_data: {
          metadata: { matchId, userId: req.user.id },
          description: `Hassabe conversation unlock — match ${matchId.slice(0,8)}`,
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        phone_number_collection:    { enabled: false },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30-minute session
      });

      // Store pending payment record
      await pool.query(`
        INSERT INTO payments
          (user_id, match_id, amount, currency, payment_type,
           stripe_session_id, stripe_payment_url, status)
        VALUES ($1, $2, $3, $4, 'conversation_unlock', $5, $6, 'pending')
      `, [
        req.user.id, matchId,
        PRICES.CONVERSATION_UNLOCK, PRICES.CURRENCY,
        session.id, session.url,
      ]);

      res.json({
        checkoutUrl: session.url,
        sessionId:   session.id,
        expiresAt:   new Date(session.expires_at * 1000).toISOString(),
        amount:      PRICES.CONVERSATION_UNLOCK,
        currency:    PRICES.CURRENCY,
      });

    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).json({ error: 'Failed to create checkout session. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/payments/webhook — Stripe webhook handler
//  CRITICAL: This route must use raw body (not JSON parsed).
//  Mount BEFORE express.json() middleware in server.js.
// ══════════════════════════════════════════════════════════════
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[Webhook] Signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }

    console.log(`[Webhook] Event: ${event.type} — ${event.id}`);

    // Idempotency: check if already processed
    const existing = await pool.query(
      'SELECT id FROM webhook_events WHERE stripe_event_id = $1', [event.id]
    );
    if (existing.rows[0]) {
      console.log(`[Webhook] Already processed: ${event.id}`);
      return res.json({ received: true, duplicate: true });
    }

    // Record the event
    await pool.query(
      `INSERT INTO webhook_events (stripe_event_id, event_type, payload)
       VALUES ($1, $2, $3)`,
      [event.id, event.type, JSON.stringify(event)]
    ).catch(() => {});

    // Process the event
    try {
      switch (event.type) {

        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentFailed(event.data.object);
          break;

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionUpdate(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionCancelled(event.data.object);
          break;

        case 'invoice.payment_succeeded':
          await handleInvoicePaid(event.data.object);
          break;

        case 'charge.refunded':
          await handleRefund(event.data.object);
          break;

        default:
          console.log(`[Webhook] Unhandled event type: ${event.type}`);
      }

      // Mark event as processed
      await pool.query(
        'UPDATE webhook_events SET processed = true WHERE stripe_event_id = $1', [event.id]
      );

    } catch (err) {
      console.error(`[Webhook] Handler error for ${event.type}:`, err);
      await pool.query(
        'UPDATE webhook_events SET error = $1 WHERE stripe_event_id = $2',
        [err.message, event.id]
      );
      // Still return 200 to prevent Stripe retry loop for application errors
    }

    res.json({ received: true });
  }
);

// ── Webhook handlers ──────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  const { matchId, userId, partnerId, paymentType, partnerFirstName } = session.metadata || {};
  if (!matchId || !userId) {
    console.error('[Webhook] Missing metadata in checkout session:', session.id);
    return;
  }

  const amount   = session.amount_total;
  const currency = session.currency;
  const paymentIntentId = session.payment_intent;

  await pool.query('BEGIN');

  try {
    if (paymentType === 'conversation_unlock') {
      // Update payment record
      await pool.query(`
        UPDATE payments SET
          status                = 'succeeded',
          stripe_payment_intent = $1,
          stripe_customer_id    = $2,
          amount                = $3,
          updated_at            = now()
        WHERE stripe_session_id = $4
      `, [paymentIntentId, session.customer, amount, session.id]);

      // Unlock the conversation
      const unlockResult = await pool.query(`
        UPDATE matches SET
          status                = 'messaging_unlocked',
          payment_id            = (SELECT id FROM payments WHERE stripe_session_id = $1),
          messaging_unlocked_at = now(),
          expires_at            = now() + interval '30 days',
          updated_at            = now()
        WHERE id = $2 AND status = 'approved'
        RETURNING id, user_a_id, user_b_id
      `, [session.id, matchId]);

      if (!unlockResult.rows[0]) {
        console.warn('[Webhook] Match not found or already unlocked:', matchId);
        await pool.query('ROLLBACK');
        return;
      }

      const match = unlockResult.rows[0];
      const pId   = partnerId || (match.user_a_id === userId ? match.user_b_id : match.user_a_id);

      await pool.query('COMMIT');

      // Get partner's first name for notification
      const myProfileResult = await pool.query(
        'SELECT first_name FROM profiles WHERE user_id = $1', [userId]
      );
      const myFirstName = myProfileResult.rows[0]?.first_name || 'Your match';

      // Notify both users
      await notifyPair(
        userId, pId,
        'messaging_unlocked',
        { matchId, partnerFirstName },
        { matchId, partnerFirstName: myFirstName }
      );

      // Send receipt email to payer
      const payerResult = await pool.query(
        'SELECT u.email, u.name, p.first_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1',
        [userId]
      );
      if (payerResult.rows[0]) {
        await sendReceiptEmail({
          email:          payerResult.rows[0].email,
          firstName:      payerResult.rows[0].first_name || payerResult.rows[0].name,
          partnerName:    partnerFirstName,
          amount,
          currency,
          paymentIntentId,
          matchId,
          receiptUrl:     session.receipt_url || null,
        }).catch(err => console.warn('[Webhook] Receipt email failed:', err.message));
      }

      console.log(`[Webhook] ✓ Conversation unlocked: match ${matchId}`);

    } else if (paymentType === 'gold_subscription') {
      await pool.query(`
        UPDATE users SET subscription_tier = 'gold', updated_at = now() WHERE id = $1
      `, [userId]);
      await pool.query('COMMIT');
      console.log(`[Webhook] ✓ Gold subscription activated for user ${userId}`);
    }

  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

async function handlePaymentFailed(paymentIntent) {
  const { matchId } = paymentIntent.metadata || {};
  if (!matchId) return;

  await pool.query(`
    UPDATE payments SET status = 'failed', updated_at = now()
    WHERE stripe_payment_intent = $1
  `, [paymentIntent.id]);

  console.log(`[Webhook] Payment failed for match ${matchId}: ${paymentIntent.last_payment_error?.message}`);
}

async function handleSubscriptionUpdate(subscription) {
  const customerId = subscription.customer;
  const tier       = subscription.status === 'active' ? 'gold' : 'free';

  await pool.query(`
    UPDATE users SET subscription_tier = $1, updated_at = now()
    WHERE stripe_customer_id = $2
  `, [tier, customerId]);
}

async function handleSubscriptionCancelled(subscription) {
  await pool.query(`
    UPDATE users SET subscription_tier = 'free', updated_at = now()
    WHERE stripe_customer_id = $1
  `, [subscription.customer]);
  console.log(`[Webhook] Subscription cancelled for customer ${subscription.customer}`);
}

async function handleInvoicePaid(invoice) {
  // Record recurring Gold subscription payments
  if (invoice.subscription) {
    await pool.query(`
      INSERT INTO payments (user_id, amount, currency, payment_type, stripe_payment_intent, status)
      SELECT u.id, $1, $2, 'gold_subscription', $3, 'succeeded'
      FROM users u WHERE u.stripe_customer_id = $4
      ON CONFLICT DO NOTHING
    `, [invoice.amount_paid, invoice.currency, invoice.payment_intent, invoice.customer]);
  }
}

async function handleRefund(charge) {
  await pool.query(`
    UPDATE payments SET
      status     = 'refunded',
      refunded_at = now(),
      updated_at  = now()
    WHERE stripe_payment_intent = $1
  `, [charge.payment_intent]);

  // If conversation unlock was refunded, re-lock the conversation
  const paymentResult = await pool.query(
    'SELECT match_id FROM payments WHERE stripe_payment_intent = $1 AND payment_type = $2',
    [charge.payment_intent, 'conversation_unlock']
  );

  if (paymentResult.rows[0]?.match_id) {
    await pool.query(`
      UPDATE matches SET
        status                = 'approved',
        messaging_unlocked_at = NULL,
        payment_id            = NULL,
        expires_at            = NULL,
        updated_at            = now()
      WHERE id = $1
    `, [paymentResult.rows[0].match_id]);
    console.log(`[Webhook] Conversation re-locked after refund: ${paymentResult.rows[0].match_id}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  GET /api/payments/history — User's payment history
// ══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id, p.amount, p.currency, p.payment_type,
        p.status, p.stripe_payment_intent,
        p.refunded_at, p.created_at,
        m.id AS match_id, m.combined_score,
        pr.first_name AS partner_first_name
      FROM payments p
      LEFT JOIN matches m ON m.id = p.match_id
      LEFT JOIN profiles pr ON pr.user_id = (
        CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
      )
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
      LIMIT 50
    `, [req.user.id]);

    res.json({
      payments: result.rows.map(p => ({
        id:                 p.id,
        amount:             p.amount,
        amountFormatted:    `$${(p.amount / 100).toFixed(2)}`,
        currency:           p.currency,
        type:               p.payment_type,
        status:             p.status,
        paymentIntentId:    p.stripe_payment_intent,
        refundedAt:         p.refunded_at,
        createdAt:          p.created_at,
        match:              p.match_id ? {
          id:          p.match_id,
          score:       p.combined_score,
          partnerName: p.partner_first_name,
        } : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/payments/refund/:paymentId — Admin refund
// ══════════════════════════════════════════════════════════════
router.post('/refund/:paymentId',
  requireAdmin,
  [
    param('paymentId').isUUID(),
    body('reason').isIn(['duplicate','fraudulent','requested_by_customer','other']),
    body('amount').optional().isInt({ min: 1 }),
  ],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      const paymentResult = await pool.query(
        'SELECT * FROM payments WHERE id = $1 AND status = $2',
        [req.params.paymentId, 'succeeded']
      );

      if (!paymentResult.rows[0]) {
        return res.status(404).json({ error: 'Payment not found or not eligible for refund' });
      }

      const payment = paymentResult.rows[0];
      const refundAmount = req.body.amount || payment.amount;

      const refund = await stripe.refunds.create({
        payment_intent: payment.stripe_payment_intent,
        amount:         refundAmount,
        reason:         req.body.reason,
        metadata: {
          adminId:   req.user.id,
          paymentId: payment.id,
          matchId:   payment.match_id || '',
        },
      });

      await pool.query(`
        UPDATE payments SET
          status      = $1,
          refunded_at = now(),
          updated_at  = now()
        WHERE id = $2
      `, [refundAmount === payment.amount ? 'refunded' : 'partially_refunded', payment.id]);

      res.json({
        message:      'Refund processed successfully.',
        refundId:     refund.id,
        amount:       refundAmount,
        status:       refund.status,
      });
    } catch (err) {
      console.error('Refund error:', err);
      res.status(500).json({ error: `Refund failed: ${err.message}` });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  POST /api/payments/subscription — Create Gold subscription
// ══════════════════════════════════════════════════════════════
router.post('/subscription',
  requireAuth,
  payLimiter,
  [body('plan').isIn(['monthly', 'annual'])],
  async (req, res) => {
    const err = checkValidation(req, res);
    if (err) return;

    try {
      // Check not already subscribed
      const userResult = await pool.query(
        'SELECT subscription_tier FROM users WHERE id = $1', [req.user.id]
      );
      if (userResult.rows[0]?.subscription_tier === 'gold') {
        return res.status(409).json({ error: 'You already have an active Gold subscription.' });
      }

      const customerId = await getOrCreateStripeCustomer(req.user.id, req.user.email, req.user.name);

      // Create subscription checkout
      const priceId = req.body.plan === 'annual'
        ? process.env.STRIPE_GOLD_ANNUAL_PRICE_ID
        : process.env.STRIPE_GOLD_MONTHLY_PRICE_ID;

      const session = await stripe.checkout.sessions.create({
        customer:            customerId,
        mode:                'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.FRONTEND_URL}/settings?subscription=success`,
        cancel_url:  `${process.env.FRONTEND_URL}/settings?subscription=cancelled`,
        metadata: {
          userId:      req.user.id,
          paymentType: 'gold_subscription',
          plan:        req.body.plan,
        },
        allow_promotion_codes:      true,
        billing_address_collection: 'auto',
      });

      res.json({ checkoutUrl: session.url, sessionId: session.id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create subscription.' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  DELETE /api/payments/subscription — Cancel Gold subscription
// ══════════════════════════════════════════════════════════════
router.delete('/subscription', requireAuth, async (req, res) => {
  try {
    const customerResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]
    );
    const customerId = customerResult.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'No active subscription found' });

    // Find active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId, status: 'active', limit: 1,
    });

    if (!subscriptions.data[0]) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel at period end (not immediately)
    await stripe.subscriptions.update(subscriptions.data[0].id, {
      cancel_at_period_end: true,
    });

    res.json({
      message: 'Subscription will cancel at the end of your current billing period.',
      cancelAt: new Date(subscriptions.data[0].current_period_end * 1000).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/payments/admin/summary — Revenue dashboard
// ══════════════════════════════════════════════════════════════
router.get('/admin/summary', requireAdmin, async (req, res) => {
  try {
    const [totals, monthly, recent] = await Promise.all([
      pool.query(`
        SELECT
          SUM(amount) FILTER (WHERE status = 'succeeded')    AS total_revenue,
          COUNT(*)    FILTER (WHERE status = 'succeeded')    AS total_payments,
          COUNT(*)    FILTER (WHERE payment_type = 'conversation_unlock' AND status = 'succeeded') AS unlocks,
          COUNT(*)    FILTER (WHERE payment_type = 'gold_subscription' AND status = 'succeeded')   AS gold_subs,
          SUM(amount) FILTER (WHERE status = 'refunded')     AS total_refunded,
          COUNT(*)    FILTER (WHERE status = 'refunded')     AS refund_count
        FROM payments
      `),
      pool.query(`
        SELECT
          date_trunc('month', created_at) AS month,
          SUM(amount)  AS revenue,
          COUNT(*)     AS payments
        FROM payments
        WHERE status = 'succeeded'
          AND created_at > now() - interval '12 months'
        GROUP BY 1 ORDER BY 1 DESC
      `),
      pool.query(`
        SELECT p.id, p.amount, p.payment_type, p.status, p.created_at,
               u.email, pr.first_name
        FROM payments p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN profiles pr ON pr.user_id = p.user_id
        ORDER BY p.created_at DESC LIMIT 10
      `),
    ]);

    const t = totals.rows[0];
    res.json({
      totals: {
        revenue:       t.total_revenue || 0,
        revenueFormatted: `$${((t.total_revenue || 0) / 100).toFixed(2)}`,
        payments:      parseInt(t.total_payments || 0),
        unlocks:       parseInt(t.unlocks || 0),
        goldSubs:      parseInt(t.gold_subs || 0),
        refunded:      t.total_refunded || 0,
        refundCount:   parseInt(t.refund_count || 0),
      },
      monthly: monthly.rows.map(r => ({
        month:    r.month,
        revenue:  r.revenue,
        payments: parseInt(r.payments),
      })),
      recent: recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment summary' });
  }
});

// ══════════════════════════════════════════════════════════════
//  HELPER: Get or create Stripe customer
// ══════════════════════════════════════════════════════════════
async function getOrCreateStripeCustomer(userId, email, name) {
  // Check if user already has a Stripe customer ID
  const result = await pool.query(
    'SELECT stripe_customer_id FROM users WHERE id = $1', [userId]
  );

  if (result.rows[0]?.stripe_customer_id) {
    return result.rows[0].stripe_customer_id;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { hassabe_user_id: userId },
  });

  // Save to database
  await pool.query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, userId]
  );

  return customer.id;
}

module.exports = router;

// ══════════════════════════════════════════════════════════════
//  MOUNT IN server.js — WEBHOOK MUST BE BEFORE express.json():
//
//  // 1. Webhook route FIRST (needs raw body)
//  const paymentRoutes = require('./payment-routes');
//  app.use('/api/payments/webhook',
//    express.raw({ type: 'application/json' }),
//    paymentRoutes
//  );
//
//  // 2. JSON middleware for all other routes
//  app.use(express.json());
//
//  // 3. All other payment routes
//  app.use('/api/payments', paymentRoutes);
//
//  PACKAGES: npm install stripe
//
//  ENV VARIABLES NEEDED:
//   STRIPE_SECRET_KEY          — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET      — whsec_...
//   STRIPE_GOLD_MONTHLY_PRICE_ID  — price_...
//   STRIPE_GOLD_ANNUAL_PRICE_ID   — price_...
// ══════════════════════════════════════════════════════════════
