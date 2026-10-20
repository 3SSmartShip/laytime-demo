// Built-in reader for SOF text, CSV and Excel files. No AI: finds dates, times and keywords line by line.
// PDFs, scans and Word files need the Luma provider.
const ExcelJS = require('exceljs');
const Codes = require('../../shared/codes');
const { assertSafeZip } = require('./zipguard');

const MAX_LINES = 20000;

const pad = n => String(n).padStart(2, '0');
const STOP_WORDS = /\b(stop|stopp|suspend|ntc|not to count|delay|await|waiting|break ?down|idle|rain|shower|swell|humid|shift|draft|draught|strike|no cargo|shortage)/i;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${pad(v.getUTCDate())}.${pad(v.getUTCMonth() + 1)}.${v.getUTCFullYear()} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'object') return v.text || v.result || (v.richText ? v.richText.map(t => t.text).join('') : '');
  return String(v);
}

async function toLines(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx') {
    assertSafeZip(buffer);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const lines = [];
    wb.eachSheet(ws => ws.eachRow(row => {
      if (lines.length >= MAX_LINES) return;
      const cells = [];
      row.eachCell({ includeEmpty: false }, c => { const t = cellText(c.value).trim(); if (t) cells.push(t); });
      if (cells.length) lines.push(cells.join(' '));
    }));
    return lines;
  }
  if (['csv', 'txt', 'tsv', 'text'].includes(ext)) return buffer.toString('utf8').split(/\r?\n/, MAX_LINES).map(l => l.replace(/[,;\t]+/g, ' ').trim()).filter(Boolean);
  const err = new Error('The built-in reader handles Excel, CSV and text. Connect Luma to read PDFs, scans and Word files.');
  err.unsupported = true;
  throw err;
}

// Turns lines into raw events in the shape normalize() accepts.
function readLines(lines) {
  const events = [];
  let lastDate = null;
  const dRe = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/;
  const tRe = /(?:^|[^\d.\/:])([01]?\d|2[0-4]):?([0-5]\d)(?:\s*(?:hrs?|h|lt))?(?=[^\d.\/]|$)/g;
  lines.forEach(line => {
    const dm = line.match(dRe);
    let date = lastDate;
    if (dm) { let y = +dm[3]; if (y < 100) y += 2000; date = `${y}-${pad(+dm[2])}-${pad(+dm[1])}`; lastDate = date; }
    if (!date) return;
    const rest = dm ? line.replace(dm[0], ' ') : line;
    const times = [];
    let m;
    tRe.lastIndex = 0;
    while ((m = tRe.exec(rest)) && times.length < 4) times.push(`${pad(+m[1] % 24)}:${m[2]}`);
    if (!times.length) return;
    const text = rest.replace(tRe, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–:]+|[\s\-–:]+$/g, '').trim();
    const ms = Codes.guessMilestone(text);
    if (ms && times.length === 1) { events.push({ kind: 'milestone', code: ms, at: `${date}T${times[0]}`, remark: text, source_text: line }); return; }
    if (times.length >= 2 && STOP_WORDS.test(text)) {
      let to = `${date}T${times[1]}`;
      const from = `${date}T${times[0]}`;
      if (to <= from) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); to = `${d.toISOString().slice(0, 10)}T${times[1]}`; }
      events.push({ kind: 'stoppage', code: Codes.guess(text), from, to, remark: text, source_text: line });
      return;
    }
    if (ms) events.push({ kind: 'milestone', code: ms, at: `${date}T${times[0]}`, remark: text, source_text: line });
  });
  return { events };
}

async function extract({ buffer, filename }) {
  const lines = await toLines(buffer, filename);
  return readLines(lines);
}

module.exports = { extract, readLines, toLines };
