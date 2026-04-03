-- ═══════════════════════════════════════════════════════════════
--  HASSABE — Master Database Schema
--  Run this ONCE in Supabase SQL Editor to set up the full database.
--  Paste the entire file and click Run.
-- ═══════════════════════════════════════════════════════════════

-- ── Enable required extensions ───────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;


-- ════════════════════════════════════════════════════════════════
--  STEP 1: CORE TABLES
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               VARCHAR(255) UNIQUE NOT NULL,
  phone               VARCHAR(30),
  password_hash       VARCHAR(255),
  auth_provider       VARCHAR(20)  NOT NULL DEFAULT 'email',
  name                VARCHAR(120),
  status              VARCHAR(20)  NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','deleted')),
  email_verified      BOOLEAN      NOT NULL DEFAULT false,
  phone_verified      BOOLEAN      NOT NULL DEFAULT false,
  tfa_enabled         BOOLEAN      NOT NULL DEFAULT false,
  tfa_secret          VARCHAR(100),
  profile_complete    BOOLEAN      NOT NULL DEFAULT false,
  r1_complete         BOOLEAN      NOT NULL DEFAULT false,
  subscription_tier   VARCHAR(20)  NOT NULL DEFAULT 'free',
  stripe_customer_id  VARCHAR(60),
  is_admin            BOOLEAN      NOT NULL DEFAULT false,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;


-- Verification codes (email/phone OTP)
CREATE TABLE IF NOT EXISTS verification_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        VARCHAR(10) NOT NULL,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('email','phone','password_reset')),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vcodes_user ON verification_codes(user_id, type, used);


-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  revoked     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rtokens_user ON refresh_tokens(user_id);


