╔══════════════════════════════════════════════════════════════════╗
║  HASSABE (ሃሳቤ) — Complete Fullstack App                         ║
║  hassabe.com · AI Matchmaking for Habesha Professionals          ║
╚══════════════════════════════════════════════════════════════════╝

Stack:   GitHub · Supabase · Vercel (frontend) · Railway (backend)
Price:   $49.99 per conversation unlock (~$47.97 net after Stripe)
Cities:  Calgary · Edmonton · Vancouver · Toronto
         Washington DC · New York · Los Angeles
Cost:    ~$8.50/month · Break-even: 1 payment


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FILES IN THIS PACKAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

backend/                        → Deploy to Railway
  server.js                     Single entry point — mounts all routes
  package.json                  All npm dependencies
  railway.json                  Railway deployment config
  .env.example                  Copy → .env, fill every value
  matching-engine.js            Nightly AI engine (pgvector + GPT-4o)
  chat-server.js                Socket.IO real-time server
  notification-service.js       FCM push + Resend email
  payment-email.js              Receipt, refund, Gold email templates
  routes/
    auth-routes.js              Register, login, 2FA, refresh, logout
    profile-routes.js           Profile CRUD (7-step, no photos)
    questionnaire-routes.js     Round 1 (30 questions + embeddings)
    match-routes.js             Match API + nightly cron
    round2-routes.js            Round 2 + final scoring
    notification-routes.js      FCM tokens + broadcast
    payment-routes.js           Stripe checkout + webhook + refunds
    chat-routes.js              Message history + voice + status
    admin-routes.js             Admin panel API (20 endpoints)

frontend/                       → Deploy to Vercel
  vercel.json                   Vercel routing config
  js/config.js                  ← EDIT THIS FIRST (API URL + Stripe key)
  assets/logo.png               Hassabe logo
  landing.html                  Waitlist / home page
  auth.html                     Login / signup / 2FA
  onboarding.html               7-step profile builder
  questionnaire-r1.html         Round 1 (30 questions)
  matches.html                  Live match dashboard
  notifications.html            Notification center
  questionnaire-r2.html         Round 2 (25 deep questions)
  match-result.html             Approved / declined screen
  payment.html                  $49.99 Stripe checkout + history
  chat.html                     Real-time messaging + voice notes
  admin.html                    Admin dashboard (all panels, live data)
  firebase-messaging-sw.js      Push notification service worker

database/
  schema.sql                    Run once in Supabase → creates everything

.gitignore                      Git ignore file


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  BEFORE ANYTHING: Edit frontend/js/config.js
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Open frontend/js/config.js and change two lines:

  API:       'https://your-hassabe-backend.railway.app'  ← Railway URL
  STRIPE_PK: 'pk_live_your_stripe_publishable_key'       ← Stripe key

One file, done. Every page reads from it.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 1 — GitHub
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Create a GitHub repo and push this entire folder:

  git init
  git add .
  git commit -m "Hassabe v1.0"
  git remote add origin https://github.com/YOUR_USERNAME/hassabe.git
  git push -u origin main

Both Vercel and Railway will connect to this repo and auto-deploy
every time you push a change.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 2 — Supabase (database)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. supabase.com → New project → name it "hassabe"
2. SQL Editor → paste all of database/schema.sql → Run
   You'll see: "Hassabe database schema installed successfully."
3. Settings → Database → Connection string (URI)
   Copy it: postgresql://postgres:[PWD]@db.[REF].supabase.co:5432/postgres
   This becomes DATABASE_URL in your Railway env variables


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 3 — Railway (backend)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. railway.app → Login with GitHub → New Project
2. Deploy from GitHub repo → select your hassabe repo
3. Settings → Root Directory → set to "backend"
4. Variables tab → add everything from backend/.env.example
   (fill in every value — see GETTING API KEYS below)
5. Your backend URL:  https://hassabe-backend-xxxx.railway.app
   → Put this in frontend/js/config.js as API, then push to GitHub


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 4 — Vercel (frontend)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. vercel.com → Login with GitHub → New Project
2. Import your hassabe GitHub repo
3. Configure:
     Framework Preset:  Other
     Root Directory:    frontend
     Build Command:     (leave empty)
     Output Directory:  . (dot)
4. Deploy
5. Settings → Domains → Add hassabe.com and www.hassabe.com
   Vercel gives you DNS records — add them at your domain registrar:
     A     @    76.76.21.21
     CNAME www  cname.vercel-dns.com

SSL certificates are automatic. Custom domain is free on Vercel.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 5 — Stripe Webhook
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stripe Dashboard → Developers → Webhooks → Add endpoint:
  URL: https://hassabe-backend-xxxx.railway.app/api/payments/webhook
  Events:
    checkout.session.completed
    payment_intent.payment_failed
    charge.refunded
    customer.subscription.created
    customer.subscription.deleted
    invoice.payment_succeeded

Copy the Signing secret (whsec_xxx) → add as STRIPE_WEBHOOK_SECRET in Railway


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STEP 6 — Go live
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Visit hassabe.com/auth.html → create your account
2. Supabase SQL Editor:
   UPDATE users SET is_admin = true WHERE email = 'your@email.com';
3. Visit hassabe.com/admin.html — live admin dashboard
4. Create two test accounts, complete profile + Round 1
5. Admin → AI Engine → Run Live Match
6. Complete Round 2 on both accounts
7. Stripe test card: 4242 4242 4242 4242 → confirm $49.99 payment
8. Confirm chat unlocks and real-time messaging works
9. When ready: swap Stripe test keys for live keys in Railway


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  GETTING API KEYS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATABASE_URL     Supabase → Settings → Database → URI
JWT_SECRET       node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
RESEND_API_KEY   resend.com → API Keys → Create (add hassabe.com as domain)
OPENAI_API_KEY   platform.openai.com → API Keys
STRIPE_SECRET_KEY          stripe.com → Developers → API Keys (sk_test_ first)
STRIPE_WEBHOOK_SECRET      From webhook endpoint after Step 5
STRIPE_GOLD_MONTHLY_PRICE_ID  Create in Stripe Products: $19.99/mo
STRIPE_GOLD_ANNUAL_PRICE_ID   Create in Stripe Products: $149.99/yr
CLOUDINARY_CLOUD_NAME     cloudinary.com → Dashboard
CLOUDINARY_API_KEY        cloudinary.com → Dashboard
CLOUDINARY_API_SECRET     cloudinary.com → Dashboard
FIREBASE_SERVICE_ACCOUNT_JSON
  Firebase Console → Project Settings → Service Accounts →
  Generate new private key → minify JSON to one line:
  python3 -c "import json; print(json.dumps(json.load(open('key.json'))))"
  Also update firebase-messaging-sw.js with your web config
FRONTEND_URL     https://hassabe.com


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AFTER SETUP — DEPLOYING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  git add . && git commit -m "update" && git push

  Vercel redeploys frontend in ~30 seconds
  Railway redeploys backend in ~60 seconds
  Supabase database stays as-is (run schema changes manually)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MONTHLY COST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Railway (backend)       $5.00
  Supabase (database)     $0.00   free tier
  Vercel (frontend)       $0.00   free tier + custom domain
  GitHub (repo)           $0.00   free
  Cloudinary (voice)      $0.00   25GB free
  Resend (email)          $0.00   3,000/mo free
  Firebase FCM (push)     $0.00   unlimited free
  OpenAI                  ~$2–5
  hassabe.com domain      ~$1.50
                         ──────
  Total                  ~$8.50/month


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  hassabe.com — ሃሳቤ means "My Vision" in Amharic
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
