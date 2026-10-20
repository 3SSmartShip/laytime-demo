// End-to-end API tests against a real Postgres. Run with TEST_DATABASE_URL pointing at an EMPTY database:
//   TEST_DATABASE_URL=postgres://laytime:laytime@localhost:5432/laytime_test npm test
const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('API tests (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.ADMIN_EMAIL = 'root@test.local';
  process.env.ADMIN_PASSWORD = 'root-password-123';
  process.env.SEED_DEMO = 'false';
  const { pool } = require('../src/db');
  const { migrate } = require('../src/migrate');
  const { seed } = require('../src/seed');
  const { createApp } = require('../src/server');

  let base, server;
  class Client {
    constructor() { this.cookie = ''; this.tenant = null; }
    async req(method, path, body, raw) {
      const h = { 'X-Requested-With': 'fetch' };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (this.cookie) h.Cookie = this.cookie;
      if (this.tenant) h['X-Tenant-Id'] = this.tenant;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie');
      if (sc) this.cookie = sc.split(';')[0];
      if (raw) return r;
      return { status: r.status, body: await r.json().catch(() => null) };
    }
    async login(login, password, { keepTemp = false } = {}) {
      const r = await this.req('POST', '/api/auth/login', { login, password });
      if (r.status === 200 && r.body.user.mustChangePassword && !keepTemp) await this.req('POST', '/api/auth/password', { current: password, next: password });
      return r;
    }
  }

  test.before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(); await seed();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  test.after(async () => { server.close(); await pool.end(); });

  const root = new Client(), a = new Client(), b = new Client();
  let tA, tB, voyageA;

  test('platform admin signs in and creates two organisations', async () => {
    assert.strictEqual((await root.login('root@test.local', 'wrong-password')).status, 401);
    assert.strictEqual((await root.login('root@test.local', 'root-password-123')).status, 200);
    const r1 = await root.req('POST', '/api/admin/tenants', { name: 'Alpha Shipping', adminName: 'Asha', adminEmail: 'asha@alpha.test', adminPassword: 'alpha-password-1' });
    const r2 = await root.req('POST', '/api/admin/tenants', { name: 'Beta Lines', adminName: 'Bala', adminEmail: 'bala@beta.test', adminPassword: 'beta-password-12' });
    assert.strictEqual(r1.status, 201); assert.strictEqual(r2.status, 201);
    tA = r1.body.tenant.id; tB = r2.body.tenant.id;
  });

  test('CSRF header is required on writes', async () => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403);
  });

  test('tenant admin creates a voyage from the example', async () => {
    assert.strictEqual((await a.login('asha@alpha.test', 'alpha-password-1')).status, 200);
    const r = await a.req('POST', '/api/voyages', { sample: true });
    assert.strictEqual(r.status, 201);
    voyageA = r.body.voyage;
    assert.strictEqual(voyageA.summary.complete, true);
    assert.ok(Math.abs(voyageA.summary.net + 13425.64) < 0.01);
  });

  test('another organisation cannot see, read, change or delete it', async () => {
    assert.strictEqual((await b.login('bala@beta.test', 'beta-password-12')).status, 200);
    assert.strictEqual((await b.req('GET', '/api/voyages')).body.voyages.length, 0);
    assert.strictEqual((await b.req('GET', `/api/voyages/${voyageA.id}`)).status, 404);
    assert.strictEqual((await b.req('PUT', `/api/voyages/${voyageA.id}`, { data: voyageA.data, version: voyageA.version })).status, 404);
    assert.strictEqual((await b.req('DELETE', `/api/voyages/${voyageA.id}`)).status, 404);
    assert.strictEqual((await b.req('GET', `/api/voyages/${voyageA.id}/export.xlsx`)).status, 404);
    // a tenant user cannot switch tenant with the header
    b.tenant = tA;
    assert.strictEqual((await b.req('GET', '/api/voyages')).body.voyages.length, 0);
    b.tenant = null;
    assert.strictEqual((await b.req('GET', '/api/admin/tenants')).status, 403);
  });

  test('platform admin reaches a tenant only by choosing it', async () => {
    assert.strictEqual((await root.req('GET', '/api/voyages')).status, 400);
    root.tenant = tA;
    assert.strictEqual((await root.req('GET', '/api/voyages')).body.voyages.length, 1);
    root.tenant = tB;
    assert.strictEqual((await root.req('GET', '/api/voyages')).body.voyages.length, 0);
  });

  test('saves with versioning and rejects a stale save', async () => {
    const data = { ...voyageA.data, vessel: 'MV Changed' };
    const ok = await a.req('PUT', `/api/voyages/${voyageA.id}`, { data, version: voyageA.version });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.voyage.version, voyageA.version + 1);
    const stale = await a.req('PUT', `/api/voyages/${voyageA.id}`, { data, version: voyageA.version });
    assert.strictEqual(stale.status, 409);
  });

  test('rejects malformed voyage data', async () => {
    const cur = (await a.req('GET', `/api/voyages/${voyageA.id}`)).body.voyage;
    const bad = await a.req('PUT', `/api/voyages/${voyageA.id}`, { data: { ...cur.data, ports: [] }, version: cur.version });
    assert.strictEqual(bad.status, 400);
  });

  test('exports an Excel workbook', async () => {
    const r = await a.req('GET', `/api/voyages/${voyageA.id}/export.xlsx`, undefined, true);
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Summary', '1 Sur LP', '2 Visakhapatnam DP']);
  });

  test('members cannot manage users; disabled users are signed out', async () => {
    const add = await a.req('POST', '/api/admin/users', { name: 'Mo', email: 'mo@alpha.test', role: 'member', password: 'member-password' });
    assert.strictEqual(add.status, 201);
    const m = new Client();
    assert.strictEqual((await m.login('mo@alpha.test', 'member-password')).status, 200);
    assert.strictEqual((await m.req('GET', '/api/admin/users')).status, 403);
    assert.strictEqual((await m.req('DELETE', `/api/voyages/${voyageA.id}`)).status, 403);
    await a.req('PATCH', `/api/admin/users/${add.body.user.id}`, { active: false });
    assert.strictEqual((await m.req('GET', '/api/voyages')).status, 401);
  });

  test('the last admin of an organisation cannot be removed', async () => {
    const me = (await a.req('GET', '/api/auth/me')).body.user;
    assert.strictEqual((await a.req('PATCH', `/api/admin/users/${me.id}`, { role: 'member' })).status, 400);
  });
}
