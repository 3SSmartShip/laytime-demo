// Validation of the voyage document and server-side calculation of its summary.
const { z } = require('zod');
const Engine = require('../shared/engine');
const Statement = require('../shared/statement');

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
  return v;
}

function compute(v) {
  const R = Engine.computeVoyage(v);
  return { R, summary: Statement.summary(v, R) };
}

function blankVoyage() {
  return parseVoyage({ ports: [{ name: '', op: 'Loading', turn: '6' }] });
}

module.exports = { parseVoyage, compute, blankVoyage };
