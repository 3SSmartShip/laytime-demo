// Small fetch wrapper: JSON, CSRF header, tenant header for platform admins, 401 → sign-in page.
window.Api = (function () {
  const TKEY = 'lt-tenant';
  let tenant = null;
  try {
    tenant = sessionStorage.getItem(TKEY);
  } catch (e) {}

  function setTenant(id) {
    tenant = id || null;
    try {
      id ? sessionStorage.setItem(TKEY, id) : sessionStorage.removeItem(TKEY);
    } catch (e) {}
  }
  function headers(json) {
    const h = { 'X-Requested-With': 'fetch' };
    if (json) h['Content-Type'] = 'application/json';
    if (tenant) h['X-Tenant-Id'] = tenant;
    return h;
  }
  async function call(method, path, body) {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !path.startsWith('/api/auth/login')) {
      location.href = '/login.html';
      throw new Error('Signed out');
    }
    const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok) {
      const e = new Error((j && j.error) || r.statusText);
      e.status = r.status;
      e.body = j;
      throw e;
    }
    return j;
  }
  async function download(path, fallbackName) {
    const r = await fetch(path, { credentials: 'same-origin', headers: headers(false) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'Download failed.');
    }
    const blob = await r.blob();
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  return {
    get: p => call('GET', p),
    post: (p, b) => call('POST', p, b || {}),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: p => call('DELETE', p),
    download,
    setTenant,
    getTenant: () => tenant,
  };
})();
