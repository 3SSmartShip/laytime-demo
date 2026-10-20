// Validation of the voyage document and server-side calculation of its summary.
const { z } = require('zod');
const Engine = require('../shared/engine');
const Statement = require('../shared/statement');
const Sof = require('../shared/sof');
const Codes = require('../shared/codes');
const crypto = require('crypto');

const str = max => z.string().max(max).optional().default('');
const dt = z
  .string()
  .max(16)
  .regex(/^$|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM')
  .optional()
  .default('');
const d = z
  .string()
  .max(10)
  .regex(/^$|^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .optional()
  .default('');
const numStr = z
  .union([z.string().max(20), z.number()])
  .transform(v => String(v ?? ''))
  .optional()
  .default('');

const exception = z.object({
  f: dt,
  t: dt,
  d: str(300),
  p: z
    .union([z.literal(0), z.literal(50)])
    .catch(0)
    .default(0),
  od: z.boolean().optional().default(false),
});

const port = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  tz: z
    .string()
    .regex(/^[+-]\d{2}:\d{2}$/)
    .optional()
    .default('+05:30'),
  etc: dt,
  name: str(120),
  op: z.enum(['Loading', 'Discharging']).default('Loading'),
  qty: numStr,
  rate: numStr,
  mode: z.enum(['rate', 'fixed']).default('rate'),
  fixedHours: numStr,
  terms: z.enum(['SHINC', 'SHEX', 'SATPM SHEX', 'SSHEX', 'FHEX', 'Custom']).default('SHINC'),
  sDay: z
    .string()
    .regex(/^[0-6]$/)
    .default('0'),
  sTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('00:00'),
  eDay: z
    .string()
    .regex(/^[0-6]$/)
    .default('1'),
  eTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('00:00'),
  holidays: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .max(200)
    .default([]),
  arrived: dt,
  nor: dt,
  norAcc: dt,
  berthed: dt,
  commenced: dt,
  completed: dt,
  sailed: dt,
  turn: numStr,
  commenceOv: dt,
  exceptions: z.array(exception).max(2000).default([]),
});

const voyage = z.object({
  vessel: str(120),
  charterers: str(160),
  owners: str(160),
  cpDate: d,
  cargo: str(160),
  currency: z.string().max(4).optional().default('USD'),
  demRate: numStr,
  desRate: numStr,
  hd: z.boolean().default(true),
  odad: z.boolean().default(true),
  calcMode: z.enum(['separate', 'reversible']).default('separate'),
  active: z.number().int().min(0).default(0),
  ports: z.array(port).min(1).max(20),
  codeRules: z
    .record(z.object({ p: z.union([z.literal(0), z.literal(50), z.literal(100)]), od: z.boolean() }))
    .optional()
    .default({}),
});

function parseVoyage(input) {
  const r = voyage.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    const err = new Error(`Invalid voyage data at ${i.path.join('.') || 'root'}: ${i.message}`);
    err.status = 400;
    throw err;
  }
  const v = r.data;
  if (v.active >= v.ports.length) v.active = 0;
  const seen = new Set();
  v.ports.forEach(p => {
    if (!p.id || seen.has(p.id)) p.id = crypto.randomUUID();
    seen.add(p.id);
  });
  Object.keys(v.codeRules).forEach(k => {
    if (!Codes.BY_CODE[k] || Codes.BY_CODE[k].kind !== 'stoppage') delete v.codeRules[k];
  });
  return v;
}

// Merges the live SOF events into the voyage, then calculates.
function compute(v, events) {
  const merged = Sof.applyEvents(v, events || [], { now: Sof.nowLocal(v.ports[0] && v.ports[0].tz) });
  const R = Engine.computeVoyage(merged);
  const summary = Statement.summary(merged, R);
  summary.disputed = Sof.disputedCount(events);
  return { R, merged, summary };
}

function blankVoyage() {
  return parseVoyage({ ports: [{ name: '', op: 'Loading', turn: '6' }] });
}

module.exports = { parseVoyage, compute, blankVoyage };
