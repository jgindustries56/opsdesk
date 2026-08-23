# Deploying a client

Two environments, one codebase, one GitHub repo. You test on yours, then push
to make it live on theirs.

---

## 1. The branch → environment model

```
GitHub repo (this code)
│
├── branch: staging  ──────►  Railway "staging" environment   ──► your private test URL
│                                                                  (banner: STAGING)
│
└── branch: main     ──────►  Railway "production" environment ──► client.theirdomain.com
                                                                   (no banner, live)
```

Railway creates a **production** environment by default, and lets you add
persistent environments that auto-deploy from their own git branch, each with
its own isolated variables. That is exactly the shape you want.

### One-time setup

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Add a **Postgres** service to the project (Railway provisions it in a click).
4. In the app service → **Variables**, set `DATABASE_URL` to the reference
   `${{Postgres.DATABASE_URL}}` — never paste the raw connection string.
5. Rename the default environment to `production` if it isn't already, and set
   its service to deploy from the **`main`** branch.
6. **New Environment → Duplicate** the production one, call it `staging`, and
   point its service at the **`staging`** branch.
7. Give the staging environment its own Postgres service so test data never
   touches client data. This matters more than it sounds — one shared database
   and your demo will eventually delete something real.

### Day to day

```bash
git checkout staging
# ...make changes, or have Claude make them...
git commit -am "Add consignment tracking for Rox"
git push origin staging          # → deploys to YOUR test instance only
```

Check it. When you're happy:

```bash
git checkout main
git merge staging
git push origin main             # → deploys to the CLIENT's live site
```

That's the "tell me to push it live" step. Nothing reaches a client until that
second push.

---

## 2. Variables per environment

Every variable in `.env.example` gets set on the Railway service. The
**staging** and **production** environments hold separate copies, so you can
point staging at a scratch database and give it a different name.

Minimum for a production deployment:

| Variable | Value |
|---|---|
| `DEPLOY_ENV` | `production` |
| `APP_PASSWORD` | the client's password (**required** — the app refuses to boot without it) |
| `SESSION_SECRET` | long random string |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `COMPANY_NAME` | the client's name |

On staging, set `DEPLOY_ENV=staging` and you get the striped warning banner
across the top of every page, so you can never demo test data thinking it's live.

---

## 3. The address: their name, not Railway's

Railway hands every service an ugly `something.up.railway.app` URL. Replacing it
takes two DNS records.

### Step 1 — Railway side

Service → **Settings → Public Networking → + Custom Domain**. Enter
`app.theirdomain.com`. Railway returns **two records**:

- a **CNAME** pointing at something like `g05ns7.up.railway.app`
- a **TXT** record for ownership verification

Both are required — a CNAME alone will not verify. Railway then issues a
Let's Encrypt certificate automatically and renews it, so HTTPS is handled.

Domain limits per service: 1 on Trial, **2 on Hobby**, 20 on Pro.

### Step 2 — DNS side (this is the "bunch of variables" screen)

In Cloudflare (free plan is fine) → your domain → **DNS → Records → Add record**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `app` | `g05ns7.up.railway.app` (whatever Railway gave you) | **DNS only** |
| TXT | (as shown by Railway) | (as shown by Railway) | — |

Turn the orange proxy cloud **off** (grey / "DNS only") for the initial setup.
Proxying before Railway has verified and issued its certificate is the single
most common way this breaks.

For a bare/apex domain (`theirdomain.com` with no `app.` in front), Cloudflare's
CNAME flattening handles it. Route 53 and Azure DNS do not — move the domain's
nameservers to Cloudflare and it works.

### Doing it for free

Be precise about what "free" means here, because two different things get
charged for:

| Thing | Cost |
|---|---|
| Custom domain support on Railway | **Free**, included in your plan |
| HTTPS certificate | **Free**, automatic (Let's Encrypt) |
| Cloudflare DNS hosting | **Free** plan is enough |
| The domain *name* itself | This is the only part that costs money |

So the hosting side is free. For the name:

- **The client already owns a domain** — the usual case, and the best one.
  Rox and Canwil have websites, so they already have a domain. You just add an
  `app.` or `portal.` subdomain to it. Costs nothing, and it makes the system
  look like part of their existing site, which is worth more than the domain fee.
- **A free subdomain service** — `eu.org` has issued free domains since 1996
  (approval can take weeks), and there are curated lists of free subdomain
  providers. Fine for your own staging instance; I would not put a paying
  client on one.
- **Buying one** — roughly $10–15/year at cost through Cloudflare Registrar,
  which sells at wholesale with no markup. Bill it to the setup fee.

**My recommendation:** always use a subdomain of the client's existing domain.
It is free, it looks native, and it means you never hold a domain that a client
might one day need to take with them.

---

## 4. Before you hand it over

- [ ] `APP_PASSWORD` set and given to the client (not over email in plain text)
- [ ] `SESSION_SECRET` is a long random value, different per client
- [ ] `DEPLOY_ENV=production` so the staging banner is gone
- [ ] Postgres attached; confirm `/healthz` reports `"driver":"postgres"`
- [ ] Custom domain verified and green in Railway
- [ ] Branding variables set — name, tagline, colours, vocabulary
- [ ] Follow-up thresholds tuned to how fast their business actually moves
- [ ] Modules trimmed to what they use
- [ ] Railway backups enabled on the Postgres service
- [ ] You have tested the whole flow on staging first
