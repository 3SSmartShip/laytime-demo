// Login IDs: 3–40 characters, letters, digits, dot, underscore, hyphen. Unique regardless of case.
const { z } = require('zod');
const { httpError } = require('./auth');

const RE = /^[A-Za-z0-9._-]{3,40}$/;
const schema = z.string().trim().regex(RE, 'Login ID must be 3–40 characters: letters, digits, dot, underscore or hyphen.');

function baseFrom(text) {
  let b = String(text || '').toLowerCase().split('@')[0]
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30);
  if (b.length < 3) b = `user${b}`;
  return b;
}

async function isTaken(db, loginId, exceptUserId = null) {
  const { rows } = await db.query('SELECT id FROM users WHERE lower(login_id) = lower($1)', [loginId]);
  return !!rows[0] && rows[0].id !== exceptUserId;
}

async function suggest(db, text) {
  const b = baseFrom(text);
  if (!(await isTaken(db, b))) return b;
  for (let n = 2; n < 1000; n++) { const c = `${b}-${n}`; if (!(await isTaken(db, c))) return c; }
  return `${b}-${Date.now().toString(36)}`;
}

// Validates a requested login ID (or builds one from the fallback text) and makes sure it is free.
async function claim(db, requested, fallbackText) {
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const r = schema.safeParse(requested);
    if (!r.success) throw httpError(400, r.error.issues[0].message);
    if (await isTaken(db, r.data)) {
      const e = httpError(409, `Login ID "${r.data}" is already taken. Try "${await suggest(db, r.data)}".`);
      e.extra = { suggestion: await suggest(db, r.data) };
      throw e;
    }
    return r.data;
  }
  return suggest(db, fallbackText);
}

module.exports = { RE, schema, baseFrom, suggest, claim, isTaken };
