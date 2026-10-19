document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginMsg'),
    btn = document.getElementById('loginBtn');
  msg.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Sign-in failed.');
    location.href = '/';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
