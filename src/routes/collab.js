// Live SOF, stakeholders and documents for one voyage: /api/v/:id/...
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { query, tx, audit } = require('../db');
const { httpError } = require('../auth');
const { voyageAccess, redact, COMMERCIAL_DEFAULT } = require('../access');
const { loadEvents, refreshSummary } = require('../esof');
const { parseVoyage } = require('../voyageData');
const { processDocument, provider } = require('../extract');
const Codes = require('../../shared/codes');
const Engine = require('../../shared/engine');
const bcrypt = require('bcryptjs');
const LoginId = require('../loginId');
const { normalizeMobile } = require('../contact');

const router = express.Router({ mergeParams: true });
const dt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use a full date and time.');
const uuid = z.string().uuid();

function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, r.error.issues[0].message);
  return r.data;
}
const wrap = fn => (req, res, next) => fn(req, res).catch(next);

const MODULE_NAMES = Object.fromEntries(require('../permissions').MODULES.map(m => [m.key, m.label]));
// Loads the caller's access to the voyage and checks the module the route belongs to.
async function access(req, module) {
  req.access = await voyageAccess(req.user, req.params.id);
  if (module && !req.access.perms[module]) throw httpError(403, `Your role does not have access to "${MODULE_NAMES[module]}" on this voyage.`);
  return req.access;
}
function portIds(a) { return new Set((a.voyage.data.ports || []).map(p => p.id)); }

