// Excel workbook in the client's statement layout: one summary sheet plus one sheet per port.
const ExcelJS = require('exceljs');
const Engine = require('../shared/engine');
const Statement = require('../shared/statement');

function buildWorkbook(V) {
  const R = Engine.computeVoyage(V);
  const cur = V.currency || 'USD';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Laytime Calculator';
  const thin = { style: 'thin', color: { argb: 'FF9AA9B4' } };
  const B = { top: thin, left: thin, bottom: thin, right: thin };
  const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6EBF1' } };

  const S = wb.addWorksheet('Summary');
  S.columns = [{ width: 26 }, { width: 8 }, { width: 28 }, { width: 28 }, { width: 14 }, { width: 18 }];
  S.addRow([`LAYTIME SUMMARY – ${V.vessel || ''}${V.charterers ? ' – A/c ' + V.charterers : ''}`]).font = { bold: true, size: 13 };
  S.addRow([`Calculation: ${V.calcMode === 'reversible' ? 'Reversible (laytime pooled across ports)' : 'Each port separate'}${V.odad ? ' · Once on demurrage, always on demurrage' : ''}`]);
  S.addRow([]);
  const sh = S.addRow(['Port', 'LP/DP', 'Time allowed', 'Time used', 'Result', `Amount (${cur})`]);
  sh.eachCell(c => { c.font = { bold: true }; c.fill = fill; c.border = B; });
  V.ports.forEach((p, i) => {
    const r = R.res[i];
    const row = r.errs.length ? [p.name, p.op === 'Loading' ? 'LP' : 'DP', 'Incomplete', '', '', '']
      : [p.name, p.op === 'Loading' ? 'LP' : 'DP', Engine.fmtLong(r.portAllowed), Engine.fmtLong(r.used),
        r.demAmt > 0 ? 'Demurrage' : r.desAmt > 0 ? 'Despatch' : '–', r.demAmt > 0 ? +r.demAmt.toFixed(2) : r.desAmt > 0 ? -(+r.desAmt.toFixed(2)) : 0];
    const x = S.addRow(row);
    x.eachCell({ includeEmpty: true }, c => { c.border = B; });
    x.getCell(6).numFmt = '#,##0.00;[Red]-#,##0.00';
  });
  const nt = S.addRow(['', '', '', '', R.net >= 0 ? 'Net to owners' : 'Net to charterers', +Math.abs(R.net).toFixed(2)]);
  nt.font = { bold: true }; nt.getCell(6).numFmt = '#,##0.00';

  const used = new Set();
  V.ports.forEach((p, i) => {
    const r = R.res[i];
    if (r.errs.length) return;
    let nm = `${i + 1} ${(p.name || 'Port').replace(/[\\/?*[\]:]/g, '')} ${p.op === 'Loading' ? 'LP' : 'DP'}`.slice(0, 31);
    while (used.has(nm)) nm = nm.slice(0, 28) + '_' + i;
    used.add(nm);
    const W = wb.addWorksheet(nm);
    W.columns = [{ width: 12 }, { width: 7 }, { width: 8 }, { width: 8 }, { width: 12 }, { width: 8 }, { width: 14 }, { width: 14 }, { width: 52 }];
    const L = Statement.portLines(V, R, i);
    const t1 = W.addRow([`${L.head[0][0]} – ${L.head[0][1]}`]);
    t1.font = { bold: true, size: 13 };
    W.mergeCells(t1.number, 1, t1.number, 9);
    L.head.slice(1).forEach(([k, v]) => { const x = W.addRow(['', '', '', k, '', '', ':', v]); x.getCell(4).font = { bold: true }; });
    W.addRow([]);
    const h = W.addRow(Statement.COLS);
    h.eachCell(c => { c.font = { bold: true }; c.fill = fill; c.border = B; c.alignment = { wrapText: true, vertical: 'middle' }; });
    h.height = 30;
    L.rows.forEach(x => {
      const row = W.addRow(x);
      row.eachCell({ includeEmpty: true }, c => { c.border = B; });
      if (/^Laytime (expired|already)/.test(String(x[8]))) row.eachCell({ includeEmpty: true }, c => { c.font = { bold: true, color: { argb: 'FFB3342B' } }; });
      [3, 4, 5, 6, 7, 8].forEach(n => { row.getCell(n).alignment = { horizontal: 'center' }; });
    });
    W.addRow([]);
    L.tot.forEach(([k, a, b]) => {
      const x = W.addRow(['', '', '', k, '', '', a, b === '' ? '' : b, b === '' ? '' : 'days']);
      x.getCell(4).font = { bold: true };
      if (typeof a === 'number') { x.getCell(7).numFmt = '#,##0.00'; x.getCell(7).font = { bold: true }; }
    });
    W.views = [{ state: 'frozen', ySplit: h.number }];
  });
  return wb;
}

module.exports = { buildWorkbook };
