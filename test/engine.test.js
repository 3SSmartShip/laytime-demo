// Checks the engine against the client's MV Vishva Nidhi Excel statements.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { makeSample } = require('../shared/sample');

const V = makeSample(E.parseSOF);
const R = E.computeVoyage(V);
const [lp, dp] = R.res;

test('loadport Sur: time used matches statement (02d 14h 35m)', () => {
  assert.deepStrictEqual(lp.errs, []);
  assert.strictEqual(E.fmtLong(lp.used), '02 Days - 14 Hrs - 35 Mins');
});

test('loadport Sur: allowed is 36,010.25 / 12,000 = 03d 00h 01m', () => {
  assert.strictEqual(E.fmtLong(lp.allowed), '03 Days - 00 Hrs - 01 Mins');
});

test('disport Visakhapatnam: time used and saved match statement', () => {
  assert.strictEqual(E.fmtLong(dp.used), '02 Days - 13 Hrs - 25 Mins');
  assert.strictEqual(E.fmtLong(dp.saved), '03 Days - 10 Hrs - 37 Mins');
  assert.ok(Math.abs(dp.desAmt - 12049.38) < 0.01);
});

test('SAFSHEX excludes Saturday 12:00 to Monday 08:00', () => {
  const sat = dp.rows.find(r => r.d === 'SAFSHEX EIU');
  assert.ok(sat);
  assert.strictEqual(E.fmtDT(sat.a), '14.09.2013 12:00');
});

test('demurrage after expiry, ODAD ignores ordinary NTC but honours "stops demurrage"', () => {
  const v = { demRate: '10000', hd: true, odad: true, calcMode: 'separate', ports: [{
    name: 'X', op: 'Loading', mode: 'fixed', fixedHours: '24', terms: 'SHINC', sDay: '0', sTime: '00:00', eDay: '1', eTime: '00:00',
    nor: '2026-01-05T00:00', turn: '0', completed: '2026-01-07T00:00',
    exceptions: [{ f: '2026-01-06T06:00', t: '2026-01-06T12:00', d: 'Rain', p: 0, od: false },
                 { f: '2026-01-06T18:00', t: '2026-01-06T20:00', d: "Vessel's crane breakdown", p: 0, od: true }] }] };
  const r = E.computeVoyage(v).res[0];
  assert.strictEqual(E.fmtDT(r.expiry), '06.01.2026 00:00');
  assert.strictEqual(r.dem, 22); // 24h less the 2h breakdown; rain ignored under ODAD
  assert.ok(Math.abs(r.demAmt - 22 / 24 * 10000) < 1e-6);
});

test('reversible pools laytime across ports', () => {
  const base = { op: 'Loading', mode: 'fixed', terms: 'SHINC', sDay: '0', sTime: '00:00', eDay: '1', eTime: '00:00', turn: '0', exceptions: [] };
  const v = { demRate: '1000', hd: true, odad: true, calcMode: 'reversible', ports: [
    { ...base, name: 'A', fixedHours: '48', nor: '2026-01-01T00:00', completed: '2026-01-02T00:00' },
    { ...base, name: 'B', op: 'Discharging', fixedHours: '24', nor: '2026-01-10T00:00', completed: '2026-01-12T00:00' }] };
  const R2 = E.computeVoyage(v);
  assert.strictEqual(R2.res[1].used, 48);
  assert.strictEqual(R2.res[1].dem, 0);
  assert.strictEqual(R2.totDes, 0);
});

test('SOF paste parser reads dates, times, overnight periods and half time', () => {
  const r = E.parseSOF('17.09.2013 14:45 - 18.09.2013 03:30\tNTC - Due to rain\n18/09/13 2330 0130 shifting half time\nnot a line');
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].d, 'Due to rain');
  assert.strictEqual(r.rows[1].t, '2013-09-19T01:30');
  assert.strictEqual(r.rows[1].p, 50);
  assert.deepStrictEqual(r.bad, ['not a line']);
});
