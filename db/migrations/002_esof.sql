-- Phase 1/2: stakeholders per voyage, live SOF events, reviews, uploaded documents.

-- External stakeholders (agents, masters, stevedores...) belong to no organisation.
ALTER TABLE users DROP CONSTRAINT users_role_tenant;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','member','external'));
ALTER TABLE users ADD CONSTRAINT users_role_tenant CHECK ((role IN ('superadmin','external')) = (tenant_id IS NULL));
ALTER TABLE users ADD COLUMN company text NOT NULL DEFAULT '';

CREATE TABLE voyage_participants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voyage_id            uuid NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_role           text NOT NULL CHECK (party_role IN ('owner','charterer','broker','agent','master','stevedore','terminal','surveyor')),
  can_see_commercials  boolean NOT NULL DEFAULT false,
  invited_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (voyage_id, user_id)
);
CREATE INDEX vp_user_idx ON voyage_participants (user_id);

CREATE TABLE invites (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           text NOT NULL UNIQUE,
  voyage_id            uuid NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  email                text NOT NULL,
  party_role           text NOT NULL,
  can_see_commercials  boolean NOT NULL DEFAULT false,
  invited_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at           timestamptz NOT NULL,
  accepted_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_voyage_idx ON invites (voyage_id);

-- Times are port local time, stored as 'YYYY-MM-DDTHH:MM' text to match the calculator.
CREATE TABLE sof_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voyage_id    uuid NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  port_id      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('milestone','stoppage','note')),
  code         text NOT NULL,
  at           text,
  from_at      text,
  to_at        text,
  remark       text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','paste','document')),
  document_id  uuid,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  author_party text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','disputed')),
  version      integer NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sof_voyage_idx ON sof_events (voyage_id, port_id) WHERE deleted_at IS NULL;

CREATE TABLE event_reviews (
  id          bigserial PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES sof_events(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  party       text NOT NULL DEFAULT '',
  decision    text NOT NULL CHECK (decision IN ('confirm','dispute','comment')),
  comment     text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX er_event_idx ON event_reviews (event_id);

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voyage_id    uuid NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  port_id      text,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  sha256       text NOT NULL,
  content      bytea NOT NULL,
  doc_type     text NOT NULL DEFAULT 'sof' CHECK (doc_type IN ('sof','cp','other')),
  status       text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','ready','failed','applied')),
  provider     text,
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX docs_voyage_idx ON documents (voyage_id, created_at DESC);
