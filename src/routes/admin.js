const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query, tx, audit } = require('../db');
const { requireRole, httpError } = require('../auth');

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

const userOut = u => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  active: u.active,
  mustChangePassword: u.must_change_password,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

// ---- users (tenant admins and platform admins) ----
router.get('/users', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const { rows } = await query('SELECT * FROM users WHERE tenant_id = $1 ORDER BY lower(name), lower(email)', [tid]);
    res.json({ users: rows.map(userOut) });
  } catch (e) {
    next(e);
  }
});

router.post('/users', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const b = parse(
      z.object({
        email: z.string().email().max(200),
        name: z.string().min(1).max(120),
        role: z.enum(['admin', 'member']),
        password: pw,
      }),
      req.body,
    );
    const exists = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email]);
    if (exists.rows[0]) throw httpError(409, 'A user with this email already exists.');
    const { rows } = await query(
      `INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
      [tid, b.email.trim(), b.name.trim(), b.role, await bcrypt.hash(b.password, 12)],
    );
    await audit(
      { query },
      { tenantId: tid, userId: req.user.id, action: 'user_created', detail: { email: b.email, role: b.role } },
    );
    res.status(201).json({ user: userOut(rows[0]) });
  } catch (e) {
    next(e);
  }
});

router.patch('/users/:id', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        role: z.enum(['admin', 'member']).optional(),
        active: z.boolean().optional(),
        password: pw.optional(),
      }),
      req.body,
    );
    const out = await tx(async db => {
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tid]);
      const u = rows[0];
      if (!u) throw httpError(404, 'User not found.');
      if (u.id === req.user.id && (b.active === false || b.role === 'member'))
        throw httpError(400, 'You cannot remove your own admin access.');
      if ((b.active === false || b.role === 'member') && u.role === 'admin') {
        const { rows: a } = await db.query(
          `SELECT count(*)::int n FROM users WHERE tenant_id = $1 AND role = 'admin' AND active AND id <> $2`,
          [tid, id],
        );
        if (a[0].n === 0) throw httpError(400, 'Each organisation needs at least one active admin.');
      }
      const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
      const { rows: up } = await db.query(
        `UPDATE users SET name = COALESCE($1,name), role = COALESCE($2,role), active = COALESCE($3,active),
                password_hash = COALESCE($4,password_hash), must_change_password = CASE WHEN $4::text IS NULL THEN must_change_password ELSE true END
          WHERE id = $5 RETURNING *`,
        [b.name ?? null, b.role ?? null, b.active ?? null, hash, id],
      );
      await audit(db, {
        tenantId: tid,
        userId: req.user.id,
        action: 'user_updated',
        detail: { id, ...b, password: b.password ? 'reset' : undefined },
      });
      return up[0];
    });
    res.json({ user: userOut(out) });
  } catch (e) {
    next(e);
  }
});

// ---- tenants (platform admins only) ----
router.get('/tenants', requireRole('superadmin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*, (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
              (SELECT count(*)::int FROM voyages v WHERE v.tenant_id = t.id) AS voyages
         FROM tenants t ORDER BY lower(t.name)`,
    );
    res.json({
      tenants: rows.map(t => ({
        id: t.id,
        name: t.name,
        active: t.active,
        users: t.users,
        voyages: t.voyages,
        createdAt: t.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/tenants', requireRole('superadmin'), async (req, res, next) => {
  try {
    const b = parse(
      z.object({
        name: z.string().min(1).max(160),
        adminEmail: z.string().email().max(200),
        adminName: z.string().min(1).max(120),
        adminPassword: pw,
      }),
      req.body,
    );
    const exists = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.adminEmail]);
    if (exists.rows[0]) throw httpError(409, 'A user with this email already exists.');
    const t = await tx(async db => {
      const { rows } = await db.query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', [b.name.trim()]);
      await db.query(
        `INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,'admin',$4,true)`,
        [rows[0].id, b.adminEmail.trim(), b.adminName.trim(), await bcrypt.hash(b.adminPassword, 12)],
      );
      await audit(db, {
        tenantId: rows[0].id,
        userId: req.user.id,
        action: 'tenant_created',
        detail: { name: b.name, admin: b.adminEmail },
      });
      return rows[0];
    });
    res.status(201).json({ tenant: { id: t.id, name: t.name, active: t.active } });
  } catch (e) {
    next(e);
  }
});

router.patch('/tenants/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(
      z.object({ name: z.string().min(1).max(160).optional(), active: z.boolean().optional() }),
      req.body,
    );
    const { rows } = await query(
      'UPDATE tenants SET name = COALESCE($1,name), active = COALESCE($2,active) WHERE id = $3 RETURNING *',
      [b.name ?? null, b.active ?? null, id],
    );
    if (!rows[0]) throw httpError(404, 'Organisation not found.');
    await audit({ query }, { tenantId: id, userId: req.user.id, action: 'tenant_updated', detail: b });
    res.json({ tenant: { id: rows[0].id, name: rows[0].name, active: rows[0].active } });
  } catch (e) {
    next(e);
  }
});

// ---- activity log ----
router.get('/audit', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const tid = targetTenant(req);
    const { rows } = await query(
      `SELECT a.action, a.detail, a.at, a.voyage_id, u.name AS user_name, u.email AS user_email, v.vessel
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN voyages v ON v.id = a.voyage_id
        WHERE a.tenant_id = $1 ORDER BY a.at DESC LIMIT 200`,
      [tid],
    );
    res.json({ entries: rows });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