-- ════════════════════════════════════════════════════════════════
--  STEP 2: PROFILES (no photos — text-only)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profiles (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Basic info
  first_name               VARCHAR(60)  NOT NULL,
  last_name                VARCHAR(60)  NOT NULL,
  date_of_birth            DATE         NOT NULL,
  gender                   VARCHAR(20)  NOT NULL CHECK (gender IN ('male','female','other')),
  seeking                  VARCHAR(20)  NOT NULL DEFAULT 'all',
  city                     VARCHAR(100) NOT NULL,
  country                  VARCHAR(4),

  -- Career & Education
  profession               VARCHAR(120),
  industry                 VARCHAR(80),
  education_level          VARCHAR(60),
  field_of_study           VARCHAR(100),
  residency_status         VARCHAR(40),

  -- Identity & Heritage
  ethnicity                TEXT[]       NOT NULL DEFAULT '{}',
  languages                TEXT[]       NOT NULL DEFAULT '{}',
  heritage_strength        SMALLINT     NOT NULL DEFAULT 3 CHECK (heritage_strength BETWEEN 1 AND 5),

  -- Faith & Religion
  religion                 VARCHAR(40),
  practice_level           VARCHAR(30),
  faith_match_importance   SMALLINT     NOT NULL DEFAULT 3 CHECK (faith_match_importance BETWEEN 1 AND 5),

  -- Relationship Goals
  relationship_goal        VARCHAR(40),
  marital_history          VARCHAR(20),
  children_preference      VARCHAR(30),
  open_to_relocation       VARCHAR(20),
  partner_age_min          SMALLINT     NOT NULL DEFAULT 18,
  partner_age_max          SMALLINT     NOT NULL DEFAULT 65,

  -- Lifestyle
  weekend_activities       TEXT[]       NOT NULL DEFAULT '{}',
  career_balance           VARCHAR(30),
  deal_breakers            TEXT[]       NOT NULL DEFAULT '{}',

  -- Bio (carries 35 pts in score — increased since no photos)
  bio                      VARCHAR(500),

  -- Scoring & visibility
  profile_score            SMALLINT     NOT NULL DEFAULT 0,
  is_verified              BOOLEAN      NOT NULL DEFAULT false,
  is_visible               BOOLEAN      NOT NULL DEFAULT true,
  matching_pool            BOOLEAN      NOT NULL DEFAULT false,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user         ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_gender       ON profiles(gender);
CREATE INDEX IF NOT EXISTS idx_profiles_country      ON profiles(country);
CREATE INDEX IF NOT EXISTS idx_profiles_religion     ON profiles(religion);
CREATE INDEX IF NOT EXISTS idx_profiles_score        ON profiles(profile_score DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_pool         ON profiles(matching_pool) WHERE matching_pool = true;
CREATE INDEX IF NOT EXISTS idx_profiles_ethnicity    ON profiles USING GIN(ethnicity);
CREATE INDEX IF NOT EXISTS idx_profiles_languages    ON profiles USING GIN(languages);
CREATE INDEX IF NOT EXISTS idx_profiles_deal_breakers ON profiles USING GIN(deal_breakers);


-- Auto-set matching_pool when score ≥ 70
CREATE OR REPLACE FUNCTION update_matching_pool()
RETURNS TRIGGER AS $$
BEGIN
  NEW.matching_pool := NEW.profile_score >= 70;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profile_score
  BEFORE INSERT OR UPDATE OF profile_score ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_matching_pool();


-- ════════════════════════════════════════════════════════════════
--  STEP 3: MATCHES
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS matches (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Scores
  r1_score               DECIMAL(5,2),
  r2_score               DECIMAL(5,2),
  combined_score         DECIMAL(5,2),
  score_breakdown        JSONB        NOT NULL DEFAULT '{}',

  -- AI insights
  compatibility_summary  TEXT,
  shared_values          TEXT[],
  icebreakers            TEXT[],
  friction_points        TEXT[],

  -- Status flow
  status                 VARCHAR(30)  NOT NULL DEFAULT 'notified',

  -- Round 2 tracking
  r2_a_completed_at      TIMESTAMPTZ,
  r2_b_completed_at      TIMESTAMPTZ,
  r2_expires_at          TIMESTAMPTZ,

  -- Payment & messaging
  payment_id             UUID,
  messaging_unlocked_at  TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,

  -- Admin
  admin_override         BOOLEAN      NOT NULL DEFAULT false,
  admin_note             TEXT,

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_user_a  ON matches(user_a_id);
CREATE INDEX IF NOT EXISTS idx_matches_user_b  ON matches(user_b_id);
CREATE INDEX IF NOT EXISTS idx_matches_status  ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_score   ON matches(combined_score DESC NULLS LAST);


-- Auto-set r2_expires_at when match is notified
CREATE OR REPLACE FUNCTION set_r2_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('notified','pending_r2')
     AND OLD.status NOT IN ('notified','pending_r2')
     AND NEW.r2_expires_at IS NULL
  THEN
    NEW.r2_expires_at := now() + interval '72 hours';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_r2_expiry
  BEFORE UPDATE OF status ON matches
  FOR EACH ROW EXECUTE FUNCTION set_r2_expiry();


-- ════════════════════════════════════════════════════════════════
--  STEP 4: QUESTIONNAIRE RESPONSES + EMBEDDINGS
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round            SMALLINT      NOT NULL CHECK (round IN (1, 2)),
  match_id         UUID          REFERENCES matches(id) ON DELETE SET NULL,
  responses        JSONB         NOT NULL DEFAULT '[]',
  narrative_text   TEXT,
  embedding        vector(1536),
  embedding_model  VARCHAR(60),
  dimension_scores JSONB         NOT NULL DEFAULT '{}',
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  status           VARCHAR(20)   NOT NULL DEFAULT 'complete',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE NULLS NOT DISTINCT (user_id, round, match_id)
);

CREATE INDEX IF NOT EXISTS idx_qr_user_round ON questionnaire_responses(user_id, round);
CREATE INDEX IF NOT EXISTS idx_qr_match      ON questionnaire_responses(match_id) WHERE match_id IS NOT NULL;

-- pgvector ANN index (run REINDEX after first 100 rows)
CREATE INDEX IF NOT EXISTS idx_qr_embedding
  ON questionnaire_responses
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);


CREATE TABLE IF NOT EXISTS questionnaire_drafts (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round            SMALLINT     NOT NULL CHECK (round IN (1, 2)),
  match_id         UUID         REFERENCES matches(id) ON DELETE CASCADE,
  current_question SMALLINT     NOT NULL DEFAULT 0,
  answers          JSONB        NOT NULL DEFAULT '{}',
  answers_count    SMALLINT     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE NULLS NOT DISTINCT (user_id, round, match_id)
);

CREATE INDEX IF NOT EXISTS idx_qdraft_user ON questionnaire_drafts(user_id, round);
CREATE INDEX IF NOT EXISTS idx_qdraft_r2
  ON questionnaire_drafts(user_id, match_id)
  WHERE round = 2 AND match_id IS NOT NULL;


-- Cosine similarity helper function
CREATE OR REPLACE FUNCTION cosine_similarity_r1(user_a UUID, user_b UUID)
RETURNS FLOAT AS $$
  SELECT 1 - (
    (SELECT embedding FROM questionnaire_responses WHERE user_id = user_a AND round = 1 AND status = 'complete')
    <=>
    (SELECT embedding FROM questionnaire_responses WHERE user_id = user_b AND round = 1 AND status = 'complete')
  );
$$ LANGUAGE SQL STABLE;


-- Find candidate matches via ANN search
CREATE OR REPLACE FUNCTION find_candidate_matches(
  target_user_id  UUID,
  candidate_limit INT DEFAULT 50
)
RETURNS TABLE (candidate_id UUID, similarity FLOAT) AS $$
DECLARE
  target_embedding vector(1536);
BEGIN
  SELECT qr.embedding INTO target_embedding
  FROM questionnaire_responses qr
  WHERE qr.user_id = target_user_id AND qr.round = 1 AND qr.status = 'complete';

  IF target_embedding IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    qr.user_id AS candidate_id,
    (1 - (qr.embedding <=> target_embedding))::FLOAT AS similarity
  FROM questionnaire_responses qr
  JOIN profiles p ON p.user_id = qr.user_id
  WHERE
    qr.round = 1 AND qr.status = 'complete'
    AND qr.user_id != target_user_id
    AND p.matching_pool = true AND p.is_visible = true
    AND NOT EXISTS (
      SELECT 1 FROM matches m
      WHERE (m.user_a_id = target_user_id AND m.user_b_id = qr.user_id)
         OR (m.user_a_id = qr.user_id AND m.user_b_id = target_user_id)
    )
  ORDER BY qr.embedding <=> target_embedding
  LIMIT candidate_limit;
END;
$$ LANGUAGE plpgsql STABLE;


-- ════════════════════════════════════════════════════════════════
--  STEP 5: NOTIFICATIONS & DEVICES
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(40)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT         NOT NULL,
  data        JSONB        NOT NULL DEFAULT '{}',
  read        BOOLEAN      NOT NULL DEFAULT false,
  read_at     TIMESTAMPTZ,
  pushed      BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread  ON notifications(user_id) WHERE read = false;


CREATE TABLE IF NOT EXISTS device_tokens (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        VARCHAR(500) NOT NULL UNIQUE,
  platform     VARCHAR(10)  NOT NULL CHECK (platform IN ('ios','android','web')),
  device_id    VARCHAR(200),
  app_version  VARCHAR(20),
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  last_seen    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON device_tokens(user_id) WHERE is_active = true;


CREATE TABLE IF NOT EXISTS notification_preferences (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  preferences  JSONB        NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ════════════════════════════════════════════════════════════════
--  STEP 6: PAYMENTS & WEBHOOKS
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id              UUID         REFERENCES matches(id) ON DELETE SET NULL,
  amount                INTEGER      NOT NULL,  -- 4999 = $49.99
  currency              VARCHAR(3)   NOT NULL DEFAULT 'usd',
  payment_type          VARCHAR(30)  NOT NULL,
  status                VARCHAR(30)  NOT NULL DEFAULT 'pending',
  stripe_session_id     VARCHAR(120) UNIQUE,
  stripe_payment_intent VARCHAR(120),
  stripe_customer_id    VARCHAR(60),
  stripe_payment_url    TEXT,
  stripe_subscription_id VARCHAR(120),
  refunded_at           TIMESTAMPTZ,
  refund_amount         INTEGER,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_user    ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_match   ON payments(match_id) WHERE match_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);


CREATE TABLE IF NOT EXISTS webhook_events (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  VARCHAR(120) NOT NULL UNIQUE,
  event_type       VARCHAR(80)  NOT NULL,
  payload          JSONB        NOT NULL DEFAULT '{}',
  processed        BOOLEAN      NOT NULL DEFAULT false,
  error            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_event_id  ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_processed ON webhook_events(processed) WHERE processed = false;


CREATE TABLE IF NOT EXISTS promo_codes (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(30)  NOT NULL UNIQUE,
  stripe_coupon_id VARCHAR(60),
  description     VARCHAR(200),
  discount_type   VARCHAR(10)  NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value  INTEGER      NOT NULL,
  max_uses        INTEGER,
  uses_count      INTEGER      NOT NULL DEFAULT 0,
  valid_from      TIMESTAMPTZ,
  valid_until     TIMESTAMPTZ,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ════════════════════════════════════════════════════════════════
--  STEP 7: MESSAGES
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS messages (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         UUID         NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content          TEXT,
  type             VARCHAR(20)  NOT NULL DEFAULT 'text'
                   CHECK (type IN ('text','voice','ai_starter','system')),
  voice_url        TEXT,
  voice_duration_s SMALLINT,
  sent_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  read_at          TIMESTAMPTZ,
  client_msg_id    VARCHAR(100) UNIQUE,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_match  ON messages(match_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(match_id, sender_id) WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_msg_id) WHERE client_msg_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS message_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      VARCHAR(50) NOT NULL,
  details     TEXT,
  reviewed    BOOLEAN     NOT NULL DEFAULT false,
  action_taken VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_reports_unreviewed ON message_reports(reviewed) WHERE reviewed = false;


-- ════════════════════════════════════════════════════════════════
--  STEP 8: ADMIN & ENGINE
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS match_reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reporter_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       VARCHAR(50) NOT NULL,
  details      TEXT,
  reviewed     BOOLEAN     NOT NULL DEFAULT false,
  action_taken VARCHAR(50),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, reporter_id)
);


CREATE TABLE IF NOT EXISTS engine_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  users_processed       INTEGER     NOT NULL DEFAULT 0,
  candidates_evaluated  INTEGER     NOT NULL DEFAULT 0,
  matches_created       INTEGER     NOT NULL DEFAULT 0,
  errors                INTEGER     NOT NULL DEFAULT 0,
  dry_run               BOOLEAN     NOT NULL DEFAULT false,
  triggered_by          VARCHAR(30) NOT NULL DEFAULT 'scheduler',
  duration_seconds      DECIMAL(8,2),
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_engine_runs_date ON engine_runs(started_at DESC);


CREATE TABLE IF NOT EXISTS scoring_audit (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       UUID         NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  r1_score       DECIMAL(5,2),
  r2_score       DECIMAL(5,2),
  combined_score DECIMAL(5,2),
  r2_breakdown   JSONB        NOT NULL DEFAULT '{}',
  outcome        VARCHAR(20)  NOT NULL,
  triggered_by   VARCHAR(30)  NOT NULL DEFAULT 'auto',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      VARCHAR(60) NOT NULL,
  target_type VARCHAR(30),
  target_id   UUID,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_admin   ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);


-- ════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════

ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE questionnaire_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE questionnaire_drafts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches               ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log       ENABLE ROW LEVEL SECURITY;

-- Users manage their own profile
CREATE POLICY "users_own_profile" ON profiles FOR ALL USING (auth.uid()::uuid = user_id);
-- Users see own responses
CREATE POLICY "users_own_responses" ON questionnaire_responses FOR SELECT USING (auth.uid()::uuid = user_id);
CREATE POLICY "users_insert_responses" ON questionnaire_responses FOR INSERT WITH CHECK (auth.uid()::uuid = user_id);
-- Users see own matches
CREATE POLICY "users_own_matches" ON matches FOR SELECT USING (auth.uid()::uuid = user_a_id OR auth.uid()::uuid = user_b_id);
-- Users see own notifications
CREATE POLICY "users_own_notifications" ON notifications FOR SELECT USING (auth.uid()::uuid = user_id);
CREATE POLICY "users_update_notifications" ON notifications FOR UPDATE USING (auth.uid()::uuid = user_id);
-- Users manage own devices
CREATE POLICY "users_own_devices" ON device_tokens FOR ALL USING (auth.uid()::uuid = user_id);
-- Users see own payments
CREATE POLICY "users_own_payments" ON payments FOR SELECT USING (auth.uid()::uuid = user_id);
-- Users read messages in own unlocked matches
CREATE POLICY "users_read_messages" ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM matches m WHERE m.id = match_id AND (m.user_a_id = auth.uid()::uuid OR m.user_b_id = auth.uid()::uuid) AND m.status = 'messaging_unlocked')
);
CREATE POLICY "users_send_messages" ON messages FOR INSERT WITH CHECK (
  sender_id = auth.uid()::uuid AND
  EXISTS (SELECT 1 FROM matches m WHERE m.id = match_id AND (m.user_a_id = auth.uid()::uuid OR m.user_b_id = auth.uid()::uuid) AND m.status = 'messaging_unlocked')
);
-- Audit log: server-only
CREATE POLICY "no_direct_audit_access" ON admin_audit_log FOR ALL USING (false);
CREATE POLICY "no_direct_webhook_access" ON webhook_events FOR ALL USING (false);


-- ════════════════════════════════════════════════════════════════
--  USEFUL VIEWS
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW system_overview AS
  SELECT
    (SELECT COUNT(*) FROM users WHERE status = 'active')               AS active_users,
    (SELECT COUNT(*) FROM profiles WHERE matching_pool = true)         AS in_pool,
    (SELECT COUNT(*) FROM questionnaire_responses WHERE round = 1 AND status = 'complete') AS r1_done,
    (SELECT COUNT(*) FROM matches WHERE status NOT IN ('expired','declined')) AS active_matches,
    (SELECT COUNT(*) FROM matches WHERE status = 'messaging_unlocked') AS conversations_open,
    (SELECT COUNT(*) FROM match_reports WHERE reviewed = false)        AS open_reports,
    (SELECT SUM(amount) FROM payments WHERE status = 'succeeded'
       AND created_at >= date_trunc('month', now()))                   AS revenue_mtd,
    (SELECT COUNT(*) FROM payments WHERE status = 'succeeded'
       AND payment_type = 'conversation_unlock')                       AS total_unlocks;

CREATE OR REPLACE VIEW monthly_revenue AS
  SELECT
    date_trunc('month', created_at) AS month,
    SUM(amount) FILTER (WHERE status = 'succeeded')  AS gross,
    SUM(amount) FILTER (WHERE status = 'refunded')   AS refunds,
    COUNT(*) FILTER (WHERE status = 'succeeded')     AS payments
  FROM payments
  GROUP BY 1 ORDER BY 1 DESC;


-- ════════════════════════════════════════════════════════════════
--  GRANT YOURSELF ADMIN (run after first signup)
--  UPDATE users SET is_admin = true WHERE email = 'your@email.com';
-- ════════════════════════════════════════════════════════════════

SELECT 'Hassabe database schema installed successfully.' AS result;
