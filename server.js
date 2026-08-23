'use strict';

const path = require('node:path');
const express = require('express');

const config = require('./src/config');
const db = require('./src/db');
const schema = require('./src/schema');
const auth = require('./src/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Minimal cookie helpers (avoids a dependency for two functions).
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
    if (opts.httpOnly) bits.push('HttpOnly');
    if (opts.secure) bits.push('Secure');
    if (opts.sameSite) bits.push(`SameSite=${opts.sameSite}`);
    if (opts.maxAge) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    res.append('Set-Cookie', bits.join('; '));
    return res;
  };
  res.clearCookie = (name) => {
    res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0`);
    return res;
  };
  next();
});

// ---- Health check (Railway pings this; must never require auth) ------------
app.get('/healthz', (req, res) =>
  res.json({
    ok: true,
    company: config.companyName,
    env: config.deployEnv,
    driver: db.usingPostgres ? 'postgres' : 'sqlite',
    time: new Date().toISOString(),
  })
);

// ---- Login ----------------------------------------------------------------
app.get('/login', (req, res) => {
  res.type('html').send(loginPage(req.query.error ? 'That password did not match.' : ''));
});

app.post('/login', (req, res) => {
  if (auth.passwordMatches((req.body || {}).password)) {
    auth.issue(res);
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  auth.clear(res);
  res.redirect('/login');
});

// ---- Everything below requires a session ----------------------------------
app.use(auth.required);
app.use(auth.writable);

app.get('/api/config', (req, res) => res.json(config.publicConfig()));

const guard = (moduleName) => (req, res, next) =>
  config.modules[moduleName] ? next() : res.status(404).json({ error: `${moduleName} is disabled` });

/**
 * Express 4 does not catch rejections from async handlers — an unhandled one
 * takes the whole process down. Wrapping every handler once here means a bad
 * request returns a 500 and the client's app stays up.
 */
function safeRouter(router) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const entry of layer.route.stack) {
      const original = entry.handle;
      if (original.length > 3) continue;
      entry.handle = (req, res, next) => Promise.resolve(original(req, res, next)).catch(next);
    }
  }
  return router;
}

app.use('/api/contacts', guard('contacts'), safeRouter(require('./src/routes/contacts')));
app.use('/api/intakes', guard('intakes'), safeRouter(require('./src/routes/intakes')));
app.use('/api/jobs', guard('jobs'), safeRouter(require('./src/routes/jobs')));
app.use('/api/invoices', guard('invoices'), safeRouter(require('./src/routes/invoices')));
app.use('/api/dashboard', safeRouter(require('./src/routes/dashboard')));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Something went wrong' });
});

function loginPage(message) {
  const c = config;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.companyName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family:${c.brandFont}; background:#0e1116; color:#e6edf3; }
  .card { background:#161b22; padding:2.5rem; border-radius:${c.brandRadius};
          width:min(92vw,380px); border:1px solid #2a313c; }
  h1 { margin:0 0 .25rem; font-size:1.35rem; }
  p.sub { margin:0 0 1.5rem; color:#8b949e; font-size:.9rem; }
  input { width:100%; padding:.7rem .8rem; border-radius:8px; border:1px solid #2a313c;
          background:#0e1116; color:inherit; font-size:1rem; box-sizing:border-box; }
  button { width:100%; margin-top:1rem; padding:.75rem; border:0; border-radius:8px;
           background:${c.brandPrimary}; color:#fff; font-size:1rem; font-weight:600; cursor:pointer; }
  .err { color:#ff7b72; font-size:.85rem; margin-top:.75rem; }
  .env { margin-top:1.25rem; font-size:.75rem; color:#8b949e; text-transform:uppercase; letter-spacing:.08em; }
</style></head><body>
<form class="card" method="post" action="/login">
  <h1>${escapeHtml(c.companyName)}</h1>
  <p class="sub">${escapeHtml(c.companyTagline)}</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  ${message ? `<div class="err">${escapeHtml(message)}</div>` : ''}
  ${c.isProduction ? '' : `<div class="env">${escapeHtml(c.deployEnv)} environment</div>`}
</form></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

async function start() {
  // Refuse to run a production deployment wide open. Cheap insurance against
  // a client's customer list sitting on the public internet unauthenticated.
  if (config.isProduction && !config.appPassword) {
    console.error('FATAL: APP_PASSWORD must be set when DEPLOY_ENV=production.');
    process.exit(1);
  }

  await db.init();
  await schema.migrate();

  app.listen(config.port, () => {
    console.log(
      `${config.companyName} · ${config.deployEnv} · ${db.usingPostgres ? 'postgres' : 'sqlite'} · :${config.port}`
    );
    if (!config.appPassword) console.warn('WARNING: no APP_PASSWORD set — this instance is open.');
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
