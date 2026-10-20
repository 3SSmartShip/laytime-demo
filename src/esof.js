// Server helpers for SOF events.
const { compute } = require('./voyageData');

const EVENT_COLS = `e.id, e.author_id, e.port_id, e.kind, e.code, e.at, e.from_at, e.to_at, e.remark, e.source, e.document_id, e.author_party, e.status, e.version,
  e.deleted_at, e.created_at, e.updated_at, u.name AS author_name, u.company AS author_company`;

async function loadEvents(db, voyageId, { withReviews = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${EVENT_COLS} FROM sof_events e LEFT JOIN users u ON u.id = e.author_id
      WHERE e.voyage_id = $1 AND e.deleted_at IS NULL ORDER BY COALESCE(e.at, e.from_at), e.created_at`, [voyageId]);
  const events = rows.map(r => ({ ...r, updated_at: r.updated_at && r.updated_at.toISOString() }));
  if (withReviews && events.length) {
    const { rows: rv } = await db.query(
      `SELECT r.event_id, r.party, r.decision, r.comment, r.at, u.name AS user_name FROM event_reviews r
         LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ANY($1) ORDER BY r.at`, [events.map(e => e.id)]);
    const by = {};
    rv.forEach(r => (by[r.event_id] = by[r.event_id] || []).push(r));
    events.forEach(e => { e.reviews = by[e.id] || []; });
  }
  return events;
}

// Recalculate and store the voyage summary after its data or SOF changed.
async function refreshSummary(db, voyageId) {
  const { rows } = await db.query('SELECT data FROM voyages WHERE id = $1', [voyageId]);
  if (!rows[0]) return;
  const events = await loadEvents(db, voyageId);
  const { summary } = compute(rows[0].data, events);
  await db.query('UPDATE voyages SET summary = $1 WHERE id = $2', [JSON.stringify(summary), voyageId]);
}

// Moves a voyage's typed-in exceptions into the SOF as events (used for the example voyage).
async function exceptionsToEvents(db, voyageId, data, userId, party) {
  const Codes = require('../shared/codes');
  for (const p of data.ports) {
    for (const x of p.exceptions || []) {
      await db.query(`INSERT INTO sof_events (voyage_id, port_id, kind, code, from_at, to_at, remark, source, author_id, author_party, status)
        VALUES ($1,$2,'stoppage',$3,$4,$5,$6,'manual',$7,$8,'open')`, [voyageId, p.id, Codes.guess(x.d), x.f, x.t, x.d, userId, party]);
    }
    p.exceptions = [];
  }
  await db.query('UPDATE voyages SET data = $1 WHERE id = $2', [JSON.stringify(data), voyageId]);
  await refreshSummary(db, voyageId);
}

module.exports = { loadEvents, refreshSummary, exceptionsToEvents };