// ---------- voyage view ----------
router.get('/', wrap(async (req, res) => {
  const a = await access(req);
  const v = a.voyage;
  const [events, parts, docs] = await Promise.all([
    loadEvents({ query }, v.id, { withReviews: true }),
    query(`SELECT p.id, p.party_role, p.can_see_commercials, u.name, u.email, u.mobile, u.company, u.login_id, u.must_change_password, u.last_login_at,
                  (u.created_by_tenant = $2) AS can_reset
             FROM voyage_participants p JOIN users u ON u.id = p.user_id WHERE p.voyage_id = $1 ORDER BY p.created_at`, [v.id, v.tenant_id]),
    query(`SELECT id, port_id, filename, mime, size, doc_type, status, provider, result, error, created_at, uploaded_by FROM documents WHERE voyage_id = $1 ORDER BY created_at DESC`, [v.id]),
  ]);
  const invites = a.manage && a.perms.stakeholders ? (await query(`SELECT id, email, party_role, can_see_commercials, expires_at, accepted_at FROM invites WHERE voyage_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [v.id])).rows : [];
  res.json({
    access: { manage: a.manage, perms: a.perms, party: a.party, partyLabel: a.partyLabel, commercial: a.commercial,
      recordable: [...Codes.MILESTONES, ...Codes.STOPPAGES].map(c => c.code).filter(c => a.canRecord(c)), provider: provider() },
    voyage: { id: v.id, vessel: v.vessel, status: v.status, version: v.version, operator: v.tenant_name, data: a.commercial ? v.data : redact(v.data), summary: a.commercial ? v.summary : null },
    events: !a.perms.sof_view ? [] : events.map(e => { const o = { ...e, mine: e.author_id === req.user.id }; delete o.author_id; return o; }), participants: parts.rows.map(p => a.manage && a.perms.stakeholders ? p : { id: p.id, party_role: p.party_role, name: p.name, company: p.company }), invites,
    documents: !a.perms.documents ? [] : docs.rows.filter(d => a.commercial || d.doc_type !== 'cp').map(d => ({ ...d, mine: d.uploaded_by === req.user.id, uploaded_by: undefined })),
  });
}));

// ---------- events ----------
const eventBody = z.object({
  portId: z.string().max(40), code: z.string().max(40),
  at: dt.optional().nullable(), from: dt.optional().nullable(), to: dt.optional().nullable(),
  remark: z.string().max(300).optional().default(''),
});

function checkEvent(a, b) {
  const def = Codes.BY_CODE[b.code];
  if (!def) throw httpError(400, 'Choose an event type from the list.');
  if (!portIds(a).has(b.portId)) throw httpError(400, 'That port is not on this voyage.');
  if (!a.canRecord(b.code)) throw httpError(403, `As ${a.partyLabel} you cannot record "${def.label}".`);
  if (def.kind === 'milestone') { if (!b.at) throw httpError(400, 'Enter the date and time.'); return { kind: 'milestone', at: b.at, from_at: null, to_at: null }; }
  if (!b.from) throw httpError(400, 'Enter when the stoppage started.');
  if (b.to && b.to <= b.from) throw httpError(400, 'The end must be after the start.');
  return { kind: 'stoppage', at: null, from_at: b.from, to_at: b.to || null };
}

async function insertEvent(db, req, a, b, extra = {}) {
  const t = checkEvent(a, b);
  const { rows } = await db.query(
    `INSERT INTO sof_events (voyage_id, port_id, kind, code, at, from_at, to_at, remark, source, document_id, author_id, author_party)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [a.voyage.id, b.portId, t.kind, b.code, t.at, t.from_at, t.to_at, b.remark || '', extra.source || 'manual', extra.documentId || null, req.user.id, a.party]);
  return rows[0].id;
}

router.post('/events', wrap(async (req, res) => {
  const a = await access(req, 'sof_record');
  const b = parse(eventBody, req.body);
  const id = await tx(async db => {
    const id = await insertEvent(db, req, a, b);
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'sof_event_added', detail: { code: b.code } });
    await refreshSummary(db, a.voyage.id);
    return id;
  });
  res.status(201).json({ id });
}));

// Pasted SOF lines: "17.09.2013 14:45 18.09.2013 03:30 Due to rain", or "16.09.2013 08:05 NOR tendered".
router.post('/events/bulk', wrap(async (req, res) => {
  const a = await access(req, 'sof_record');
  const b = parse(z.object({ portId: z.string().max(40), text: z.string().max(100000) }), req.body);
  const created = [], skipped = [];
  await tx(async db => {
    for (const line of b.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2000)) {
      const st = Engine.parseSOF(line).rows[0];
      try {
        if (st) {
          await insertEvent(db, req, a, { portId: b.portId, code: Codes.guess(st.d), from: st.f, to: st.t, remark: st.d }, { source: 'paste' });
          created.push(line);
          continue;
        }
        const m = line.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})[\sT,]+(\d{1,2}):?(\d{2})\s+(.+)$/);
        const ms = m && Codes.guessMilestone(m[6]);
        if (!ms) { skipped.push(line); continue; }
        let y = +m[3]; if (y < 100) y += 2000;
        const at = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}T${String(m[4]).padStart(2, '0')}:${m[5]}`;
        await insertEvent(db, req, a, { portId: b.portId, code: ms, at, remark: m[6] }, { source: 'paste' });
        created.push(line);
      } catch (e) { if (e.status === 403 || e.status === 400) skipped.push(`${line}  (${e.message})`); else throw e; }
    }
    if (created.length) {
      await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'sof_lines_pasted', detail: { count: created.length } });
      await refreshSummary(db, a.voyage.id);
    }
  });
  res.json({ created: created.length, skipped });
}));

async function loadEvent(db, a, eid) {
  if (!uuid.safeParse(eid).success) throw httpError(404, 'Event not found.');
  const { rows } = await db.query('SELECT * FROM sof_events WHERE id = $1 AND voyage_id = $2 AND deleted_at IS NULL', [eid, a.voyage.id]);
  if (!rows[0]) throw httpError(404, 'Event not found.');
  return rows[0];
}

router.patch('/events/:eid', wrap(async (req, res) => {
  const a = await access(req, 'sof_record');
  const b = parse(eventBody.extend({ version: z.number().int() }), req.body);
  await tx(async db => {
    const e = await loadEvent(db, a, req.params.eid);
    if (!a.manage && e.author_id !== req.user.id) throw httpError(403, 'Only the person who recorded this event can change it. Add a comment or dispute it instead.');
    if (!a.manage && e.status === 'confirmed') throw httpError(403, 'This event has been confirmed. Dispute it if it is wrong.');
    if (e.version !== b.version) throw httpError(409, 'Someone changed this event. Reload to see the latest.');
    const t = checkEvent(a, b);
    await db.query(`UPDATE sof_events SET port_id=$1, kind=$2, code=$3, at=$4, from_at=$5, to_at=$6, remark=$7, status='open', version=version+1, updated_at=now() WHERE id=$8`,
      [b.portId, t.kind, b.code, t.at, t.from_at, t.to_at, b.remark || '', e.id]);
    await db.query(`INSERT INTO event_reviews (event_id, user_id, party, decision, comment) VALUES ($1,$2,$3,'comment',$4)`, [e.id, req.user.id, a.party, 'Changed the event; confirmations were reset.']);
    await refreshSummary(db, a.voyage.id);
  });
  res.json({ ok: true });
}));

router.delete('/events/:eid', wrap(async (req, res) => {
  const a = await access(req, 'sof_record');
  await tx(async db => {
    const e = await loadEvent(db, a, req.params.eid);
    if (!a.manage && (e.author_id !== req.user.id || e.status === 'confirmed')) throw httpError(403, 'You can only remove your own events before they are confirmed.');
    await db.query('UPDATE sof_events SET deleted_at = now(), updated_at = now() WHERE id = $1', [e.id]);
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'sof_event_removed', detail: { code: e.code } });
    await refreshSummary(db, a.voyage.id);
  });
  res.json({ ok: true });
}));

router.post('/events/:eid/review', wrap(async (req, res) => {
  const a = await access(req, 'sof_review');
  const b = parse(z.object({ decision: z.enum(['confirm', 'dispute', 'comment']), comment: z.string().max(1000).optional().default('') }), req.body);
  if (b.decision !== 'confirm' && !b.comment.trim()) throw httpError(400, b.decision === 'dispute' ? 'Say why you dispute this event.' : 'Write a comment.');
  await tx(async db => {
    const e = await loadEvent(db, a, req.params.eid);
    if (b.decision === 'confirm' && e.author_id === req.user.id) throw httpError(400, 'Another party has to confirm your own event.');
    await db.query(`INSERT INTO event_reviews (event_id, user_id, party, decision, comment) VALUES ($1,$2,$3,$4,$5)`, [e.id, req.user.id, a.party, b.decision, b.comment.trim()]);
    if (b.decision !== 'comment') {
      await db.query(`UPDATE sof_events SET status = $1, updated_at = now() WHERE id = $2`, [b.decision === 'confirm' ? 'confirmed' : 'disputed', e.id]);
      await refreshSummary(db, a.voyage.id);
    }
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: `sof_event_${b.decision}`, detail: { code: e.code } });
  });
  res.json({ ok: true });
}));

// ---------- stakeholders ----------
const inviteBody = z.object({
  email: z.string().email().max(200), party: z.enum(Object.keys(Codes.PARTY_ROLES)), commercial: z.boolean().optional(),
});

router.post('/invites', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can invite people.');
  const b = parse(inviteBody, req.body);
  const commercial = b.commercial ?? !!COMMERCIAL_DEFAULT[b.party];
  const out = await tx(async db => {
    const { rows: ex } = await db.query('SELECT id, tenant_id, role FROM users WHERE lower(email) = lower($1)', [b.email]);
    const u = ex[0];
    if (u && u.tenant_id === a.voyage.tenant_id) throw httpError(400, 'This person is already in your organisation and can see the voyage.');
    if (u && u.role === 'superadmin') throw httpError(400, 'Platform admins already have access.');
    if (u) {
      await db.query(`INSERT INTO voyage_participants (voyage_id, user_id, party_role, can_see_commercials, invited_by) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (voyage_id, user_id) DO UPDATE SET party_role = EXCLUDED.party_role, can_see_commercials = EXCLUDED.can_see_commercials`,
        [a.voyage.id, u.id, b.party, commercial, req.user.id]);
      await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_added', detail: { email: b.email, party: b.party } });
      return { added: true };
    }
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query(`INSERT INTO invites (token_hash, voyage_id, email, party_role, can_see_commercials, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '14 days')`,
      [crypto.createHash('sha256').update(token).digest('hex'), a.voyage.id, b.email.trim(), b.party, commercial, req.user.id]);
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_invited', detail: { email: b.email, party: b.party } });
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    return { link: `${base}/invite.html#${token}` };
  });
  res.status(201).json(out);
}));

