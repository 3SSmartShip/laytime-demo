const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { seed } = require('./seed');
const { requireAuth, csrfGuard, resolveTenant } = require('./auth');

function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/healthz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', csrfGuard);
  app.use('/api/auth/otp', require('./routes/otp'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/voyages', requireAuth, resolveTenant, require('./routes/voyages'));
  app.use('/api/admin', requireAuth, require('./routes/admin'));
  app.use('/api/invites', require('./routes/invites'));
  app.use('/api/v/:id', requireAuth, require('./routes/collab'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), { maxAge: config.isProd ? '1h' : 0 }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));

  // errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'This voyage is too large to save.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (err.code === '23505' && /login_id|email/.test(err.constraint || '')) return res.status(409).json({ error: 'That login ID or email is already in use.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. Try again.' : err.message, ...(err.extra || {}) });
  });
  return app;
}

async function start() {
  await migrate();
  await seed();
  const { recoverInterrupted } = require('./extract');
  await recoverInterrupted();
  setInterval(() => recoverInterrupted().catch(e => console.error('recover', e)), 5 * 60 * 1000).unref();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`laytime app listening on :${config.port}`));

  // Hosts (Railway, Docker) send SIGTERM on redeploy: finish open requests, then close the pool.
  const shutdown = signal => {
    console.log(`${signal} received, shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createApp };

if (require.main === module) {
  start().catch(e => { console.error(e); process.exit(1); });
}
