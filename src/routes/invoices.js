'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const {
  nowIso,
  todayIso,
  addDays,
  toCents,
  loadInvoice,
  syncInvoiceStatus,
  nextInvoiceNumber,
  logActivity,
} = require('../lib');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = req.query.status;
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = await db.all('SELECT * FROM invoices ORDER BY id DESC');
  if (status) rows = rows.filter((r) => r.status === status);

  const contacts = await db.all('SELECT id, name, company FROM contacts');
  const cmap = new Map(contacts.map((c) => [String(c.id), c]));

  const out = [];
  for (const inv of rows) {
    const full = await loadInvoice(inv.id);
    const entry = {
      ...inv,
      contact: cmap.get(String(inv.contact_id)) || null,
      totals: full.totals,
      item_count: full.items.length,
    };
    if (
      q &&
      ![entry.number, entry.contact?.name, entry.contact?.company, entry.notes]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    ) {
      continue;
    }
    out.push(entry);
  }
  res.json(out);
});

router.get('/:id', async (req, res) => {
  const inv = await loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const activity = await db.all(
    "SELECT * FROM activity WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY id DESC",
    [req.params.id]
  );
  res.json({ ...inv, activity });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const issue = b.issue_date || todayIso();
  const number = b.number || (await nextInvoiceNumber());
  const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) : config.defaultTaxRate;

  const inv = await db.one(
    `INSERT INTO invoices (number, contact_id, job_id, status, issue_date, due_date, tax_rate_bp,
       discount_cents, notes, terms, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [
      number,
      b.contact_id || null,
      b.job_id || null,
      b.status || 'Draft',
      issue,
      b.due_date || addDays(issue, config.paymentTermsDays),
      Math.round(taxRate * 100),
      toCents(b.discount),
      b.notes || null,
      b.terms || config.paymentTermsText.replace('{{days}}', String(config.paymentTermsDays)),
      nowIso(),
    ]
  );

  const items = Array.isArray(b.items) ? b.items : [];
  for (const [i, item] of items.entries()) {
    if (!item || !item.description) continue;
    await db.query(
      `INSERT INTO invoice_items (invoice_id, description, qty, unit_cents, position)
       VALUES ($1,$2,$3,$4,$5)`,
      [inv.id, item.description, Number(item.qty || 1), toCents(item.unit_price), i]
    );
  }

  // Pulling an invoice from a job copies the job's agreed value across as a
  // starting line, so nobody re-types what was already quoted.
  if (b.job_id && !items.length) {
    const job = await db.one('SELECT * FROM jobs WHERE id = $1', [b.job_id]);
    if (job && Number(job.value_cents) > 0) {
      await db.query(
        `INSERT INTO invoice_items (invoice_id, description, qty, unit_cents, position)
         VALUES ($1,$2,1,$3,0)`,
        [inv.id, job.title, Number(job.value_cents)]
      );
    }
  }

  await logActivity('invoice', inv.id, 'created', `Created ${number}`);
  res.status(201).json(await loadInvoice(inv.id));
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.one('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  await db.query(
    `UPDATE invoices SET contact_id=$1, job_id=$2, status=$3, issue_date=$4, due_date=$5,
       tax_rate_bp=$6, discount_cents=$7, notes=$8, terms=$9, updated_at=$10 WHERE id=$11`,
    [
      b.contact_id ?? existing.contact_id,
      b.job_id ?? existing.job_id,
      b.status ?? existing.status,
      b.issue_date ?? existing.issue_date,
      b.due_date ?? existing.due_date,
      b.tax_rate !== undefined ? Math.round(Number(b.tax_rate) * 100) : existing.tax_rate_bp,
      b.discount !== undefined ? toCents(b.discount) : existing.discount_cents,
      b.notes ?? existing.notes,
      b.terms ?? existing.terms,
      nowIso(),
      req.params.id,
    ]
  );

  // Items are replaced wholesale when supplied — simplest correct behaviour
  // for a line-item editor that posts the whole table back.
  if (Array.isArray(b.items)) {
    await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
    for (const [i, item] of b.items.entries()) {
      if (!item || !item.description) continue;
      await db.query(
        `INSERT INTO invoice_items (invoice_id, description, qty, unit_cents, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, item.description, Number(item.qty || 1), toCents(item.unit_price), i]
      );
    }
  }

  await syncInvoiceStatus(req.params.id);
  res.json(await loadInvoice(req.params.id));
});

/** Mark as sent. Starts the overdue clock. */
router.post('/:id/send', async (req, res) => {
  const existing = await db.one('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await db.query(
    `UPDATE invoices SET status='Sent', sent_at=$1, issue_date=COALESCE(issue_date,$2), updated_at=$1
     WHERE id=$3`,
    [nowIso(), todayIso(), req.params.id]
  );
  await syncInvoiceStatus(req.params.id);
  await logActivity('invoice', req.params.id, 'sent', 'Marked as sent');
  res.json(await loadInvoice(req.params.id));
});

router.post('/:id/void', async (req, res) => {
  await db.query("UPDATE invoices SET status='Void', updated_at=$1 WHERE id=$2", [
    nowIso(),
    req.params.id,
  ]);
  await logActivity('invoice', req.params.id, 'void', 'Voided');
  res.json(await loadInvoice(req.params.id));
});

/** Record a payment against an invoice. */
router.post('/:id/payments', async (req, res) => {
  const b = req.body || {};
  const inv = await loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  const amount = b.amount !== undefined ? toCents(b.amount) : inv.totals.balance;
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

  await db.query(
    `INSERT INTO payments (invoice_id, amount_cents, method, reference, paid_on, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      req.params.id,
      amount,
      b.method || config.paymentMethods[0],
      b.reference || null,
      b.paid_on || todayIso(),
      b.notes || null,
      nowIso(),
    ]
  );
  if (inv.status === 'Draft') {
    await db.query("UPDATE invoices SET status='Sent', sent_at=$1 WHERE id=$2", [
      nowIso(),
      req.params.id,
    ]);
  }
  await syncInvoiceStatus(req.params.id);
  await logActivity('invoice', req.params.id, 'payment', `Payment recorded`);
  res.status(201).json(await loadInvoice(req.params.id));
});

router.delete('/:id/payments/:paymentId', async (req, res) => {
  await db.query('DELETE FROM payments WHERE id = $1 AND invoice_id = $2', [
    req.params.paymentId,
    req.params.id,
  ]);
  await syncInvoiceStatus(req.params.id);
  res.json(await loadInvoice(req.params.id));
});

router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
