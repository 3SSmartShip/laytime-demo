const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query, tx, audit } = require('../db');
const { requireRole, requirePerm, httpError } = require('../auth');
const Perms = require('../permissions');
const { normalizeMobile } = require('../contact');
const LoginId = require('../loginId');

const router = express.Router();
const pw = z.string().min(10, 'Passwords need at least 10 characters.').max(200);

function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, r.error.issues[0].message);
  return r.data;
}

// Which tenant's users this request manages: own tenant for admins, ?tenant= for platform admins.
function targetTenant(req) {
  if (req.user.role === 'superadmin') {
    const t = req.get('X-Tenant-Id') || req.query.tenant;
    if (!t || !z.string().uuid().safeParse(t).success) throw httpError(400, 'Choose an organisation first.');
    return t;
  }
  return req.user.tenant_id;
}

const optEmail = z.union([z.literal(''), z.string().trim().email('Enter a valid email or leave it blank.').max(200)]).optional();
const optMobile = z.string().trim().max(30).optional();
function mobileOrNull(v) {
  if (v === undefined) return undefined;
  const m = normalizeMobile(v);
  if (m === undefined) throw httpError(400, 'Enter a valid mobile number, with country code if outside India.');
  return m;
}
const userOut = u => ({ id: u.id, loginId: u.login_id, email: u.email, mobile: u.mobile, name: u.name, role: u.role, active: u.active, mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at, createdAt: u.created_at });

// ---- users (tenant admins and platform admins) ----
router.get('/users', requireRole('admin', 'superadmin'), requirePerm('users'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const { rows } = await query('SELECT * FROM users WHERE tenant_id = $1 ORDER BY lower(name), lower(login_id)', [tid]);
    res.json({ users: rows.map(userOut) });
  } catch (e) { next(e); }
});

router.post('/users', requireRole('admin', 'superadmin'), requirePerm('users'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const b = parse(z.object({ loginId: z.string().max(40).optional(), email: optEmail, mobile: optMobile, name: z.string().trim().min(1).max(120), role: z.enum(['admin', 'member']), password: pw }), req.body);
    const email = b.email || null;
    const mobile = mobileOrNull(b.mobile) || null;
    const u = await tx(async db => {
      if (email && (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])).rows[0]) throw httpError(409, 'A user with this email already exists.');
      if (mobile && (await db.query('SELECT 1 FROM users WHERE mobile = $1', [mobile])).rows[0]) throw httpError(409, 'A user with this mobile number already exists.');
      const loginId = await LoginId.claim(db, b.loginId, email || b.name);
      const { rows } = await db.query(
        `INSERT INTO users (tenant_id, login_id, email, mobile, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
        [tid, loginId, email, mobile, b.name, b.role, await bcrypt.hash(b.password, 12)]);
      await audit(db, { tenantId: tid, userId: req.user.id, action: 'user_created', detail: { loginId, email, role: b.role } });
      return rows[0];
    });
    res.status(201).json({ user: userOut(u) });
  } catch (e) { next(e); }
});

router.patch('/users/:id', requireRole('admin', 'superadmin'), requirePerm('users'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ name: z.string().min(1).max(120).optional(), role: z.enum(['admin', 'member']).optional(), active: z.boolean().optional(), password: pw.optional(), email: optEmail, mobile: optMobile }), req.body);
    const mobile = mobileOrNull(b.mobile);
    const out = await tx(async db => {
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tid]);
      const u = rows[0];
      if (!u) throw httpError(404, 'User not found.');
      if (u.id === req.user.id && (b.active === false || b.role === 'member')) throw httpError(400, 'You cannot remove your own admin access.');
      if ((b.active === false || b.role === 'member') && u.role === 'admin') {
        const { rows: a } = await db.query(`SELECT count(*)::int n FROM users WHERE tenant_id = $1 AND role = 'admin' AND active AND id <> $2`, [tid, id]);
        if (a[0].n === 0) throw httpError(400, 'Each organisation needs at least one active admin.');
      }
      const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
      if (b.email !== undefined) {
        if (b.email && (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [b.email, id])).rows[0]) throw httpError(409, 'Another user already has this email.');
        await db.query('UPDATE users SET email = $1 WHERE id = $2', [b.email || null, id]);
      }
      if (mobile !== undefined) {
        if (mobile && (await db.query('SELECT 1 FROM users WHERE mobile = $1 AND id <> $2', [mobile, id])).rows[0]) throw httpError(409, 'Another user already has this mobile number.');
        await db.query('UPDATE users SET mobile = $1 WHERE id = $2', [mobile, id]);
      }
      const { rows: up } = await db.query(
        `UPDATE users SET name = COALESCE($1,name), role = COALESCE($2,role), active = COALESCE($3,active),
                password_hash = COALESCE($4,password_hash), must_change_password = CASE WHEN $4::text IS NULL THEN must_change_password ELSE true END,
                session_version = CASE WHEN $4::text IS NULL THEN session_version ELSE session_version + 1 END
          WHERE id = $5 RETURNING *`, [b.name ?? null, b.role ?? null, b.active ?? null, hash, id]);
      await audit(db, { tenantId: tid, userId: req.user.id, action: 'user_updated', detail: { id, ...b, password: b.password ? 'reset' : undefined } });
      return up[0];
    });
    res.json({ user: userOut(out) });
  } catch (e) { next(e); }
});

// ---- tenants (platform admins only) ----
router.get('/tenants', requireRole('superadmin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*, (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
              (SELECT count(*)::int FROM voyages v WHERE v.tenant_id = t.id) AS voyages
         FROM tenants t ORDER BY lower(t.name)`);
    res.json({ tenants: rows.map(t => ({ id: t.id, name: t.name, active: t.active, users: t.users, voyages: t.voyages, createdAt: t.created_at })) });
  } catch (e) { next(e); }
});

