// Adapter for the Luma document-intelligence API.
//
// Only this file knows Luma's request and response format. If Luma's API differs from what is
// assumed below, change buildRequest() and parseResponse() — nothing else in the app needs to change.
//
// Assumed request : POST {LUMA_API_URL}  multipart/form-data
//                   file        the uploaded document
//                   task        "laytime_extraction"
//                   instructions plain-English task description (below)
//                   schema      JSON Schema of the answer we want
//                   context     JSON: vessel, port names, document type
//                   Authorization: Bearer {LUMA_API_KEY}
// Expected answer : JSON matching SCHEMA, either at the top level or under "data" / "result".
const Codes = require('../../shared/codes');

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          port: { type: 'string', description: 'Port name as written, if the document covers several ports' },
          kind: { enum: ['milestone', 'stoppage'] },
          code: { enum: [...Codes.MILESTONES.map(m => m.code), ...Codes.STOPPAGES.map(s => s.code)] },
          at: { type: 'string', description: 'Milestone time, YYYY-MM-DDTHH:MM, port local time' },
          from: { type: 'string', description: 'Stoppage start, YYYY-MM-DDTHH:MM' },
          to: { type: 'string', description: 'Stoppage end, YYYY-MM-DDTHH:MM' },
          remark: { type: 'string' },
          source_text: { type: 'string', description: 'The line in the document this came from' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['kind', 'code'],
      },
    },
    terms: {
      type: 'object',
      description: 'Only for charter parties / recaps',
      properties: {
        vessel: { type: 'string' },
        charterers: { type: 'string' },
        owners: { type: 'string' },
        cargo: { type: 'string' },
        cpDate: { type: 'string', description: 'YYYY-MM-DD' },
        qty: { type: 'number' },
        rate: { type: 'number', description: 'MT per day' },
        terms: { enum: ['SHINC', 'SHEX', 'SATPM SHEX', 'SSHEX', 'FHEX'] },
        turnTimeHours: { type: 'number' },
        demRate: { type: 'number' },
        desRate: { type: 'number' },
        hd: { type: 'boolean' },
        odad: { type: 'boolean' },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['events'],
};

const INSTRUCTIONS = `You are reading a shipping document (statement of facts, timesheet, port log or charter party).
Return every event with its exact date and time in port local time.
Milestones: vessel arrived, NOR tendered, NOR accepted, laytime commences, berthed / all fast, commenced and completed loading or discharge, sailed.
Stoppages: every period when cargo work stopped or time is excluded, with start and end, and the reason mapped to one of the given codes.
Do not report periods when cargo work was going on.
For a charter party or recap, also fill "terms".
Never guess a time: leave it out and add a warning instead.`;

function buildRequest({ buffer, filename, mime, docType, context }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('task', 'laytime_extraction');
  form.append('instructions', INSTRUCTIONS);
  form.append('schema', JSON.stringify(SCHEMA));
  form.append('context', JSON.stringify({ ...context, documentType: docType }));
  return { method: 'POST', headers: { Authorization: `Bearer ${process.env.LUMA_API_KEY || ''}` }, body: form };
}

async function parseResponse(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`Luma returned ${res.status}: ${text.slice(0, 200)}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Luma did not return JSON.');
  }
  // Some APIs wrap a JSON answer as a string; unwrap it.
  for (const k of ['data', 'result', 'output', 'answer']) {
    if (typeof j[k] === 'string') {
      try {
        j[k] = JSON.parse(j[k]);
      } catch {
        /* leave as is */
      }
    }
  }
  return j;
}

async function extract(args) {
  const url = process.env.LUMA_API_URL;
  if (!url) throw new Error('LUMA_API_URL is not set.');
  const ctrl = new AbortController();
  const timeoutMs = parseInt(process.env.LUMA_TIMEOUT_MS || '120000', 10);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs > 0 ? timeoutMs : 120000);
  try {
    const res = await fetch(url, { ...buildRequest(args), signal: ctrl.signal });
    return await parseResponse(res);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Luma took too long to answer.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extract, SCHEMA, INSTRUCTIONS };
