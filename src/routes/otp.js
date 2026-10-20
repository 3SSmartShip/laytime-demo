// Sign in with a one-time code, and verify one's own email / mobile number.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, tx, audit } = require('../db');
const { httpError, setSession, requireAuth } = require('../auth');
const { normalizeMobile, maskMobile, maskEmail, isEmail } = require('../contact');
const notify = require('../notify');
const Otp = require('../otp');
const { me } = require('./authShared');

const router = express.Router();
const reqLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many code requests. Try again in 15 minutes.' } });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in 15 minutes.' } });

// Works out the channel and the normalised address from what the person typed.
function target(input) {
  const s = String(input || '').trim();
  if (isEmail(s)) return { channel: 'email', value: s.toLowerCase(), col: 'email', masked: maskEmail(s) };
  const m = normalizeMobile(s);
  if (!m) throw httpError(400, 'Enter your mobile number (with country code if outside India) or your email.');
  return { channel: 'sms', value: m, col: 'mobile', masked: maskMobile(m) };
}

function requireChannel(channel) {
  const en = notify.enabled();
  if (!en[channel]) throw httpError(400, channel === 'sms' ? 'Codes by text message are not available. Use your email or password.' : 'Codes by email are not available. Use your mobile number or password.');
}

async function findUser(t) {
  const { rows } = await query(
    `SELECT u.*, t.name AS tenant_name, t.active AS tenant_active FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.${t.col}) = lower($1)`, [t.value]);
  const u = rows[0];
  return u && u.active && !(u.tenant_id && !u.tenant_active) ? u : null;
}

router.get('/options', (req, res) => res.json(notify.enabled()));

router.post('/request', reqLimiter, async (req, res, next) => {
  try {
    const t = target(req.body && req.body.login);
    requireChannel(t.channel);
    const u = await findUser(t);
    // Same answer whether or not the account exists.
    const out = { ok: true, channel: t.channel, sentTo: t.masked, resendIn: Otp.RESEND_SECONDS };
    // Sent after replying, so response time and provider errors do not reveal who has an account.
    res.json(out);
    if (u) Otp.issue({ query }, { userId: u.id, purpose: 'login', channel: t.channel, target: t.value }).catch(e => console.error('otp send failed', e.message));
  } catch (e) { next(e); }
});

router.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const t = target(req.body && req.body.login);
    const u = await findUser(t);
    if (!u) throw httpError(400, 'That code is not correct or has expired. Ask for a new one.');
    const r = await Otp.check({ query }, { userId: u.id, purpose: 'login', target: t.value, code: req.body.code });
    if (!r.ok) throw httpError(400, r.error);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit({ query }, { tenantId: u.tenant_id, userId: u.id, action: 'login_otp', detail: { channel: t.channel } });
    setSession(res, u, { amr: 'otp' });
    res.json({ user: me(u, 'otp') });
  } catch (e) { next(e); }
});

// ---------- add or change one's own email / mobile (verified by code) ----------
const contactBody = z.object({ kind: z.enum(['email', 'mobile']), value: z.string().trim().min(1).max(200) });

function contactTarget(b) {
  if (b.kind === 'email') {
    if (!isEmail(b.value)) throw httpError(400, 'Enter a valid email address.');
    return { channel: 'email', value: b.value.toLowerCase(), purpose: 'verify_email' };
  }
  const m = normalizeMobile(b.value);
  if (!m) throw httpError(400, 'Enter a valid mobile number, with country code if outside India.');
  return { channel: 'sms', value: m, purpose: 'verify_mobile' };
}

router.post('/contact/request', requireAuth, reqLimiter, async (req, res, next) => {
  try {
    const b = contactBody.parse(req.body);
    const t = contactTarget(b);
    requireChannel(t.channel);
    const { rows } = await query(`SELECT id FROM users WHERE lower(${b.kind}) = lower($1) AND id <> $2`, [t.value, req.user.id]);
    if (rows[0]) throw httpError(409, `This ${b.kind === 'email' ? 'email' : 'mobile number'} is already used by another login.`);
    let r;
    try { r = await Otp.issue({ query }, { userId: req.user.id, purpose: t.purpose, channel: t.channel, target: t.value }); }
    catch (e) { console.error('otp send failed', e.message); throw httpError(502, 'We could not send the code just now. Try again later.'); }
    if (!r.sent) throw httpError(429, r.reason === 'cooldown' ? 'A code was sent less than a minute ago. Wait a moment before asking again.' : 'Too many codes in the last hour. Try again later.');
    res.json({ ok: true, sentTo: t.channel === 'sms' ? maskMobile(t.value) : maskEmail(t.value), resendIn: Otp.RESEND_SECONDS });
  } catch (e) { next(e instanceof z.ZodError ? httpError(400, 'Invalid request.') : e); }
});

router.post('/contact/verify', requireAuth, verifyLimiter, async (req, res, next) => {
  try {
    const b = contactBody.extend({ code: z.string().max(12) }).parse(req.body);
    const t = contactTarget(b);
    // Checked outside the transaction so a wrong code still counts as an attempt.
    const r = await Otp.check({ query }, { userId: req.user.id, purpose: t.purpose, target: t.value, code: b.code });
    if (!r.ok) throw httpError(400, r.error);
    await tx(async db => {
      await db.query(`UPDATE users SET ${b.kind} = $1 WHERE id = $2`, [t.value, req.user.id]);
      await audit(db, { tenantId: req.user.tenant_id, userId: req.user.id, action: `${b.kind}_verified` });
    });
    res.json({ ok: true, [b.kind]: t.value });
  } catch (e) { next(e instanceof z.ZodError ? httpError(400, 'Invalid request.') : e); }
});

router.post('/contact/remove', requireAuth, async (req, res, next) => {
  try {
    const { kind } = z.object({ kind: z.enum(['email', 'mobile']) }).parse(req.body);
    await query(`UPDATE users SET ${kind} = NULL WHERE id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e instanceof z.ZodError ? httpError(400, 'Invalid request.') : e); }
});

module.exports = router;
module.exports.limiters = { request: reqLimiter, verify: verifyLimiter }; // tests reset these
