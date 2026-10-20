// Unique login IDs: sign-in, uniqueness, stakeholder logins without email, password resets.
const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('login ID tests (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.ADMIN_LOGIN = '3s.admin';
  process.env.ADMIN_EMAIL = '';
  process.env.ADMIN_PASSWORD = 'root-password-123';
  process.env.SEED_DEMO = 'false';
  const { pool } = require('../src/db');
  const { migrate } = require('../src/migrate');
  const { seed } = require('../src/seed');
  const { createApp } = require('../src/server');

  let base, server;
  class Client {
    constructor() { this.cookie = ''; this.tenant = null; }
    async req(method, path, body) {
      const h = { 'X-Requested-With': 'fetch' };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (this.cookie) h.Cookie = this.cookie;
      if (this.tenant) h['X-Tenant-Id'] = this.tenant;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie');
      if (sc) this.cookie = sc.split(';')[0];
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

  const root = new Client(), opA = new Client(), opB = new Client();
  let vidA, vidB;

  test('platform admin signs in with the login ID from ADMIN_LOGIN, in any case', async () => {
    const r = await root.login('3S.Admin', 'root-password-123');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.loginId, '3s.admin');
    assert.strictEqual((await new Client().login('3s.admin', 'wrong-password')).status, 401);
    assert.strictEqual((await new Client().login('nobody', 'root-password-123')).status, 401);
  });

  test('organisations get an admin with a chosen login ID; no email needed', async () => {
    const a = await root.req('POST', '/api/admin/tenants', { name: 'Alpha', adminName: 'Asha Rao', adminLoginId: 'asha.alpha', adminPassword: 'alpha-password-1' });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(a.body.adminLoginId, 'asha.alpha');
    const dup = await root.req('POST', '/api/admin/tenants', { name: 'Dup', adminName: 'X', adminLoginId: 'ASHA.alpha', adminPassword: 'dup-password-12' });
    assert.strictEqual(dup.status, 409, 'login IDs are unique regardless of case');
    assert.strictEqual(dup.body.suggestion, 'asha.alpha-2');
    const names = (await root.req('GET', '/api/admin/tenants')).body.tenants.map(t => t.name);
    assert.ok(!names.includes('Dup'), 'nothing is created when the login ID is taken');
    const b = await root.req('POST', '/api/admin/tenants', { name: 'Beta', adminName: 'Bala K', adminEmail: 'bala@beta.test', adminPassword: 'beta-password-12' });
    assert.strictEqual(b.body.adminLoginId, 'bala', 'built from the email when left blank');
    assert.strictEqual((await opA.login('asha.alpha', 'alpha-password-1')).status, 200);
    assert.strictEqual((await opB.login('bala@beta.test', 'beta-password-12')).status, 200, 'email still works');
    assert.strictEqual((await new Client().login('bala', 'beta-password-12')).status, 200);
  });

  test('admin adds users by login ID; invalid IDs are refused', async () => {
    const bad = await opA.req('POST', '/api/admin/users', { name: 'Bad', loginId: 'has space', role: 'member', password: 'member-password' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await opA.req('POST', '/api/admin/users', { name: 'Bad', loginId: 'a@b', role: 'member', password: 'member-password' })).status, 400);
    const ok = await opA.req('POST', '/api/admin/users', { name: 'Meera Nair', loginId: 'meera', email: '', role: 'member', password: 'member-password' });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.user.loginId, 'meera');
    assert.strictEqual(ok.body.user.email, null);
    const auto = await opA.req('POST', '/api/admin/users', { name: 'Meera Nair', role: 'member', password: 'member-password' });
    assert.strictEqual(auto.body.user.loginId, 'meera.nair');
    const m = new Client();
    const r = await m.login('MEERA', 'member-password', { keepTemp: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.mustChangePassword, true);
    const blocked = await m.req('GET', '/api/voyages');
    assert.strictEqual(blocked.status, 403, 'nothing works until the temporary password is replaced');
    assert.strictEqual(blocked.body.code, 'password_change_required');
    assert.strictEqual((await m.req('GET', '/api/auth/me')).status, 200);
    assert.strictEqual((await m.req('POST', '/api/auth/password', { current: 'member-password', next: 'my-own-password' })).status, 200);
    assert.strictEqual((await new Client().login('meera', 'my-own-password')).status, 200);
  });

  test('operator creates a stakeholder login without email; it opens only that voyage', async () => {
    vidA = (await opA.req('POST', '/api/voyages', { sample: true })).body.voyage.id;
    vidB = (await opB.req('POST', '/api/voyages', { sample: true })).body.voyage.id;
    const r = await opA.req('POST', `/api/v/${vidA}/participants`, { name: 'Capt. Singh', company: 'MV Vishva Nidhi', loginId: 'master.vnidhi', party: 'master', password: 'master-password-1' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.loginId, 'master.vnidhi');
    const taken = await opA.req('POST', `/api/v/${vidA}/participants`, { name: 'Other', loginId: 'Master.VNidhi', party: 'agent', password: 'other-password-1' });
    assert.strictEqual(taken.status, 409);
    const cap = new Client();
    const li = await cap.login('master.vnidhi', 'master-password-1');
    assert.strictEqual(li.status, 200);
    assert.strictEqual(li.body.user.role, 'external');
    assert.strictEqual(li.body.user.mustChangePassword, true);
    assert.strictEqual((await cap.req('GET', `/api/v/${vidA}`)).status, 200);
    assert.strictEqual((await cap.req('GET', `/api/v/${vidB}`)).status, 404);
    assert.strictEqual((await cap.req('POST', `/api/v/${vidA}/events`, { portId: (await cap.req('GET', `/api/v/${vidA}`)).body.voyage.data.ports[0].id, code: 'NOR_TENDERED', at: '2013-08-30T06:30' })).status, 201);
    const part = (await opA.req('GET', `/api/v/${vidA}`)).body.participants.find(p => p.login_id === 'master.vnidhi');
    assert.strictEqual(part.can_reset, true);
  });

  test('only the organisation that created a stakeholder login can reset its password', async () => {
    const pA = (await opA.req('GET', `/api/v/${vidA}`)).body.participants.find(p => p.login_id === 'master.vnidhi');
    const rs = await opA.req('POST', `/api/v/${vidA}/participants/${pA.id}/reset`, { password: 'reset-password-1' });
    assert.strictEqual(rs.status, 200, 'the creator can reset while the login is only used on its voyages');
    assert.strictEqual((await new Client().login('master.vnidhi', 'reset-password-1')).status, 200);
    const add = await opB.req('POST', `/api/v/${vidB}/participants/existing`, { loginId: 'MASTER.vnidhi', party: 'master' });
    assert.strictEqual(add.status, 201, 'another operator can add an existing stakeholder by login ID');
    const pB = (await opB.req('GET', `/api/v/${vidB}`)).body.participants.find(p => p.login_id === 'master.vnidhi');
    assert.strictEqual(pB.can_reset, false);
    assert.strictEqual((await opB.req('POST', `/api/v/${vidB}/participants/${pB.id}/reset`, { password: 'hijack-password' })).status, 403);
    assert.strictEqual((await opB.req('POST', `/api/v/${vidB}/participants/existing`, { loginId: 'meera', party: 'agent' })).status, 404, 'organisation users cannot be pulled in as stakeholders');
    const takeover = await opA.req('POST', `/api/v/${vidA}/participants/${pA.id}/reset`, { password: 'takeover-password' });
    assert.strictEqual(takeover.status, 403, 'once the login works on Beta voyages, Alpha cannot reset it and sign in as them');
    assert.strictEqual((await new Client().login('master.vnidhi', 'takeover-password')).status, 401);
  });

  test('stakeholders who accept an email invite choose their own login ID', async () => {
    const inv = await opA.req('POST', `/api/v/${vidA}/invites`, { email: 'ops@agency.test', party: 'agent' });
    const token = inv.body.link.split('#')[1];
    const c = new Client();
    const look = await c.req('POST', '/api/invites/lookup', { token });
    assert.strictEqual(look.body.suggestedLoginId, 'ops');
    const clash = await c.req('POST', '/api/invites/accept', { token, loginId: 'meera', name: 'Agent', password: 'agent-password-1' });
    assert.strictEqual(clash.status, 409);
    const ok = await c.req('POST', '/api/invites/accept', { token, loginId: 'coastal.agency', name: 'Agent', password: 'agent-password-1' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.loginId, 'coastal.agency');
    assert.strictEqual((await new Client().login('coastal.agency', 'agent-password-1')).status, 200);
  });

  test('stakeholders see each other by name only, never login IDs or emails', async () => {
    const cap = new Client(); await cap.login('master.vnidhi', 'reset-password-1');
    const parts = (await cap.req('GET', `/api/v/${vidA}`)).body.participants;
    assert.ok(parts.length >= 2);
    parts.forEach(p => { assert.strictEqual(p.login_id, undefined); assert.strictEqual(p.email, undefined); });
  });
}
