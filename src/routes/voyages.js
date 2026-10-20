const express = require('express');
const { z } = require('zod');
const { query, tx, audit } = require('../db');
const { httpError, requirePerm } = require('../auth');
const { redact } = require('../access');
const { parseVoyage, compute, blankVoyage } = require('../voyageData');
const { makeSample } = require('../../shared/sample');
const Engine = require('../../shared/engine');
const { buildWorkbook } = require('../export');
const { loadEvents, exceptionsToEvents } = require('../esof');

const router = express.Router();
const uuid = z.string().uuid();

function idParam(req) {
  const r = uuid.safeParse(req.params.id);
  if (!r.success) throw httpError(404, 'Voyage not found.');
  return r.data;
}

// Every voyage query is scoped by tenant_id = req.tenantId.
async function loadVoyage(db, tenantId, id) {
  const { rows } = await db.query(
    `SELECT v.*, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM voyages v LEFT JOIN users cu ON cu.id = v.created_by LEFT JOIN users uu ON uu.id = v.updated_by
      WHERE v.id = $1 AND v.tenant_id = $2`, [id, tenantId]);
  if (!rows[0]) throw httpError(404, 'Voyage not found.');
  return rows[0];
}

// Without the "Rates and amounts" module, rates and results are never sent.
function out(v, perms) {
  const amounts = !perms || perms.amounts;
  return { id: v.id, vessel: v.vessel, charterers: v.charterers, status: v.status, data: amounts ? v.data : redact(v.data), summary: amounts ? v.summary : null, version: v.version,
    createdBy: v.created_by_name || null, updatedBy: v.updated_by_name || null, createdAt: v.created_at, updatedAt: v.updated_at };
}

async function insertVoyage(db, req, data, status = 'draft') {
  const v = parseVoyage(data);
  const { summary } = compute(v);
  const { rows } = await db.query(
    `INSERT INTO voyages (tenant_id, vessel, charterers, status, data, summary, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [req.tenantId, v.vessel, v.charterers, status, JSON.stringify(v), JSON.stringify(summary), req.user.id]);
  await audit(db, { tenantId: req.tenantId, userId: req.user.id, voyageId: rows[0].id, action: 'voyage_created' });
  return rows[0].id;
}

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const params = [req.tenantId];
    let where = 'v.tenant_id = $1';
    if (q) { params.push(`%${q}%`); where += ` AND (v.vessel ILIKE $2 OR v.charterers ILIKE $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v.data->'ports') p WHERE p->>'name' ILIKE $2))`; }
    const { rows } = await query(
      `SELECT v.id, v.vessel, v.charterers, v.status, v.summary, v.version, v.updated_at, uu.name AS updated_by_name
         FROM voyages v LEFT JOIN users uu ON uu.id = v.updated_by
        WHERE ${where} ORDER BY v.updated_at DESC LIMIT 500`, params);
    res.json({ voyages: rows.map(r => ({ id: r.id, vessel: r.vessel, charterers: r.charterers, status: r.status, summary: req.perms.amounts ? r.summary : (r.summary ? { complete: r.summary.complete, ports: (r.summary.ports || []).map(p => ({ name: p.name, op: p.op })) } : null), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by_name })) });
  } catch (e) { next(e); }
});

router.post('/', requirePerm('voyages_edit'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const data = body.sample ? makeSample(Engine.parseSOF) : (body.data || blankVoyage());
    const id = await tx(async db => {
      const id = await insertVoyage(db, req, data);
      if (body.sample) {
        const { rows } = await db.query('SELECT data FROM voyages WHERE id = $1', [id]);
        await exceptionsToEvents(db, id, rows[0].data, req.user.id, 'operator');
      }
      return id;
    });
    res.status(201).json({ voyage: out(await loadVoyage({ query }, req.tenantId, id), req.perms) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try { res.json({ voyage: out(await loadVoyage({ query }, req.tenantId, idParam(req)), req.perms) }); }
  catch (e) { next(e); }
});

router.put('/:id', requirePerm('voyages_edit'), async (req, res, next) => {
  try {
    const id = idParam(req);
    const body = z.object({ data: z.any(), version: z.number().int(), status: z.enum(['draft', 'final']).optional() }).safeParse(req.body);
    if (!body.success) throw httpError(400, 'Send data and version.');
    const v = parseVoyage(body.data.data);
    const result = await tx(async db => {
      const { summary } = compute(v, await loadEvents(db, id));
      const cur = await loadVoyage(db, req.tenantId, id);
      if (cur.version !== body.data.version) {
        const err = httpError(409, `${cur.updated_by_name || 'Someone'} saved a newer version of this voyage.`);
        err.extra = { version: cur.version };
        throw err;
      }
      await db.query(
        `UPDATE voyages SET vessel=$1, charterers=$2, data=$3, summary=$4, status=COALESCE($5,status),
                version=version+1, updated_by=$6, updated_at=now() WHERE id=$7 AND tenant_id=$8`,
        [v.vessel, v.charterers, JSON.stringify(v), JSON.stringify(summary), body.data.status || null, req.user.id, id, req.tenantId]);
      if (body.data.status && body.data.status !== cur.status)
        await audit(db, { tenantId: req.tenantId, userId: req.user.id, voyageId: id, action: `voyage_${body.data.status}` });
      return loadVoyage(db, req.tenantId, id);
    });
    res.json({ voyage: out(result, req.perms) });
  } catch (e) { next(e); }
});

router.post('/:id/duplicate', requirePerm('voyages_edit'), async (req, res, next) => {
  try {
    const src = await loadVoyage({ query }, req.tenantId, idParam(req));
    const data = { ...src.data, vessel: `${src.data.vessel || 'Voyage'} (copy)` };
    const id = await tx(db => insertVoyage(db, req, data));
    res.status(201).json({ voyage: out(await loadVoyage({ query }, req.tenantId, id), req.perms) });
  } catch (e) { next(e); }
});

router.delete('/:id', requirePerm('voyages_edit'), async (req, res, next) => {
  try {
    const id = idParam(req);
    const cur = await loadVoyage({ query }, req.tenantId, id);
    if (req.user.role === 'member' && cur.created_by !== req.user.id) throw httpError(403, 'Only the person who created this voyage or an admin can delete it.');
    await tx(async db => {
      await audit(db, { tenantId: req.tenantId, userId: req.user.id, voyageId: null, action: 'voyage_deleted', detail: { id, vessel: cur.vessel } });
      await db.query('DELETE FROM voyages WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/:id/export.xlsx', requirePerm('export'), async (req, res, next) => {
  try {
    const v = await loadVoyage({ query }, req.tenantId, idParam(req));
    const { merged } = compute(v.data, await loadEvents({ query }, v.id));
    const wb = buildWorkbook(merged);
    const name = `Laytime ${(v.vessel || 'voyage').replace(/[^\w .-]/g, '').trim() || 'voyage'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

module.exports = router;
