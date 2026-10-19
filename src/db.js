const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

async function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function audit(db, { tenantId, userId, voyageId, action, detail }) {
  await db.query('INSERT INTO audit_log (tenant_id, user_id, voyage_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [
    tenantId || null,
    userId || null,
    voyageId || null,
    action,
    detail ? JSON.stringify(detail) : null,
  ]);
}

module.exports = { pool, query, tx, audit };
