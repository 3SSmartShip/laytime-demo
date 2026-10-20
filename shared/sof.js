// Turns live SOF events into the calculator's inputs, and forecasts laytime while a vessel is working.
(function (root, factory) {
  if (typeof module !== 'undefined') module.exports = factory(require('./engine.js'), require('./codes.js'));
  else root.Sof = factory(root.Engine, root.Codes);
})(typeof window !== 'undefined' ? window : this, function (E, C) {
  const MS_FIELDS = C.MILESTONES.map(m => m.field);

  function nowLocal(tz) {
    const m = String(tz || '+05:30').match(/^([+-])(\d{2}):?(\d{2})$/);
    const off = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 330;
    return new Date(Date.now() + off * 60000).toISOString().slice(0, 16);
  }

  // events: [{id, port_id, kind, code, at, from_at, to_at, remark, status, deleted_at}]
  function applyEvents(V, events, opts) {
    opts = opts || {};
    const out = JSON.parse(JSON.stringify(V));
    const evs = (events || []).filter(e => !e.deleted_at && !(opts.excludeDisputed && e.status === 'disputed'));
    out.ports.forEach(p => {
      const mine = evs.filter(e => e.port_id === p.id);
      p._fromSof = {};
      // milestones: the latest-entered one of each type wins
      const byCode = {};
      mine
        .filter(e => e.kind === 'milestone' && e.at)
        .forEach(e => {
          const k = e.code;
          if (!byCode[k] || (e.updated_at || '') > (byCode[k].updated_at || '')) byCode[k] = e;
        });
      C.MILESTONES.forEach(m => {
        const e = byCode[m.code];
        if (e) {
          p[m.field] = e.at;
          p._fromSof[m.field] = { id: e.id, status: e.status };
        }
      });
      // stoppages become laytime exceptions according to the voyage's CP treatment
      const ex = [];
      mine
        .filter(e => e.kind === 'stoppage' && e.from_at)
        .forEach(e => {
          const r = C.rule(out, e.code);
          if (r.p >= 100 && !r.od) return; // counts in full: nothing to deduct
          let to = e.to_at;
          if (!to) to = p.completed || opts.now || '';
          if (!to || to <= e.from_at) return;
          const lbl = (C.BY_CODE[e.code] || { label: e.code }).label;
          // p = treatment during laytime; dp = treatment once on demurrage (only used when od is set)
          ex.push({
            f: e.from_at,
            t: to,
            d:
              (e.remark ? `${lbl} – ${e.remark}` : lbl) +
              (e.status === 'disputed' ? ' [disputed]' : '') +
              (e.to_at ? '' : ' [ongoing]'),
            p: r.p,
            dp: r.p >= 100 ? 0 : r.p,
            od: r.od,
            _ev: e.id,
            _status: e.status,
            _open: !e.to_at,
          });
        });
      p.exceptions = [...(p.exceptions || []).map(x => ({ ...x, _manual: true })), ...ex];
    });
    return out;
  }

  // Forecast for a port that is still working: when laytime expires, and the result at ETC.
  function forecast(V, i, now) {
    const p = V.ports[i];
    if (!p || p.completed) return null;
    now = now || nowLocal(p.tz);
    const far = E.toInput(E.parseDT(now) + 90 * 86400000);
    const probe = JSON.parse(JSON.stringify(V));
    probe.ports[i].completed = far;
    const r1 = E.computeVoyage(probe).res[i];
    if (r1.errs && r1.errs.length) return { errs: r1.errs };
    const out = { now, expiry: r1.expiry, etc: null };
    if (p.etc && E.parseDT(p.etc) > E.parseDT(now)) {
      const at = JSON.parse(JSON.stringify(V));
      at.ports[i].completed = p.etc;
      const R = E.computeVoyage(at),
        r = R.res[i];
      if (!r.errs.length) out.etc = { at: p.etc, dem: r.dem, demAmt: r.demAmt, saved: r.saved, desAmt: r.desAmt };
    }
    // time used so far
    const sofar = JSON.parse(JSON.stringify(V));
    sofar.ports[i].completed = now;
    const r0 = E.computeVoyage(sofar).res[i];
    if (!r0.errs.length) {
      out.usedSoFar = r0.used;
      out.demSoFar = r0.dem;
      out.allowed = r0.portAllowed;
    }
    return out;
  }

  function disputedCount(events) {
    return (events || []).filter(e => !e.deleted_at && e.status === 'disputed').length;
  }

  return { applyEvents, forecast, nowLocal, disputedCount, MS_FIELDS };
});
