# Laytime Calculator

A multi-tenant web app that ship operators and chartering teams use to calculate **laytime, demurrage and despatch**. It produces the usual day-by-day laytime statements and exports them to Excel.

- One voyage can have several load and discharge ports.
- Ports are settled separately, or as **reversible**, with laytime pooled across ports.
- Laytime terms: SHINC, SHEX, SAFSHEX (SATPM SHEX), SSHEX, FHEX or a custom excluded window, plus port holidays.
- Not-to-count periods can be pasted straight from the Statement of Facts (SOF) or from Excel.
- Each client organisation sees only its own voyages and users.

The calculation is checked against the MV Vishva Nidhi loadport and disport statements (see [test/engine.test.js](test/engine.test.js)).

---

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Users and permissions](#users-and-permissions)
- [How the calculation works](#how-the-calculation-works)
- [API reference](#api-reference)

---

## Architecture

| Part      | Technology                                                                |
| --------- | ------------------------------------------------------------------------- |
| Server    | Node.js 24 (22+ works), Express 4                                         |
| Database  | PostgreSQL 16 (one database, rows scoped by `tenant_id`)                  |
| Frontend  | Plain HTML, CSS and JavaScript served by the same server. No build step.  |
| Auth      | Email and password (bcrypt), JWT in an `httpOnly` cookie                  |
| Hosting   | Railway (Dockerfile + Railway Postgres); docker-compose for self-hosting  |

```
Browser ──► Express (src/server.js)
              ├── /api/auth      sign in / out, change password
              ├── /api/voyages   CRUD, duplicate, Excel export   (tenant-scoped)
              ├── /api/admin     users, organisations, audit log
              ├── /shared/*      laytime engine served to the browser
              └── /*             static frontend (public/)
                     │
                     ▼
                 PostgreSQL: tenants · users · voyages (JSONB) · audit_log
```

**One engine, two places.** The laytime engine in [shared/engine.js](shared/engine.js) is plain JavaScript with no dependencies. The browser loads it to show results live while the user types. The server uses the same file to compute the stored summary and to build the Excel export, so the two can never disagree.

**Voyages are documents.** A voyage (its ports, times and SOF periods) is stored as one JSONB value. It is validated on every save by the zod schema in [src/voyageData.js](src/voyageData.js). Saves use optimistic locking: each save sends the `version` it started from, and the server returns `409` if someone else saved first.

### Project layout

```
src/
  server.js        Express app: security headers, routes, static files, error handler
  config.js        All environment variables, read in one place
  db.js            pg pool, transaction helper, audit-log writer
  migrate.js       Applies db/migrations/*.sql in order (runs on start)
  seed.js          First start: platform admin and optional demo organisation
  auth.js          Session cookie, auth / CSRF / tenant middleware
  voyageData.js    Voyage validation (zod) and server-side summary
  export.js        Excel workbook builder (exceljs)
  routes/          auth.js · voyages.js · admin.js
shared/
  engine.js        Laytime engine: time windows, SOF parser, port and voyage calculation
  statement.js     Turns engine output into statement lines (screen, copy, Excel)
  sample.js        The MV Vishva Nidhi example voyage
public/
  index.html       App shell (voyage list, editor, admin, account)
  login.html       Sign-in page
  css/app.css
  js/api.js        fetch wrapper (CSRF header, tenant header, 401 → sign-in)
  js/main.js       Session, routing, voyage list, admin and account screens
  js/editor.js     Voyage editor with live calculation and autosave
db/migrations/     SQL migrations, applied in filename order
test/              Engine tests and API tests (node:test)
railway.json       Railway build and deploy settings
```

---

## Quick start

### With Docker (recommended)

```bash
cp .env.example .env
# edit .env: set DB_PASSWORD, JWT_SECRET (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

On first start the app:

1. creates the database tables
2. creates the platform admin
3. creates a "Demo Shipping" organisation containing the Vishva Nidhi example voyage (skip this with `SEED_DEMO=false`)

```bash
docker compose logs -f app                                        # app logs
docker compose down                                               # stop (data is kept in the pgdata volume)
docker compose exec db pg_dump -U laytime laytime > backup.sql    # back up the database
```

### Without Docker

You need Node 22+ (24 recommended, see `.nvmrc`) and a PostgreSQL 16 database.

```bash
npm install
export DATABASE_URL=postgres://laytime:password@localhost:5432/laytime
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password'
npm run dev        # restarts on file changes; use `npm start` in production
```

---

## Configuration

All settings are environment variables, read in [src/config.js](src/config.js).

| Variable          | Default                                    | Notes                                                                                 |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | `postgres://laytime:laytime@localhost/...` | PostgreSQL connection string                                                          |
| `JWT_SECRET`      | dev-only value                             | **Required in production**, at least 32 characters. Changing it signs everyone out.   |
| `PORT`            | `3000`                                     | HTTP port                                                                             |
| `ADMIN_EMAIL`     |                                            | Platform admin created on first start only                                            |
| `ADMIN_PASSWORD`  |                                            | At least 10 characters                                                                |
| `SEED_DEMO`       | `true`                                     | Create the demo organisation on first start                                           |
| `COOKIE_SECURE`   | `true` in production                       | Set `true` whenever the app is served over HTTPS                                      |
| `TRUST_PROXY`     | `1` in production                          | Number of proxy hops in front of the app (for client IPs and the sign-in rate limit) |
| `SESSION_HOURS`   | `12`                                       | Sign-in lifetime                                                                      |
| `NODE_ENV`        |                                            | `production` turns on secure defaults and static-file caching                         |

`DB_PASSWORD` and `APP_PORT` are used only by `docker-compose.yml`. Never commit `.env`.

---

## Development

| Command                | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | Start the server and restart on changes         |
| `npm test`             | Run the tests                                   |
| `npm run lint`         | ESLint                                          |
| `npm run format`       | Format everything with Prettier                 |
| `npm run check`        | Format check + lint + tests (run before pushing) |
| `npm run migrate`      | Apply migrations without starting the server    |

**Database changes.** Add a new file in `db/migrations/`, for example `002_add_voyage_notes.sql`. Never edit a migration that has already run. Migrations apply in filename order inside a transaction, and a Postgres advisory lock makes them safe when several app instances start at once.

**Changing the calculation.** Put calculation logic in `shared/engine.js` and statement layout in `shared/statement.js`. Keep both free of DOM and Node-only APIs, because they run in both places. Add a test to `test/engine.test.js` for any rule change.

**Frontend.** There is no bundler. Scripts are loaded in order by `public/index.html` and share a few globals: `Engine`, `Statement`, `Api`, `Editor`. The Content Security Policy only allows scripts from the app's own origin, so don't add inline scripts or CDN script tags.

---

## Testing

```bash
npm test                                                                   # engine tests only
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/laytime_test npm test   # adds API tests
```

The API tests **drop and recreate the schema** in `TEST_DATABASE_URL`, so point them at an empty, throwaway database. A quick one with Docker:

```bash
docker run --rm -d --name laytime-test-db -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
docker stop laytime-test-db
```

The API tests cover sign-in, CSRF protection, tenant isolation (one organisation cannot read or change another's voyages), versioned saves, validation, Excel export and user-management rules.

---

## Deployment

The app is **one long-running Node process plus a PostgreSQL database**. Production runs on Railway. Any other host that runs a Docker container works too.

### Checklist for going live

1. **Serve it over HTTPS** and set `COOKIE_SECURE=true`. Behind a proxy or load balancer, set `TRUST_PROXY` to the number of hops.
2. **Use strong secrets.** `JWT_SECRET` should be 32+ random characters (`openssl rand -hex 32`).
3. **Back up the database** on a schedule (managed snapshots, or `pg_dump`).
4. **After first sign-in:** change the platform admin password (Account), then create client organisations under Admin.
5. The health check is `GET /healthz`. It returns `200` when the database is reachable.

### Railway (production)

The app runs on [Railway](https://railway.com): one service built from the `Dockerfile`, plus a Railway PostgreSQL database. [railway.json](railway.json) tells Railway to build with the Dockerfile, wait for `/healthz` before switching traffic to a new deploy, and restart the app if it crashes.

**First-time setup**

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, and pick the repo.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the app service → **Variables** and add:

   | Variable         | Value                                                               |
   | ---------------- | ------------------------------------------------------------------- |
   | `DATABASE_URL`   | `${{Postgres.DATABASE_URL}}` (a reference to the database service)  |
   | `JWT_SECRET`     | output of `openssl rand -hex 32`                                    |
   | `ADMIN_EMAIL`    | the platform admin's email                                          |
   | `ADMIN_PASSWORD` | a long temporary password (10+ characters)                          |
   | `SEED_DEMO`      | `false` for production, `true` for a demo environment               |

   You don't need to set `PORT`, `NODE_ENV`, `COOKIE_SECURE` or `TRUST_PROXY`. Railway sets `PORT`, the Dockerfile sets `NODE_ENV=production`, and the production defaults are right for Railway's HTTPS proxy.

5. App service → **Settings → Networking → Generate Domain**, or add your own domain.
6. Optionally, set **Settings → Region** close to your users.

On the first deploy the app creates the tables and the platform admin. Sign in, change the admin password under Account, and then remove `ADMIN_PASSWORD` from the variables.

**After that**, every push to the connected branch (normally `main`) deploys automatically. Migrations run on start, and the new version only takes traffic once `/healthz` passes, so a failed migration leaves the old version running.

**Backups.** Turn on backups for the Postgres service (its **Backups** tab), or run a scheduled `pg_dump` against the database's public connection URL.

### Self-hosted (any Linux server)

`docker compose up -d --build` on any Linux server, with Caddy in front for HTTPS:

```
laytime.yourdomain.com {
  reverse_proxy localhost:3000
}
```

---

## Users and permissions

| Role           | Belongs to                         | Can                                                                                                  |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Platform admin | No organisation (the 3S team)      | Create and disable organisations; pick any organisation from the top bar to work on its voyages and users; see its activity |
| Admin          | One organisation (a client)        | Create, edit and delete that organisation's voyages; add and disable its users; reset passwords     |
| Member         | One organisation                   | Create and edit voyages; delete only voyages they created                                            |

Every voyage query is filtered on the server by the signed-in user's organisation. A client user cannot reach another organisation's data, even by changing request headers. Platform admins choose an organisation with the `X-Tenant-Id` header, which the UI sets from the picker in the top bar.

New users get a temporary password and are asked to change it. Every sign-in, voyage change and user change is written to `audit_log`.

---

## How the calculation works

- **Time starts counting** at "Time to count from" if it is filled in. Otherwise it starts at NOR tendered plus the turn time.
- **Laytime allowed** is quantity ÷ daily rate × 24 hours, or a fixed number of hours.
- **Excluded windows** (e.g. SAFSHEX = Saturday 12:00 to Monday 08:00) and holidays don't count, even if used (EIU).
- **Not-to-count periods** stop the clock. A period marked half time counts at 50%.
- **Laytime expiry:** once laytime runs out the vessel is on demurrage. With "Once on demurrage, always on demurrage" (ODAD) ticked, only periods marked "Stops demurrage" interrupt it. Untick it if the charter party lets other delays count off demurrage too.
- **Despatch** is paid on laytime saved (allowed minus used) at the despatch rate. "HD" sets it to half the demurrage rate.
- **Amounts** are pro rata: days (to 4 decimals) × the daily rate.
- **Reversible:** laytime allowed at all ports is pooled. Ports are counted in tab order, so demurrage can start at a later port. Despatch is settled at the last port.

All times are port-local wall-clock times. They are stored as UTC timestamps purely as a container, so an entry of 06:00 always shows as 06:00, whatever the user's time zone.

---

## API reference

All endpoints are JSON and need the session cookie. Write requests (POST, PUT, PATCH, DELETE) must send `X-Requested-With: fetch`. Platform admins also send `X-Tenant-Id` to pick an organisation.

| Method         | Path                         | Purpose                                                    |
| -------------- | ---------------------------- | ---------------------------------------------------------- |
| POST           | /api/auth/login              | Sign in `{email, password}`                                |
| POST           | /api/auth/logout             | Sign out                                                   |
| GET            | /api/auth/me                 | Current user                                               |
| POST           | /api/auth/password           | Change own password `{current, next}`                      |
| GET            | /api/voyages?q=              | List voyages (search by vessel, charterers or port)        |
| POST           | /api/voyages                 | Create; `{sample:true}` loads the example                  |
| GET            | /api/voyages/:id             | Read                                                       |
| PUT            | /api/voyages/:id             | Save `{data, version, status?}`; `409` if someone saved first |
| POST           | /api/voyages/:id/duplicate   | Copy                                                       |
| DELETE         | /api/voyages/:id             | Delete                                                     |
| GET            | /api/voyages/:id/export.xlsx | Excel workbook                                             |
| GET/POST/PATCH | /api/admin/users             | Manage users                                               |
| GET/POST/PATCH | /api/admin/tenants           | Manage organisations (platform admin)                      |
| GET            | /api/admin/audit             | Recent activity                                            |
| GET            | /healthz                     | Health check (no auth)                                     |
