# Laytime Calculator

A multi-tenant web app for laytime, demurrage and despatch:

- one voyage with several ports
- each port settled separately, or reversible across ports
- SHINC / SHEX / SAFSHEX / SSHEX / FHEX or a custom excluded window, plus port holidays
- a live statement of facts shared with agents, masters, stevedores, terminals, surveyors, owners and charterers, who record, confirm and dispute events
- AI reading of SOFs and charter parties through Luma, with a built-in reader for Excel and CSV
- not-to-count periods pasted straight from the SOF or from Excel
- statements in the familiar day-by-day layout, exported to Excel

The calculation has been checked against the MV Vishva Nidhi loadport and disport statements (see `test/engine.test.js`).

## Stack

| Part | What |
|---|---|
| Server | Node.js 24 (22+ works), Express |
| Database | PostgreSQL 16+ |
| Frontend | Plain HTML/CSS/JS served by the same server; no build step |
| Hosting | Railway (Dockerfile + Railway Postgres, see [Deploying on Railway](#deploying-on-railway)); docker-compose for self-hosting |

The laytime engine is in `shared/engine.js` and runs in both the browser (live results while typing) and the server (stored summaries and Excel export).

## Run it with Docker (recommended)

```bash
cp .env.example .env
# edit .env: set DB_PASSWORD, JWT_SECRET (openssl rand -hex 32), ADMIN_LOGIN, ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000 and sign in with `ADMIN_LOGIN` / `ADMIN_PASSWORD`.

On first start the app:
1. creates the database tables
2. creates the platform admin
3. creates a "Demo Shipping" organisation with the Vishva Nidhi example voyage, unless `SEED_DEMO=false`

Useful commands:

```bash
docker compose logs -f app      # app logs
docker compose down             # stop (data is kept in the pgdata volume)
docker compose exec db pg_dump -U laytime laytime > backup.sql   # backup
```

## Run it without Docker

You need Node 22+ (24 recommended, see `.nvmrc`) and a PostgreSQL database.

```bash
npm install
export DATABASE_URL=postgres://laytime:password@localhost:5432/laytime
export ADMIN_LOGIN=platform.admin ADMIN_PASSWORD='a-long-password'
npm run dev        # restarts on file changes; `npm start` in production
```

## Who can do what

| Role | Belongs to | Can |
|---|---|---|
| Platform admin | No organisation (your 3S team) | Create and disable organisations; pick any organisation from the top bar to work on its voyages and users; see its activity |
| Admin | One organisation (a client) | Create, edit and delete that organisation's voyages; add and disable its users; reset passwords |
| Member | One organisation | Create and edit voyages; delete only voyages they created |

Every voyage query is filtered by the signed-in user's organisation on the server. A client user cannot reach another organisation's data, even by changing request headers. This is covered by `test/api.test.js`.

### Login IDs and passwords

- **One login per person.** Everyone has a unique login ID and a password. Login IDs are 3–40 characters (letters, digits, dot, underscore, hyphen) and not case-sensitive, so `Capt.Singh` and `capt.singh` are the same login. Email is optional; people can sign in with either their login ID or their email.
- **Creating logins.** An admin adds people with a login ID, which is suggested from their name and can be edited, and a generated temporary password. If the login ID is taken, the app proposes the next free one (`capt.singh-2`). The sign-in details appear in a card with a copy button.
- **First sign-in.** A temporary password works only for choosing a new one. Every other request is refused until the person sets their own password.
- **Stakeholders** (agent, master, stevedore and so on) get a login in one of three ways, from *Stakeholders on this voyage*:
  - **Create a login.** For people without their own email, such as a ship's master. You pass the login ID and password on yourself.
  - **Invite by email.** They choose their own login ID and password from the link.
  - **Existing login ID.** Adds someone who already works with you on another voyage. They keep their password.
- **Password resets.** Organisation admins reset their own users. An operator can reset a stakeholder's password only if their organisation created that login **and** the login is not also used on another organisation's voyages; otherwise the creator could sign in as that person and read the other organisation's data. Stakeholders can always change their own password under Account, or sign in with a code.
- **Sessions.** Changing or resetting a password signs that person out everywhere else. Ten failed sign-ins for one login ID lock it for 15 minutes, on top of the per-IP limit.
- **Upgrading.** Existing users get a login ID built from their email (e.g. `ravi@agency.com` → `ravi`, then `ravi-2` if taken). Check theirs under Admin → Users.

## Deploying on Railway

Production runs on [Railway](https://railway.com): one service built from the `Dockerfile` plus a Railway PostgreSQL database. [railway.json](railway.json) tells Railway to build with the Dockerfile, switch traffic only once `/healthz` passes (so a failed migration leaves the old version running), and restart the app if it crashes.

**First-time setup**

1. In Railway: **New Project → Deploy from GitHub repo** → `3SSmartShip/laytime-demo`.
2. In the project: **+ New → Database → PostgreSQL**.
3. App service → **Variables**. The minimum:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `JWT_SECRET` | `openssl rand -hex 32` |
   | `ADMIN_LOGIN` | the platform admin's login ID (3–40 letters, digits, `.`, `_`, `-`); don't keep the default `admin` |
   | `ADMIN_PASSWORD` | a long temporary password, removed after first sign-in |
   | `APP_URL` | `https://<your domain>`, used in invite links |
   | `SEED_DEMO` | `false` in production |

   Add the SMS/email settings to turn on code sign-in, and the Luma settings for AI reading of PDFs ([.env.example](.env.example) lists every variable). Leave `PORT`, `NODE_ENV`, `COOKIE_SECURE` and `TRUST_PROXY` unset: Railway sets `PORT`, the Dockerfile sets `NODE_ENV=production`, and the production defaults (secure cookies, one trusted proxy hop) are right for Railway.
4. App service → **Settings → Networking → Generate Domain** (or add your own), and pick a **Region** near your users.
5. Sign in, change the admin password under Account, then delete `ADMIN_PASSWORD` from the variables. Create client organisations under Admin.

Every push to `main` then deploys automatically. Migrations run on start.

**Before going live, check:**

- Backups are on for the Postgres service (its **Backups** tab), or a scheduled `pg_dump` runs against it.
- If Luma is on, clients know their uploaded documents are sent to Luma for reading.
- `JWT_SECRET` is also the key for one-time codes. Changing it signs everyone out and voids codes in flight.
- `.env.example` has `COOKIE_SECURE=false` for local use. Don't copy that to Railway.

### Self-hosting

`docker compose up -d --build` on any Linux server, with HTTPS in front (Caddy shown) and `COOKIE_SECURE=true`:

```
laytime.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Back up the `pgdata` volume or run `pg_dump` on a schedule.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Server with restart on changes |
| `npm test` | Tests (engine only, unless `TEST_DATABASE_URL` is set) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run check` | Format check + lint + tests; run before pushing |

Make changes on top of the latest `main` from GitHub, so formatting and fixes are not lost.

## Tests

```bash
npm test                                            # engine tests only
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/laytime_test npm test   # adds API tests
```

The API tests drop and recreate the schema in `TEST_DATABASE_URL`, so point them at an empty database you don't need. A throwaway one with Docker:

```bash
docker run --rm -d --name laytime-test-db -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
docker stop laytime-test-db
```

Use a real Postgres. In-browser/WASM Postgres builds (PGlite) mix up statements from parallel connections and make the tests fail at random.

## Signing in with a one-time code

People can sign in with a 6-digit code sent to their **mobile number** (SMS) or **email**, as well as with their login ID and password. The sign-in page shows the code option only when at least one channel is set up.

- **Mobile numbers** are stored in international format. A 10-digit number without a country code is taken as Indian (`DEFAULT_COUNTRY_CODE=91`), so `98765 43210` becomes `+919876543210`. Each mobile number and email can belong to only one login.
- **How mobile and email get on a login:**
  - Admins enter them when adding users (or later with *Edit contact*), and operators when creating stakeholder logins.
  - People can add or change their own under *Account*. That change is confirmed with a code sent to the new number or address.
- **Rules for codes:** a code is valid for 5 minutes (`OTP_TTL_MINUTES`) and works once. Only the newest code counts. Five wrong tries cancel it. A new code can be sent after 60 seconds, at most 5 an hour per person, with extra limits per IP address. The code is sent after the reply, so the answer and its timing are the same whether or not an account exists, and nobody can find out who has a login. A failed send is logged on the server.
- **Temporary passwords:** a code proves who someone is. So a person who signs in with a code is not forced to replace a temporary password, and can set a password without knowing the old one.

### Setting up SMS and email

In `.env`:

| Setting | Options |
|---|---|
| `OTP_SMS_PROVIDER` | `msg91`, `twilio`, `webhook`, `none` |
| `OTP_EMAIL_PROVIDER` | `smtp`, `webhook`, `none` |

- **MSG91** (India): needs a DLT-registered sender and an OTP template with one variable for the code; set `MSG91_TEMPLATE_ID` and, if your variable is not called `otp`, `MSG91_CODE_VAR`. Check the request in `src/notify.js` against your MSG91 account's Flow API settings before going live.
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`).
- **webhook**: for any other gateway (Fast2SMS, Gupshup, your own). The app POSTs `{"to", "code", "message", "purpose"}` as JSON to `SMS_WEBHOOK_URL` / `EMAIL_WEBHOOK_URL`, with `Authorization: Bearer <token>` if a token is set.
- **SMTP**: any mail server (Google Workspace, Zoho, Amazon SES). Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
- **console**: for local testing only. Codes are printed in the server log; production refuses this setting.

All sending code is in `src/notify.js`.

## Roles and modules

The platform admin decides what each role can see and do, under **Admin → Roles and modules**. Roles are Admin and Member for an organisation's own users, plus each stakeholder role (Owners, Charterers, Broker, Port agent, Master, Stevedore, Terminal, Surveyor).

| Module | What it covers |
|---|---|
| Statement of facts | See SOF events and port times |
| Record SOF events | Add, change and remove events (stakeholders still only the event types their role allows) |
| Confirm and dispute events | Reviewing other people's events |
| Documents and AI reading | Uploading SOFs and charter parties |
| Rates and amounts | The laytime calculation, rates, demurrage and despatch |
| Live forecast | Laytime expiry and expected result while working |
| Excel export | Downloading the statement |
| Edit voyages and CP terms | Creating, changing, deleting voyages (organisation roles only) |
| Manage stakeholders | Inviting people and creating their logins (organisation roles only) |
| Manage users | Organisation admins only |
| Activity log | Organisation roles only |

- **Two levels.** *Default for all organisations* applies everywhere. Choosing one organisation overrides the default for that organisation only; overridden cells are highlighted, and *Reset this organisation to the defaults* clears them.
- **Dependencies are applied for you.** Recording, reviewing and documents need *Statement of facts*. Excel export and editing need *Rates and amounts*. A cell switched on but blocked by a missing dependency says so.
- **Enforced on the server.** Every API call is checked, and data a role cannot see (rates, amounts, results) is not sent at all. Changes take effect on the next request, also for people already signed in.
- **Organisation users without *Rates and amounts*** open voyages in the statement-of-facts view, not the calculator.
- **Stakeholders** need both *Rates and amounts* for their role and "can see amounts" on the voyage.
- **Platform admins** always have every module.

The defaults match how the app worked before. Stakeholder owners, charterers and brokers don't record events by default; everything else is on.

## Live statement of facts (eSOF)

Every port has a shared statement of facts. Each person records what they saw, and the others confirm or dispute it.

**Inviting stakeholders.** Open a voyage, go to *Stakeholders on this voyage*, enter an email and pick a role. You get a single-use link, valid for 14 days. Send it however you like; the app does not send email. The person sets their name and password and lands on the voyage in the stakeholder portal (`/portal.html`).

| Role | Can record | Sees rates and amounts |
|---|---|---|
| Port agent, Master | Every milestone and stoppage | Only if you tick it |
| Stevedore | Commenced/completed, ETC, weather, hatch shifting, gear and shore equipment breakdowns, cargo and labour delays, strikes | Only if ticked |
| Terminal | Berthing, commenced/completed, ETC, shore equipment, cargo, berth and tide delays, weather | Only if ticked |
| Surveyor | Draft surveys | Only if ticked |
| Owners, Charterers, Broker | Nothing (they review) | Yes by default |
| Your own organisation | Everything, plus CP terms and invitations | Yes |

Stakeholders without commercial access never receive rates, terms or amounts from the server.

**Events.** Milestones (arrived, NOR tendered/accepted, laytime commences, berthed, commenced, completed, sailed, ETC) fill the time sheet automatically and lock those fields. Stoppages have a reason code and a start, plus an end once they finish; an open stoppage runs up to the current port time. Pasting lines works too.

**Reviews.** Only another side can confirm an event: not its author, and not someone with the same role (another agent, or a colleague in your own organisation). Anyone can dispute it, but must give a reason. A disputed event can then be confirmed only by the party that disputed it, or by your organisation. The author can fix a disputed event, which sets it back to open. If an event changed after a reviewer opened it, their confirm or dispute is refused, so nobody confirms a version they didn't see. Confirmed events can only be changed by your organisation. Disputed lines are marked `[disputed]` in the statement and counted on the voyage.

**CP treatment.** Each reason code has a default treatment (e.g. rain not to count, shore crane breakdown counts, ship's gear breakdown not to count and stops demurrage). Change it per voyage in *CP treatment of SOF reasons* to match the charter party. The statement recalculates at once.

**Live forecast.** While a port is still working (no completion yet), the result shows time used so far, when laytime will expire if time keeps counting, and, if an ETC is entered, the expected demurrage or despatch at ETC. Set the port's time zone so "now" is port local time.

## Reading documents (AI)

Upload a statement of facts, timesheet or charter party under *Documents*. The app reads it in the background and lists the events and terms it found. Nothing is added until someone ticks the lines and clicks **Add selected to SOF**. Charter party terms (rates, quantity, laytime terms, turn time, demurrage, despatch) can only be applied by your organisation.

Two readers are built in:

- **Built-in reader** (default): Excel, CSV and text. It looks for dates, times and keywords line by line. Lines without a stop word are treated as working time and skipped.
- **Luma** (set `LUMA_API_URL` and `LUMA_API_KEY`): any format Luma reads, including PDFs and scans.

### Connecting Luma

All Luma-specific code is in `src/extract/luma.js`. As written, it sends:

```
POST $LUMA_API_URL
Authorization: Bearer $LUMA_API_KEY
Content-Type: multipart/form-data
  file          the document
  task          "laytime_extraction"
  instructions  plain-English description of the job
  schema        JSON Schema of the expected answer (see SCHEMA in luma.js)
  context       {"vessel": ..., "ports": [{"name", "operation"}], "documentType": "sof" | "cp" | "other"}
```

and expects JSON like this, at the top level or under `data` / `result`:

```json
{
  "events": [
    {"kind": "milestone", "code": "NOR_TENDERED", "at": "2013-09-13T08:05", "remark": "NOR tendered", "source_text": "...", "confidence": 0.97},
    {"kind": "stoppage", "code": "RAIN", "from": "2013-09-16T15:00", "to": "2013-09-16T22:30", "remark": "Rain"}
  ],
  "terms": {"qty": 36010.25, "rate": 6000, "terms": "SATPM SHEX", "turnTimeHours": 24, "demRate": 7000, "hd": true},
  "warnings": []
}
```

If Luma's real API looks different, change only `buildRequest()` and `parseResponse()` in that file. Everything after that is tolerant:
- dates may be ISO, `17.09.2013 14:45` or `17 Sep 2013 14:45`
- unknown or missing codes are guessed from the remark
- port names are matched to the voyage's ports
- rows without usable times are skipped with a warning

The mock Luma server in `test/esof.test.js` shows the round trip.

Documents are stored in Postgres (15 MB limit per file), so they survive redeploys. They are read in the app process, two at a time, with the rest waiting their turn. Excel files are refused if they expand to more than 25 MB, which stops "zip bombs" from crashing the server. Only the first 20,000 lines are read. A document cut off by a restart is marked *Could not read* after 10 minutes, and can be retried. For heavy volumes, move `processDocument()` to a job queue.

Terms found in any document (rates, quantities, laytime terms) are only sent to people who can see amounts.

## How the calculation works

- **Time starts counting** at "Time to count from" if it is filled in. Otherwise it starts at NOR tendered plus the turn time.
- **Excluded windows** (e.g. SAFSHEX = Saturday 12:00 to Monday 08:00) and holidays apply even if used (EIU).
- **Not-to-count periods** stop the clock. A period marked half time counts at 50%. Once on demurrage, a period that stops demurrage counts at its own demurrage share (by default the same as its laytime share).
- **Laytime expiry:** when laytime runs out the vessel is on demurrage. With "Once on demurrage, always on demurrage" ticked, only periods marked "Stops demurrage" interrupt it. Untick it if the charter party lets other delays count off demurrage too.
- **Despatch** is paid on laytime saved (allowed minus used), at the despatch rate. "HD" sets it to half the demurrage rate.
- **Amounts** are pro rata: days to 4 decimals × the daily rate.
- **Reversible:** laytime allowed at all ports is pooled. Ports are counted in tab order, and demurrage can start at a later port.

## Project layout

```
src/            server: config, db, migrations runner, auth, routes, Excel export, seed
shared/         laytime engine, statement builder, example voyage (used by browser and server)
public/         login, app shell, stakeholder portal, invite page, CSS, browser JS
src/extract/    document reading: Luma adapter, built-in reader, result normaliser
db/migrations/  SQL migrations, applied in order on start
test/           engine, API, eSOF/document, login ID, OTP, permission and hardening tests (with mock Luma and SMS/email gateways)
railway.json    Railway build and deploy settings
```

## API (for integrations)

All endpoints are JSON and need the session cookie. Write requests (POST, PUT, PATCH, DELETE) must send `X-Requested-With: fetch`. Platform admins also send `X-Tenant-Id` to pick an organisation.

| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/login | Sign in `{login, password}`; `login` is a login ID or an email |
| GET | /api/auth/otp/options | Which code channels are available `{sms, email}` |
| POST | /api/auth/otp/request | Send a sign-in code `{login}` (mobile number or email) |
| POST | /api/auth/otp/verify | Sign in `{login, code}` |
| POST | /api/auth/otp/contact/request, /contact/verify, /contact/remove | Add or change own mobile/email `{kind, value, code}` |
| GET / PUT / DELETE | /api/admin/permissions?scope=default\|<organisation id> | Roles × modules matrix (platform admin) |
| POST | /api/auth/logout | Sign out |
| GET | /api/auth/me | Current user |
| POST | /api/auth/password | Change own password `{current, next}` |
| GET | /api/voyages?q= | List voyages |
| POST | /api/voyages | Create; `{sample:true}` loads the example |
| GET | /api/voyages/:id | Read |
| PUT | /api/voyages/:id | Save `{data, version, status?}`; 409 if someone saved first |
| POST | /api/voyages/:id/duplicate | Copy |
| DELETE | /api/voyages/:id | Delete |
| GET | /api/voyages/:id/export.xlsx | Excel workbook |
| GET/POST/PATCH | /api/admin/users | Manage users |
| GET/POST/PATCH | /api/admin/tenants | Manage organisations (platform admin) |
| GET | /api/admin/audit | Recent activity |
| GET | /api/v/:id | Voyage as seen by the caller: access, data (redacted if needed), events with reviews, stakeholders, documents |
| POST | /api/v/:id/events | Record an event `{portId, code, at}` or `{portId, code, from, to?}` |
| POST | /api/v/:id/events/bulk | Pasted lines `{portId, text}` |
| PATCH / DELETE | /api/v/:id/events/:eid | Change (with `version`) or remove an event |
| POST | /api/v/:id/events/:eid/review | `{decision: confirm\|dispute\|comment, comment, version?}`; 409 if the event changed since `version` |
| POST | /api/v/:id/invites | Invite `{email, party, commercial?}`; returns a link |
| POST | /api/v/:id/participants | Create a stakeholder login `{name, company?, loginId?, email?, party, commercial?, password}` |
| POST | /api/v/:id/participants/existing | Add an existing stakeholder `{loginId, party, commercial?}` |
| POST | /api/v/:id/participants/:pid/reset | Reset a stakeholder password your organisation created `{password}` |
| PATCH / DELETE | /api/v/:id/participants/:pid | Change or remove a stakeholder |
| POST | /api/v/:id/documents | Upload: raw body, headers `X-Filename`, `X-Doc-Type`, `X-Port-Id` |
| POST | /api/v/:id/documents/:did/apply | `{events: [indexes], terms: bool}` |
| POST | /api/invites/lookup, /api/invites/accept | Invitation flow (public) |
| GET | /api/invites/mine | Stakeholder's voyages |
| GET | /healthz | Health check, no sign-in (200 when the database answers) |
