// Stakeholders, live SOF and document reading. Needs TEST_DATABASE_URL (an empty database; it is wiped).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('eSOF tests (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.ADMIN_EMAIL = 'root@test.local';
  process.env.ADMIN_PASSWORD = 'root-password-123';
  process.env.SEED_DEMO = 'false';
  delete process.env.LUMA_API_URL;
  const { pool } = require('../src/db');
  const { migrate } = require('../src/migrate');
  const { seed } = require('../src/seed');
  const { createApp } = require('../src/server');

  let base, server, luma, lumaHits = 0, lumaSaw = null;
  class Client {
    constructor() { this.cookie = ''; }
    async req(method, path, body, headers = {}) {
      const h = { 'X-Requested-With': 'fetch', ...headers };
      let payload;
      if (Buffer.isBuffer(body)) { payload = body; h['Content-Type'] = 'application/octet-stream'; }
      else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
      if (this.cookie) h.Cookie = this.cookie;
      const r = await fetch(base + path, { method, headers: h, body: payload });
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
  const waitDoc = async (c, vid, did) => {
    for (let i = 0; i < 50; i++) {
      const d = (await c.req('GET', `/api/v/${vid}`)).body.documents.find(x => x.id === did);
      if (d && ['ready', 'failed', 'applied'].includes(d.status)) return d;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('document not processed');
  };

  test.before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(); await seed();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    // stand-in for the Luma API
    luma = http.createServer((req, res) => {
      lumaHits++;
      let n = 0; req.on('data', c => { n += c.length; });
      req.on('end', () => {
        lumaSaw = { auth: req.headers.authorization, type: req.headers['content-type'], bytes: n };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { events: [
          { kind: 'milestone', code: 'NOR_TENDERED', at: '13.09.2013 08:05', remark: 'NOR tendered' },
          { kind: 'stoppage', code: 'RAIN', from: '2013-09-16T15:00', to: '2013-09-16T22:30', remark: 'Rain' },
          { kind: 'stoppage', from: '2013-09-17T10:00', to: '2013-09-17T11:00', remark: "Ship's crane no. 2 breakdown" },
          { kind: 'stoppage', remark: 'no times here' },
        ], terms: { demRate: '7,000', hd: true, terms: 'SAFSHEX', rate: 6000, qty: 36010.25, turnTimeHours: 24 } } }));
      });
    }).listen(0);
  });
  test.after(async () => { server.close(); luma.close(); await pool.end(); });

  const root = new Client(), op = new Client(), agent = new Client(), owner = new Client(), steve = new Client(), outsider = new Client();
  let vid, portLP, portDP;

  test('operator sets up an organisation and the example voyage', async () => {
    await root.login('root@test.local', 'root-password-123');
    await root.req('POST', '/api/admin/tenants', { name: 'Op Co', adminName: 'Ops', adminEmail: 'ops@op.test', adminPassword: 'ops-password-1' });
    await root.req('POST', '/api/admin/tenants', { name: 'Other Co', adminName: 'Oth', adminEmail: 'oth@other.test', adminPassword: 'oth-password-1' });
    await op.login('ops@op.test', 'ops-password-1');
    const r = await op.req('POST', '/api/voyages', { sample: true });
    assert.strictEqual(r.status, 201);
    vid = r.body.voyage.id;
    const v = await op.req('GET', `/api/v/${vid}`);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.access.manage, true);
    assert.strictEqual(v.body.events.length, 27, 'example exceptions became SOF events');
    [portLP, portDP] = v.body.voyage.data.ports.map(p => p.id);
    assert.ok(Math.abs(v.body.voyage.summary.net + 13425.64) < 0.01, 'figures unchanged after moving to events');
  });

  async function invite(party, email, name) {
    const r = await op.req('POST', `/api/v/${vid}/invites`, { email, party });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const token = r.body.link.split('#')[1];
    const c = new Client();
    const look = await c.req('POST', '/api/invites/lookup', { token });
    assert.strictEqual(look.body.existingAccount, false);
    const acc = await c.req('POST', '/api/invites/accept', { token, name, company: 'X', password: `${party}-password-1` });
    assert.strictEqual(acc.status, 200);
    assert.strictEqual((await c.req('POST', '/api/invites/accept', { token, name, password: 'whatever-123' })).status, 410, 'link is single use');
    return c;
  }

  test('stakeholders join by invite link', async () => {
    Object.assign(agent, await invite('agent', 'agent@port.test', 'Port Agent'));
    Object.assign(owner, await invite('owner', 'owner@ship.test', 'Owner Rep'));
    Object.assign(steve, await invite('stevedore', 'steve@stv.test', 'Stevedore'));
    const mine = await agent.req('GET', '/api/invites/mine');
    assert.strictEqual(mine.body.voyages.length, 1);
    assert.strictEqual(mine.body.voyages[0].summary, null, 'agent sees no commercial summary');
  });

  test('operational roles do not see commercial terms; owners do', async () => {
    const a = (await agent.req('GET', `/api/v/${vid}`)).body;
    assert.strictEqual(a.access.commercial, false);
    assert.strictEqual(a.voyage.data.demRate, undefined);
    assert.strictEqual(a.voyage.data.ports[0].rate, undefined);
    assert.strictEqual(a.voyage.summary, null);
    const o = (await owner.req('GET', `/api/v/${vid}`)).body;
    assert.strictEqual(o.access.commercial, true);
    assert.strictEqual(o.voyage.data.demRate, '7000');
  });

  test('tenant-only routes stay closed to stakeholders and outsiders', async () => {
    assert.strictEqual((await agent.req('GET', '/api/voyages')).status, 403);
    assert.strictEqual((await agent.req('GET', `/api/voyages/${vid}`)).status, 403);
    await outsider.login('oth@other.test', 'oth-password-1');
    assert.strictEqual((await outsider.req('GET', `/api/v/${vid}`)).status, 404);
    assert.strictEqual((await outsider.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'RAIN', from: '2013-09-15T01:00', to: '2013-09-15T02:00' })).status, 404);
  });

  let rainId;
  test('agent records a stoppage; it changes the result for everyone', async () => {
    const before = (await owner.req('GET', `/api/v/${vid}`)).body.voyage.summary.net;
    const r = await agent.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'RAIN', from: '2013-09-23T08:00', to: '2013-09-23T10:00', remark: 'Heavy rain' });
    assert.strictEqual(r.status, 201);
    rainId = r.body.id;
    const after = (await owner.req('GET', `/api/v/${vid}`)).body.voyage.summary.net;
    assert.ok(Math.abs((after - before) - (-2 / 24 * 3500)) < 0.01, '2h more NTC = 2h more despatch');
  });

  test('roles limit what can be recorded', async () => {
    const r = await steve.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'NOR_TENDERED', at: '2013-09-13T08:05' });
    assert.strictEqual(r.status, 403);
    const ok = await steve.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'SHORE_EQUIP', from: '2013-09-23T11:00', to: '2013-09-23T12:00', remark: 'Grab 2 down' });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual((await owner.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'RAIN', from: '2013-09-23T13:00', to: '2013-09-23T14:00' })).status, 403);
  });

  test('confirm and dispute', async () => {
    assert.strictEqual((await agent.req('POST', `/api/v/${vid}/events/${rainId}/review`, { decision: 'confirm' })).status, 400, 'cannot confirm own event');
    assert.strictEqual((await owner.req('POST', `/api/v/${vid}/events/${rainId}/review`, { decision: 'dispute' })).status, 400, 'dispute needs a reason');
    assert.strictEqual((await owner.req('POST', `/api/v/${vid}/events/${rainId}/review`, { decision: 'dispute', comment: 'Log shows drizzle only until 08:40' })).status, 200);
    let v = (await op.req('GET', `/api/v/${vid}`)).body;
    let e = v.events.find(x => x.id === rainId);
    assert.strictEqual(e.status, 'disputed');
    assert.strictEqual(v.voyage.summary.disputed, 1);
    assert.strictEqual(e.reviews[0].party, 'owner');
    // the author can no longer silently edit a confirmed event, but can fix a disputed one
    const fix = await agent.req('PATCH', `/api/v/${vid}/events/${rainId}`, { portId: portDP, code: 'RAIN', from: '2013-09-23T08:00', to: '2013-09-23T08:40', remark: 'Rain', version: e.version });
    assert.strictEqual(fix.status, 200);
    e = (await op.req('GET', `/api/v/${vid}`)).body.events.find(x => x.id === rainId);
    assert.strictEqual(e.status, 'open');
    assert.strictEqual((await owner.req('POST', `/api/v/${vid}/events/${rainId}/review`, { decision: 'confirm' })).status, 200);
    assert.strictEqual((await agent.req('DELETE', `/api/v/${vid}/events/${rainId}`)).status, 403, 'confirmed events cannot be removed by the author');
  });

  test('reviews: stale confirms are refused, and a side cannot confirm its own events', async () => {
    const r = await agent.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'RAIN', from: '2013-09-23T16:00', to: '2013-09-23T17:00', remark: 'Rain' });
    const seen = (await owner.req('GET', `/api/v/${vid}`)).body.events.find(x => x.id === r.body.id);
    await agent.req('PATCH', `/api/v/${vid}/events/${r.body.id}`, { portId: portDP, code: 'RAIN', from: '2013-09-23T16:00', to: '2013-09-23T18:00', remark: 'Rain', version: seen.version });
    const stale = await owner.req('POST', `/api/v/${vid}/events/${r.body.id}/review`, { decision: 'confirm', version: seen.version });
    assert.strictEqual(stale.status, 409, 'the owner saw 1 hour, the event now says 2');
    const fresh = (await owner.req('GET', `/api/v/${vid}`)).body.events.find(x => x.id === r.body.id);
    assert.strictEqual((await owner.req('POST', `/api/v/${vid}/events/${r.body.id}/review`, { decision: 'dispute', comment: 'Rain stopped 17:00', version: fresh.version })).status, 200);
    assert.strictEqual((await steve.req('POST', `/api/v/${vid}/events/${r.body.id}/review`, { decision: 'confirm', version: fresh.version })).status, 403,
      'a third party cannot wipe the owner\'s dispute by confirming');
    const mine = await op.req('POST', `/api/v/${vid}/events`, { portId: portDP, code: 'RAIN', from: '2013-09-23T19:00', to: '2013-09-23T19:30' });
    const colleague = new Client(); await colleague.login('ops@op.test', 'ops-password-1');
    assert.strictEqual((await colleague.req('POST', `/api/v/${vid}/events/${mine.body.id}/review`, { decision: 'confirm' })).status, 400, 'the operator side cannot confirm its own event');
  });

  test('pasted SOF lines become events', async () => {
    const r = await agent.req('POST', `/api/v/${vid}/events/bulk`, { portId: portDP, text: '23.09.2013 12:30 13:00 Shifting berth\n23.09.2013 15:15 Completed discharge\nnonsense' });
    assert.strictEqual(r.body.created, 2);
    assert.strictEqual(r.body.skipped.length, 1);
  });

  test('CP treatment table changes how a reason counts', async () => {
    const cur = (await op.req('GET', `/api/voyages/${vid}`)).body.voyage;
    const n0 = cur.summary.net;
    const data = { ...cur.data, codeRules: { SHIFT_HATCH: { p: 100, od: false } } };
    const r = await op.req('PUT', `/api/voyages/${vid}`, { data, version: cur.version });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.voyage.summary.net > n0, 'loader shifting now counts, so less despatch');
  });

  test('built-in reader: CSV SOF upload, review and apply', async () => {
    const csv = Buffer.from([
      'Date,Time,Event', '22.09.2013,0805,NOR tendered', '22.09.2013,1000-1130,Cargo operations suspended due to rain',
      '22.09.2013,1200-1400,Discharging in progress', '23.09.2013,0930 1015,Awaiting trucks',
    ].join('\n'));
    const up = await agent.req('POST', `/api/v/${vid}/documents`, csv, { 'X-Filename': 'sof.csv', 'X-Doc-Type': 'sof', 'X-Port-Id': portDP });
    assert.strictEqual(up.status, 201);
    const d = await waitDoc(agent, vid, up.body.id);
    assert.strictEqual(d.status, 'ready', d.error);
    assert.strictEqual(d.provider, 'local');
    const codes = d.result.events.map(e => e.code);
    assert.deepStrictEqual(codes, ['NOR_TENDERED', 'RAIN', 'AWAIT_CARGO']);
    const ap = await agent.req('POST', `/api/v/${vid}/documents/${d.id}/apply`, { events: [1, 2] });
    assert.strictEqual(ap.body.added, 2);
    const again = await agent.req('POST', `/api/v/${vid}/documents/${d.id}/apply`, { events: [1] });
    assert.strictEqual(again.body.added, 0, 'already applied');
    assert.strictEqual((await agent.req('POST', `/api/v/${vid}/documents/${d.id}/apply`, { events: [], terms: true })).status, 200);
  });

  test('built-in reader rejects PDFs with a clear message', async () => {
    const up = await agent.req('POST', `/api/v/${vid}/documents`, Buffer.from('%PDF-1.4 test'), { 'X-Filename': 'sof.pdf', 'X-Port-Id': portDP });
    const d = await waitDoc(agent, vid, up.body.id);
    assert.strictEqual(d.status, 'failed');
    assert.match(d.error, /Luma/);
  });

  test('an Excel zip bomb is refused and the server keeps working', async () => {
    const { zipOf } = require('./helpers/zip');
    const bomb = zipOf('xl/worksheets/sheet1.xml', Buffer.alloc(40 * 1024 * 1024, 0x41));
    const up = await agent.req('POST', `/api/v/${vid}/documents`, bomb, { 'X-Filename': 'sof.xlsx', 'X-Port-Id': portDP });
    assert.strictEqual(up.status, 201);
    const d = await waitDoc(agent, vid, up.body.id);
    assert.strictEqual(d.status, 'failed');
    assert.match(d.error, /too large/);
    assert.strictEqual((await agent.req('GET', `/api/v/${vid}`)).status, 200);
  });

  test('files with non-Latin names download with their real name', async () => {
    const up = await agent.req('POST', `/api/v/${vid}/documents`, Buffer.from('a,b'), { 'X-Filename': encodeURIComponent('SOF – Paradip 港.csv'), 'X-Port-Id': portDP });
    assert.strictEqual(up.status, 201);
    const r = await fetch(`${base}/api/v/${vid}/documents/${up.body.id}/file`, { headers: { Cookie: agent.cookie } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''SOF%20%E2%80%93%20Paradip%20%E6%B8%AF\.csv/);
    assert.strictEqual((await agent.req('POST', `/api/v/${vid}/documents`, Buffer.from('a'), { 'X-Filename': '%E2%80', 'X-Port-Id': portDP })).status, 400, 'broken %-encoding is a 400, not a 500');
  });

  test('people outside the voyage cannot upload to it', async () => {
    const outsider = new Client(); await outsider.login('oth@other.test', 'oth-password-1');
    const r = await outsider.req('POST', `/api/v/${vid}/documents`, Buffer.from('a,b'), { 'X-Filename': 'x.csv' });
    assert.strictEqual(r.status, 404);
  });

  test('Luma provider: sends the file, normalises the answer, applies terms', async () => {
    process.env.LUMA_API_URL = `http://127.0.0.1:${luma.address().port}/extract`;
    process.env.LUMA_API_KEY = 'test-key';
    const cp = await agent.req('POST', `/api/v/${vid}/documents`, Buffer.from('%PDF'), { 'X-Filename': 'cp.pdf', 'X-Doc-Type': 'cp' });
    assert.strictEqual(cp.status, 403, 'agents cannot upload charter parties');
    const up = await op.req('POST', `/api/v/${vid}/documents`, Buffer.from('%PDF-1.4 pretend SOF'), { 'X-Filename': 'sof scan.pdf', 'X-Doc-Type': 'sof', 'X-Port-Id': portDP });
    const d = await waitDoc(op, vid, up.body.id);
    assert.strictEqual(d.status, 'ready', d.error);
    assert.strictEqual(d.provider, 'luma');
    assert.strictEqual(lumaSaw.auth, 'Bearer test-key');
    assert.match(lumaSaw.type, /multipart\/form-data/);
    assert.deepStrictEqual(d.result.events.map(e => e.code), ['NOR_TENDERED', 'RAIN', 'SHIP_GEAR']);
    assert.strictEqual(d.result.events[0].at, '2013-09-13T08:05');
    assert.ok(d.result.warnings.some(w => /no start time/.test(w)));
    assert.deepStrictEqual(d.result.terms, { demRate: '7000', hd: true, qty: '36010.25', rate: '6000', turn: '24', terms: 'SATPM SHEX' });
    const seenByAgent = (await agent.req('GET', `/api/v/${vid}`)).body.documents.find(x => x.id === d.id);
    assert.ok(seenByAgent, 'agents still see the SOF document');
    assert.strictEqual(seenByAgent.result.terms, undefined, 'but not the rates read from it');
    assert.strictEqual((await owner.req('GET', `/api/v/${vid}`)).body.documents.find(x => x.id === d.id).result.terms.demRate, '7000');
    const cur = (await op.req('GET', `/api/voyages/${vid}`)).body.voyage;
    const ap = await op.req('POST', `/api/v/${vid}/documents/${d.id}/apply`, { events: [2], terms: true });
    assert.strictEqual(ap.body.added, 1);
    assert.strictEqual(ap.body.termsApplied, true);
    const now = (await op.req('GET', `/api/voyages/${vid}`)).body.voyage;
    assert.strictEqual(now.version, cur.version + 1);
    assert.strictEqual(now.data.ports[1].turn, '24');
    delete process.env.LUMA_API_URL;
  });

  test('operator can remove a stakeholder', async () => {
    const v = (await op.req('GET', `/api/v/${vid}`)).body;
    const p = v.participants.find(x => x.party_role === 'stevedore');
    assert.strictEqual((await op.req('DELETE', `/api/v/${vid}/participants/${p.id}`)).status, 200);
    assert.strictEqual((await steve.req('GET', `/api/v/${vid}`)).status, 404);
  });
}
