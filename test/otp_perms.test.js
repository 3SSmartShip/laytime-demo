// One-time-code sign-in (SMS and email through mock gateways) and role × module permissions.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('OTP and permission tests (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.ADMIN_LOGIN = 'root';
  process.env.ADMIN_PASSWORD = 'root-password-123';
  process.env.SEED_DEMO = 'false';
  process.env.OTP_SMS_PROVIDER = 'webhook';
  process.env.OTP_EMAIL_PROVIDER = 'webhook';
  const { pool } = require('../src/db');
  const { migrate } = require('../src/migrate');
  const { seed } = require('../src/seed');
  const { createApp } = require('../src/server');

  let base, server, gw;
  const outbox = [];
  const lastCode = to => { const m = [...outbox].reverse().find(x => x.to === to); return m && m.code; };

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
    gw = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { outbox.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(b) }); res.end('{}'); }); }).listen(0);
    const g = `http://127.0.0.1:${gw.address().port}`;
    process.env.SMS_WEBHOOK_URL = `${g}/sms`; process.env.SMS_WEBHOOK_TOKEN = 'sms-token';
    process.env.EMAIL_WEBHOOK_URL = `${g}/email`;
  });
  test.after(async () => { server.close(); gw.close(); await pool.end(); });

  const root = new Client(), op = new Client();
  let tid, vid, memberId;

  test('setup: organisation, member with mobile, voyage, agent with mobile', async () => {
    await root.login('root', 'root-password-123');
    tid = (await root.req('POST', '/api/admin/tenants', { name: 'Op Co', adminName: 'Ops', adminLoginId: 'ops', adminEmail: 'ops@op.test', adminPassword: 'ops-password-1' })).body.tenant.id;
    await op.login('ops', 'ops-password-1');
    const m = await op.req('POST', '/api/admin/users', { name: 'Meera', loginId: 'meera', mobile: '98765 43210', role: 'member', password: 'member-password' });
    assert.strictEqual(m.status, 201);
    assert.strictEqual(m.body.user.mobile, '+919876543210', 'Indian 10-digit numbers get +91');
    memberId = m.body.user.id;
    const dup = await op.req('POST', '/api/admin/users', { name: 'X', loginId: 'xx1', mobile: '+91 98765-43210', role: 'member', password: 'member-password' });
    assert.strictEqual(dup.status, 409, 'mobile numbers are unique');
    assert.strictEqual((await op.req('POST', '/api/admin/users', { name: 'X', loginId: 'xx2', mobile: '12345', role: 'member', password: 'member-password' })).status, 400);
    vid = (await op.req('POST', '/api/voyages', { sample: true })).body.voyage.id;
    const ag = await op.req('POST', `/api/v/${vid}/participants`, { name: 'Ravi', loginId: 'ravi.agent', mobile: '+65 9123 4567', party: 'agent', password: 'agent-password-1' });
    assert.strictEqual(ag.status, 201);
  });

  test('login options report which code channels are on', async () => {
    const r = await new Client().req('GET', '/api/auth/otp/options');
    assert.deepStrictEqual(r.body, { sms: true, email: true });
  });

  test('sign in with a code sent by SMS', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/auth/otp/request', { login: '9876543210' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.channel, 'sms');
    assert.strictEqual(r.body.sentTo, '+91••••••3210');
    const sms = outbox.at(-1);
    assert.strictEqual(sms.path, '/sms');
    assert.strictEqual(sms.auth, 'Bearer sms-token');
    assert.strictEqual(sms.to, '+919876543210');
    assert.match(sms.code, /^\d{6}$/);
    assert.match(sms.message, /sign-in code/);
    const wrong = await c.req('POST', '/api/auth/otp/verify', { login: '9876543210', code: sms.code === '000000' ? '111111' : '000000' });
    assert.strictEqual(wrong.status, 400);
    assert.match(wrong.body.error, /4 attempts left/);
    const ok = await c.req('POST', '/api/auth/otp/verify', { login: '+91 98765 43210', code: sms.code });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.user.loginId, 'meera');
    assert.strictEqual(ok.body.user.signedInWith, 'otp');
    // a temporary password does not block someone who proved they hold the phone
    assert.strictEqual(ok.body.user.mustChangePassword, true);
    assert.strictEqual((await c.req('GET', '/api/voyages')).status, 200);
    // and they can set a password without knowing the temporary one
    assert.strictEqual((await c.req('POST', '/api/auth/password', { next: 'meera-own-password' })).status, 200);
    assert.strictEqual((await new Client().login('meera', 'meera-own-password')).status, 200);
    assert.strictEqual((await c.req('POST', '/api/auth/otp/verify', { login: '9876543210', code: sms.code })).status, 400, 'a code works once');
  });

  test('sign in with a code sent by email; stakeholders too', async () => {
    const c = new Client();
    await c.req('POST', '/api/auth/otp/request', { login: 'OPS@op.test' });
    const em = outbox.at(-1);
    assert.strictEqual(em.path, '/email');
    assert.strictEqual(em.to, 'ops@op.test');
    assert.match(em.subject, /code/);
    assert.strictEqual((await c.req('POST', '/api/auth/otp/verify', { login: 'ops@op.test', code: em.code })).status, 200);
    const s = new Client();
    await s.req('POST', '/api/auth/otp/request', { login: '+6591234567' });
    const r = await s.req('POST', '/api/auth/otp/verify', { login: '+65 9123 4567', code: lastCode('+6591234567') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.role, 'external');
    assert.strictEqual((await s.req('GET', `/api/v/${vid}`)).status, 200);
  });

  test('unknown numbers get the same answer and no message', async () => {
    const n = outbox.length;
    const r = await new Client().req('POST', '/api/auth/otp/request', { login: '9000000000' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sentTo, '+91••••••0000');
    assert.strictEqual(outbox.length, n);
    assert.strictEqual((await new Client().req('POST', '/api/auth/otp/request', { login: 'not a number' })).status, 400);
  });

  test('resend waits a minute; five wrong codes lock the code; disabled users get nothing', async () => {
    await pool.query("UPDATE otp_codes SET created_at = created_at - interval '2 minutes'");
    const n = outbox.length;
    await new Client().req('POST', '/api/auth/otp/request', { login: '9876543210' });
    await new Client().req('POST', '/api/auth/otp/request', { login: '9876543210' });
    assert.strictEqual(outbox.length, n + 1, 'second request within 60 s does not send');
    const code = outbox.at(-1).code, bad = code === '123456' ? '654321' : '123456';
    const c = new Client();
    for (let i = 0; i < 5; i++) await c.req('POST', '/api/auth/otp/verify', { login: '9876543210', code: bad });
    const locked = await c.req('POST', '/api/auth/otp/verify', { login: '9876543210', code });
    assert.strictEqual(locked.status, 400);
    assert.match(locked.body.error, /Too many wrong codes/);
    await op.req('PATCH', `/api/admin/users/${memberId}`, { active: false });
    await pool.query("UPDATE otp_codes SET created_at = created_at - interval '2 minutes'");
    const m = outbox.length;
    await new Client().req('POST', '/api/auth/otp/request', { login: '9876543210' });
    assert.strictEqual(outbox.length, m, 'no code for a disabled account');
    await op.req('PATCH', `/api/admin/users/${memberId}`, { active: true });
  });

  test('people can add and verify their own mobile number', async () => {
    const c = new Client(); await c.login('ops', 'ops-password-1');
    const r = await c.req('POST', '/api/auth/otp/contact/request', { kind: 'mobile', value: '91234 56789' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await c.req('POST', '/api/auth/otp/contact/verify', { kind: 'mobile', value: '9123456789', code: '000000' })).status, 400);
    const ok = await c.req('POST', '/api/auth/otp/contact/verify', { kind: 'mobile', value: '9123456789', code: lastCode('+919123456789') });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await c.req('GET', '/api/auth/me')).body.user.mobile, '+919123456789');
    const taken = await c.req('POST', '/api/auth/otp/contact/request', { kind: 'mobile', value: '+65 9123 4567' });
    assert.strictEqual(taken.status, 409, 'cannot claim someone else\'s number');
  });

  test('verifying a new contact allows five tries, then the code is dead', async () => {
    // earlier tests used up this IP's code requests; start a fresh window
    const { limiters } = require('../src/routes/otp');
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) { limiters.request.resetKey(ip); limiters.verify.resetKey(ip); }
    const c = new Client(); await c.login('meera', 'meera-own-password');
    assert.strictEqual((await c.req('POST', '/api/auth/otp/contact/request', { kind: 'email', value: 'meera@op.test' })).status, 200);
    const code = lastCode('meera@op.test'), bad = code === '000000' ? '111111' : '000000';
    const msgs = [];
    for (let i = 0; i < 5; i++) msgs.push((await c.req('POST', '/api/auth/otp/contact/verify', { kind: 'email', value: 'meera@op.test', code: bad })).body.error);
    assert.match(msgs[0], /4 attempts left/);
    assert.match(msgs[3], /1 attempt left/);
    const right = await c.req('POST', '/api/auth/otp/contact/verify', { kind: 'email', value: 'meera@op.test', code });
    assert.strictEqual(right.status, 400);
    assert.match(right.body.error, /Too many/);
  });

  // ---------- permissions ----------
  const setPerm = (role, module, enabled, scope = 'default') => root.req('PUT', `/api/admin/permissions?scope=${scope}`, { role, module, enabled });

  test('only the platform admin can see or change permissions', async () => {
    assert.strictEqual((await op.req('GET', '/api/admin/permissions')).status, 403);
    assert.strictEqual((await op.req('PUT', '/api/admin/permissions', { role: 'member', module: 'export', enabled: false })).status, 403);
    const m = await root.req('GET', '/api/admin/permissions');
    assert.strictEqual(m.status, 200);
    assert.strictEqual(m.body.cells.member.users.applies, false);
    assert.strictEqual(m.body.cells.agent.voyages_edit.applies, false);
    assert.strictEqual(m.body.cells.admin.export.value, true);
    assert.strictEqual((await setPerm('agent', 'voyages_edit', true)).status, 400, 'cannot grant a module that does not apply');
  });

  test('turning off a module for a role blocks it on the server and hides it', async () => {
    const meera = new Client(); await meera.login('meera', 'meera-own-password');
    assert.strictEqual((await meera.req('GET', `/api/voyages/${vid}/export.xlsx`)).status, 200);
    await setPerm('member', 'export', false);
    assert.strictEqual((await meera.req('GET', `/api/voyages/${vid}/export.xlsx`)).status, 403);
    assert.strictEqual((await meera.req('GET', '/api/auth/me')).body.user.perms.export, false);
    assert.strictEqual((await op.req('GET', `/api/voyages/${vid}/export.xlsx`)).status, 200, 'admins unaffected');
    // amounts off: no rates or results; editing switches off with it
    await setPerm('member', 'amounts', false);
    const v = (await meera.req('GET', `/api/voyages/${vid}`)).body.voyage;
    assert.strictEqual(v.data.demRate, undefined);
    assert.strictEqual(v.summary, null);
    assert.strictEqual((await meera.req('GET', '/api/voyages')).body.voyages[0].summary.net, undefined);
    assert.strictEqual((await meera.req('GET', '/api/auth/me')).body.user.perms.voyages_edit, false, 'editing needs amounts');
    assert.strictEqual((await meera.req('PUT', `/api/voyages/${vid}`, { data: v.data, version: v.version })).status, 403);
    assert.strictEqual((await meera.req('GET', `/api/v/${vid}`)).body.voyage.summary, null);
    const mx = (await root.req('GET', '/api/admin/permissions')).body;
    assert.strictEqual(mx.cells.member.voyages_edit.value, true);
    assert.strictEqual(mx.cells.member.voyages_edit.blocked, true, 'the matrix shows it is blocked by a dependency');
    await setPerm('member', 'amounts', null);
    await setPerm('member', 'export', null);
    assert.strictEqual((await meera.req('GET', '/api/auth/me')).body.user.perms.export, true, 'reset to built-in default');
  });

  test('stakeholder modules: agents can be stopped from recording or uploading', async () => {
    const agent = new Client(); await agent.login('ravi.agent', 'agent-password-1');
    const portId = (await op.req('GET', `/api/v/${vid}`)).body.voyage.data.ports[1].id;
    assert.strictEqual((await agent.req('POST', `/api/v/${vid}/events`, { portId, code: 'RAIN', from: '2013-09-23T08:00', to: '2013-09-23T09:00' })).status, 201);
    await setPerm('agent', 'sof_record', false);
    assert.strictEqual((await agent.req('POST', `/api/v/${vid}/events`, { portId, code: 'RAIN', from: '2013-09-23T10:00', to: '2013-09-23T11:00' })).status, 403);
    assert.deepStrictEqual((await agent.req('GET', `/api/v/${vid}`)).body.access.recordable, []);
    await setPerm('agent', 'documents', false);
    assert.deepStrictEqual((await agent.req('GET', `/api/v/${vid}`)).body.documents, []);
    await setPerm('agent', 'sof_view', false);
    const v = (await agent.req('GET', `/api/v/${vid}`)).body;
    assert.deepStrictEqual(v.events, []);
    assert.strictEqual(v.access.perms.sof_review, false, 'reviewing needs the SOF');
    await Promise.all(['sof_record', 'documents', 'sof_view'].map(m => setPerm('agent', m, null)));
  });

  test('per-organisation overrides beat the default, and only for that organisation', async () => {
    const other = (await root.req('POST', '/api/admin/tenants', { name: 'Other', adminName: 'O', adminLoginId: 'other.admin', adminPassword: 'other-password-1' })).body.tenant.id;
    const oc = new Client(); await oc.login('other.admin', 'other-password-1');
    await setPerm('admin', 'audit', false);
    assert.strictEqual((await op.req('GET', '/api/admin/audit')).status, 403);
    assert.strictEqual((await oc.req('GET', '/api/admin/audit')).status, 403);
    await setPerm('admin', 'audit', true, tid);
    assert.strictEqual((await op.req('GET', '/api/admin/audit')).status, 200, 'Op Co override turns it back on');
    assert.strictEqual((await oc.req('GET', '/api/admin/audit')).status, 403, 'others keep the default');
    const m = (await root.req('GET', `/api/admin/permissions?scope=${tid}`)).body;
    assert.strictEqual(m.cells.admin.audit.source, 'organisation');
    assert.strictEqual(m.cells.admin.audit.inherited, false);
    assert.strictEqual((await root.req('DELETE', `/api/admin/permissions?scope=${tid}`)).status, 200);
    assert.strictEqual((await op.req('GET', '/api/admin/audit')).status, 403);
    await setPerm('admin', 'audit', null);
    assert.strictEqual((await op.req('GET', '/api/admin/audit')).status, 200);
    assert.ok(other);
  });
}
