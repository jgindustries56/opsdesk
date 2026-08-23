'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const { nowIso, toCents, logActivity } = require('../lib');

const router = express.Router();

async function decorate(rows) {
  const contacts = await db.all('SELECT id, name, company, phone, email FROM contacts');
  const map = new Map(contacts.map((c) => [String(c.id), c]));
  const invoices = await db.all('SELECT id, number, job_id, status FROM invoices');
  const byJob = new Map();
  for (const inv of invoices) {
    if (!inv.job_id) continue;
    if (!byJob.has(String(inv.job_id))) byJob.set(String(inv.job_id), []);
    byJob.get(String(inv.job_id)).push(inv);
  }
  return rows.map((r) => ({
    ...r,
    contact: map.get(String(r.contact_id)) || null,
    invoices: byJob.get(String(r.id)) || [],
  }));
}

router.get('/', async (req, res) => {
  const stage = req.query.stage;
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = await db.all('SELECT * FROM jobs ORDER BY id DESC');
  if (stage) rows = rows.filter((r) => r.stage === stage);
  if (q) {
    rows = rows.filter((r) =>
      [r.title, r.description, r.reference, r.owner]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  res.json(await decorate(rows));
});

router.get('/board', async (req, res) => {
  const rows = await decorate(await db.all('SELECT * FROM jobs ORDER BY id DESC'));
  res.json(config.jobStages.map((stage) => ({ stage, items: rows.filter((r) => r.stage === stage) })));
});

router.get('/:id', async (req, res) => {
  const row = await db.one('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const [decorated] = await decorate([row]);
  const activity = await db.all(
    "SELECT * FROM activity WHERE entity_type = 'job' AND entity_id = $1 ORDER BY id DESC",
    [req.params.id]
  );
  res.json({ ...decorated, activity });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) {
    return res.status(400).json({ error: 'A title is required' });
  }
  const row = await db.one(
    `INSERT INTO jobs (contact_id, intake_id, reference, title, description, stage, owner,
       value_cents, due_date, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10) RETURNING *`,
    [
      b.contact_id || null,
      b.intake_id || null,
      b.reference || null,
      String(b.title).trim(),
      b.description || null,
      b.stage || config.jobStages[0],
      b.owner || null,
      toCents(b.value),
      b.due_date || null,
      nowIso(),
    ]
  );
  await logActivity('job', row.id, 'created', 'Created');
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const stage = b.stage ?? existing.stage;
  const stageChanged = stage !== existing.stage;
  const completed = stage === 'Complete';

  const row = await db.one(
    `UPDATE jobs SET contact_id=$1, intake_id=$2, reference=$3, title=$4, description=$5, stage=$6,
       owner=$7, value_cents=$8, due_date=$9, completed_at=$10, last_activity_at=$11, updated_at=$11
     WHERE id=$12 RETURNING *`,
    [
      b.contact_id ?? existing.contact_id,
      b.intake_id ?? existing.intake_id,
      b.reference ?? existing.reference,
      b.title ?? existing.title,
      b.description ?? existing.description,
      stage,
      b.owner ?? existing.owner,
      b.value !== undefined ? toCents(b.value) : existing.value_cents,
      b.due_date !== undefined ? b.due_date || null : existing.due_date,
      completed ? existing.completed_at || nowIso() : null,
      nowIso(),
      req.params.id,
    ]
  );
  if (stageChanged) await logActivity('job', row.id, 'stage', `Moved ${existing.stage} → ${stage}`);
  res.json(row);
});

router.post('/:id/touch', async (req, res) => {
  const b = req.body || {};
  await db.query('UPDATE jobs SET last_activity_at=$1, updated_at=$1 WHERE id=$2', [
    nowIso(),
    req.params.id,
  ]);
  await logActivity('job', req.params.id, 'note', b.body || 'Progress logged');
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM jobs WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