// Create a stakeholder login directly (no email needed): returns the login ID for the operator to pass on.
router.post('/participants', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can add people.');
  const b = parse(z.object({
    name: z.string().trim().min(1, 'Enter the person\'s name.').max(120), company: z.string().trim().max(160).optional().default(''),
    loginId: z.string().max(40).optional(), email: z.union([z.literal(''), z.string().trim().email('Enter a valid email or leave it blank.').max(200)]).optional(),
    mobile: z.string().trim().max(30).optional(),
    party: z.enum(Object.keys(Codes.PARTY_ROLES)), commercial: z.boolean().optional(),
    password: z.string().min(10, 'Passwords need at least 10 characters.').max(200),
  }), req.body);
  const commercial = b.commercial ?? !!COMMERCIAL_DEFAULT[b.party];
  const out = await tx(async db => {
    const email = b.email || null;
    const mobile = normalizeMobile(b.mobile);
    if (mobile === undefined) throw httpError(400, 'Enter a valid mobile number, with country code if outside India.');
    if (email && (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])).rows[0])
      throw httpError(409, 'Someone with this email already has a login. Use "Invite by email" to add them.');
    if (mobile && (await db.query('SELECT 1 FROM users WHERE mobile = $1', [mobile])).rows[0])
      throw httpError(409, 'Someone with this mobile number already has a login. Add them with "Existing login ID".');
    const loginId = await LoginId.claim(db, b.loginId, email || b.name);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (tenant_id, login_id, email, mobile, name, company, role, password_hash, must_change_password, created_by_tenant)
       VALUES (NULL,$1,$2,$3,$4,$5,'external',$6,true,$7) RETURNING id`,
      [loginId, email, mobile, b.name, b.company, await bcrypt.hash(b.password, 12), a.voyage.tenant_id]);
    await db.query(`INSERT INTO voyage_participants (voyage_id, user_id, party_role, can_see_commercials, invited_by) VALUES ($1,$2,$3,$4,$5)`,
      [a.voyage.id, u.id, b.party, commercial, req.user.id]);
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_login_created', detail: { loginId, party: b.party } });
    return { loginId };
  });
  res.status(201).json(out);
}));

// Add someone who already has a login, by their login ID.
router.post('/participants/existing', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can add people.');
  const b = parse(z.object({ loginId: LoginId.schema, party: z.enum(Object.keys(Codes.PARTY_ROLES)), commercial: z.boolean().optional() }), req.body);
  const { rows } = await query(`SELECT id, role, tenant_id FROM users WHERE lower(login_id) = lower($1) AND active`, [b.loginId]);
  const u = rows[0];
  if (!u || u.role !== 'external') throw httpError(404, 'No stakeholder login with that ID. Check the spelling, or create a new login.');
  await query(`INSERT INTO voyage_participants (voyage_id, user_id, party_role, can_see_commercials, invited_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (voyage_id, user_id) DO UPDATE SET party_role = EXCLUDED.party_role, can_see_commercials = EXCLUDED.can_see_commercials`,
    [a.voyage.id, u.id, b.party, b.commercial ?? !!COMMERCIAL_DEFAULT[b.party], req.user.id]);
  await audit({ query }, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_added', detail: { loginId: b.loginId, party: b.party } });
  res.status(201).json({ ok: true });
}));

// Reset a stakeholder's password — only for logins this organisation created.
router.post('/participants/:pid/reset', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can reset passwords.');
  const b = parse(z.object({ password: z.string().min(10, 'Passwords need at least 10 characters.').max(200) }), req.body);
  if (!uuid.safeParse(req.params.pid).success) throw httpError(404, 'Not found.');
  const { rows } = await query(`SELECT u.id, u.login_id, u.created_by_tenant FROM voyage_participants p JOIN users u ON u.id = p.user_id WHERE p.id = $1 AND p.voyage_id = $2`, [req.params.pid, a.voyage.id]);
  const u = rows[0];
  if (!u) throw httpError(404, 'Not found.');
  if (u.created_by_tenant !== a.voyage.tenant_id) throw httpError(403, 'This login was created by another organisation. The person can change their own password, or ask whoever created it.');
  await query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [await bcrypt.hash(b.password, 12), u.id]);
  await audit({ query }, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_password_reset', detail: { loginId: u.login_id } });
  res.json({ loginId: u.login_id });
}));

router.patch('/participants/:pid', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!uuid.safeParse(req.params.pid).success) throw httpError(404, 'Not found.');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can change access.');
  const b = parse(z.object({ party: z.enum(Object.keys(Codes.PARTY_ROLES)).optional(), commercial: z.boolean().optional() }), req.body);
  const { rowCount } = await query(`UPDATE voyage_participants SET party_role = COALESCE($1, party_role), can_see_commercials = COALESCE($2, can_see_commercials) WHERE id = $3 AND voyage_id = $4`,
    [b.party ?? null, b.commercial ?? null, req.params.pid, a.voyage.id]);
  if (!rowCount) throw httpError(404, 'Not found.');
  res.json({ ok: true });
}));

router.delete('/participants/:pid', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can remove people.');
  if (!uuid.safeParse(req.params.pid).success) throw httpError(404, 'Not found.');
  await query('DELETE FROM voyage_participants WHERE id = $1 AND voyage_id = $2', [req.params.pid, a.voyage.id]);
  await audit({ query }, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'participant_removed' });
  res.json({ ok: true });
}));

router.delete('/invites/:iid', wrap(async (req, res) => {
  const a = await access(req, 'stakeholders');
  if (!a.manage) throw httpError(403, 'Only the voyage operator can cancel invites.');
  if (!uuid.safeParse(req.params.iid).success) throw httpError(404, 'Not found.');
  await query('DELETE FROM invites WHERE id = $1 AND voyage_id = $2', [req.params.iid, a.voyage.id]);
  res.json({ ok: true });
}));

// ---------- documents ----------
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  csv: 'text/csv', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

router.post('/documents', express.raw({ type: () => true, limit: '15mb' }), wrap(async (req, res) => {
  const a = await access(req, 'documents');
  const filename = decodeURIComponent(req.get('X-Filename') || '').replace(/[\\/\r\n"]/g, '_').slice(0, 200);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!filename || !MIME[ext]) throw httpError(400, 'Upload a PDF, Excel, Word, CSV, text or image file.');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'The file is empty.');
  const docType = ['sof', 'cp', 'other'].includes(req.get('X-Doc-Type')) ? req.get('X-Doc-Type') : 'sof';
  if (docType === 'cp' && !a.commercial) throw httpError(403, 'Only commercial parties can upload charter parties.');
  const portId = req.get('X-Port-Id') || null;
  if (portId && !portIds(a).has(portId)) throw httpError(400, 'That port is not on this voyage.');
  const { rows } = await query(
    `INSERT INTO documents (voyage_id, port_id, uploaded_by, filename, mime, size, sha256, content, doc_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [a.voyage.id, portId, req.user.id, filename, MIME[ext], req.body.length, crypto.createHash('sha256').update(req.body).digest('hex'), req.body, docType]);
  await audit({ query }, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'document_uploaded', detail: { filename, docType } });
  setImmediate(() => processDocument(rows[0].id).catch(e => console.error('extract', e)));
  res.status(201).json({ id: rows[0].id });
}));

