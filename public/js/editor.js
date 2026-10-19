// Voyage editor: the laytime calculator bound to one saved voyage, with autosave.
window.Editor = (function () {
  const $ = id => document.getElementById(id);
  const esc = s =>
    String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const E = window.Engine,
    S = window.Statement;
  const { computeVoyage, parseSOF, allowedHours, fmtDur, fmtLong, fmtDT, fmtHM, fmtDHM, hhmm, parseDT, num, PRESETS } =
    E;
  const DOWS = E.DOW;
  const money = (v, c) =>
    `${c || 'USD'} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtNum = S.fmtNum;

  function blankPort(prev) {
    return {
      name: '',
      op: prev ? (prev.op === 'Loading' ? 'Discharging' : 'Loading') : 'Loading',
      qty: prev ? prev.qty : '',
      rate: '',
      mode: 'rate',
      fixedHours: '',
      terms: 'SHINC',
      sDay: '0',
      sTime: '00:00',
      eDay: '1',
      eTime: '00:00',
      holidays: [],
      arrived: '',
      nor: '',
      norAcc: '',
      berthed: '',
      commenced: '',
      completed: '',
      sailed: '',
      turn: '6',
      commenceOv: '',
      exceptions: [],
    };
  }

  let V = null,
    rec = null,
    R = null;
  let saveTimer = null,
    saving = false,
    dirty = false,
    blocked = false;
  const P = () => V.ports[V.active];

  // ---------- saving ----------
  function setState(t, bad) {
    const el = $('saveState');
    el.textContent = t;
    el.classList.toggle('bad', !!bad);
  }
  function save() {
    if (!rec || blocked) return;
    dirty = true;
    setState('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }
  async function flush(statusChange) {
    clearTimeout(saveTimer);
    if (!rec || blocked) return;
    if (saving) {
      saveTimer = setTimeout(() => flush(statusChange), 300);
      return;
    }
    if (!dirty && !statusChange) return;
    saving = true;
    dirty = false;
    setState('Saving…');
    try {
      const body = { data: V, version: rec.version };
      if (statusChange) body.status = statusChange;
      const { voyage } = await Api.put(`/api/voyages/${rec.id}`, body);
      rec.version = voyage.version;
      rec.status = voyage.status;
      setState(
        dirty
          ? 'Unsaved changes'
          : `Saved ${new Date(voyage.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      );
    } catch (e) {
      if (e.status === 409) {
        blocked = true;
        $('conflictMsg').textContent = `${e.message} Your latest edits here were not saved.`;
        $('conflict').hidden = false;
        setState('Not saved', true);
      } else {
        dirty = true;
        setState(`Not saved: ${e.message}`, true);
        saveTimer = setTimeout(flush, 5000);
      }
    } finally {
      saving = false;
    }
  }
  $('conflictReload').onclick = async () => {
    const { voyage } = await Api.get(`/api/voyages/${rec.id}`);
    open(voyage);
  };
  window.addEventListener('beforeunload', e => {
    if (dirty || saving) {
      flush();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  $('vStatus').addEventListener('change', () => flush($('vStatus').value));
  $('btnBack').onclick = async () => {
    await flush();
    location.hash = '#/voyages';
  };

  // ---------- static selects ----------
  document
    .querySelectorAll('select.dow')
    .forEach(s => (s.innerHTML = DOWS.map((d, i) => `<option value="${i}">${d}</option>`).join('')));

  // ---------- voyage fields ----------
  function fillVoyage() {
    document.querySelectorAll('[data-v]').forEach(el => {
      const k = el.dataset.v;
      if (el.type === 'checkbox') el.checked = !!V[k];
      else el.value = V[k] ?? '';
    });
    document.querySelectorAll('input[name=calcMode]').forEach(r => (r.checked = r.value === V.calcMode));
    $('desRate').disabled = !!V.hd;
  }
  document.querySelectorAll('[data-v]').forEach(el =>
    el.addEventListener('input', () => {
      const k = el.dataset.v;
      V[k] = el.type === 'checkbox' ? el.checked : el.value;
      $('desRate').disabled = !!V.hd;
      calc();
    }),
  );
  document.querySelectorAll('input[name=calcMode]').forEach(r =>
    r.addEventListener('change', () => {
      V.calcMode = r.value;
      calc();
    }),
  );

  // ---------- tabs ----------
  function renderTabs() {
    $('tabs').innerHTML =
      V.ports
        .map(
          (
            p,
            i,
          ) => `<button type="button" role="tab" class="tab${i === V.active ? ' on' : ''}" data-tab="${i}" aria-selected="${i === V.active}">
    <span class="tn">${String(i + 1).padStart(2, '0')}</span><span>${esc(p.name || 'Unnamed port')}</span><span class="top">${p.op === 'Loading' ? 'LP' : 'DP'}</span></button>`,
        )
        .join('') + `<button type="button" class="tab add" id="portAdd">+ Add port</button>`;
    $('tabs')
      .querySelectorAll('[data-tab]')
      .forEach(
        b =>
          (b.onclick = () => {
            V.active = +b.dataset.tab;
            renderTabs();
            fillPort();
            calc();
          }),
      );
    $('portAdd').onclick = () => {
      if (V.ports.length >= 20) return;
      V.ports.push(blankPort(V.ports[V.ports.length - 1]));
      V.active = V.ports.length - 1;
      renderTabs();
      fillPort();
      calc();
    };
    $('portDel').hidden = V.ports.length < 2;
    $('portDel').textContent = 'Remove this port';
    delete $('portDel').dataset.arm;
  }
  $('portDel').onclick = function () {
    if (!this.dataset.arm) {
      this.dataset.arm = '1';
      this.textContent = 'Click again to remove';
      setTimeout(() => {
        if (this.dataset.arm) {
          delete this.dataset.arm;
          this.textContent = 'Remove this port';
        }
      }, 3000);
      return;
    }
    V.ports.splice(V.active, 1);
    V.active = Math.max(0, V.active - 1);
    renderTabs();
    fillPort();
    calc();
  };

  // ---------- port fields ----------
  function fillPort() {
    const p = P();
    document.querySelectorAll('[data-p]').forEach(el => {
      el.value = p[el.dataset.p] ?? '';
    });
    $('modeRate').checked = p.mode !== 'fixed';
    $('modeFixed').checked = p.mode === 'fixed';
    syncPortUI();
    renderHolidays();
    renderEx();
    $('pasteBox').value = '';
    $('pasteMsg').textContent = '';
  }
  function syncPortUI() {
    const p = P();
    document.querySelectorAll('[data-rate]').forEach(e => (e.hidden = p.mode === 'fixed'));
    document.querySelectorAll('[data-fixed]').forEach(e => (e.hidden = p.mode !== 'fixed'));
    const off = p.terms === 'SHINC';
    ['sDay', 'sTime', 'eDay', 'eTime'].forEach(id => ($(id).disabled = off));
  }
  document.querySelectorAll('[data-p]').forEach(el =>
    el.addEventListener('input', () => {
      const p = P(),
        k = el.dataset.p;
      p[k] = el.value;
      if (k === 'terms' && p.terms !== 'Custom') {
        const pr = PRESETS[p.terms] || [0, '00:00', 1, '00:00'];
        [p.sDay, p.sTime, p.eDay, p.eTime] = pr.map(String);
        ['sDay', 'sTime', 'eDay', 'eTime'].forEach(i => ($(i).value = p[i]));
      }
      if (['sDay', 'sTime', 'eDay', 'eTime'].includes(k) && p.terms !== 'Custom') {
        p.terms = 'Custom';
        $('terms').value = 'Custom';
      }
      if (k === 'name' || k === 'op') renderTabs();
      syncPortUI();
      calc();
    }),
  );
  document.querySelectorAll('input[name=mode]').forEach(r =>
    r.addEventListener('change', () => {
      P().mode = r.value;
      syncPortUI();
      calc();
    }),
  );

  function renderHolidays() {
    const h = P().holidays || [];
    $('holList').innerHTML = h.length
      ? h
          .map(
            (d, i) =>
              `<span class="chip">${fmtDT(parseDT(d + 'T00:00')).slice(0, 10)}<button type="button" data-hi="${i}" aria-label="Remove holiday">×</button></span>`,
          )
          .join('')
      : '<span class="hint">None</span>';
    $('holList')
      .querySelectorAll('[data-hi]')
      .forEach(
        b =>
          (b.onclick = () => {
            P().holidays.splice(+b.dataset.hi, 1);
            renderHolidays();
            calc();
          }),
      );
  }
  $('holAdd').onclick = () => {
    const v = $('holNew').value,
      p = P();
    p.holidays = p.holidays || [];
    if (v && !p.holidays.includes(v)) {
      p.holidays.push(v);
      p.holidays.sort();
      renderHolidays();
      calc();
    }
    $('holNew').value = '';
  };

  function renderEx() {
    const ex = P().exceptions;
    const L = $('exList');
    $('exCount').textContent = ex.length ? `${ex.length} period${ex.length > 1 ? 's' : ''}` : '';
    if (!ex.length) {
      L.innerHTML = '<div class="hint">No periods yet. Paste SOF lines above or add one by hand.</div>';
      return;
    }
    L.innerHTML = ex
      .map(
        (x, i) => `<div class="ex">
    <label class="f">From<input type="datetime-local" data-i="${i}" data-x="f" value="${esc(x.f)}"></label>
    <label class="f">To<input type="datetime-local" data-i="${i}" data-x="t" value="${esc(x.t)}"></label>
    <label class="f wide">Remarks<input data-i="${i}" data-x="d" value="${esc(x.d)}" maxlength="300" placeholder="Rain, shifting, draft survey…"></label>
    <label class="f">Counts<select data-i="${i}" data-x="p"><option value="0"${x.p == 0 ? ' selected' : ''}>NTC</option><option value="50"${x.p == 50 ? ' selected' : ''}>Half time</option></select></label>
    <label class="chk" title="Under ODAD, only periods ticked here interrupt demurrage"><input type="checkbox" data-i="${i}" data-x="od"${x.od ? ' checked' : ''}>Stops demurrage</label>
    <button type="button" class="del" data-del="${i}" aria-label="Remove period">×</button></div>`,
      )
      .join('');
    L.querySelectorAll('[data-x]').forEach(el =>
      el.addEventListener('input', () => {
        const x = P().exceptions[+el.dataset.i],
          k = el.dataset.x;
        x[k] = el.type === 'checkbox' ? el.checked : k === 'p' ? +el.value : el.value;
        calc();
      }),
    );
    L.querySelectorAll('[data-del]').forEach(
      b =>
        (b.onclick = () => {
          P().exceptions.splice(+b.dataset.del, 1);
          renderEx();
          calc();
        }),
    );
  }
  $('exAdd').onclick = () => {
    const ex = P().exceptions,
      last = ex[ex.length - 1];
    const base = last && last.t ? last.t : P().commenceOv || P().nor || '';
    ex.push({ f: base, t: base, d: '', p: 0, od: false });
    renderEx();
    calc();
  };
  $('exSort').onclick = () => {
    P().exceptions.sort((a, b) => (a.f || '').localeCompare(b.f || ''));
    renderEx();
    calc();
  };
  $('exClear').onclick = function () {
    if (!P().exceptions.length) return;
    if (!this.dataset.arm) {
      this.dataset.arm = '1';
      this.textContent = 'Click again to clear';
      setTimeout(() => {
        delete this.dataset.arm;
        this.textContent = 'Clear all';
      }, 3000);
      return;
    }
    delete this.dataset.arm;
    this.textContent = 'Clear all';
    P().exceptions = [];
    renderEx();
    calc();
  };
  $('pasteAdd').onclick = () => {
    const r = parseSOF($('pasteBox').value);
    P().exceptions.push(...r.rows);
    P().exceptions.sort((a, b) => (a.f || '').localeCompare(b.f || ''));
    $('pasteMsg').innerHTML =
      (r.rows.length ? `<span class="ok">Added ${r.rows.length} period${r.rows.length > 1 ? 's' : ''}.</span> ` : '') +
      (r.bad.length
        ? `<span class="bad">Could not read ${r.bad.length} line${r.bad.length > 1 ? 's' : ''}: ${esc(r.bad.slice(0, 3).join(' | '))}${r.bad.length > 3 ? ' …' : ''}</span>`
        : '');
    if (r.rows.length) $('pasteBox').value = r.bad.join('\n');
    renderEx();
    calc();
  };

  // ---------- calculation + render ----------
  function verdict(r, cur) {
    if (r.dem > 0.0001)
      return {
        cls: 'dem',
        lbl: 'Demurrage due to owners',
        amt: money(r.demAmt, cur),
        det: `${fmtLong(r.dem)}  ·  ${(r.dem / 24).toFixed(4)} days`,
      };
    if (r.desAmt > 0.0001)
      return {
        cls: 'des',
        lbl: 'Despatch due to charterers',
        amt: money(r.desAmt, cur),
        det: `${fmtLong(r.saved)} saved  ·  ${(r.saved / 24).toFixed(4)} days`,
      };
    if (V.calcMode === 'reversible' && r.expiry === null)
      return {
        cls: 'even',
        lbl: 'Laytime carried to next port',
        amt: fmtDur(r.pool - r.cumAfter),
        det: 'Remaining pooled laytime',
      };
    return { cls: 'even', lbl: 'No demurrage or despatch', amt: money(0, cur), det: 'Laytime exactly used' };
  }
  function calc() {
    if (!V) return;
    save();
    R = computeVoyage(V);
    const cur = V.currency || 'USD',
      p = P(),
      r = R.res[V.active];
    const al = allowedHours(p);
    $('allowedOut').textContent = al > 0 ? `${fmtLong(al)}  ·  ${(al / 24).toFixed(4)} days` : '–';
    $('edTitle').textContent = V.vessel || 'Untitled voyage';
    $('subline').textContent =
      [
        V.charterers && `A/c ${V.charterers}`,
        V.cpDate && `C/P ${fmtDT(parseDT(V.cpDate + 'T00:00')).slice(0, 10)}`,
        V.cargo,
      ]
        .filter(Boolean)
        .join('  ·  ') || 'Enter voyage details';
    $('rateNote').textContent =
      num(V.demRate) > 0
        ? `${cur} ${fmtNum(V.demRate)} PDPR${V.hd ? ' HD' : ''} · despatch ${cur} ${fmtNum(R.desRate)}/day`
        : '';
    renderSummary(cur);
    renderPortResult(p, r, cur);
  }
  function renderSummary(cur) {
    const ok = R.res.every(r => !r.errs.length),
      net = R.net;
    let v;
    if (!ok)
      v = {
        cls: 'even',
        lbl: 'Voyage result',
        amt: 'Incomplete',
        det: 'Complete every port to see the voyage balance',
      };
    else if (net > 0.005)
      v = { cls: 'dem', lbl: 'Net due to owners', amt: money(net, cur), det: 'Demurrage less despatch, all ports' };
    else if (net < -0.005)
      v = {
        cls: 'des',
        lbl: 'Net due to charterers',
        amt: money(-net, cur),
        det: 'Despatch less demurrage, all ports',
      };
    else v = { cls: 'even', lbl: 'Voyage balance', amt: money(0, cur), det: 'Nothing payable either way' };
    const rows = V.ports
      .map((p, i) => {
        const r = R.res[i];
        if (r.errs.length)
          return `<tr data-go="${i}" class="${i === V.active ? 'cur' : ''}"><td>${esc(p.name || 'Unnamed')}</td><td>${p.op === 'Loading' ? 'LP' : 'DP'}</td><td class="m r" colspan="2"><span class="warn">Incomplete</span></td></tr>`;
        const side =
          r.demAmt > 0
            ? `<span class="pill pd">DEM</span>`
            : r.desAmt > 0
              ? `<span class="pill pok">DES</span>`
              : '<span class="pill p0">–</span>';
        return `<tr data-go="${i}" class="${i === V.active ? 'cur' : ''}"><td>${esc(p.name || 'Unnamed')}</td><td>${p.op === 'Loading' ? 'LP' : 'DP'}</td><td class="m r">${fmtDur(r.portAllowed)}</td><td class="m r">${side} ${r.demAmt > 0 ? money(r.demAmt, cur) : r.desAmt > 0 ? money(r.desAmt, cur) : ''}</td></tr>`;
      })
      .join('');
    $('voyage').innerHTML = `<h2>Voyage ${V.calcMode === 'reversible' ? '· reversible' : '· ports separate'}</h2>
    <div class="verdict ${v.cls}"><span class="lbl">${v.lbl}</span><span class="amt">${v.amt}</span><span class="det">${v.det}</span></div>
    <div class="tbl mt8"><table class="sum"><thead><tr><th>Port</th><th></th><th class="r">Allowed</th><th class="r">Result</th></tr></thead><tbody>${rows}</tbody>
    ${ok ? `<tfoot><tr><td colspan="3">Demurrage ${money(R.totDem, cur)} · Despatch ${money(R.totDes, cur)}</td><td class="m r">${money(Math.abs(net), cur)}</td></tr></tfoot>` : ''}</table></div>`;
    $('voyage')
      .querySelectorAll('[data-go]')
      .forEach(
        tr =>
          (tr.onclick = () => {
            V.active = +tr.dataset.go;
            renderTabs();
            fillPort();
            calc();
          }),
      );
  }
  function renderPortResult(p, r, cur) {
    const res = $('portResult');
    if (r.errs.length) {
      res.innerHTML =
        `<h2>${esc(p.name || 'This port')}</h2>` + r.errs.map(e => `<div class="err">${esc(e)}</div>`).join('');
      ['tl', 'ticks', 'stmt', 'stmtHead', 'stmtFoot'].forEach(id => ($(id).innerHTML = ''));
      return;
    }
    const v = verdict(r, cur);
    res.innerHTML = `<h2>${esc(p.name || 'This port')} · ${esc(p.op)}</h2>
   <div class="verdict ${v.cls}"><span class="lbl">${v.lbl}</span><span class="amt">${v.amt}</span><span class="det">${v.det}</span></div>
   <dl class="kv">
    <dt>Time to count from</dt><dd>${fmtDT(r.commence)}</dd>
    <dt>${p.op === 'Loading' ? 'Loading' : 'Discharge'} completed</dt><dd>${fmtDT(r.end)}</dd>
    <dt>Laytime expired</dt><dd>${r.expiry !== null ? fmtDT(r.expiry) : 'Not expired'}</dd>
    <span class="sep"></span>
    <dt>Time allowed${V.calcMode === 'reversible' ? ' (this port)' : ''}</dt><dd>${fmtLong(r.portAllowed)}</dd>
    ${V.calcMode === 'reversible' ? `<dt>Pooled, all ports</dt><dd>${fmtLong(r.pool)}</dd>` : ''}
    <dt>Time used</dt><dd>${fmtLong(r.used)}</dd>
    ${r.dem > 0 ? `<dt>Time on demurrage</dt><dd>${fmtLong(r.dem)}</dd>` : ''}
    ${r.desAmt > 0 ? `<dt>Time saved</dt><dd>${fmtLong(r.saved)}</dd>` : ''}
   </dl>`;
    // timeline
    const t0 = r.rows[0].a,
      t1 = r.end,
      span = t1 - t0;
    const pc = x => (((x - t0) / span) * 100).toFixed(3) + '%';
    const kind = x =>
      x.ph === 'pre'
        ? 't-pre'
        : x.ph === 'dem'
          ? x.f < 1
            ? 't-demx'
            : 't-dem'
          : x.f === 1
            ? 't-count'
            : x.f > 0
              ? 't-half'
              : 't-excl';
    let tl = r.rows
      .map(
        x =>
          `<div class="${kind(x)}" style="left:${pc(x.a)};width:${(((x.b - x.a) / span) * 100).toFixed(3)}%" title="${fmtDT(x.a)} – ${fmtDT(x.b)} ${esc(S.remark(x) || 'Counting')}"></div>`,
      )
      .join('');
    if (r.expiry !== null && r.expiry > t0)
      tl += `<div class="mark" style="left:${pc(r.expiry)}" title="Laytime expired ${fmtDT(r.expiry)}"></div>`;
    $('tl').innerHTML = tl;
    const DAYMS = 86400000,
      days = Math.ceil(span / DAYMS),
      step = Math.max(1, Math.ceil(days / 7));
    let tk = '';
    for (let d = Math.ceil(t0 / DAYMS) * DAYMS, i = 0; d < t1; d += DAYMS, i++) {
      if (i % step) continue;
      const q = (d - t0) / span;
      if (q < 0.04 || q > 0.96) continue;
      tk += `<span style="left:${(q * 100).toFixed(2)}%">${fmtDT(d).slice(0, 5)}</span>`;
    }
    $('ticks').innerHTML = tk;
    // statement header
    const L = S.portLines(V, R, V.active);
    $('stmtHead').innerHTML = L.head
      .slice(1)
      .filter(([k]) => k !== 'Time to count from')
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v || '–')}</dd></div>`)
      .join('');
    // statement table
    const anyDem = r.rows.some(x => x.ph === 'dem');
    let body = '',
      lastDay = null;
    const span2 = anyDem ? 5 : 4;
    if (r.already)
      body += `<tr class="expiry"><td colspan="4" class="m">${fmtDT(r.commence)}</td><td colspan="${span2}">Laytime already exhausted at previous port – vessel on demurrage</td></tr>`;
    r.rows.forEach(x => {
      const dk = Math.floor(x.a / 86400000),
        d = new Date(x.a),
        first = dk !== lastDay;
      lastDay = dk;
      const pct =
        x.ph === 'pre'
          ? ''
          : `<span class="pill ${x.ph === 'dem' ? (x.f < 1 ? 'p0' : 'pd') : 'p' + Math.round(x.f * 100)}">${Math.round(x.f * 100)}%</span>`;
      const used = x.ph === 'pre' || x.c < 1e-6 ? '–' : fmtHM(x.c);
      body += `<tr class="${x.ph}${first ? ' daystart' : ''}"><td class="m">${first ? fmtDT(x.a).slice(0, 10) : ''}</td><td>${first ? DOWS[d.getUTCDay()] : ''}</td><td class="m">${hhmm(x.a)}</td><td class="m">${hhmm(x.b, true)}</td>
      <td class="m r">${used}</td><td>${pct}</td><td class="m r">${x.ph === 'pre' ? '–' : fmtDHM(x.cumLay)}</td>${anyDem ? `<td class="m r">${x.ph === 'dem' ? fmtDHM(x.cumDem) : ''}</td>` : ''}<td class="rem">${esc(S.remark(x))}</td></tr>`;
      if (r.expiry !== null && !r.already && x.ph === 'lay' && Math.abs(x.b - r.expiry) < 1)
        body += `<tr class="expiry"><td colspan="4" class="m">${fmtDT(r.expiry)}</td><td colspan="${span2}">Laytime expired – vessel on demurrage</td></tr>`;
    });
    $('stmt').innerHTML =
      `<thead><tr><th>Date</th><th>Day</th><th>From</th><th>To</th><th class="r">Time used<br><small>HH:MM</small></th><th>Counts</th><th class="r">Cumulative<br><small>DD:HH:MM</small></th>${anyDem ? '<th class="r">Demurrage<br><small>DD:HH:MM</small></th>' : ''}<th>Remarks</th></tr></thead><tbody>${body}</tbody>`;
    $('stmtFoot').innerHTML = L.tot
      .map(
        ([k, a, b]) =>
          `<dt>${esc(k)}</dt><dd>${typeof a === 'number' ? a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(a)}${b !== '' ? `<small>${b} days</small>` : ''}</dd>`,
      )
      .join('');
  }

  // ---------- copy + export ----------
  $('btnCopy').onclick = () => {
    const t = $('toast'),
      r = R && R.res[V.active];
    if (!r || r.errs.length) {
      t.textContent = 'Complete this port first.';
      return;
    }
    const L = S.portLines(V, R, V.active);
    const txt = [
      ...L.head.map(x => x.join('\t')),
      '',
      S.COLS.join('\t'),
      ...L.rows.map(x => x.join('\t')),
      '',
      ...L.tot.map(x => x.join('\t')),
    ].join('\n');
    navigator.clipboard.writeText(txt).then(
      () => {
        t.textContent = 'Copied. Paste into Excel or an email.';
      },
      () => {
        let ta = $('copyFallback');
        if (!ta) {
          ta = document.createElement('textarea');
          ta.id = 'copyFallback';
          ta.className = 'fallback';
          $('stmtWrap').after(ta);
        }
        ta.value = txt;
        ta.select();
        t.textContent = 'Copy is blocked. The text is selected below; press Ctrl+C.';
      },
    );
    setTimeout(() => (t.textContent = ''), 5000);
  };
  $('btnExcel').onclick = async () => {
    const t = $('toast');
    t.textContent = 'Preparing workbook…';
    try {
      await flush();
      await Api.download(`/api/voyages/${rec.id}/export.xlsx`, 'laytime.xlsx');
      t.textContent = '';
    } catch (e) {
      t.textContent = e.message;
    }
  };

  // ---------- open ----------
  function open(record) {
    clearTimeout(saveTimer);
    rec = { id: record.id, version: record.version, status: record.status };
    V = record.data;
    if (!V.ports || !V.ports.length) V.ports = [blankPort()];
    if (V.active >= V.ports.length) V.active = 0;
    blocked = false;
    dirty = false;
    $('conflict').hidden = true;
    $('vStatus').value = record.status || 'draft';
    fillVoyage();
    renderTabs();
    fillPort();
    calc();
    dirty = false;
    clearTimeout(saveTimer);
    setState(record.updatedBy ? `Last saved by ${record.updatedBy}` : '');
  }
  return { open, flush, isDirty: () => dirty || saving };
})();
