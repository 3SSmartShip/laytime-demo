const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://laytime:laytime@localhost:5432/laytime',
  jwtSecret: process.env.JWT_SECRET || (isProd ? '' : 'dev-only-secret-change-me'),
  sessionHours: parseInt(process.env.SESSION_HOURS || '12', 10),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : ''),
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  seedDemo: process.env.SEED_DEMO !== 'false',
};

if (isProd && (!config.jwtSecret || config.jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}

module.exports = config;
