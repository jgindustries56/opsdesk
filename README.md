# OpsDesk

One engine. Many branded deployments.

A small-business operations core: customers, enquiries, jobs, invoices,
payments — and a follow-up queue that surfaces anything gone quiet. Every
client gets their own Railway deployment, their own database, their own domain
and their own vocabulary. Nobody sees the shared skeleton underneath.

---

## Why it exists

Small businesses either pay $50–400/month for generic software that fits
badly, or $25,000+ for custom software. This sits in the gap: the *feel* of
bespoke software at a fraction of the cost, because 80% of it is already built
and only the last 20% is per-client work.

## The follow-up queue

Most of these tools store records. This one asks a question every morning:
**what has gone quiet that shouldn't have?**

| Rule | Fires when |
|---|---|
| `intake_stale` | An open enquiry hasn't been touched in *N* days |
| `reminder_due` | A scheduled follow-up date has arrived or passed |
| `job_stale` | Live work hasn't moved in *N* days |
| `job_overdue` | Work is past the date promised to the customer |
| `job_uninvoiced` | Work finished and nobody billed for it |
| `invoice_draft` | An invoice was written but never sent |
| `invoice_overdue` | A sent invoice is past due and still short |

Every threshold is an environment variable. Tighten them for a fast-moving
business, loosen them for a slow one.

---

## Running it on your own machine

No database to install, no Docker, no setup.

```bash
npm install
npm run seed      # optional demo data
npm start         # http://localhost:3000
```

With `DATABASE_URL` unset it writes to a local SQLite file. Set `DATABASE_URL`
and the identical code runs on Postgres. Same SQL, same routes, no branching
logic in the app.

```bash
npm test          # 24 end-to-end checks against a throwaway database
```

## Configuration

Everything client-specific lives in environment variables — see
[`.env.example`](.env.example), which is commented in full. The headlines:

```bash
COMPANY_NAME="Rox Jewellers"
BRAND_PRIMARY="#7a5af8"
LABEL_CONTACT="Client"          # a jeweller has clients
LABEL_JOB="Piece"               # ...and pieces, not "jobs"
INTAKE_STAGES="New,Quoted,Deposit taken,In workshop,Ready,Collected"
FOLLOWUP_INTAKE_DAYS=2
MODULES="contacts,intakes,jobs,invoices,payments,followups"
```

Change `LABEL_JOB` and the navigation, buttons, modals and follow-up messages
all re-word themselves. Change `BRAND_PRIMARY` and the whole app re-skins.
Drop a module from `MODULES` and its tab and API disappear.

## Deploying

See [DEPLOY.md](DEPLOY.md) — two Railway environments (`staging` from the
`staging` branch, `production` from `main`), plus the DNS records that put the
client's own domain on the front.

---

## Architecture

```
server.js            Express app, auth gate, module guards, static hosting
src/config.js        The white-label layer — every per-client variable
src/db.js            Dual driver: Postgres when DATABASE_URL is set, else SQLite
src/schema.js        Tables and indexes, created on boot, additive only
src/lib.js           Money maths, invoice numbering, the follow-up rules
src/auth.js          Signed-cookie session, one shared password per deployment
src/routes/          contacts · intakes · jobs · invoices · dashboard
public/              Single-page front end, no build step, themed from /api/config
test/smoke.js        End-to-end suite
seed.js              Demo data for sales calls
```

Two runtime dependencies: `express` and `pg`. Nothing else. Fast builds, small
attack surface, and very little that can rot between deployments.

### Decisions worth knowing

- **Money is integer cents.** No floats, no rounding drift, no argument with a
  client over a penny on a total.
- **Follow-up rules run in JavaScript, not SQL.** Both database drivers then
  behave identically and the thresholds stay per-client configurable.
- **Schema migrations are additive and idempotent.** Every deploy runs them;
  none of them destroy data.
- **Async route handlers are wrapped centrally.** A thrown error returns a 500
  instead of taking the client's app down.
- **Production refuses to boot without `APP_PASSWORD`.** Cheap insurance
  against a client's customer list sitting open on the internet.

## Extending for a client

The per-client 20% is a new module, not a fork:

1. Add its table to `src/schema.js`.
2. Add `src/routes/<module>.js` and mount it in `server.js` behind a
   `guard('<module>')`.
3. Add a view function in `public/app.js` and a nav entry in `buildNav()`.
4. Add the module name to that client's `MODULES` variable — and only theirs.

Everyone else stays on the same shared core and keeps getting your fixes.