async function loadDoc(a, did, cols = 'id, port_id, filename, mime, doc_type, status, result, uploaded_by') {
  if (!uuid.safeParse(did).success) throw httpError(404, 'Document not found.');
  const { rows } = await query(`SELECT ${cols} FROM documents WHERE id = $1 AND voyage_id = $2`, [did, a.voyage.id]);
  if (!rows[0] || (rows[0].doc_type === 'cp' && !a.commercial)) throw httpError(404, 'Document not found.');
  return rows[0];
}

router.get('/documents/:did/file', wrap(async (req, res) => {
  const a = await access(req, 'documents');
  const d = await loadDoc(a, req.params.did, 'filename, mime, content, doc_type');
  res.setHeader('Content-Type', d.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${d.filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(d.content);
}));

router.post('/documents/:did/retry', wrap(async (req, res) => {
  const a = await access(req, 'documents');
  const d = await loadDoc(a, req.params.did);
  if (!a.manage && d.uploaded_by !== req.user.id) throw httpError(403, 'Only the uploader or the operator can retry.');
  setImmediate(() => processDocument(d.id).catch(e => console.error('extract', e)));
  res.json({ ok: true });
}));

router.post('/documents/:did/apply', wrap(async (req, res) => {
  const a = await access(req, 'documents');
  const b = parse(z.object({ events: z.array(z.number().int().min(0)).max(1000).default([]), terms: z.boolean().optional().default(false) }), req.body);
  const d = await loadDoc(a, req.params.did);
  if (d.status !== 'ready' && d.status !== 'applied') throw httpError(400, 'This document has not been read yet.');
  const result = d.result || { events: [] };
  const out = await tx(async db => {
    let added = 0; const skipped = [];
    for (const i of b.events) {
      const e = result.events[i];
      if (!e || e.applied) continue;
      try {
        await insertEvent(db, req, a, { portId: e.port_id, code: e.code, at: e.at, from: e.from_at, to: e.to_at, remark: e.remark }, { source: 'document', documentId: d.id });
        e.applied = true; added++;
      } catch (err) { if (err.status === 400 || err.status === 403) skipped.push(`${(Codes.BY_CODE[e.code] || {}).label || e.code}: ${err.message}`); else throw err; }
    }
    let termsApplied = false;
    if (b.terms && result.terms) {
      if (!a.manage || !a.perms.voyages_edit) throw httpError(403, 'Only the voyage operator can change charter party terms.');
      const { rows } = await db.query('SELECT data FROM voyages WHERE id = $1 FOR UPDATE', [a.voyage.id]);
      const data = rows[0].data, t = result.terms;
      ['vessel', 'charterers', 'owners', 'cargo', 'cpDate', 'demRate', 'desRate', 'hd', 'odad'].forEach(k => { if (t[k] !== undefined) data[k] = t[k]; });
      const port = data.ports.find(p => p.id === d.port_id) || data.ports[0];
      ['qty', 'rate', 'terms'].forEach(k => { if (t[k] !== undefined) port[k] = t[k]; });
      if (t.turn !== undefined) port.turn = t.turn;
      if (t.terms) { const pr = Engine.PRESETS[t.terms]; if (pr) [port.sDay, port.sTime, port.eDay, port.eTime] = pr.map(String); }
      const v = parseVoyage(data);
      await db.query('UPDATE voyages SET data = $1, vessel = $2, charterers = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $5',
        [JSON.stringify(v), v.vessel, v.charterers, req.user.id, a.voyage.id]);
      result.termsApplied = true; termsApplied = true;
    }
    await db.query(`UPDATE documents SET result = $1, status = 'applied', updated_at = now() WHERE id = $2`, [JSON.stringify(result), d.id]);
    await audit(db, { tenantId: a.voyage.tenant_id, userId: req.user.id, voyageId: a.voyage.id, action: 'document_applied', detail: { filename: d.filename, events: added, terms: termsApplied } });
    await refreshSummary(db, a.voyage.id);
    return { added, skipped, termsApplied };
  });
  res.json(out);
}));

// Excel statement for anyone allowed to export and to see amounts (stakeholders included).
router.get('/export.xlsx', wrap(async (req, res) => {
  const a = await access(req, 'export');
  if (!a.commercial) throw httpError(403, 'You do not have access to the amounts on this voyage.');
  const { buildWorkbook } = require('../export');
  const { compute } = require('../voyageData');
  const { merged } = compute(a.voyage.data, await loadEvents({ query }, a.voyage.id));
  const wb = buildWorkbook(merged);
  const name = `Laytime ${(a.voyage.vessel || 'voyage').replace(/[^\w .-]/g, '').trim() || 'voyage'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
