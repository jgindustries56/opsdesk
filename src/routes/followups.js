'use strict';

const express = require('express');
const db = require('../db');
const { nowIso } = require('../lib');

const router = express.Router();

/**
 * When-then commitments — "remind me Monday morning" — resolved to a real
 * timestamp server-side so a commitment made is a commitment kept, not a
 * label sitting in browser memory.
 */
const TRIGGER_OPTIONS = [
  { label: 'Later today', resolve: (d) => new Date(d.getTime() + 3 * 60 * 60 * 1000) },
  { label: 'Tomorrow morning', resolve: (d) => atNextClock(d, 1, 9) },
  { label: 'Monday morning', resolve: (d) => atNextWeekday(d, 1, 9) },
  { label: 'Next week', resolve: (d) => new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000) },
];

function atNextClock(from, daysAhead, hourUtc) {
  const d = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

function atNextWeekday(from, isoWeekday, hourUtc) {
  const d = new Date(from);
  const current = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  let add = isoWeekday - current;
  if (add <= 0) add += 7;
  d.setUTCDate(d.getUTCDate() + add);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

function resolveTrigger(label, from = new Date()) {
  const found = TRIGGER_OPTIONS.find((t) => t.label === label);
  return found ? found.resolve(from) : new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

router.get('/options', (req, res) => {
  res.json(TRIGGER_OPTIONS.map((t) => t.label));
});

router.get('/', async (req, res) => {
  const due = req.query.due === '1';
  let rows = await db.all(
    'SELECT * FROM scheduled_followups WHERE done_at IS NULL ORDER BY trigger_at'
  );
  if (due) rows = rows.filter((r) => new Date(r.trigger_at) <= new Date());
  res.json(rows);
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.trigger_label || !b.target_kind) {
    return res.status(400).json({ error: 'trigger_label and target_kind are required' });
  }
  const triggerAt = resolveTrigger(b.trigger_label);
  const row = await db.one(
    `INSERT INTO scheduled_followups (trigger_label, trigger_at, target_kind, target_id, label, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.trigger_label, triggerAt.toISOString(), b.target_kind, b.target_id || null, b.label || null, nowIso()]
  );
  res.status(201).json(row);
});

router.post('/:id/done', async (req, res) => {
  const row = await db.one('UPDATE scheduled_followups SET done_at=$1 WHERE id=$2 RETURNING *', [
    nowIso(),
    req.params.id,
  ]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM scheduled_followups WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
