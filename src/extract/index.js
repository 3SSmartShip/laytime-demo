// Runs an uploaded document through Luma (if configured) or the built-in reader, and stores proposals.
const { query } = require('../db');
const { normalize } = require('./normalize');
const local = require('./local');
const luma = require('./luma');

function provider() {
  const p = (process.env.EXTRACT_PROVIDER || '').toLowerCase();
  if (p === 'local') return 'local';
  if (p === 'luma' || process.env.LUMA_API_URL) return 'luma';
  return 'local';
}

async function processDocument(docId) {
  const { rows } = await query(
    `SELECT d.*, v.data AS voyage_data FROM documents d JOIN voyages v ON v.id = d.voyage_id WHERE d.id = $1`, [docId]);
  const doc = rows[0];
  if (!doc) return;
  const prov = provider();
  await query(`UPDATE documents SET status = 'processing', provider = $2, error = NULL, updated_at = now() WHERE id = $1`, [docId, prov]);
  try {
    const ports = doc.voyage_data.ports || [];
    const context = { vessel: doc.voyage_data.vessel, ports: ports.map(p => ({ name: p.name, operation: p.op })) };
    const args = { buffer: doc.content, filename: doc.filename, mime: doc.mime, docType: doc.doc_type, context };
    let raw;
    if (prov === 'luma') raw = await luma.extract(args);
    else raw = await local.extract(args);
    const result = normalize(raw, { ports, defaultPortId: doc.port_id || (ports[0] && ports[0].id) });
    if (!result.events.length && !result.terms) result.warnings.unshift('No events or terms were found in this document.');
    await query(`UPDATE documents SET status = 'ready', result = $2, updated_at = now() WHERE id = $1`, [docId, JSON.stringify(result)]);
  } catch (e) {
    await query(`UPDATE documents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [docId, String(e.message || e).slice(0, 500)]);
  }
}

module.exports = { processDocument, provider };
