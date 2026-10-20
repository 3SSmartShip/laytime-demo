-- Every user gets a unique login ID. Email becomes optional (masters and stevedores often share a mailbox).

ALTER TABLE users ADD COLUMN login_id text;
-- Which organisation created an external stakeholder's login; only that organisation may reset its password.
ALTER TABLE users ADD COLUMN created_by_tenant uuid REFERENCES tenants(id) ON DELETE SET NULL;

-- Give existing users a login ID from their email, adding -2, -3... where needed.
DO $$
DECLARE r record; b text; c text; n int;
BEGIN
  FOR r IN SELECT id, email FROM users ORDER BY created_at, id LOOP
    b := left(regexp_replace(lower(split_part(coalesce(r.email, ''), '@', 1)), '[^a-z0-9._-]', '', 'g'), 30);
    IF length(b) < 3 THEN b := 'user' || b; END IF;
    c := b; n := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE lower(login_id) = c) LOOP
      n := n + 1; c := b || '-' || n;
    END LOOP;
    UPDATE users SET login_id = c WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN login_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_login_id_format CHECK (login_id ~ '^[A-Za-z0-9._-]{3,40}$');
CREATE UNIQUE INDEX users_login_id_uniq ON users (lower(login_id));
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
