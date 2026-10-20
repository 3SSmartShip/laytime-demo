// One-time codes: create, send, check.
const crypto = require('crypto');
const config = require('./config');
const notify = require('./notify');

const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_PER_HOUR = 5;

const hash = (id, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${id}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Returns {sent:true} or {sent:false, reason:'cooldown'|'limit'}. Throws if the provider fails.
async function issue(db, { userId, purpose, channel, target }) {
  const { rows: recent } = await db.query(
    `SELECT created_at FROM otp_codes WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC`, [userId, purpose]);
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESEND_SECONDS * 1000) return { sent: false, reason: 'cooldown' };
  if (recent.length >= MAX_PER_HOUR) return { sent: false, reason: 'limit' };
  const code = newCode();
  const id = crypto.randomUUID();
  // only the newest code for a purpose is valid
  await db.query(`UPDATE otp_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`, [userId, purpose]);
  await db.query(`INSERT INTO otp_codes (id, user_id, purpose, channel, target, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
    [id, userId, purpose, channel, target, hash(id, code), notify.ttlMin()]);
  if (channel === 'sms') await notify.sendSms(target, code, purpose);
  else await notify.sendEmail(target, code, purpose);
  return { sent: true };
}

// Returns {ok:true} or {ok:false, error}.
async function check(db, { userId, purpose, target, code }) {
  const { rows } = await db.query(
    `SELECT * FROM otp_codes WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [userId, purpose]);
  const o = rows[0];
  const bad = { ok: false, error: 'That code is not correct or has expired. Ask for a new one.' };
  if (!o || (target && o.target.toLowerCase() !== String(target).toLowerCase())) return bad;
  if (o.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many wrong codes. Ask for a new one.' };
  const given = String(code || '').replace(/\D/g, '');
  const a = Buffer.from(hash(o.id, given), 'hex'), b = Buffer.from(o.code_hash, 'hex');
  if (given.length !== 6 || !crypto.timingSafeEqual(a, b)) {
    await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [o.id]);
    const left = MAX_ATTEMPTS - o.attempts - 1;
    return { ok: false, error: left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong codes. Ask for a new one.' };
  }
  await db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [o.id]);
  return { ok: true };
}

module.exports = { issue, check, RESEND_SECONDS };
