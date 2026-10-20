// Laytime engine: pure functions, no DOM. Runs in the browser (live results) and on the server.
//
// Times are port-local wall-clock times stored as UTC milliseconds, so a value like
// "2013-08-31T06:00" is always read and printed as 06:00 regardless of the machine's time zone.
// Durations are in hours.
const H = 3600000; // ms per hour
const DAY = 86400000; // ms per day
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Excluded window per laytime term: [start day, start time, end day, end time]; 0 = Sunday.
const PRESETS = {
  SHINC: null,
  SHEX: [0, '00:00', 1, '00:00'],
  'SATPM SHEX': [6, '12:00', 1, '08:00'],
  SSHEX: [6, '00:00', 1, '00:00'],
  FHEX: [5, '00:00', 6, '00:00'],
};
// How each term is printed on statements. EIU = even if used.
const TERM_LABEL = {
  SHINC: 'SHINC',
  SHEX: 'SHEX EIU',
  'SATPM SHEX': 'SAFSHEX EIU',
  SSHEX: 'SSHEX EIU',
  FHEX: 'FHEX EIU',
  Custom: 'per C/P',
};

const num = v => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : 0;
};
const pad = n => String(n).padStart(2, '0');
function parseDT(s) {
  if (!s) return NaN;
  const [d, t] = String(s).split('T');
  const [y, m, dd] = d.split('-').map(Number);
  if (!y || !m || !dd) return NaN;
  const [hh, mi] = (t || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, dd, hh || 0, mi || 0);
}
function toInput(ms) {
  return isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) : '';
}
const tmin = s => {
  if (!s) return 0;
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
function fmtDate(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}
function fmtDT(ms) {
  if (!isFinite(ms)) return '–';
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function hhmm(ms, isEnd) {
  const d = new Date(ms);
  if (isEnd && d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return '24:00';
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function splitDur(h) {
  let m = Math.round(Math.abs(h) * 60);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const hh = Math.floor(m / 60);
  return { d, h: hh, m: m - hh * 60, neg: h < 0 };
}
function fmtDur(h) {
  const x = splitDur(h);
  return `${x.neg ? '−' : ''}${pad(x.d)}d ${pad(x.h)}h ${pad(x.m)}m`;
}
function fmtLong(h) {
  const x = splitDur(h);
  return `${pad(x.d)} Days - ${pad(x.h)} Hrs - ${pad(x.m)} Mins`;
}
function fmtHM(h) {
  const m = Math.round(h * 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
function fmtDHM(h) {
  const x = splitDur(h);
  return `${pad(x.d)}:${pad(x.h)}:${pad(x.m)}`;
}

// Laytime allowed at a port, in hours: quantity / daily rate, or a fixed figure.
function allowedHours(p) {
  if (p.mode === 'fixed') return num(p.fixedHours);
  return num(p.rate) > 0 ? (num(p.qty) / num(p.rate)) * 24 : 0;
}

// Reads "dd.mm.yy[yy]" (also "/" or "-" separated) from a SOF date token.
const SOF_DATE = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;
// One time token: optional date, then HH:MM or HHMM, optionally followed by "hrs".
const SOF_TIME =
  /^(?:[\s,;|–—-]*)(?:(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})[\sT,]*)?(\d{1,2}):?(\d{2})(?:\s*(?:hrs|hr|h))?(?![\d./])/i;

function sofDateUTC(date, h, mi) {
  const m = date.match(SOF_DATE);
  let y = +m[3];
  if (y < 100) y += 2000;
  return Date.UTC(y, +m[2] - 1, +m[1], h, mi);
}

// Parses SOF lines pasted as text, e.g. "31.08.2013 08:20 08:50 Loader shifting",
// into not-to-count periods. Returns { rows, bad } where bad holds unreadable lines.
function parseSOF(text) {
  const rows = [];
  const bad = [];
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    // Take up to two leading time tokens: "from" and "to".
    let rest = raw;
    const toks = [];
    for (let k = 0; k < 2; k++) {
      const m = rest.match(SOF_TIME);
      if (!m) break;
      toks.push({ date: m[1] || null, h: +m[2], mi: +m[3] });
      rest = rest.slice(m[0].length);
    }
    if (toks.length < 2 || !toks[0].date) {
      bad.push(raw);
      continue;
    }

    const from = sofDateUTC(toks[0].date, toks[0].h, toks[0].mi);
    let to;
    if (toks[1].date) {
      to = sofDateUTC(toks[1].date, toks[1].h, toks[1].mi);
    } else {
      // "to" has no date: same day, or the next day if the period runs past midnight.
      to = sofDateUTC(toks[0].date, toks[1].h, toks[1].mi);
      if (to <= from) to += DAY;
    }
    if (!isFinite(from) || !isFinite(to) || to <= from) {
      bad.push(raw);
      continue;
    }

    let desc = rest.replace(/^[\s,;|–—-]+/, '').trim();
    const pct = /\b(50\s*%|half(\s*time)?)\b/i.test(desc) ? 50 : 0;
    const stopsDemurrage =
      /\b(breakdown of vessel|vessel'?s? (gear|crane)|ship'?s? (gear|crane)|stops? demurrage)\b/i.test(desc);
    desc = desc.replace(/^NTC\s*[-–:]\s*/i, '');
    rows.push({ f: toInput(from), t: toInput(to), d: desc || 'Not to count', p: pct, od: stopsDemurrage });
  }
  return { rows, bad };
}

// How a stretch of time counts: f is the fraction counted (1, 0.5 or 0), d the remark.
// key is 'p' (share counted during laytime) or 'dp' (share counted once on demurrage).
const COUNTS = { f: 1, d: '' };
function fromPeriods(periods, key = 'p') {
  return { f: Math.min(...periods.map(x => x[key])) / 100, d: periods.map(x => x.d).join(' / ') };
}

/**
 * Computes laytime for one port.
 *
 * ctx.allowed   laytime available, in hours (the pooled total when reversible)
 * ctx.startCum  laytime already used before this port, in hours (reversible only)
 * ctx.odad      once on demurrage, always on demurrage
 *
 * Returns { errs } when inputs are missing. Otherwise the result has the key times
 * (commence, end, expiry), hour totals (used, dem, saved, cumAfter) and the statement
 * rows. Each row is { a, b, d, f, ph, c, cumLay, cumDem }: start and end ms, remark,
 * fraction counted, phase ('pre' notice time, 'lay' laytime, 'dem' demurrage),
 * hours counted, and running totals.
 */
function computePort(p, ctx) {
  const errs = [];
  const allowed = ctx.allowed;
  const nor = parseDT(p.nor);
  const commence = p.commenceOv ? parseDT(p.commenceOv) : isFinite(nor) ? nor + num(p.turn) * H : NaN;
  const end = parseDT(p.completed);
  if (!(allowed > 0)) errs.push('Enter quantity and rate (or a fixed laytime) to get the laytime allowed.');
  if (!isFinite(commence)) errs.push('Enter NOR tendered, or the time to count from.');
  if (!isFinite(end)) errs.push('Enter the time loading or discharging was completed.');
  if (isFinite(commence) && isFinite(end) && end <= commence)
    errs.push('Completion is before time starts to count. Check the time sheet.');
  if (errs.length) return { errs };

  // Not-to-count / half-time periods from the SOF.
  const periods = (p.exceptions || [])
    .map(x => ({
      f: parseDT(x.f),
      t: parseDT(x.t),
      d: x.d || 'Not to count',
      p: +x.p || 0,
      // Share counted on demurrage when the period stops demurrage; older data has no dp, so use p.
      dp: x.dp !== undefined && x.dp !== null ? +x.dp : +x.p || 0,
      od: !!x.od,
    }))
    .filter(x => isFinite(x.f) && isFinite(x.t) && x.t > x.f);

  // Weekly excluded window (e.g. SAFSHEX Sat 12:00 to Mon 08:00), as minutes from Sunday 00:00.
  const hasWindow = p.terms !== 'SHINC';
  const winStart = +p.sDay * 1440 + tmin(p.sTime);
  const winEnd = +p.eDay * 1440 + tmin(p.eTime);
  const holidays = new Set(p.holidays || []);
  const termLabel = TERM_LABEL[p.terms] || p.terms;

  // Remark if ms falls in the excluded window or on a holiday, else null.
  function excludedBy(ms) {
    if (!hasWindow) return null;
    if (holidays.has(new Date(ms).toISOString().slice(0, 10))) return `Holiday – ${termLabel}`;
    const d = new Date(ms);
    const weekMin = d.getUTCDay() * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    const inWindow =
      winStart < winEnd
        ? weekMin >= winStart && weekMin < winEnd
        : winStart > winEnd
          ? weekMin >= winStart || weekMin < winEnd // window wraps past Saturday midnight
          : false;
    return inWindow ? termLabel : null;
  }

  // Excluded windows and SOF periods both stop the clock before laytime expires.
  function laytimeCount(mid, active) {
    const excluded = excludedBy(mid);
    if (excluded) return { f: 0, d: excluded };
    return active.length ? fromPeriods(active) : COUNTS;
  }

  // On demurrage with ODAD, only periods marked "stops demurrage" interrupt it.
  function demurrageCount(mid, active) {
    if (!ctx.odad) return laytimeCount(mid, active);
    const stops = active.filter(x => x.od);
    return stops.length ? fromPeriods(stops, 'dp') : COUNTS;
  }

  // Break points: every moment where the counting rule can change.
  const points = new Set([commence, end]);
  const addPoint = t => {
    if (t > commence && t < end) points.add(t);
  };
  periods.forEach(x => {
    addPoint(x.f);
    addPoint(x.t);
  });
  for (let day = Math.floor(commence / DAY) * DAY; day <= end; day += DAY) {
    const dow = new Date(day).getUTCDay();
    addPoint(day); // midnight, so statement rows split by calendar day
    if (dow == p.sDay) addPoint(day + tmin(p.sTime) * 60000);
    if (dow == p.eDay) addPoint(day + tmin(p.eTime) * 60000);
  }
  const breaks = [...points].sort((a, b) => a - b);

  let cum = ctx.startCum || 0; // laytime used so far, hours
  let dem = 0; // time on demurrage, hours
  let used = 0; // laytime used at this port, hours
  let expiry = cum >= allowed - 1e-9 ? commence : null;
  const already = expiry !== null; // laytime ran out at an earlier port
  const segs = [];

  // Counts the slice [a, b). If laytime runs out inside it, splits it at the expiry moment.
  function addSegment(a, b) {
    if (b - a < 1) return;
    const mid = (a + b) / 2;
    const hrs = (b - a) / H;
    const active = periods.filter(x => x.f <= mid && mid < x.t);

    if (expiry !== null) {
      const { f, d } = demurrageCount(mid, active);
      segs.push({ a, b, d, f, ph: 'dem', c: hrs * f });
      dem += hrs * f;
      return;
    }

    const { f, d } = laytimeCount(mid, active);
    if (f > 0 && cum + hrs * f > allowed + 1e-9) {
      const need = (allowed - cum) / f;
      const split = a + need * H;
      segs.push({ a, b: split, d, f, ph: 'lay', c: need * f });
      used += need * f;
      cum = allowed;
      expiry = split;
      addSegment(split, b);
      return;
    }
    segs.push({ a, b, d, f, ph: 'lay', c: hrs * f });
    cum += hrs * f;
    used += hrs * f;
    if (f > 0 && cum >= allowed - 1e-9) {
      cum = allowed;
      expiry = b;
    }
  }
  for (let i = 0; i < breaks.length - 1; i++) addSegment(breaks[i], breaks[i + 1]);

  // Merge back-to-back segments with the same rule within one calendar day.
  const rows = [];
  for (const s of segs) {
    const last = rows[rows.length - 1];
    const sameRule = last && last.d === s.d && last.f === s.f && last.ph === s.ph;
    if (sameRule && Math.abs(last.b - s.a) < 1 && Math.floor(last.a / DAY) === Math.floor((s.b - 1) / DAY)) {
      last.b = s.b;
      last.c += s.c;
    } else rows.push({ ...s });
  }

  // Notice time between NOR and time counting, one row per calendar day.
  const pre = [];
  if (isFinite(nor) && commence > nor) {
    const label = p.commenceOv ? 'NOR tendered – time not yet counting' : `As per C/P – ${num(p.turn)} hr turn time`;
    for (let a = nor; a < commence; ) {
      const b = Math.min(commence, Math.floor(a / DAY) * DAY + DAY);
      pre.push({ a, b, d: label, f: 0, ph: 'pre', c: 0 });
      a = b;
    }
  }

  // Running totals for the statement.
  let cumLay = ctx.startCum || 0;
  let cumDem = 0;
  const all = [...pre, ...rows];
  for (const r of all) {
    if (r.ph === 'lay') cumLay += r.c;
    if (r.ph === 'dem') cumDem += r.c;
    r.cumLay = cumLay;
    r.cumDem = cumDem;
  }
  const saved = expiry === null ? allowed - cum : 0;
  return { errs, allowed, nor, commence, end, expiry, already, used, cumAfter: cum, dem, saved, rows: all };
}

// Computes every port and the money. Ports are either settled separately or, when
// reversible, share one pooled allowance counted in tab order.
function computeVoyage(V) {
  const ports = V.ports || [];
  const allowedEach = ports.map(allowedHours);
  const res = [];
  if (V.calcMode === 'reversible') {
    const pool = allowedEach.reduce((a, b) => a + b, 0);
    let cum = 0;
    ports.forEach((p, i) => {
      const r = computePort(p, { allowed: pool, startCum: cum, odad: V.odad });
      r.portAllowed = allowedEach[i];
      r.pool = pool;
      if (!r.errs.length) cum = r.cumAfter;
      res.push(r);
    });
  } else {
    ports.forEach((p, i) => {
      const r = computePort(p, { allowed: allowedEach[i], startCum: 0, odad: V.odad });
      r.portAllowed = allowedEach[i];
      res.push(r);
    });
  }
  const demRate = num(V.demRate),
    desRate = V.hd ? demRate / 2 : num(V.desRate);
  const rd = h => h / 24;
  res.forEach(r => {
    if (r.errs.length) return;
    r.demDays = rd(r.dem);
    r.demAmt = r.demDays * demRate;
    r.desDays = 0;
    r.desAmt = 0;
  });
  if (V.calcMode === 'reversible') {
    const last = [...res].reverse().find(r => !r.errs.length);
    if (last && last.expiry === null && res.every(r => !r.errs.length)) {
      last.desDays = rd(last.saved);
      last.desAmt = last.desDays * desRate;
    }
    res.forEach(r => {
      if (r !== last) r.saved = 0;
    });
  } else {
    res.forEach(r => {
      if (r.errs.length) return;
      r.desDays = rd(r.saved);
      r.desAmt = r.desDays * desRate;
    });
  }
  const ok = res.filter(r => !r.errs.length);
  const totDem = ok.reduce((a, r) => a + r.demAmt, 0),
    totDes = ok.reduce((a, r) => a + r.desAmt, 0);
  return { res, demRate, desRate, totDem, totDes, net: totDem - totDes };
}

const Engine = {
  computeVoyage,
  computePort,
  parseSOF,
  allowedHours,
  fmtDur,
  fmtLong,
  fmtDT,
  fmtDate,
  fmtHM,
  fmtDHM,
  hhmm,
  parseDT,
  toInput,
  num,
  tmin,
  TERM_LABEL,
  PRESETS,
  DOW,
};
if (typeof module !== 'undefined') module.exports = Engine;
if (typeof window !== 'undefined') window.Engine = Engine;
