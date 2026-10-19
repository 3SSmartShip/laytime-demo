// App shell: session, organisation picker, routing, voyage list, admin and account screens.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s =>
    String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const money = (v, c) =>
    `${c || 'USD'} ${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const when = s =>
    s
      ? new Date(s).toLocaleString([], {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '–';
  let me = null,
    tenants = [];

  function show(view) {
    ['viewList', 'viewEditor', 'viewAdmin', 'viewAccount'].forEach(v => ($(v).hidden = v !== view));
    $('navVoyages').classList.toggle('on', view === 'viewList' || view === 'viewEditor');
    $('navAdmin').classList.toggle('on', view === 'viewAdmin');
    $('navAccount').classList.toggle('on', view === 'viewAccount');
  }
  function msg(el, text, ok) {
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'ok' : 'bad');
  }
  function arm(btn, label, fn) {
    if (!btn.dataset.arm) {
      btn.dataset.arm = '1';
      const old = btn.textContent;
      btn.textContent = label;
      setTimeout(() => {
        if (btn.dataset.arm) {
          delete btn.dataset.arm;
          btn.textContent = old;
        }
      }, 3000);
      return;
    }
    delete btn.dataset.arm;
    fn();
  }

  // ---------- session ----------
  async function boot() {
    try {
      ({ user: me } = await Api.get('/api/auth/me'));
    } catch (e) {
      return;
    }
    $('who').textContent = me.name || me.email;
    $('pwBanner').hidden = !me.mustChangePassword;
    $('navAdmin').hidden = !(me.role === 'admin' || me.role === 'superadmin');
    if (me.role === 'superadmin') {
      const r = await Api.get('/api/admin/tenants');
      tenants = r.tenants;
      const pick = $('tenantPick');
      pick.hidden = false;
      pick.innerHTML =
        '<option value="">Choose organisation…</option>' +
        tenants.map(t => `<option value="${t.id}">${esc(t.name)}${t.active ? '' : ' (disabled)'}</option>`).join('');
      if (Api.getTenant() && tenants.some(t => t.id === Api.getTenant())) pick.value = Api.getTenant();
      else Api.setTenant(null);
      $('orgName').textContent = 'Platform admin';
    } else {
      $('orgName').textContent = me.tenantName || '';
      Api.setTenant(null);
    }
    route();
  }
  $('tenantPick').addEventListener('change', async e => {
    if (Editor.isDirty()) await Editor.flush();
    Api.setTenant(e.target.value);
    location.hash = '#/voyages';
    route();
  });
  $('btnLogout').onclick = async () => {
    try {
      await Editor.flush();
    } catch (e) {}
    await Api.post('/api/auth/logout');
    location.href = '/login.html';
  };

  // ---------- routing ----------
  window.addEventListener('hashchange', route);
  async function route() {
    const h = location.hash || '#/voyages';
    if (h.startsWith('#/voyage/')) return openVoyage(h.slice(9));
    if (h === '#/admin') return showAdmin();
    if (h === '#/account') return show('viewAccount');
    return showList();
  }
  const needTenant = () => me.role === 'superadmin' && !Api.getTenant();

  // ---------- list ----------
  let searchTimer = null;
  $('listSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadList, 250);
  });
  async function showList() {
    show('viewList');
    loadList();
  }
  async function loadList() {
    const T = $('listTable');
    $('listMsg').textContent = '';
    if (needTenant()) {
      T.innerHTML =
        '<tbody><tr><td class="empty">Choose an organisation at the top to see its voyages.</td></tr></tbody>';
      return;
    }
    try {
      const q = $('listSearch').value.trim();
      const { voyages } = await Api.get('/api/voyages' + (q ? `?q=${encodeURIComponent(q)}` : ''));
      if (!voyages.length) {
        T.innerHTML = `<tbody><tr><td class="empty">${q ? 'No voyages match that search.' : 'No voyages yet. Start one with "New voyage", or load the example to see how it works.'}</td></tr></tbody>`;
        return;
      }
      T.innerHTML =
        `<thead><tr><th>Vessel</th><th>Charterers</th><th>Ports</th><th>Status</th><th class="r">Result</th><th>Last saved</th><th></th></tr></thead><tbody>` +
        voyages
          .map(v => {
            const s = v.summary || {},
              ports = (s.ports || []).map(p => esc(p.name || '?')).join(' → ');
            const res = !s.complete
              ? '<span class="warn">Incomplete</span>'
              : s.net > 0.005
                ? `<span class="pill pd">DEM</span> ${money(s.net, s.currency)}`
                : s.net < -0.005
                  ? `<span class="pill pok">DES</span> ${money(s.net, s.currency)}`
                  : '–';
            return `<tr data-id="${v.id}"><td><strong>${esc(v.vessel || 'Untitled voyage')}</strong></td><td>${esc(v.charterers || '–')}</td><td>${ports || '–'}</td><td><span class="status ${v.status}">${v.status}</span></td><td class="m r">${res}</td><td class="hint">${when(v.updatedAt)}${v.updatedBy ? ' · ' + esc(v.updatedBy) : ''}</td>
        <td><div class="row-actions"><button type="button" data-dup="${v.id}">Duplicate</button><button type="button" data-del="${v.id}">Delete</button></div></td></tr>`;
          })
          .join('') +
        '</tbody>';
      T.querySelectorAll('tr[data-id]').forEach(
        tr =>
          (tr.onclick = e => {
            if (e.target.closest('button')) return;
            location.hash = '#/voyage/' + tr.dataset.id;
          }),
      );
      T.querySelectorAll('[data-dup]').forEach(
        b =>
          (b.onclick = async () => {
            try {
              const { voyage } = await Api.post(`/api/voyages/${b.dataset.dup}/duplicate`);
              location.hash = '#/voyage/' + voyage.id;
            } catch (e) {
              $('listMsg').textContent = e.message;
            }
          }),
      );
      T.querySelectorAll('[data-del]').forEach(
        b =>
          (b.onclick = () =>
            arm(b, 'Confirm delete', async () => {
              try {
                await Api.del(`/api/voyages/${b.dataset.del}`);
                loadList();
              } catch (e) {
                $('listMsg').textContent = e.message;
                b.textContent = 'Delete';
              }
            })),
      );
    } catch (e) {
      $('listMsg').textContent = e.message;
    }
  }
  async function newVoyage(sample) {
    if (needTenant()) {
      $('listMsg').textContent = 'Choose an organisation first.';
      return;
    }
    try {
      const { voyage } = await Api.post('/api/voyages', sample ? { sample: true } : {});
      location.hash = '#/voyage/' + voyage.id;
    } catch (e) {
      $('listMsg').textContent = e.message;
    }
  }
  $('btnNewVoyage').onclick = () => newVoyage(false);
  $('btnNewSample').onclick = () => newVoyage(true);

  // ---------- editor ----------
  async function openVoyage(id) {
    if (needTenant()) {
      location.hash = '#/voyages';
      return;
    }
    try {
      const { voyage } = await Api.get('/api/voyages/' + encodeURIComponent(id));
      show('viewEditor');
      Editor.open(voyage);
      window.scrollTo(0, 0);
    } catch (e) {
      location.hash = '#/voyages';
      setTimeout(() => {
        $('listMsg').textContent = e.message;
      }, 50);
    }
  }

  // ---------- admin ----------
  async function showAdmin() {
    if (!(me.role === 'admin' || me.role === 'superadmin')) {
      location.hash = '#/voyages';
      return;
    }
    show('viewAdmin');
    $('tenantsPanel').hidden = me.role !== 'superadmin';
    if (me.role === 'superadmin') loadTenants();
    loadUsers();
    loadAudit();
  }
  async function loadTenants() {
    const { tenants: t } = await Api.get('/api/admin/tenants');
    tenants = t;
    $('tenantTable').innerHTML =
      `<thead><tr><th>Organisation</th><th class="r">Users</th><th class="r">Voyages</th><th>Status</th><th></th></tr></thead><tbody>` +
      t
        .map(
          x => `<tr><td>${esc(x.name)}</td><td class="m r">${x.users}</td><td class="m r">${x.voyages}</td><td><span class="status ${x.active ? 'final' : 'draft'}">${x.active ? 'active' : 'disabled'}</span></td>
    <td><div class="row-actions"><button type="button" data-open="${x.id}">Open</button><button type="button" data-tog="${x.id}" data-on="${x.active}">${x.active ? 'Disable' : 'Enable'}</button></div></td></tr>`,
        )
        .join('') +
      '</tbody>';
    $('tenantTable')
      .querySelectorAll('[data-open]')
      .forEach(
        b =>
          (b.onclick = () => {
            Api.setTenant(b.dataset.open);
            $('tenantPick').value = b.dataset.open;
            loadUsers();
            loadAudit();
          }),
      );
    $('tenantTable')
      .querySelectorAll('[data-tog]')
      .forEach(
        b =>
          (b.onclick = () =>
            arm(b, 'Confirm', async () => {
              await Api.patch(`/api/admin/tenants/${b.dataset.tog}`, { active: b.dataset.on !== 'true' });
              loadTenants();
            })),
      );
    const pick = $('tenantPick'),
      cur = pick.value;
    pick.innerHTML =
      '<option value="">Choose organisation…</option>' +
      t.map(x => `<option value="${x.id}">${esc(x.name)}${x.active ? '' : ' (disabled)'}</option>`).join('');
    pick.value = cur;
  }
  $('tenantForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('tenantMsg');
    try {
      const { tenant } = await Api.post('/api/admin/tenants', {
        name: $('tnName').value.trim(),
        adminName: $('tnAdminName').value.trim(),
        adminEmail: $('tnAdminEmail').value.trim(),
        adminPassword: $('tnAdminPw').value,
      });
      msg(
        m,
        `Created ${tenant.name}. Share the temporary password with its admin; they will be asked to change it.`,
        true,
      );
      e.target.reset();
      loadTenants();
    } catch (err) {
      msg(m, err.message);
    }
  });
  async function loadUsers() {
    const T = $('userTable');
    if (needTenant()) {
      T.innerHTML =
        '<tbody><tr><td class="empty">Choose or open an organisation to manage its users.</td></tr></tbody>';
      $('usersFor').textContent = '';
      $('userForm').hidden = true;
      return;
    }
    $('userForm').hidden = false;
    $('usersFor').textContent =
      me.role === 'superadmin' ? (tenants.find(t => t.id === Api.getTenant()) || {}).name || '' : me.tenantName || '';
    try {
      const { users } = await Api.get('/api/admin/users');
      T.innerHTML =
        `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>` +
        users
          .map(
            u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><select data-role="${u.id}"${u.id === me.id ? ' disabled' : ''}><option value="member"${u.role === 'member' ? ' selected' : ''}>Member</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select></td>
      <td><span class="status ${u.active ? 'final' : 'draft'}">${u.active ? 'active' : 'disabled'}</span>${u.mustChangePassword ? ' <span class="hint">temp password</span>' : ''}</td><td class="hint">${when(u.lastLoginAt)}</td>
      <td><div class="row-actions"><button type="button" data-reset="${u.id}">Reset password</button>${u.id === me.id ? '' : `<button type="button" data-act="${u.id}" data-on="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`}</div></td></tr>`,
          )
          .join('') +
        '</tbody>';
      T.querySelectorAll('[data-role]').forEach(
        s =>
          (s.onchange = async () => {
            try {
              await Api.patch(`/api/admin/users/${s.dataset.role}`, { role: s.value });
              msg($('userMsg'), 'Role updated.', true);
            } catch (e) {
              msg($('userMsg'), e.message);
              loadUsers();
            }
          }),
      );
      T.querySelectorAll('[data-act]').forEach(
        b =>
          (b.onclick = () =>
            arm(b, 'Confirm', async () => {
              try {
                await Api.patch(`/api/admin/users/${b.dataset.act}`, { active: b.dataset.on !== 'true' });
                loadUsers();
              } catch (e) {
                msg($('userMsg'), e.message);
                loadUsers();
              }
            })),
      );
      T.querySelectorAll('[data-reset]').forEach(
        b =>
          (b.onclick = () =>
            arm(b, 'Confirm reset', async () => {
              const pw = tempPassword();
              try {
                await Api.patch(`/api/admin/users/${b.dataset.reset}`, { password: pw });
                msg(
                  $('userMsg'),
                  `Temporary password: ${pw}  (share it securely; they will be asked to change it)`,
                  true,
                );
                loadUsers();
              } catch (e) {
                msg($('userMsg'), e.message);
              }
            })),
      );
    } catch (e) {
      T.innerHTML = `<tbody><tr><td class="empty">${esc(e.message)}</td></tr></tbody>`;
    }
  }
  function tempPassword() {
    const a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const b = new Uint32Array(14);
    crypto.getRandomValues(b);
    return [...b].map(x => a[x % a.length]).join('');
  }
  $('uPw').value = tempPassword();
  $('tnAdminPw').value = tempPassword();
  $('userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('userMsg');
    try {
      await Api.post('/api/admin/users', {
        name: $('uName').value.trim(),
        email: $('uEmail').value.trim(),
        role: $('uRole').value,
        password: $('uPw').value,
      });
      msg(m, `Added ${$('uEmail').value.trim()}. Temporary password: ${$('uPw').value}`, true);
      e.target.reset();
      $('uPw').value = tempPassword();
      loadUsers();
      loadAudit();
    } catch (err) {
      msg(m, err.message);
    }
  });
  async function loadAudit() {
    const T = $('auditTable');
    if (needTenant()) {
      T.innerHTML = '';
      return;
    }
    try {
      const { entries } = await Api.get('/api/admin/audit');
      const label = {
        login: 'Signed in',
        voyage_created: 'Created voyage',
        voyage_deleted: 'Deleted voyage',
        voyage_final: 'Marked voyage final',
        voyage_draft: 'Moved voyage to draft',
        user_created: 'Added user',
        user_updated: 'Changed user',
        password_changed: 'Changed own password',
        tenant_created: 'Organisation created',
        tenant_updated: 'Organisation changed',
      };
      T.innerHTML = entries.length
        ? `<thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>` +
          entries
            .map(
              a =>
                `<tr><td class="hint">${when(a.at)}</td><td>${esc(a.user_name || a.user_email || '–')}</td><td>${esc(label[a.action] || a.action)}${a.vessel ? ' · ' + esc(a.vessel) : a.detail && a.detail.vessel ? ' · ' + esc(a.detail.vessel) : a.detail && a.detail.email ? ' · ' + esc(a.detail.email) : ''}</td></tr>`,
            )
            .join('') +
          '</tbody>'
        : '<tbody><tr><td class="empty">No activity yet.</td></tr></tbody>';
    } catch (e) {
      T.innerHTML = '';
    }
  }

  // ---------- account ----------
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('pwMsg');
    try {
      await Api.post('/api/auth/password', { current: $('pwCur').value, next: $('pwNew').value });
      msg(m, 'Password changed.', true);
      e.target.reset();
      $('pwBanner').hidden = true;
    } catch (err) {
      msg(m, err.message);
    }
  });

  boot();
})();
