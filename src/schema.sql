CREATE TABLE IF NOT EXISTS contacts (
  email text PRIMARY KEY,
  consent_source text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  unsubscribe_token uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  unsubscribed_at timestamptz
);

CREATE TABLE IF NOT EXISTS suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  body text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS challenges_email_created ON challenges (email, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane text NOT NULL CHECK (lane IN ('transactional', 'marketing')),
  recipient text NOT NULL,
  subject text,
  body text,
  campaign_id uuid REFERENCES campaigns,
  challenge_id uuid REFERENCES challenges ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'sending', 'accepted', 'failed', 'uncertain', 'suppressed', 'expired'
  )),
  send_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  diagnostic text,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_due ON messages (lane, send_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS messages_sending ON messages (started_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS messages_campaign_status ON messages (campaign_id, status) WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS requests (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lane_limits (
  lane text PRIMARY KEY,
  next_at timestamptz NOT NULL DEFAULT now(),
  quota_day date,
  attempts integer NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false
);

INSERT INTO lane_limits (lane) VALUES ('transactional'), ('marketing') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS automations (
  event text PRIMARY KEY,
  subject text NOT NULL,
  body text NOT NULL,
  delay_seconds integer NOT NULL,
  enabled boolean NOT NULL
);
