// Live Statement of Facts panel: events, reviews, pasted lines, documents (AI reading) and stakeholders.
// Used inside the operator's voyage editor and the stakeholder portal.
window.SofPanel = (function () {
  const esc = s =>
    String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const E = window.Engine,
    C = window.Codes;
  const dt = s => (s ? E.fmtDT(E.parseDT(s)) : '');
  const STATUS = { open: 'Open', confirmed: 'Confirmed', disputed: 'Disputed' };

  function create(root, ctx) {
    // ctx: {voyageId, portId(), onData(state), compact}
    let S = null,
      expanded = null,
      editing = null,
      polling = null,
      inviteLink = '';
    const el = sel => root.querySelector(sel);
    root.classList.add('sofp');

    async function load() {
      S = await Api.get(`/api/v/${ctx.voyageId}`);
      if (ctx.onData) ctx.onData(S);
      render();
      const busy = S.documents.some(d => d.status === 'uploaded' || d.status === 'processing');
      clearTimeout(polling);
      if (busy) polling = setTimeout(load, 1500);
    }
    let note = null,
      noteTimer = null;
    function paintMsg() {
      const m = el('.sofp-msg');
      if (!m) return;
      m.textContent = note ? note.t : '';
      m.className = 'sofp-msg msg ' + (note && note.ok ? 'ok' : 'bad');
    }
    function msg(t, ok) {
      note = { t, ok };
      paintMsg();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(
        () => {
          note = null;
          paintMsg();
        },
        ok ? 4000 : 10000,
      );
    }
    async function act(fn, okText) {
      try {
        await fn();
        if (okText) msg(okText, true);
        await load();
      } catch (e) {
        msg(e.message);
      }
    }

    function codeOptions(selected) {
      const rec = new Set(S.access.recordable);
      const opt = c => `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${esc(c.label)}</option>`;
      const ms = C.MILESTONES.filter(c => rec.has(c.code)),
        st = C.STOPPAGES.filter(c => rec.has(c.code));
      const groups = {};
      st.forEach(c => (groups[c.group] = groups[c.group] || []).push(c));
      return (
        (ms.length ? `<optgroup label="Milestones">${ms.map(opt).join('')}</optgroup>` : '') +
        Object.entries(groups)
          .map(([g, l]) => `<optgroup label="Stoppage – ${esc(g)}">${l.map(opt).join('')}</optgroup>`)
          .join('')
      );
    }
    function treatment(code) {
      if (!S.access.commercial) return '';
      const k = C.BY_CODE[code];
      if (!k || k.kind !== 'stoppage') return '';
      const r = C.rule(S.voyage.data, code);
      return `<span class="pill ${r.p >= 100 ? 'p100' : r.p > 0 ? 'p50' : 'p0'}" title="Treatment under this charter party">${r.p >= 100 ? 'Counts' : r.p > 0 ? 'Half' : 'NTC'}${r.od ? ' · stops DEM' : ''}</span>`;
    }

    function render() {
      const portId = ctx.portId();
      const port = S.voyage.data.ports.find(p => p.id === portId) || S.voyage.data.ports[0];
      const evs = S.events.filter(e => e.port_id === port.id);
      const disputed = evs.filter(e => e.status === 'disputed').length,
        open = evs.filter(e => e.status === 'open').length;
      const P = S.access.perms || {};
      const canAdd = S.access.recordable.length > 0;
      const people = S.access.manage && P.stakeholders;
      const ed = editing && S.events.find(e => e.id === editing);
      const kind = c => (C.BY_CODE[c] || {}).kind;
      const selCode = ed ? ed.code : (el('#sofCode') && el('#sofCode').value) || '';
      root.innerHTML = !P.sof_view
        ? `<div class="panel"><h2>Statement of facts</h2><p class="hint">Your role does not include the statement of facts.</p></div>${people ? peoplePanel() : ''}`
        : `
    <div class="panel">
      <h2>Statement of facts · ${esc(port.name || 'port')}
        <span class="hint">${evs.length} event${evs.length === 1 ? '' : 's'}${open ? ` · ${open} awaiting confirmation` : ''}${disputed ? ` · <span class="bad">${disputed} disputed</span>` : ''}</span></h2>
      ${
        canAdd
          ? `<form class="sofp-add" id="sofForm" novalidate>
        <div class="grid">
          <label class="f">Event<select id="sofCode">${codeOptions(selCode)}</select></label>
          <label class="f" data-k="ms">Date and time<input id="sofAt" type="datetime-local" value="${(ed && ed.at) || ''}"></label>
          <label class="f" data-k="st">From<input id="sofFrom" type="datetime-local" value="${(ed && ed.from_at) || ''}"></label>
          <label class="f" data-k="st"><span>To <span class="hint">(blank if still going on)</span></span><input id="sofTo" type="datetime-local" value="${(ed && ed.to_at) || ''}"></label>
          <label class="f wide2">Remarks<input id="sofRemark" maxlength="300" value="${esc(ed ? ed.remark : '')}" placeholder="e.g. Hatch 3, heavy rain"></label>
        </div>
        <div class="btnrow mt8"><button class="primary" type="submit">${ed ? 'Save changes' : 'Add to SOF'}</button>${ed ? '<button type="button" id="sofCancel">Cancel</button>' : ''}
          <span class="hint">Recording as ${esc(S.access.partyLabel)}</span></div>
      </form>
      <details class="mt8"><summary>Paste several lines</summary>
        <div class="paste mt8"><textarea id="sofPaste" placeholder="16.09.2013 15:00 22:30 Due to rain&#10;17.09.2013 14:45 18.09.2013 03:30 Due to rain&#10;23.09.2013 15:15 Completed discharge"></textarea>
        <div class="row"><button type="button" id="sofPasteBtn">Add lines</button></div></div>
      </details>`
          : `<p class="hint">${P.sof_review ? 'You can review, confirm or dispute events. Your role cannot record new ones.' : 'You can follow the events here.'}</p>`
      }
      <div class="sofp-msg msg" role="status"></div>
      <div class="tbl"><table class="sofp-list"><thead><tr><th>When</th><th>Event</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>
      ${evs.length ? evs.map(e => row(e)).join('') : `<tr><td colspan="5" class="empty">No events for this port yet.</td></tr>`}
      </tbody></table></div>
    </div>
    ${P.documents ? docsPanel(port) : ''}
    ${people ? peoplePanel() : ''}`;
      if (!P.sof_view) {
        if (people) wirePeople();
        paintMsg();
        return;
      }
      // wire
      if (canAdd) {
        const sync = () => {
          const k = kind(el('#sofCode').value);
          root.querySelectorAll('[data-k=ms]').forEach(x => (x.hidden = k !== 'milestone'));
          root.querySelectorAll('[data-k=st]').forEach(x => (x.hidden = k !== 'stoppage'));
        };
        el('#sofCode').onchange = sync;
        sync();
        el('#sofForm').onsubmit = e => {
          e.preventDefault();
          const code = el('#sofCode').value,
            k = kind(code);
          const body = {
            portId: port.id,
            code,
            remark: el('#sofRemark').value.trim(),
            at: k === 'milestone' ? el('#sofAt').value || null : null,
            from: k === 'stoppage' ? el('#sofFrom').value || null : null,
            to: k === 'stoppage' ? el('#sofTo').value || null : null,
          };
          if (ed)
            act(
              () =>
                Api.patch(`/api/v/${ctx.voyageId}/events/${ed.id}`, { ...body, version: ed.version }).then(() => {
                  editing = null;
                }),
              'Saved.',
            );
          else act(() => Api.post(`/api/v/${ctx.voyageId}/events`, body), 'Added.');
        };
        if (el('#sofCancel'))
          el('#sofCancel').onclick = () => {
            editing = null;
            render();
          };
        el('#sofPasteBtn').onclick = () =>
          act(async () => {
            const r = await Api.post(`/api/v/${ctx.voyageId}/events/bulk`, {
              portId: port.id,
              text: el('#sofPaste').value,
            });
            if (r.skipped.length)
              throw new Error(
                `Added ${r.created}. Could not read ${r.skipped.length}: ${r.skipped.slice(0, 3).join(' | ')}`,
              );
          }, 'Lines added.');
      }
      root.querySelectorAll('[data-exp]').forEach(
        b =>
          (b.onclick = () => {
            expanded = expanded === b.dataset.exp ? null : b.dataset.exp;
            render();
          }),
      );
      root.querySelectorAll('[data-edit]').forEach(
        b =>
          (b.onclick = () => {
            editing = b.dataset.edit;
            render();
            el('#sofForm').scrollIntoView({ block: 'center' });
          }),
      );
      root.querySelectorAll('[data-rm]').forEach(
        b =>
          (b.onclick = () => {
            if (!b.dataset.arm) {
              b.dataset.arm = '1';
              b.textContent = 'Confirm remove';
              return;
            }
            act(() => Api.del(`/api/v/${ctx.voyageId}/events/${b.dataset.rm}`), 'Removed.');
          }),
      );
      root.querySelectorAll('[data-rev]').forEach(
        b =>
          (b.onclick = () => {
            const [id, dec] = b.dataset.rev.split(':');
            const c = el(`#rc-${id}`);
            const ev = S.events.find(x => x.id === id);
            act(
              () =>
                Api.post(`/api/v/${ctx.voyageId}/events/${id}/review`, {
                  decision: dec,
                  comment: c ? c.value : '',
                  version: ev && ev.version,
                }),
              dec === 'confirm' ? 'Confirmed.' : dec === 'dispute' ? 'Disputed.' : 'Comment added.',
            );
          }),
      );
      if (P.documents) wireDocs(port);
      if (people) wirePeople();
      paintMsg();
    }

    function row(e) {
      const def = C.BY_CODE[e.code] || { label: e.code };
      const when =
        e.kind === 'milestone'
          ? dt(e.at)
          : `${dt(e.from_at)} → ${e.to_at ? E.fmtDT(E.parseDT(e.to_at)).slice(e.to_at.slice(0, 10) === e.from_at.slice(0, 10) ? 11 : 0) : '<span class="warn">ongoing</span>'}`;
      const P = S.access.perms || {};
      const canEdit = P.sof_record && (S.access.manage || (e.mine && e.status !== 'confirmed'));
      const n = (e.reviews || []).length;
      let h = `<tr class="ev ev-${e.status}"><td class="m">${when}</td><td><strong>${esc(def.label)}</strong> ${treatment(e.code)}${e.remark ? `<div class="hint">${esc(e.remark)}</div>` : ''}${e.source !== 'manual' ? `<div class="hint">from ${e.source === 'document' ? 'document' : 'pasted lines'}</div>` : ''}</td>
      <td>${esc(C.PARTY_ROLES[e.author_party] || (e.author_party === 'operator' ? S.voyage.operator : e.author_party))}<div class="hint">${esc(e.author_name || '')}</div></td>
      <td><span class="st st-${e.status}">${STATUS[e.status]}</span></td>
      <td><div class="row-actions"><button type="button" data-exp="${e.id}">${expanded === e.id ? 'Close' : n ? `Review (${n})` : 'Review'}</button>${canEdit ? `<button type="button" data-edit="${e.id}">Edit</button><button type="button" data-rm="${e.id}">Remove</button>` : ''}</div></td></tr>`;
      if (expanded === e.id) {
        h += `<tr class="ev-thread"><td colspan="5">
        ${(e.reviews || []).map(r => `<div class="rv rv-${r.decision}"><strong>${esc(r.user_name || '')}</strong> <span class="hint">${esc(C.PARTY_ROLES[r.party] || (r.party === 'operator' ? S.voyage.operator : r.party))} · ${new Date(r.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span> — ${r.decision === 'confirm' ? 'confirmed' : r.decision === 'dispute' ? 'disputed' : 'commented'}${r.comment ? `: ${esc(r.comment)}` : ''}</div>`).join('') || '<div class="hint">No reviews yet.</div>'}
        ${
          P.sof_review
            ? `<div class="rv-form"><input id="rc-${e.id}" maxlength="1000" placeholder="Reason or comment">
          ${!e.mine && e.status !== 'confirmed' ? `<button type="button" class="primary" data-rev="${e.id}:confirm">Confirm</button>` : ''}
          <button type="button" data-rev="${e.id}:dispute">Dispute</button><button type="button" data-rev="${e.id}:comment">Comment</button></div>`
            : ''
        }
      </td></tr>`;
      }
      return h;
    }

    // ---------- documents ----------
    function docsPanel(port) {
      const docs = S.documents;
      const prov =
        S.access.provider === 'luma'
          ? 'Luma reads PDFs, scans, Word and Excel files.'
          : 'The built-in reader handles Excel, CSV and text. PDFs and scans need Luma.';
      return `<div class="panel mt12"><h2>Documents <span class="hint">${esc(prov)}</span></h2>
      <div class="btnrow"><label class="f">Document type<select id="docType"><option value="sof">Statement of facts / timesheet</option>${S.access.commercial ? '<option value="cp">Charter party / recap</option>' : ''}<option value="other">Other</option></select></label>
        <label class="f">File<input id="docFile" type="file" accept=".pdf,.xlsx,.xls,.csv,.txt,.docx,.png,.jpg,.jpeg"></label>
        <div class="f"><span>&nbsp;</span><button type="button" class="primary" id="docUp">Upload and read</button></div></div>
      <div class="sofp-docs">${docs.length ? docs.map(d => docRow(d, port)).join('') : '<p class="hint">No documents yet. Upload the agent\'s SOF to fill the events automatically.</p>'}</div></div>`;
    }
    function docRow(d) {
      const st = {
        uploaded: 'Waiting',
        processing: 'Reading…',
        ready: 'Ready to review',
        failed: 'Could not read',
        applied: 'Added to SOF',
      }[d.status];
      let h = `<div class="doc"><div class="doc-h"><strong>${esc(d.filename)}</strong> <span class="hint">${d.doc_type === 'cp' ? 'Charter party' : d.doc_type === 'sof' ? 'SOF' : 'Other'} · ${Math.ceil(d.size / 1024)} KB${d.provider ? ` · ${d.provider === 'luma' ? 'Luma' : 'built-in reader'}` : ''}</span>
      <span class="st st-${d.status === 'failed' ? 'disputed' : d.status === 'ready' ? 'open' : 'confirmed'}">${st}</span>
      <button type="button" data-dl="${d.id}">Download</button>${d.status === 'failed' && (S.access.manage || d.mine) ? `<button type="button" data-retry="${d.id}">Try again</button>` : ''}</div>`;
      if (d.status === 'failed') h += `<div class="msg bad">${esc(d.error)}</div>`;
      if ((d.status === 'ready' || d.status === 'applied') && d.result) {
        const r = d.result,
          pname = id => (S.voyage.data.ports.find(p => p.id === id) || {}).name || '';
        if (r.events.length)
          h += `<div class="tbl"><table class="sofp-prop"><thead><tr><th></th><th>Port</th><th>When</th><th>Event</th><th>Found in document</th></tr></thead><tbody>${r.events
            .map((e, i) => {
              const def = C.BY_CODE[e.code] || { label: e.code };
              const allowed = S.access.recordable.includes(e.code);
              return `<tr class="${e.applied ? 'pre' : ''}"><td>${e.applied ? '✓' : `<input type="checkbox" data-pick="${d.id}" value="${i}"${allowed ? ' checked' : ' disabled title="Your role cannot record this event"'}>`}</td><td>${esc(pname(e.port_id))}</td>
        <td class="m">${e.kind === 'milestone' ? dt(e.at) : `${dt(e.from_at)} → ${e.to_at ? dt(e.to_at) : 'ongoing'}`}</td><td>${esc(def.label)} ${treatment(e.code)}${e.remark ? `<div class="hint">${esc(e.remark)}</div>` : ''}</td>
        <td class="hint">${esc(e.source_text || '')}${e.confidence != null ? ` <span class="pill p0">${Math.round(e.confidence * 100)}%</span>` : ''}</td></tr>`;
            })
            .join('')}</tbody></table></div>`;
        if (r.terms && S.access.commercial) {
          const L = {
            vessel: 'Vessel',
            charterers: 'Charterers',
            owners: 'Owners',
            cargo: 'Cargo',
            cpDate: 'C/P date',
            qty: 'Quantity (MT)',
            rate: 'Rate (MT/day)',
            terms: 'Terms',
            turn: 'Turn time (h)',
            demRate: 'Demurrage/day',
            desRate: 'Despatch/day',
            hd: 'Half despatch',
            odad: 'ODAD',
          };
          h += `<div class="terms"><strong>Charter party terms found</strong>${r.termsApplied ? ' <span class="st st-confirmed">applied</span>' : ''}<dl class="kv">${Object.entries(
            r.terms,
          )
            .map(([k, v]) => `<dt>${L[k] || k}</dt><dd>${esc(typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)}</dd>`)
            .join('')}</dl>
          ${S.access.manage && (S.access.perms || {}).voyages_edit && !r.termsApplied ? `<label class="chk mt8"><input type="checkbox" data-terms="${d.id}" checked> Apply these terms to the voyage</label>` : ''}</div>`;
        }
        if (r.warnings && r.warnings.length)
          h += `<details class="mt6"><summary class="hint">${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''} from the reader</summary><ul class="hint">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
        const pending =
          r.events.some(e => !e.applied && S.access.recordable.includes(e.code)) ||
          (r.terms && !r.termsApplied && S.access.manage && (S.access.perms || {}).voyages_edit);
        if (pending)
          h += `<div class="btnrow mt8"><button type="button" class="primary" data-apply="${d.id}">Add selected to SOF</button></div>`;
      }
      return h + '</div>';
    }
    function wireDocs(port) {
      el('#docUp').onclick = () => {
        const f = el('#docFile').files[0];
        if (!f) {
          msg('Choose a file first.');
          return;
        }
        if (f.size > 15 * 1024 * 1024) {
          msg('Files must be under 15 MB.');
          return;
        }
        act(async () => {
          const r = await fetch(`/api/v/${ctx.voyageId}/documents`, {
            method: 'POST',
            credentials: 'same-origin',
            body: f,
            headers: {
              'X-Requested-With': 'fetch',
              'Content-Type': 'application/octet-stream',
              'X-Filename': encodeURIComponent(f.name),
              'X-Doc-Type': el('#docType').value,
              'X-Port-Id': port.id,
            },
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || 'Upload failed.');
          }
        }, 'Uploaded. Reading the document…');
      };
      root
        .querySelectorAll('[data-dl]')
        .forEach(
          b =>
            (b.onclick = () =>
              Api.download(`/api/v/${ctx.voyageId}/documents/${b.dataset.dl}/file`, 'document').catch(e =>
                msg(e.message),
              )),
        );
      root
        .querySelectorAll('[data-retry]')
        .forEach(
          b =>
            (b.onclick = () =>
              act(() => Api.post(`/api/v/${ctx.voyageId}/documents/${b.dataset.retry}/retry`), 'Reading again…')),
        );
      root.querySelectorAll('[data-apply]').forEach(
        b =>
          (b.onclick = () => {
            const id = b.dataset.apply;
            const picks = [...root.querySelectorAll(`[data-pick="${id}"]:checked`)].map(x => +x.value);
            const t = root.querySelector(`[data-terms="${id}"]`);
            act(async () => {
              const r = await Api.post(`/api/v/${ctx.voyageId}/documents/${id}/apply`, {
                events: picks,
                terms: !!(t && t.checked),
              });
              if (r.termsApplied && ctx.onTermsApplied) await ctx.onTermsApplied();
              if (r.skipped.length) throw new Error(`Added ${r.added}. Skipped: ${r.skipped.slice(0, 3).join(' | ')}`);
            }, 'Added to the SOF.');
          }),
      );
    }

    // ---------- stakeholders ----------
    let addMode = 'create';
    function peoplePanel() {
      const P = S.participants,
        I = S.invites;
      const roleOpts = sel =>
        Object.entries(C.PARTY_ROLES)
          .map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v)}</option>`)
          .join('');
      const seen = d => (d ? new Date(d).toLocaleDateString([], { day: '2-digit', month: 'short' }) : 'never');
      return `<div class="panel mt12"><h2>Stakeholders on this voyage</h2>
      <div class="tbl"><table><thead><tr><th>Name</th><th>Login ID</th><th>Role</th><th>Sees amounts</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${P.map(
        p => `<tr><td>${esc(p.name)}<div class="hint">${[p.company, p.mobile, p.email].filter(Boolean).map(esc).join(' · ')}</div></td><td class="m">${esc(p.login_id)}${p.must_change_password ? '<div class="hint">temporary password</div>' : ''}</td>
        <td>${esc(C.PARTY_ROLES[p.party_role])}</td><td><input type="checkbox" data-com="${p.id}"${p.can_see_commercials ? ' checked' : ''} aria-label="Sees commercial figures"></td><td class="hint">${seen(p.last_login_at)}</td>
        <td><div class="row-actions">${p.can_reset ? `<button type="button" data-reset="${p.id}" data-name="${esc(p.name)}">Reset password</button>` : ''}<button type="button" data-unp="${p.id}">Remove</button></div></td></tr>`,
      ).join('')}
      ${I.map(i => `<tr class="pre"><td>${esc(i.email)}<div class="hint">invited by email, not joined yet</div></td><td></td><td>${esc(C.PARTY_ROLES[i.party_role])}</td><td>${i.can_see_commercials ? 'Yes' : 'No'}</td><td></td><td><div class="row-actions"><button type="button" data-uninv="${i.id}">Cancel</button></div></td></tr>`).join('')}
      ${!P.length && !I.length ? '<tr><td colspan="6" class="empty">Add the agent, master, stevedore and the other party so they can record and confirm events.</td></tr>' : ''}
      </tbody></table></div>
      <div class="mt12"><span class="seg" role="radiogroup" aria-label="How to add someone">
        <label><input type="radio" name="addMode" value="create"${addMode === 'create' ? ' checked' : ''}>Create a login</label>
        <label><input type="radio" name="addMode" value="email"${addMode === 'email' ? ' checked' : ''}>Invite by email</label>
        <label><input type="radio" name="addMode" value="existing"${addMode === 'existing' ? ' checked' : ''}>Existing login ID</label></span></div>
      ${
        addMode === 'create'
          ? `<form class="mt8" id="crForm" novalidate><div class="grid">
          <label class="f">Name<input id="crName" maxlength="120" required placeholder="e.g. Capt. R. Singh"></label>
          <label class="f">Company / vessel<input id="crCompany" maxlength="160"></label>
          <label class="f">Role<select id="crParty">${roleOpts('master')}</select></label>
          <label class="f">Login ID<input id="crLogin" maxlength="40" autocapitalize="none" spellcheck="false" required></label>
          <label class="f"><span>Mobile <span class="hint">(for sign-in codes)</span></span><input id="crMobile" type="tel" placeholder="+65 9123 4567"></label>
          <label class="f"><span>Email <span class="hint">(optional)</span></span><input id="crEmail" type="email"></label>
          <label class="f">Temporary password<input id="crPw" minlength="10" required value="${Api.tempPassword()}"></label></div>
        <div class="btnrow mt8"><label class="chk"><input type="checkbox" id="crCom"> Can see rates and amounts</label><button type="submit" class="primary">Create login</button></div>
        <p class="hint">For people without their own email, such as a ship's master or a stevedore. You pass the login ID and password on yourself.</p></form>`
          : ''
      }
      ${
        addMode === 'email'
          ? `<form class="btnrow mt8" id="invForm" novalidate>
          <label class="f">Email<input id="invEmail" type="email" required></label>
          <label class="f">Role<select id="invParty">${roleOpts('agent')}</select></label>
          <label class="chk"><input type="checkbox" id="invCom"> Can see rates and amounts</label>
          <div class="f"><span>&nbsp;</span><button type="submit" class="primary">Invite</button></div></form>
        <p class="hint">They open the link, choose their own login ID and password, and land on this voyage.</p>`
          : ''
      }
      ${
        addMode === 'existing'
          ? `<form class="btnrow mt8" id="exForm" novalidate>
          <label class="f">Their login ID<input id="exLogin" maxlength="40" autocapitalize="none" spellcheck="false" required></label>
          <label class="f">Role<select id="exParty">${roleOpts('agent')}</select></label>
          <label class="chk"><input type="checkbox" id="exCom"> Can see rates and amounts</label>
          <div class="f"><span>&nbsp;</span><button type="submit" class="primary">Add</button></div></form>
        <p class="hint">For a stakeholder who already works with you on another voyage. They keep their existing password.</p>`
          : ''
      }
      ${inviteLink ? `<div class="banner warn mt8">Send this link to the person (valid 14 days, single use): <code id="invLink">${esc(inviteLink)}</code> <button type="button" id="invCopy">Copy</button></div>` : ''}
      <div id="peopleCreds" class="mt8" hidden></div>
    </div>`;
    }
    let pendingCreds = null;
    function wirePeople() {
      const comDefault = (party, box) => {
        const f = () => {
          box.checked = ['owner', 'charterer', 'broker'].includes(party.value);
        };
        party.onchange = f;
        f();
      };
      root.querySelectorAll('input[name=addMode]').forEach(
        r =>
          (r.onchange = () => {
            addMode = r.value;
            inviteLink = '';
            render();
          }),
      );
      if (el('#crForm')) {
        comDefault(el('#crParty'), el('#crCom'));
        Api.linkLogin(el('#crLogin'), el('#crName'));
        el('#crForm').onsubmit = e => {
          e.preventDefault();
          const pw = el('#crPw').value,
            name = el('#crName').value.trim();
          act(async () => {
            try {
              const r = await Api.post(`/api/v/${ctx.voyageId}/participants`, {
                name,
                company: el('#crCompany').value.trim(),
                loginId: el('#crLogin').value.trim(),
                email: el('#crEmail').value.trim(),
                mobile: el('#crMobile').value.trim(),
                party: el('#crParty').value,
                commercial: el('#crCom').checked,
                password: pw,
              });
              pendingCreds = { title: `Login for ${name}`, name, loginId: r.loginId, password: pw };
            } catch (err) {
              if (err.body && err.body.suggestion) {
                const v = err.body.suggestion;
                setTimeout(() => {
                  if (el('#crLogin')) el('#crLogin').value = v;
                }, 0);
              }
              throw err;
            }
          }, 'Login created.');
        };
      }
      if (el('#invForm')) {
        comDefault(el('#invParty'), el('#invCom'));
        el('#invForm').onsubmit = e => {
          e.preventDefault();
          act(async () => {
            const r = await Api.post(`/api/v/${ctx.voyageId}/invites`, {
              email: el('#invEmail').value.trim(),
              party: el('#invParty').value,
              commercial: el('#invCom').checked,
            });
            inviteLink = r.link || '';
            if (r.added) msg('They already have a login and now have access to this voyage.', true);
          }, 'Invitation created.');
        };
      }
      if (el('#exForm')) {
        comDefault(el('#exParty'), el('#exCom'));
        el('#exForm').onsubmit = e => {
          e.preventDefault();
          act(
            () =>
              Api.post(`/api/v/${ctx.voyageId}/participants/existing`, {
                loginId: el('#exLogin').value.trim(),
                party: el('#exParty').value,
                commercial: el('#exCom').checked,
              }),
            'Added to this voyage.',
          );
        };
      }
      if (el('#invCopy'))
        el('#invCopy').onclick = () =>
          navigator.clipboard.writeText(inviteLink).then(
            () => msg('Link copied.', true),
            () => {
              const r = document.createRange();
              r.selectNode(el('#invLink'));
              getSelection().removeAllRanges();
              getSelection().addRange(r);
            },
          );
      root.querySelectorAll('[data-unp]').forEach(
        b =>
          (b.onclick = () => {
            if (!b.dataset.arm) {
              b.dataset.arm = '1';
              b.textContent = 'Confirm';
              return;
            }
            act(() => Api.del(`/api/v/${ctx.voyageId}/participants/${b.dataset.unp}`), 'Removed.');
          }),
      );
      root.querySelectorAll('[data-reset]').forEach(
        b =>
          (b.onclick = () => {
            if (!b.dataset.arm) {
              b.dataset.arm = '1';
              b.textContent = 'Confirm reset';
              return;
            }
            const pw = Api.tempPassword();
            act(async () => {
              const r = await Api.post(`/api/v/${ctx.voyageId}/participants/${b.dataset.reset}/reset`, {
                password: pw,
              });
              pendingCreds = {
                title: 'New temporary password',
                name: b.dataset.name,
                loginId: r.loginId,
                password: pw,
              };
            }, 'Password reset.');
          }),
      );
      root
        .querySelectorAll('[data-uninv]')
        .forEach(
          b =>
            (b.onclick = () =>
              act(() => Api.del(`/api/v/${ctx.voyageId}/invites/${b.dataset.uninv}`), 'Invitation cancelled.')),
        );
      root
        .querySelectorAll('[data-com]')
        .forEach(
          b =>
            (b.onchange = () =>
              act(
                () => Api.patch(`/api/v/${ctx.voyageId}/participants/${b.dataset.com}`, { commercial: b.checked }),
                'Access updated.',
              )),
        );
      if (pendingCreds) {
        Api.showCredentials(el('#peopleCreds'), pendingCreds);
        el('#peopleCreds')
          .querySelector('[data-close]')
          .addEventListener('click', () => {
            pendingCreds = null;
          });
      }
    }

    return { load, render: () => S && render(), state: () => S, stop: () => clearTimeout(polling) };
  }
  return { create };
})();
