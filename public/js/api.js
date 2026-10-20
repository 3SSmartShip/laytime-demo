// Small fetch wrapper: JSON, CSRF header, tenant header for platform admins, 401 → sign-in page.
window.Api = (function () {
  const TKEY = 'lt-tenant';
  let tenant = null;
  try { tenant = sessionStorage.getItem(TKEY); } catch (e) {}

  function setTenant(id) { tenant = id || null; try { id ? sessionStorage.setItem(TKEY, id) : sessionStorage.removeItem(TKEY); } catch (e) {} }
  function headers(json) {
    const h = { 'X-Requested-With': 'fetch' };
    if (json) h['Content-Type'] = 'application/json';
    if (tenant) h['X-Tenant-Id'] = tenant;
    return h;
  }
  async function call(method, path, body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 401 && !path.startsWith('/api/auth/login')) { location.href = '/login.html'; throw new Error('Signed out'); }
    const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (r.status === 403 && j && j.code === 'password_change_required' && location.hash !== '#/account') location.hash = '#/account';
    if (!r.ok) { const e = new Error((j && j.error) || r.statusText); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  async function download(path, fallbackName) {
    const r = await fetch(path, { credentials: 'same-origin', headers: headers(false) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Download failed.'); }
    const blob = await r.blob();
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // Mirrors the server's rule: 3–40 of letters, digits, dot, underscore, hyphen.
  function suggestLogin(text) {
    let b = String(text || '').toLowerCase().split('@')[0].normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30);
    return b.length < 3 ? (b ? `user${b}` : '') : b;
  }
  // Prefills a login ID field from another field until the user types in it.
  function linkLogin(loginEl, ...sources) {
    loginEl.dataset.auto = '1';
    loginEl.addEventListener('input', () => { loginEl.dataset.auto = loginEl.value ? '' : '1'; });
    sources.forEach(src => src.addEventListener('input', () => {
      if (!loginEl.dataset.auto) return;
      const from = sources.map(s => s.value.trim()).find(Boolean) || '';
      loginEl.value = suggestLogin(from);
    }));
  }
  function tempPassword() { const a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; const b = new Uint32Array(14); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); }
  // A card with the sign-in details to pass on, with a copy button.
  function showCredentials(el, { title, name, loginId, password }) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const url = `${location.origin}/login.html`;
    const text = `${name ? name + '\n' : ''}Sign in at: ${url}\nLogin ID: ${loginId}${password ? `\nPassword: ${password}\n(You will be asked to choose your own password.)` : ''}`;
    el.innerHTML = `<div class="creds"><strong>${esc(title || 'Sign-in details')}</strong>
      <dl><dt>Sign in at</dt><dd>${esc(url)}</dd><dt>Login ID</dt><dd class="cred-id">${esc(loginId)}</dd>${password ? `<dt>Password</dt><dd>${esc(password)}</dd>` : ''}</dl>
      <div class="btnrow"><button type="button" class="primary" data-copy>Copy details</button><button type="button" data-close>Done</button></div>
      <p class="hint">Share these privately. ${password ? 'The password is shown only now; they must change it at first sign-in.' : ''}</p></div>`;
    el.hidden = false;
    el.querySelector('[data-copy]').onclick = e => navigator.clipboard.writeText(text).then(() => { e.target.textContent = 'Copied'; }, () => { const r = document.createRange(); r.selectNodeContents(el.querySelector('dl')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    el.querySelector('[data-close]').onclick = () => { el.innerHTML = ''; el.hidden = true; };
  }
  // Account page: own mobile number and email, each confirmed with a one-time code.
  function contacts(el, me, onChange) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let editing = null, sent = false, note = '';
    const KIND = { mobile: { label: 'Mobile number', ph: '98765 43210', type: 'tel' }, email: { label: 'Email', ph: 'name@company.com', type: 'email' } };
    function draw() {
      el.innerHTML = Object.entries(KIND).map(([k, d]) => {
        if (editing !== k) return `<div class="contact-row"><div><div class="hint">${d.label}</div><div class="m">${esc(me[k] || 'Not added')}</div></div>
          <div class="row-actions"><button type="button" data-edit="${k}">${me[k] ? 'Change' : 'Add'}</button>${me[k] ? `<button type="button" data-rm="${k}">Remove</button>` : ''}</div></div>`;
        return `<form class="contact-row editing" data-form="${k}" novalidate><label class="f">${d.label}<input id="ct-${k}" type="${d.type}" placeholder="${d.ph}" ${sent ? 'readonly' : ''} value="${esc(editing === k && el.dataset.val || '')}"></label>
          ${sent ? `<label class="f">Code we sent<input id="ct-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code-input"></label>` : ''}
          <div class="row-actions"><button type="submit" class="primary">${sent ? 'Confirm' : 'Send code'}</button><button type="button" data-cancel>Cancel</button></div></form>`;
      }).join('') + `<div class="msg ${note.startsWith('!') ? 'bad' : 'ok'}">${esc(note.replace(/^!/, ''))}</div>`;
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = b.dataset.edit; sent = false; note = ''; el.dataset.val = ''; draw(); el.querySelector(`#ct-${editing}`).focus(); });
      el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { editing = null; sent = false; note = ''; draw(); });
      el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
        if (!b.dataset.arm) { b.dataset.arm = '1'; b.textContent = 'Confirm remove'; return; }
        try { await call('POST', '/api/auth/otp/contact/remove', { kind: b.dataset.rm }); me[b.dataset.rm] = null; note = 'Removed.'; draw(); onChange && onChange(me); } catch (e) { note = '!' + e.message; draw(); }
      });
      const f = el.querySelector('[data-form]');
      if (f) f.onsubmit = async e => {
        e.preventDefault();
        const k = f.dataset.form, value = el.querySelector(`#ct-${k}`).value.trim();
        el.dataset.val = value;
        try {
          if (!sent) { const r = await call('POST', '/api/auth/otp/contact/request', { kind: k, value }); sent = true; note = `Code sent to ${r.sentTo}.`; draw(); el.querySelector('#ct-code').focus(); }
          else { const r = await call('POST', '/api/auth/otp/contact/verify', { kind: k, value, code: el.querySelector('#ct-code').value.trim() }); me[k] = r[k]; editing = null; sent = false; note = `${KIND[k].label} confirmed.`; draw(); onChange && onChange(me); }
        } catch (err) { note = '!' + err.message; draw(); }
      };
    }
    draw();
  }
  return {
    contacts,
    suggestLogin, linkLogin, tempPassword, showCredentials,
    get: p => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p),
    download, setTenant, getTenant: () => tenant,
  };
})();