router.post('/tenants', requireRole('superadmin'), async (req, res, next) => {
  try {
    const b = parse(z.object({ name: z.string().trim().min(1).max(160), adminLoginId: z.string().max(40).optional(), adminEmail: optEmail, adminName: z.string().trim().min(1).max(120), adminPassword: pw }), req.body);
    const email = b.adminEmail || null;
    const t = await tx(async db => {
      if (email && (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])).rows[0]) throw httpError(409, 'A user with this email already exists.');
      const loginId = await LoginId.claim(db, b.adminLoginId, email || b.adminName);
      const { rows } = await db.query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', [b.name]);
      await db.query(`INSERT INTO users (tenant_id, login_id, email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,'admin',$5,true)`,
        [rows[0].id, loginId, email, b.adminName, await bcrypt.hash(b.adminPassword, 12)]);
      await audit(db, { tenantId: rows[0].id, userId: req.user.id, action: 'tenant_created', detail: { name: b.name, admin: loginId } });
      return { ...rows[0], adminLoginId: loginId };
    });
    res.status(201).json({ tenant: { id: t.id, name: t.name, active: t.active }, adminLoginId: t.adminLoginId });
  } catch (e) { next(e); }
});

router.patch('/tenants/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ name: z.string().min(1).max(160).optional(), active: z.boolean().optional() }), req.body);
    const { rows } = await query('UPDATE tenants SET name = COALESCE($1,name), active = COALESCE($2,active) WHERE id = $3 RETURNING *', [b.name ?? null, b.active ?? null, id]);
    if (!rows[0]) throw httpError(404, 'Organisation not found.');
    await audit({ query }, { tenantId: id, userId: req.user.id, action: 'tenant_updated', detail: b });
    res.json({ tenant: { id: rows[0].id, name: rows[0].name, active: rows[0].active } });
  } catch (e) { next(e); }
});

// ---- activity log ----
router.get('/audit', requirePerm('audit'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const { rows } = await query(
      `SELECT a.action, a.detail, a.at, a.voyage_id, u.name AS user_name, u.email AS user_email, v.vessel
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN voyages v ON v.id = a.voyage_id
        WHERE a.tenant_id = $1 ORDER BY a.at DESC LIMIT 200`, [tid]);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

// ---- roles and modules (platform admins only) ----
function scopeOf(req) {
  const s = req.query.scope || (req.body && req.body.scope) || 'default';
  if (s === 'default') return null;
  if (!z.string().uuid().safeParse(s).success) throw httpError(400, 'Unknown organisation.');
  return s;
}

router.get('/permissions', requireRole('superadmin'), async (req, res, next) => {
  try { res.json(await Perms.matrix({ query }, scopeOf(req))); } catch (e) { next(e); }
});

// Set one cell. enabled: true/false sets it; null removes the setting (back to the default).
router.put('/permissions', requireRole('superadmin'), async (req, res, next) => {
  try {
    const tid = scopeOf(req);
    const b = parse(z.object({ role: z.enum(Perms.ROLE_KEYS), module: z.enum(Perms.MODULES.map(m => m.key)), enabled: z.boolean().nullable() }), req.body);
    if (!Perms.applies(Perms.BY_KEY[b.module], b.role)) throw httpError(400, 'This module does not apply to that role.');
    if (tid && !(await query('SELECT 1 FROM tenants WHERE id = $1', [tid])).rows[0]) throw httpError(404, 'Organisation not found.');
    await tx(async db => {
      await db.query(`DELETE FROM role_permissions WHERE COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND role = $2 AND module = $3`, [tid, b.role, b.module]);
      if (b.enabled !== null) await db.query('INSERT INTO role_permissions (tenant_id, role, module, enabled, updated_by) VALUES ($1,$2,$3,$4,$5)', [tid, b.role, b.module, b.enabled, req.user.id]);
      await audit(db, { tenantId: tid, userId: req.user.id, action: 'permission_changed', detail: { role: b.role, module: b.module, enabled: b.enabled, scope: tid ? 'organisation' : 'default' } });
    });
    res.json(await Perms.matrix({ query }, tid));
  } catch (e) { next(e); }
});

// Remove every override of one organisation.
router.delete('/permissions', requireRole('superadmin'), async (req, res, next) => {
  try {
    const tid = scopeOf(req);
    if (!tid) throw httpError(400, 'Choose an organisation to reset.');
    await query('DELETE FROM role_permissions WHERE tenant_id = $1', [tid]);
    await audit({ query }, { tenantId: tid, userId: req.user.id, action: 'permissions_reset' });
    res.json(await Perms.matrix({ query }, tid));
  } catch (e) { next(e); }
});

module.exports = router;
