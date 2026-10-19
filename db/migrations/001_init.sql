CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email                 text NOT NULL,
  name                  text NOT NULL DEFAULT '',
  password_hash         text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('superadmin','admin','member')),
  active                boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  -- platform admins belong to no tenant; everyone else belongs to exactly one
  CONSTRAINT users_role_tenant CHECK ((role = 'superadmin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE voyages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vessel      text NOT NULL DEFAULT '',
  charterers  text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  data        jsonb NOT NULL,
  summary     jsonb,
  version     integer NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voyages_tenant_updated_idx ON voyages (tenant_id, updated_at DESC);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  voyage_id  uuid REFERENCES voyages(id) ON DELETE SET NULL,
  action     text NOT NULL,
  detail     jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_at_idx ON audit_log (tenant_id, at DESC);
