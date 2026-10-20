(function () {
  const $ = id => document.getElementById(id);
  const msg = t => { $('loginMsg').textContent = t || ''; };
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; });
  const go = () => {
    const next = new URLSearchParams(location.search).get('next') || '';
    location.href = /^\/[A-Za-z0-9_\-./#]*$/.test(next) && !next.startsWith('//') ? next : '/';
  };
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  // ---------- password ----------
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault(); msg('');
    busy($('loginBtn'), true, 'Signing in…');
    try { await post('/api/auth/login', { login: $('email').value.trim(), password: $('password').value }); go(); }
    catch (err) { msg(err.message); }
    finally { busy($('loginBtn'), false, 'Sign in'); }
  });

  // ---------- one-time code ----------
  let stage = 'ask', timer = null;
  function setMethod(m) {
    $('loginForm').hidden = m !== 'pwd'; $('otpForm').hidden = m !== 'otp'; msg('');
    try { localStorage.setItem('lt-login-method', m); } catch (e) { /* ignore */ }
    (m === 'pwd' ? $('email') : (stage === 'code' ? $('otpCode') : $('otpLogin'))).focus();
  }
  document.querySelectorAll('input[name=method]').forEach(r => r.addEventListener('change', () => setMethod(r.value)));

  function countdown(sec) {
    clearInterval(timer);
    const b = $('otpResend'); b.disabled = true;
    let left = sec;
    const tick = () => { if (left <= 0) { clearInterval(timer); b.disabled = false; b.textContent = 'Send again'; return; } b.textContent = `Send again in ${left}s`; left--; };
    tick(); timer = setInterval(tick, 1000);
  }
  async function send() {
    msg('');
    const r = await post('/api/auth/otp/request', { login: $('otpLogin').value.trim() });
    stage = 'code';
    $('otpLogin').readOnly = true;
    $('otpCodeRow').hidden = false; $('otpMore').hidden = false; $('otpHint').hidden = true;
    $('otpSent').textContent = `If ${r.sentTo} belongs to a login, a code is on its way by ${r.channel === 'sms' ? 'text message' : 'email'}. It is valid for a few minutes.`;
    $('otpBtn').textContent = 'Sign in';
    $('otpCode').value = ''; $('otpCode').focus();
    countdown(r.resendIn || 60);
  }
  $('otpForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('otpBtn');
    try {
      if (stage === 'ask') { busy(btn, true, 'Sending…'); await send(); }
      else { busy(btn, true, 'Checking…'); await post('/api/auth/otp/verify', { login: $('otpLogin').value.trim(), code: $('otpCode').value.trim() }); go(); }
    } catch (err) { msg(err.message); if (stage === 'ask') btn.textContent = 'Send code'; else btn.textContent = 'Sign in'; }
    finally { btn.disabled = false; }
  });
  $('otpCode').addEventListener('input', e => { if (/^\d{6}$/.test(e.target.value.trim())) $('otpForm').requestSubmit(); });
  $('otpResend').onclick = () => send().catch(err => msg(err.message));
  $('otpChange').onclick = () => {
    stage = 'ask'; clearInterval(timer);
    $('otpLogin').readOnly = false; $('otpCodeRow').hidden = true; $('otpMore').hidden = true; $('otpHint').hidden = false;
    $('otpBtn').textContent = 'Send code'; msg(''); $('otpLogin').focus();
  };

  // Show the code option only when the server can send codes.
  fetch('/api/auth/otp/options').then(r => r.json()).then(o => {
    if (!o.sms && !o.email) return;
    $('methodSeg').hidden = false;
    $('otpLabel').textContent = o.sms && o.email ? 'Mobile number or email' : o.sms ? 'Mobile number' : 'Email';
    $('otpLogin').placeholder = o.sms && o.email ? '98765 43210 or name@company.com' : o.sms ? '98765 43210' : 'name@company.com';
    $('otpLogin').inputMode = o.sms && !o.email ? 'tel' : 'email';
    $('otpHint').hidden = !o.sms;
    let saved = null; try { saved = localStorage.getItem('lt-login-method'); } catch (e) { /* ignore */ }
    const m = saved === 'pwd' ? 'pwd' : 'otp';
    $(m === 'otp' ? 'mOtp' : 'mPwd').checked = true;
    setMethod(m);
  }).catch(() => {});
})();
