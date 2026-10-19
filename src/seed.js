// First-run setup: platform admin from env, plus an optional demo organisation with the example voyage.
const bcrypt = require('bcryptjs');
const config = require('./config');
const { pool, tx } = require('./db');
const { parseVoyage, compute } = require('./voyageData');
const { makeSample } = require('../shared/sample');
const Engine = require('../shared/engine');

async function seed() {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM users WHERE role = 'superadmin'`);
  if (rows[0].n > 0) return;
  if (!config.adminEmail || !config.adminPassword) {
    console.warn('No platform admin exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart to create one.');
    return;
  }
  if (config.adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  await tx(async db => {
    const {
      rows: [admin],
    } = await db.query(
      `INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (NULL,$1,'Platform admin','superadmin',$2) RETURNING id`,
      [config.adminEmail, await bcrypt.hash(config.adminPassword, 12)],
    );
    console.log(`platform admin created: ${config.adminEmail}`);
    if (!config.seedDemo) return;
    const {
      rows: [t],
    } = await db.query(`INSERT INTO tenants (name) VALUES ('Demo Shipping') RETURNING id`);
    const v = parseVoyage(makeSample(Engine.parseSOF));
    const { summary } = compute(v);
    await db.query(
      `INSERT INTO voyages (tenant_id, vessel, charterers, data, summary, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [t.id, v.vessel, v.charterers, JSON.stringify(v), JSON.stringify(summary), admin.id],
    );
    console.log('demo organisation "Demo Shipping" created with the example voyage');
  });
}

module.exports = { seed };

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
