// Unit tests for go-live hardening that needs no database: proxy trust and the zip-bomb guard.
const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { parseTrustProxy } = require('../src/config');
const { assertSafeZip } = require('../src/extract/zipguard');
const { zipOf } = require('./helpers/zip');

test('TRUST_PROXY hop counts become numbers, so Express trusts the proxy', () => {
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('2'), 2);
  assert.strictEqual(parseTrustProxy('true'), true);
  assert.strictEqual(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
  assert.strictEqual(parseTrustProxy(''), false);
});

test('zip guard passes a real workbook', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SOF');
  for (let i = 0; i < 500; i++) ws.addRow(['22.09.2013', '1000-1130', 'Rain']);
  const size = assertSafeZip(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.ok(size > 0);
});

test('zip guard refuses a zip bomb even when its sizes lie', () => {
  const bomb = zipOf('xl/worksheets/sheet1.xml', Buffer.alloc(40 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 200 * 1024, 'tiny on disk');
  assert.throws(() => assertSafeZip(bomb), /too large/);
});

test('zip guard refuses files that are not zips', () => {
  assert.throws(() => assertSafeZip(Buffer.from('not a zip at all')), /not a valid/);
});
