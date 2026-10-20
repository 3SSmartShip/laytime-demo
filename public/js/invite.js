(function () {
  const $ = id => document.getElementById(id);
  const token = location.hash.slice(1);
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; e.suggestion = j.suggestion; throw e; } return j; });
  const done = r => { location.href = `/portal.html#/voyage/${r.voyageId}`; };

  async function start() {
    try {
      const inv = await post('/api/invites/lookup', { token });
      $('invIntro').textContent = `${inv.operator} has invited you to ${inv.vessel || 'a voyage'} as ${inv.party}.`;
      if (inv.existingAccount) {
        $('invExisting').hidden = false;
        $('invExEmail').textContent = inv.existingLoginId || inv.email;
        $('invSignIn').href = `/login.html?next=${encodeURIComponent('/invite.html#' + token)}`;
        // already signed in as that person? offer to join directly
        const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (me && me.user && (me.user.email || '').toLowerCase() === inv.email.toLowerCase()) { $('invSignIn').hidden = true; $('invJoin').hidden = false; }
      } else {
        $('invForm').hidden = false;
        $('invEmail').value = inv.email;
        $('invLogin').value = inv.suggestedLoginId || '';
      }
    } catch (e) { $('invIntro').textContent = ''; $('invMsg').textContent = e.message; }
  }
  $('invJoin').onclick = () => post('/api/invites/accept', { token }).then(done).catch(e => { $('invMsg').textContent = e.message; });
  $('invForm').addEventListener('submit', e => {
    e.preventDefault();
    $('invMsg').textContent = '';
    post('/api/invites/accept', { token, loginId: $('invLogin').value.trim(), name: $('invName').value.trim(), company: $('invCompany').value.trim(), password: $('invPw').value })
      .then(done).catch(err => { $('invMsg').textContent = err.message; if (err.suggestion) $('invLogin').value = err.suggestion; });
  });
  start();
})();
