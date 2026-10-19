const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, audit } = require('../db');
const { setSession, clearSession, requireAuth, httpError } = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

function me(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    tenantId: u.tenant_id,
    tenantName: u.tenant_name || null,
    mustChangePassword: u.must_change_password,
  };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const body = z
      .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
      .safeParse(req.body);
    if (!body.success) throw httpError(400, 'Enter your email and password.');
    const { rows } = await query(
      `SELECT u.*, t.name AS tenant_name, t.active AS tenant_active FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = lower($1)`,
      [body.data.email],
    );
    const u = rows[0];
    const ok = await bcrypt.compare(body.data.password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.active || (u.role !== 'superadmin' && !u.tenant_active))
      throw httpError(401, 'Email or password is incorrect.');
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit({ query }, { tenantId: u.tenant_id, userId: u.id, action: 'login' });
    setSession(res, u);
    res.json({ user: me(u) });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: me(req.user) }));

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({ current: z.string().max(200), next: z.string().min(10, 'Use at least 10 characters.').max(200) })
      .safeParse(req.body);
    if (!body.success) throw httpError(400, body.error.issues[0].message);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(body.data.current, rows[0].password_hash)))
      throw httpError(400, 'Current password is incorrect.');
    await query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [
      await bcrypt.hash(body.data.next, 12),
      req.user.id,
    ]);
    await audit({ query }, { tenantId: req.user.tenant_id, userId: req.user.id, action: 'password_changed' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
