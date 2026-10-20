// Cleans whatever an extractor returns into proposals the app can show for review.
const { z } = require('zod');
const Codes = require('../../shared/codes');

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// Accepts ISO ("2013-09-17T14:45"), "17.09.2013 14:45", "17/09/13 1445", "17 Sep 2013 14:45".
function toLocal(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${pad(+m[4])}:${m[5]}`;
  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})[\sT,]+(\d{1,2}):?(\d{2})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(+m[2])}-${pad(+m[1])}T${pad(+m[4])}:${m[5]}`; }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-](\d{2,4})[\sT,]+(\d{1,2}):?(\d{2})/);
  if (m && MON[m[2].toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(MON[m[2].toLowerCase()])}-${pad(+m[1])}T${pad(+m[4])}:${m[5]}`; }
  return null;
}

const rawEvent = z.object({
  port: z.string().optional(), port_name: z.string().optional(),
  kind: z.string().optional(), type: z.string().optional(),
  code: z.string().optional(), reason: z.string().optional(),
  at: z.any().optional(), time: z.any().optional(),
  from: z.any().optional(), to: z.any().optional(), from_at: z.any().optional(), to_at: z.any().optional(),
  remark: z.string().optional(), description: z.string().optional(), text: z.string().optional(),
  confidence: z.number().optional(), source_text: z.string().optional(),
}).passthrough();

const TERMS = ['SHINC', 'SHEX', 'SATPM SHEX', 'SSHEX', 'FHEX'];

function normalize(raw, { ports, defaultPortId }) {
  const out = { events: [], terms: null, warnings: [] };
  const body = raw && (raw.data || raw.result || raw);
  const list = Array.isArray(body && body.events) ? body.events : [];
  const portByName = name => {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const p = ports.find(x => x.name && (x.name.toLowerCase() === n || n.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(n)));
    return p ? p.id : null;
  };
  list.slice(0, 1000).forEach((r0, i) => {
    const r = rawEvent.safeParse(r0);
    if (!r.success) { out.warnings.push(`Row ${i + 1} could not be read.`); return; }
    const e = r.data;
    const text = e.remark || e.description || e.text || '';
    const at = toLocal(e.at ?? e.time);
    const from = toLocal(e.from_at ?? e.from), to = toLocal(e.to_at ?? e.to);
    let code = String(e.code || e.reason || '').toUpperCase().replace(/[\s-]+/g, '_');
    let kind = String(e.kind || e.type || '').toLowerCase();
    if (!Codes.BY_CODE[code]) code = '';
    if (!kind) kind = code ? Codes.BY_CODE[code].kind : (from ? 'stoppage' : 'milestone');
    if (kind === 'milestone') {
      code = code && Codes.BY_CODE[code].kind === 'milestone' ? code : Codes.guessMilestone(text);
      if (!code || !at) { if (text) out.warnings.push(`Skipped "${text.slice(0, 80)}": no recognisable event or time.`); return; }
    } else if (kind === 'stoppage') {
      code = code && Codes.BY_CODE[code].kind === 'stoppage' ? code : Codes.guess(text);
      if (!from) { out.warnings.push(`Skipped "${text.slice(0, 80)}": no start time.`); return; }
      if (to && to <= from) { out.warnings.push(`Skipped "${text.slice(0, 80)}": ends before it starts.`); return; }
    } else return;
    out.events.push({
      port_id: portByName(e.port || e.port_name) || defaultPortId, kind, code,
      at: kind === 'milestone' ? at : null, from_at: kind === 'stoppage' ? from : null, to_at: kind === 'stoppage' ? to : null,
      remark: String(text).slice(0, 300), confidence: typeof e.confidence === 'number' ? e.confidence : null,
      source_text: e.source_text ? String(e.source_text).slice(0, 400) : null,
    });
  });
  const t = body && body.terms;
  if (t && typeof t === 'object') {
    const num = v => (v === null || v === undefined || v === '' || !isFinite(parseFloat(String(v).replace(/,/g, '')))) ? undefined : String(parseFloat(String(v).replace(/,/g, '')));
    const terms = {};
    const pick = (k, v) => { if (v !== undefined && v !== null && v !== '') terms[k] = v; };
    pick('vessel', t.vessel && String(t.vessel).slice(0, 120));
    pick('charterers', t.charterers && String(t.charterers).slice(0, 160));
    pick('owners', t.owners && String(t.owners).slice(0, 160));
    pick('cargo', t.cargo && String(t.cargo).slice(0, 160));
    const cp = toLocal(t.cpDate ? `${t.cpDate} 00:00` : null); pick('cpDate', cp && cp.slice(0, 10));
    pick('demRate', num(t.demRate)); pick('desRate', num(t.desRate));
    if (typeof t.hd === 'boolean') pick('hd', t.hd);
    if (typeof t.odad === 'boolean') pick('odad', t.odad);
    pick('qty', num(t.qty)); pick('rate', num(t.rate)); pick('turn', num(t.turnTimeHours ?? t.turn));
    const term = String(t.terms || '').toUpperCase().replace('SAFSHEX', 'SATPM SHEX');
    if (TERMS.includes(term)) pick('terms', term);
    if (Object.keys(terms).length) out.terms = terms;
  }
  if (Array.isArray(body && body.warnings)) body.warnings.slice(0, 20).forEach(w => out.warnings.push(String(w).slice(0, 200)));
  return out;
}

module.exports = { normalize, toLocal };
