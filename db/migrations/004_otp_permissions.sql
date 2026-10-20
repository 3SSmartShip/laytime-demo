-- One-time-code sign-in and role-based module permissions.

ALTER TABLE users ADD COLUMN mobile text;
ALTER TABLE users ADD CONSTRAINT users_mobile_format CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{7,14}$');
CREATE UNIQUE INDEX users_mobile_uniq ON users (mobile) WHERE mobile IS NOT NULL;

CREATE TABLE otp_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('login','verify_email','verify_mobile')),
  channel      text NOT NULL CHECK (channel IN ('sms','email')),
  target       text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_user_idx ON otp_codes (user_id, purpose, created_at DESC);

-- Which modules each role may use. tenant_id NULL = default for every organisation;
-- a row with a tenant_id overrides the default for that organisation only.
CREATE TABLE role_permissions (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  role        text NOT NULL,
  module      text NOT NULL,
  enabled     boolean NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_perm_uniq ON role_permissions (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), role, module);
