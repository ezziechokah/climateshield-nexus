CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'sw')),
  role TEXT NOT NULL DEFAULT 'FARMER' CHECK (role IN ('FARMER', 'FIELD_AGENT', 'ADMIN')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recovery_tokens_expiry_idx ON recovery_tokens(expires_at);
CREATE TABLE webhook_nonces (
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(provider, nonce)
);
CREATE INDEX webhook_nonces_expiry_idx ON webhook_nonces(expires_at);
CREATE TABLE farms (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  county TEXT NOT NULL,
  locality TEXT NOT NULL,
  latitude DOUBLE PRECISION CHECK (latitude BETWEEN -4.8 AND 5.2),
  longitude DOUBLE PRECISION CHECK (longitude BETWEEN 33.8 AND 42.2),
  location_source TEXT NOT NULL CHECK (location_source IN ('manual', 'gps', 'assisted')),
  crop TEXT NOT NULL,
  planting_date DATE,
  irrigation TEXT NOT NULL DEFAULT 'unknown' CHECK (irrigation IN ('none', 'limited', 'available', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX farms_user_created_idx ON farms(user_id, created_at DESC);
CREATE TABLE climate_records (
  id UUID PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  data_kind TEXT NOT NULL CHECK (data_kind IN ('forecast', 'observation', 'historical', 'synthetic')),
  retrieved_at TIMESTAMPTZ NOT NULL,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  units JSONB NOT NULL,
  values_json JSONB NOT NULL,
  quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX climate_records_farm_time_idx ON climate_records(farm_id, retrieved_at DESC);
CREATE TABLE assessments (
  id UUID PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  climate_record_id UUID REFERENCES climate_records(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  source TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assessments_user_created_idx ON assessments(user_id, created_at DESC);
CREATE TABLE recommendations (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'sw')),
  evidence_quality TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sms_opted_out BOOLEAN NOT NULL DEFAULT false,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notification_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES notification_requests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE message_events (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  provider_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ussd_sessions (
  session_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  values_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ussd_sessions_updated_idx ON ussd_sessions(updated_at);
CREATE TABLE feedback (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
  understandable BOOLEAN NOT NULL,
  useful BOOLEAN NOT NULL,
  acted_on BOOLEAN NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feedback_created_idx ON feedback(created_at DESC);
CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);
CREATE TABLE sync_operations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);