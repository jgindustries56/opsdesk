'use strict';

const express = require('express');
const db = require('../db');
const { nowIso, logActivity } = require('../lib');

const router = express.Router();

/**
 * The unified inbox — every inbound/outbound touch across call, text, email
 * and walk-in, in one thread. Distinct from `intakes`, which models an
 * enquiry rather than a single communication.
 */

async function decorate(rows) {
  const ids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  if (!ids.length) return rows.map((r) => ({ ...r, contact: null }));
  const contacts = await db.all('SELECT id, name, company, phone, email FROM contacts');
  const map = new Map(contacts.map((c) => [String(c.id), c]));
  return rows.map((r) => ({ ...r, contact: map.get(String(r.contact_id)) || null }));
}

/** Find a contact by phone or exact name, case-insensitively. */
async function findContact(name, phone) {
  const rows = await db.all('SELECT * FROM contacts');
  if (phone) {
    const byPhone = rows.find((c) => c.phone && c.phone === phone);
    if (byPhone) return byPhone;
  }
  if (name) {
    const byName = rows.find((c) => c.name && c.name.toLowerCase() === String(name).toLowerCase());
    if (byName) return byName;
  }
  return null;
}

router.get('/', async (req, res) => {
  const { channel, status, unread } = req.query;
  let rows = await db.all('SELECT * FROM messages ORDER BY occurred_at DESC, id DESC');
  if (channel) rows = rows.filter((r) => r.channel === channel);
  if (status) rows = rows.filter((r) => r.status === status);
  if (unread === '1' || unread === 'true') rows = rows.filter((r) => Boolean(Number(r.unread)));
  res.json(await decorate(rows));
});

router.get('/unread-count', async (req, res) => {
  const rows = await db.all('SELECT id FROM messages WHERE unread = $1', [true]);
  res.json({ count: rows.length });
});

router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM messages WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const row = await db.one(
    `UPDATE messages SET status=$1, unread=$2 WHERE id=$3 RETURNING *`,
    [
      b.status ?? existing.status,
      b.unread !== undefined ? Boolean(b.unread) : Boolean(Number(existing.unread)),
      req.params.id,
    ]
  );
  res.json(row);
});

router.post('/mark-all-read', async (req, res) => {
  const { rowCount } = await db.query('UPDATE messages SET unread = $1 WHERE unread = $2', [
    false,
    true,
  ]);
  res.json({ ok: true, updated: rowCount });
});

/**
 * Persists the reply as an outbound message and closes the original thread.
 * Actual delivery (SMS/email send) waits for the intake pipe — for now this
 * is the system of record for "what did we tell this person."
 */
router.post('/:id/reply', async (req, res) => {
  const b = req.body || {};
  const original = await db.one('SELECT * FROM messages WHERE id = $1', [req.params.id]);
  if (!original) return res.status(404).json({ error: 'Not found' });
  const body = (b.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Reply body is required' });

  const outbound = await db.one(
    `INSERT INTO messages (contact_id, channel, direction, status, unread, subject, body, occurred_at, created_at)
     VALUES ($1,$2,'out','done',$3,$4,$5,$6,$6) RETURNING *`,
    [original.contact_id, original.channel, false, original.subject, body, nowIso()]
  );
  await db.query('UPDATE messages SET status=$1, unread=$2 WHERE id=$3', [
    'done',
    false,
    req.params.id,
  ]);
  if (original.contact_id) {
    await logActivity('contact', original.contact_id, 'reply', body);
  }
  res.status(201).json(outbound);
});

/** Quick capture — log an activity, creating its contact inline if needed. */
router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A contact name is required' });

  let contact = await findContact(name, b.phone);
  if (!contact) {
    contact = await db.one(
      `INSERT INTO contacts (name, phone, created_at, updated_at) VALUES ($1,$2,$3,$3) RETURNING *`,
      [name, b.phone || null, nowIso()]
    );
  }

  const row = await db.one(
    `INSERT INTO messages (contact_id, channel, direction, status, unread, subject, body, occurred_at, created_at)
     VALUES ($1,$2,'in','new',$3,$4,$5,$6,$6) RETURNING *`,
    [contact.id, b.channel || 'call', true, b.subject || null, b.note || b.body || null, nowIso()]
  );
  res.status(201).json({ ...row, contact });
});

module.exports = router;
