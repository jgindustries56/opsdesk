'use strict';

const express = require('express');
const db = require('../db');
const { nowIso, getSettingsMap } = require('../lib');

const router = express.Router();

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

router.get('/', async (req, res) => {
  const map = await getSettingsMap();
  res.json(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, coerce(v)])));
});

router.patch('/', async (req, res) => {
  const b = req.body || {};
  const keys = Object.keys(b);
  if (!keys.length) return res.status(400).json({ error: 'No settings supplied' });
  for (const key of keys) {
    const value = String(b[key]);
    const existing = await db.one('SELECT key FROM settings WHERE key = $1', [key]);
    if (existing) {
      await db.query('UPDATE settings SET value=$1, updated_at=$2 WHERE key=$3', [
        value,
        nowIso(),
        key,
      ]);
    } else {
      await db.query('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,$3)', [
        key,
        value,
        nowIso(),
      ]);
    }
  }
  const map = await getSettingsMap();
  res.json(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, coerce(v)])));
});

module.exports = router;
