// Builds the laytime statement lines (header block, rows, totals) used by Copy and the Excel export.
(function (root, factory) {
  if (typeof module !== 'undefined') module.exports = factory(require('./engine.js'));
  else root.Statement = factory(root.Engine);
})(typeof window !== 'undefined' ? window : this, function (E) {
  const COLS = [
    'Date',
    'Day',
    'From',
    'To',
    'Time used (HH:MM)',
    'Counts',
    'Cumulative (DD:HH:MM)',
    'Demurrage (DD:HH:MM)',
    'Remarks',
  ];
  const fmtNum = v => E.num(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const dOnly = s => (s ? E.fmtDT(E.parseDT(s + 'T00:00')).slice(0, 10) : '');

  function remark(r) {
    if (r.ph === 'pre') return 'NTC – ' + r.d;
    if (r.ph === 'dem') {
      if (r.f < 1) return (r.f > 0 ? 'Half time on demurrage – ' : 'NTC on demurrage – ') + r.d;
      return 'On demurrage';
    }
    if (r.f === 0) return 'NTC – ' + r.d;
    if (r.f < 1) return 'Half time – ' + r.d;
    return '';
  }
  function basisLine(p) {
    return p.mode === 'fixed'
      ? 'Laytime allowed (fixed)'
      : `Laytime allowed @ ${fmtNum(p.rate)} MT PWWD ${E.TERM_LABEL[p.terms] || p.terms}`;
  }
  function rateLine(V, R) {
    const cur = V.currency || 'USD';
    return E.num(V.demRate) ? `${cur} ${fmtNum(V.demRate)} PDPR${V.hd ? ' HD' : ` / ${cur} ${fmtNum(R.desRate)}`}` : '';
  }
  function portLines(V, R, i) {
    const p = V.ports[i],
      r = R.res[i],
      cur = V.currency || 'USD';
    const head = [
      ['LAYTIME CALCULATIONS', `${V.vessel || ''}${V.charterers ? ' – A/c ' + V.charterers : ''}`],
      ['Port', `${p.name || ''} (${p.op})`],
      ['Charter party date', dOnly(V.cpDate)],
      ['Cargo', V.cargo || ''],
      ['Vessel arrived', E.fmtDT(E.parseDT(p.arrived))],
      ['NOR tendered', E.fmtDT(E.parseDT(p.nor))],
      ['NOR accepted', E.fmtDT(E.parseDT(p.norAcc))],
      ['Vessel berthed', E.fmtDT(E.parseDT(p.berthed))],
      ['Commenced', E.fmtDT(E.parseDT(p.commenced))],
      ['Completed', E.fmtDT(E.parseDT(p.completed))],
      ['Quantity (MT)', E.num(p.qty) ? fmtNum(p.qty) : ''],
      ['Vessel sailed', E.fmtDT(E.parseDT(p.sailed))],
      [basisLine(p), E.fmtLong(r.portAllowed)],
      ['Demurrage / Despatch', rateLine(V, R)],
      ['Time to count from', E.fmtDT(r.commence)],
    ];
    const rows = [];
    let lastDay = null;
    if (r.already)
      rows.push(['', '', '', '', '', '', '', '', 'Laytime already exhausted at previous port – vessel on demurrage']);
    r.rows.forEach(x => {
      const dk = Math.floor(x.a / 86400000),
        first = dk !== lastDay;
      lastDay = dk;
      rows.push([
        first ? E.fmtDT(x.a).slice(0, 10) : '',
        first ? E.DOW[new Date(x.a).getUTCDay()] : '',
        E.hhmm(x.a),
        E.hhmm(x.b, true),
        x.ph === 'pre' || x.c < 1e-6 ? '-' : E.fmtHM(x.c),
        x.ph === 'pre' ? '' : Math.round(x.f * 100) + '%',
        x.ph === 'pre' ? '-' : E.fmtDHM(x.cumLay),
        x.ph === 'dem' ? E.fmtDHM(x.cumDem) : '',
        remark(x),
      ]);
      if (r.expiry !== null && !r.already && x.ph === 'lay' && Math.abs(x.b - r.expiry) < 1)
        rows.push(['', '', '', '', '', '', '', '', `Laytime expired ${E.fmtDT(r.expiry)} – vessel on demurrage`]);
    });
    const tot = [
      ['Time allowed', E.fmtLong(r.portAllowed), +(r.portAllowed / 24).toFixed(4)],
      ['Total time used', E.fmtLong(r.used), +(r.used / 24).toFixed(4)],
    ];
    if (r.dem > 0)
      tot.push(
        ['Time on demurrage', E.fmtLong(r.dem), +(r.dem / 24).toFixed(4)],
        [`Demurrage amount (${cur})`, +r.demAmt.toFixed(2), ''],
      );
    else if (r.desAmt > 0)
      tot.push(
        ['Total time saved', E.fmtLong(r.saved), +(r.saved / 24).toFixed(4)],
        [`Despatch amount (${cur})`, +r.desAmt.toFixed(2), ''],
      );
    return { head, rows, tot };
  }
  function summary(V, R) {
    const complete = R.res.every(r => !r.errs.length);
    return {
      complete,
      net: +R.net.toFixed(2),
      totDem: +R.totDem.toFixed(2),
      totDes: +R.totDes.toFixed(2),
      currency: V.currency || 'USD',
      ports: V.ports.map((p, i) => {
        const r = R.res[i];
        return {
          name: p.name || '',
          op: p.op,
          ok: !r.errs.length,
          demAmt: r.errs.length ? 0 : +r.demAmt.toFixed(2),
          desAmt: r.errs.length ? 0 : +r.desAmt.toFixed(2),
        };
      }),
    };
  }
  return { COLS, remark, portLines, basisLine, rateLine, summary, fmtNum };
});
