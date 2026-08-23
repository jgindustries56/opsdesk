'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const { nowIso, toCents, logActivity } = require('../lib');

const router = express.Router();

/**
 * Intakes are every inbound signal: the phone call, the walk-in, the web form,
 * the "can you quote me for..." email. Capturing them is what stops revenue
 * evaporating between the ring and the invoice.
 */

async function decorate(rows) {
  const ids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  if (!ids.length) return rows.map((r) => ({ ...r, contact: null }));
  const contacts = await db.all('SELECT id, name, company, phone, email FROM contacts');
  const map = new Map(contacts.map((c) => [String(c.id), c]));
  return rows.map((r) => ({ ...r, contact: map.get(String(r.contact_id)) || null }));
}

router.get('/', async (req, res) => {
  const stage = req.query.stage;
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = await db.all('SELECT * FROM intakes ORDER BY id DESC');
  if (stage) rows = rows.filter((r) => r.stage === stage);
  if (q) {
    rows = rows.filter((r) =>
      [r.subject, r.details, r.owner, r.channel]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  res.json(await decorate(rows));
});

router.get('/board', async (req, res) => {
  const rows = await decorate(await db.all('SELECT * FROM intakes ORDER BY id DESC'));
  const board = config.intakeStages.map((stage) => ({
    stage,
    items: rows.filter((r) => r.stage === stage),
  }));
  res.json(board);
});

router.get('/:id', async (req, res) => {
  const row = await db.one('SELECT * FROM intakes WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const [decorated] = await decorate([row]);
  const activity = await db.all(
    "SELECT * FROM activity WHERE entity_type = 'intake' AND entity_id = $1 ORDER BY id DESC",
    [req.params.id]
  );
  res.json({ ...decorated, activity });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.subject || !String(b.subject).trim()) {
    return res.status(400).json({ error: 'A subject is required' });
  }
  let contactId = b.contact_id || null;

  // Convenience: let the intake form create the contact inline. Whoever is
  // answering the phone should not have to stop and go make a customer record.
  if (!contactId && b.contact_name) {
    const created = await db.one(
      `INSERT INTO contacts (name, company, email, phone, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
      [
        String(b.contact_name).trim(),
        b.contact_company || null,
        b.contact_email || null,
        b.contact_phone || null,
        nowIso(),
      ]
    );
    contactId = created.id;
  }

  const row = await db.one(
    `INSERT INTO intakes (contact_id, channel, subject, details, stage, owner, value_cents,
       next_action, next_action_at, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10) RETURNING *`,
    [
      contactId,
      b.channel || config.intakeChannels[0],
      String(b.subject).trim(),
      b.details || null,
      b.stage || config.intakeStages[0],
      b.owner || null,
      toCents(b.value),
      b.next_action || null,
      b.next_action_at || null,
      nowIso(),
    ]
  );
  await logActivity('intake', row.id, 'created', `Logged via ${row.channel}`);
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM intakes WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const stage = b.stage ?? existing.stage;
  const stageChanged = stage !== existing.stage;
  const closed = ['Won', 'Lost'].includes(stage);

  const row = await db.one(
    `UPDATE intakes SET contact_id=$1, channel=$2, subject=$3, details=$4, stage=$5, owner=$6,
       value_cents=$7, next_action=$8, next_action_at=$9, last_activity_at=$10, closed_at=$11,
       updated_at=$10 WHERE id=$12 RETURNING *`,
    [
      b.contact_id ?? existing.contact_id,
      b.channel ?? existing.channel,
      b.subject ?? existing.subject,
      b.details ?? existing.details,
      stage,
      b.owner ?? existing.owner,
      b.value !== undefined ? toCents(b.value) : existing.value_cents,
      b.next_action ?? existing.next_action,
      b.next_action_at !== undefined ? b.next_action_at || null : existing.next_action_at,
      nowIso(),
      closed ? existing.closed_at || nowIso() : null,
      req.params.id,
    ]
  );
  if (stageChanged) {
    await logActivity('intake', row.id, 'stage', `Moved ${existing.stage} → ${stage}`);
  }
  res.json(row);
});

/** Log a contact attempt. Resets the staleness clock — that is the point. */
router.post('/:id/touch', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM intakes WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.query(
    `UPDATE intakes SET last_activity_at=$1, updated_at=$1, next_action=$2, next_action_at=$3
     WHERE id=$4`,
    [nowIso(), b.next_action ?? existing.next_action, b.next_action_at ?? null, req.params.id]
  );
  await logActivity('intake', req.params.id, 'contact', b.body || 'Followed up');
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM intakes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
