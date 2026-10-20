-- Bumped whenever a password is changed or reset; sessions carrying an older value stop working.
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 1;
