// Accepting a voyage invitation (public) and the stakeholder's list of voyages.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const { query, tx, audit } = require('../db');
const { httpError, setSession, requireAuth } = require('../auth');
const Codes = require('../../shared/codes');
const LoginId = require('../loginId');
const Perms = require('../permissions');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

async function findInvite(db, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw httpError(404, 'This invitation link is not valid.');
  const { rows } = await db.query(
    `SELECT i.*, v.vessel, t.name AS operator FROM invites i JOIN voyages v ON v.id = i.voyage_id JOIN tenants t ON t.id = v.tenant_id WHERE i.token_hash = $1`, [hash(token)]);
  const inv = rows[0];
  if (!inv) throw httpError(404, 'This invitation link is not valid.');
  if (inv.accepted_at) throw httpError(410, 'This invitation has already been used. Sign in instead.');
  if (new Date(inv.expires_at) < new Date()) throw httpError(410, 'This invitation has expired. Ask the operator for a new one.');
  return inv;
}

function currentUserId(req) {
  try { return jwt.verify(req.cookies.lt_session, config.jwtSecret).sub; } catch { return null; }
}

router.post('/lookup', limiter, async (req, res, next) => {
  try {
    const inv = await findInvite({ query }, req.body && req.body.token);
    const { rows } = await query('SELECT id, login_id FROM users WHERE lower(email) = lower($1)', [inv.email]);
    res.json({ email: inv.email, vessel: inv.vessel, operator: inv.operator, party: Codes.PARTY_ROLES[inv.party_role], existingAccount: !!rows[0], existingLoginId: rows[0] ? rows[0].login_id : undefined,
      suggestedLoginId: rows[0] ? undefined : await LoginId.suggest({ query }, inv.email) });
  } catch (e) { next(e); }
});

router.post('/accept', limiter, async (req, res, next) => {
  try {
    const b = z.object({ token: z.string().max(64), loginId: z.string().max(40).optional(), name: z.string().max(120).optional(), company: z.string().max(160).optional(), password: z.string().max(200).optional() }).parse(req.body || {});
    const user = await tx(async db => {
      const inv = await findInvite(db, b.token);
      const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [inv.email]);
      let u = rows[0];
      if (u) {
        // existing account: must be signed in as that account
        if (currentUserId(req) !== u.id) throw httpError(401, `Sign in as ${u.login_id} first, then open the link again.`);
      } else {
        if (!b.name || !b.name.trim()) throw httpError(400, 'Enter your name.');
        if (!b.password || b.password.length < 10) throw httpError(400, 'Choose a password of at least 10 characters.');
        const loginId = await LoginId.claim(db, b.loginId, inv.email);
        const { rows: vt0 } = await db.query('SELECT tenant_id FROM voyages WHERE id = $1', [inv.voyage_id]);
        const ins = await db.query(`INSERT INTO users (tenant_id, login_id, email, name, company, role, password_hash, created_by_tenant) VALUES (NULL,$1,$2,$3,$4,'external',$5,$6) RETURNING *`,
          [loginId, inv.email, b.name.trim(), (b.company || '').trim(), await bcrypt.hash(b.password, 12), vt0[0].tenant_id]);
        u = ins.rows[0];
      }
      await db.query(`INSERT INTO voyage_participants (voyage_id, user_id, party_role, can_see_commercials, invited_by) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (voyage_id, user_id) DO UPDATE SET party_role = EXCLUDED.party_role, can_see_commercials = EXCLUDED.can_see_commercials`,
        [inv.voyage_id, u.id, inv.party_role, inv.can_see_commercials, inv.invited_by]);
      await db.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [inv.id]);
      const { rows: vt } = await db.query('SELECT tenant_id FROM voyages WHERE id = $1', [inv.voyage_id]);
      await audit(db, { tenantId: vt[0].tenant_id, userId: u.id, voyageId: inv.voyage_id, action: 'invite_accepted', detail: { email: inv.email, party: inv.party_role } });
      return { ...u, voyageId: inv.voyage_id };
    });
    setSession(res, user);
    res.json({ voyageId: user.voyageId, loginId: user.login_id });
  } catch (e) {
    if (e instanceof z.ZodError) return next(httpError(400, 'Invalid request.'));
    next(e);
  }
});

// Voyages the signed-in person was invited to.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT v.id, v.vessel, v.status, v.updated_at, v.summary, v.data->'ports' AS ports, t.name AS operator, p.party_role, p.can_see_commercials, v.tenant_id,
              (SELECT count(*)::int FROM sof_events e WHERE e.voyage_id = v.id AND e.deleted_at IS NULL AND e.status = 'disputed') AS disputed,
              (SELECT count(*)::int FROM sof_events e WHERE e.voyage_id = v.id AND e.deleted_at IS NULL AND e.status = 'open') AS open
         FROM voyage_participants p JOIN voyages v ON v.id = p.voyage_id JOIN tenants t ON t.id = v.tenant_id
        WHERE p.user_id = $1 AND t.active ORDER BY v.updated_at DESC`, [req.user.id]);
    const amounts = {};
    for (const r of rows) {
      const k = `${r.tenant_id}:${r.party_role}`;
      if (!(k in amounts)) amounts[k] = (await Perms.effective({ query }, r.tenant_id, r.party_role)).amounts;
    }
    res.json({ voyages: rows.map(r => ({ id: r.id, vessel: r.vessel, status: r.status, updatedAt: r.updated_at, operator: r.operator,
      party: Codes.PARTY_ROLES[r.party_role], ports: (r.ports || []).map(p => ({ name: p.name, op: p.op })), open: r.open, disputed: r.disputed,
      summary: r.can_see_commercials && amounts[`${r.tenant_id}:${r.party_role}`] ? r.summary : null })) });
  } catch (e) { next(e); }
});

module.exports = router;
