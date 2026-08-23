'use strict';

const crypto = require('node:crypto');
const config = require('./config');

/**
 * Deliberately small: one shared password per deployment, signed cookie, no
 * user table. A five-person jeweller does not want to manage seats, and every
 * extra auth surface is another thing that can break on a Saturday.
 *
 * If APP_PASSWORD is unset the app runs open — fine on your laptop, refused in
 * production by server.js.
 */

const SECRET = config.sessionSecret || crypto.createHash('sha256')
  .update(`${config.appPassword}|${config.companyName}|opsdesk-fallback`)
  .digest('hex');

const COOKIE = 'opsdesk_session';

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > -1) acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    return acc;
  }, {});
}

function issue(res) {
  const exp = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
  const token = sign({ ok: true, exp });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  });
}

function clear(res) {
  res.clearCookie(COOKIE);
}

/** Constant-time password comparison. */
function passwordMatches(supplied) {
  if (!config.appPassword) return true;
  const a = crypto.createHash('sha256').update(String(supplied || '')).digest();
  const b = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

function required(req, res, next) {
  if (!config.appPassword) return next();
  const cookies = parseCookies(req.headers.cookie || '');
  if (verify(cookies[COOKIE])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  return res.redirect('/login');
}

/** Blocks writes when READ_ONLY is set — handy for demo instances. */
function writable(req, res, next) {
  if (config.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'This deployment is read-only' });
  }
  next();
}

module.exports = { issue, clear, required, writable, passwordMatches, COOKIE, verify, parseCookies };
