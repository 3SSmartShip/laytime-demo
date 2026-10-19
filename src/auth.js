const jwt = require('jsonwebtoken');
const config = require('./config');
const { query } = require('./db');

const COOKIE = 'lt_session';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, tid: user.tenant_id, role: user.role }, config.jwtSecret, {
    expiresIn: `${config.sessionHours}h`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Loads the user on every request so deactivation takes effect immediately.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[COOKIE];
    if (!token) throw httpError(401, 'Please sign in.');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw httpError(401, 'Your session has expired. Please sign in again.');
    }
    const { rows } = await query(
      `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.active, u.must_change_password,
              t.name AS tenant_name, t.active AS tenant_active
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [payload.sub],
    );
    const u = rows[0];
    if (!u || !u.active) throw httpError(401, 'This account is disabled.');
    if (u.role !== 'superadmin' && !u.tenant_active) throw httpError(401, 'This organisation is disabled.');
    req.user = u;
    next();
  } catch (e) {
    next(e);
  }
}

// Mutating requests must carry a header that cross-site forms cannot send.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') return next(httpError(403, 'Request blocked.'));
  next();
}

// Works out which tenant a request acts on. Platform admins pick one with X-Tenant-Id.
async function resolveTenant(req, res, next) {
  try {
    if (req.user.role !== 'superadmin') {
      req.tenantId = req.user.tenant_id;
      return next();
    }
    const tid = req.get('X-Tenant-Id') || req.query.tenant;
    if (!tid || !/^[0-9a-f-]{36}$/i.test(tid)) throw httpError(400, 'Choose an organisation first.');
    const { rows } = await query('SELECT id FROM tenants WHERE id = $1', [tid]);
    if (!rows[0]) throw httpError(404, 'Organisation not found.');
    req.tenantId = tid;
    next();
  } catch (e) {
    next(e);
  }
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : next(httpError(403, 'You do not have permission for this.'));
}

module.exports = { setSession, clearSession, requireAuth, csrfGuard, resolveTenant, requireRole, httpError };
