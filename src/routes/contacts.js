'use strict';

const express = require('express');
const db = require('../db');
const { nowIso, logActivity } = require('../lib');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const includeArchived = req.query.archived === '1';
  let rows = await db.all('SELECT * FROM contacts ORDER BY name');
  if (!includeArchived) rows = rows.filter((r) => !r.archived || Number(r.archived) === 0);
  if (q) {
    rows = rows.filter((r) =>
      [r.name, r.company, r.email, r.phone, r.tags]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const contact = await db.one('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const [intakes, jobs, invoices, activity] = await Promise.all([
    db.all('SELECT * FROM intakes WHERE contact_id = $1 ORDER BY id DESC', [req.params.id]),
    db.all('SELECT * FROM jobs WHERE contact_id = $1 ORDER BY id DESC', [req.params.id]),
    db.all('SELECT * FROM invoices WHERE contact_id = $1 ORDER BY id DESC', [req.params.id]),
    db.all(
      "SELECT * FROM activity WHERE entity_type = 'contact' AND entity_id = $1 ORDER BY id DESC",
      [req.params.id]
    ),
  ]);
  res.json({ ...contact, intakes, jobs, invoices, activity });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) {
    return res.status(400).json({ error: 'A name is required' });
  }
  const row = await db.one(
    `INSERT INTO contacts (name, company, email, phone, address, tags, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [
      String(b.name).trim(),
      b.company || null,
      b.email || null,
      b.phone || null,
      b.address || null,
      b.tags || null,
      b.notes || null,
      nowIso(),
    ]
  );
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const row = await db.one(
    `UPDATE contacts SET name=$1, company=$2, email=$3, phone=$4, address=$5, tags=$6,
       notes=$7, archived=$8, updated_at=$9 WHERE id=$10 RETURNING *`,
    [
      b.name ?? existing.name,
      b.company ?? existing.company,
      b.email ?? existing.email,
      b.phone ?? existing.phone,
      b.address ?? existing.address,
      b.tags ?? existing.tags,
      b.notes ?? existing.notes,
      b.archived !== undefined ? Boolean(b.archived) : Boolean(Number(existing.archived)),
      nowIso(),
      req.params.id,
    ]
  );
  res.json(row);
});

router.post('/:id/notes', async (req, res) => {
  const body = (req.body || {}).body;
  if (!body) return res.status(400).json({ error: 'Note body required' });
  await logActivity('contact', req.params.id, 'note', body, (req.body || {}).actor || 'user');
  res.status(201).json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
