const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, audit } = require('../db');
const { setSession, clearSession, requireAuth, httpError } = require('../auth');
const Perms = require('../permissions');
const { me } = require('./authShared');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

// Failed sign-ins per login ID, whatever the IP. Successful sign-ins do not count.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req =>
    'login:' +
    String((req.body && (req.body.login || req.body.email)) || '')
      .trim()
      .toLowerCase(),
  message: { error: 'Too many failed sign-ins for this login. Try again in 15 minutes, or sign in with a code.' },
});

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

router.post('/login', loginLimiter, accountLimiter, async (req, res, next) => {
  try {
    const body = z
      .object({
        login: z.string().trim().min(1).max(200).optional(),
        email: z.string().trim().max(200).optional(),
        password: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    const login = body.success && (body.data.login || body.data.email);
    if (!login) throw httpError(400, 'Enter your login ID (or email) and password.');
    // An email always contains "@"; a login ID never does.
    const col = login.includes('@') ? 'email' : 'login_id';
    const { rows } = await query(
      `SELECT u.*, t.name AS tenant_name, t.active AS tenant_active FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.${col}) = lower($1)`,
      [login],
    );
    const u = rows[0];
    const ok = await bcrypt.compare(body.data.password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.active || (u.tenant_id && !u.tenant_active))
      throw httpError(401, 'Login ID or password is incorrect.');
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit({ query }, { tenantId: u.tenant_id, userId: u.id, action: 'login' });
    setSession(res, u);
    res.json({
      user: me(u, 'pwd', u.role === 'external' ? null : await Perms.effective({ query }, u.tenant_id, u.role)),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: me(req.user, req.amr, req.perms) }));

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        current: z.string().max(200).optional().default(''),
        next: z.string().min(10, 'Use at least 10 characters.').max(200),
      })
      .safeParse(req.body);
    if (!body.success) throw httpError(400, body.error.issues[0].message);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    // After signing in with a one-time code, a person may set a password without the old one.
    if (req.amr !== 'otp' && !(await bcrypt.compare(body.data.current, rows[0].password_hash)))
      throw httpError(400, 'Current password is incorrect.');
    const {
      rows: [sv],
    } = await query(
      'UPDATE users SET password_hash = $1, must_change_password = false, session_version = session_version + 1 WHERE id = $2 RETURNING session_version',
      [await bcrypt.hash(body.data.next, 12), req.user.id],
    );
    await audit({ query }, { tenantId: req.user.tenant_id, userId: req.user.id, action: 'password_changed' });
    // Other devices are signed out; this one gets a fresh session.
    setSession(res, { ...req.user, session_version: sv.session_version }, { amr: req.amr });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.limiters = { ip: loginLimiter, account: accountLimiter }; // tests reset these
