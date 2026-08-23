'use strict';

const db = require('./db');
const config = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a user-entered money string ("1,250.50", "$40") into integer cents. */
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateIso, days) {
  const d = new Date(dateIso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between a timestamp and now. Negative means in the future. */
function daysSince(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

/** Next invoice number, allocated atomically enough for a single-tenant app. */
async function nextInvoiceNumber() {
  const key = 'invoice_number';
  const row = await db.one('SELECT value FROM counters WHERE key = $1', [key]);
  let next;
  if (!row) {
    next = config.invoiceStartNumber;
    await db.query('INSERT INTO counters (key, value) VALUES ($1, $2)', [key, next]);
  } else {
    next = Number(row.value) + 1;
    await db.query('UPDATE counters SET value = $1 WHERE key = $2', [next, key]);
  }
  return `${config.invoicePrefix}${next}`;
}

/** Compute an invoice's money picture from its items and payments. */
function computeTotals(items, payments, invoice) {
  const subtotal = items.reduce(
    (sum, it) => sum + Math.round(Number(it.qty || 0) * Number(it.unit_cents || 0)),
    0
  );
  const discount = Number(invoice?.discount_cents || 0);
  const taxable = Math.max(0, subtotal - discount);
  const taxRateBp = Number(invoice?.tax_rate_bp || 0); // basis points, 875 = 8.75%
  const tax = Math.round((taxable * taxRateBp) / 10000);
  const total = taxable + tax;
  const paid = payments.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0);
  const balance = total - paid;
  return { subtotal, discount, tax, taxRateBp, total, paid, balance };
}

/** Load one invoice with its items, payments and totals. */
async function loadInvoice(id) {
  const invoice = await db.one('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!invoice) return null;
  const items = await db.all(
    'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position, id',
    [id]
  );
  const payments = await db.all(
    'SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_on, id',
    [id]
  );
  const contact = invoice.contact_id
    ? await db.one('SELECT * FROM contacts WHERE id = $1', [invoice.contact_id])
    : null;
  return { ...invoice, items, payments, contact, totals: computeTotals(items, payments, invoice) };
}

/**
 * Recalculate an invoice's status from what has actually been paid.
 * Draft and Void are respected as manual states; everything else is derived.
 */
async function syncInvoiceStatus(id) {
  const inv = await loadInvoice(id);
  if (!inv) return null;
  if (inv.status === 'Draft' || inv.status === 'Void') return inv;

  let status = 'Sent';
  let paidAt = null;
  if (inv.totals.total > 0 && inv.totals.paid >= inv.totals.total) {
    status = 'Paid';
    paidAt = inv.paid_at || nowIso();
  } else if (inv.totals.paid > 0) {
    status = 'Partial';
  }
  await db.query('UPDATE invoices SET status = $1, paid_at = $2, updated_at = $3 WHERE id = $4', [
    status,
    paidAt,
    nowIso(),
    id,
  ]);
  return { ...inv, status, paid_at: paidAt };
}

async function logActivity(entityType, entityId, kind, body, actor = 'system') {
  await db.query(
    'INSERT INTO activity (entity_type, entity_id, kind, body, actor, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [entityType, entityId, kind, body, actor, nowIso()]
  );
}

/** Touch an entity's "last activity" clock so the follow-up queue backs off. */
async function touch(table, id) {
  await db.query(`UPDATE ${table} SET last_activity_at = $1, updated_at = $1 WHERE id = $2`, [
    nowIso(),
    id,
  ]);
}

/**
 * The follow-up queue — the reason anyone buys this thing.
 *
 * Every rule answers the same question: what has gone quiet that shouldn't have?
 * Rules are computed in JS rather than SQL so both database drivers behave
 * identically and the thresholds stay configurable per client.
 */
async function buildFollowUps() {
  const rules = config.followUp;
  const out = [];
  const contactsById = new Map(
    (await db.all('SELECT id, name, company, phone, email FROM contacts')).map((c) => [
      String(c.id),
      c,
    ])
  );
  const who = (id) => contactsById.get(String(id)) || null;

  // 1. Enquiries that have gone quiet while still open.
  const openStages = new Set(['New', 'Contacted', 'Quoted']);
  for (const it of await db.all('SELECT * FROM intakes')) {
    if (!openStages.has(it.stage)) continue;
    const idle = daysSince(it.last_activity_at || it.created_at);
    if (idle !== null && idle >= rules.intakeStaleDays) {
      out.push({
        type: 'intake_stale',
        severity: idle >= rules.intakeStaleDays * 3 ? 'high' : 'medium',
        entity: 'intake',
        id: it.id,
        title: it.subject,
        contact: who(it.contact_id),
        detail: `${config.labels.intake} sat at "${it.stage}" for ${idle} day${idle === 1 ? '' : 's'} with no contact`,
        days: idle,
        action: it.next_action || 'Chase this up',
        value_cents: Number(it.value_cents || 0),
      });
    }
  }

  // 2. Explicit reminders that have come due.
  for (const it of await db.all('SELECT * FROM intakes WHERE next_action_at IS NOT NULL')) {
    if (!openStages.has(it.stage)) continue;
    const due = daysSince(it.next_action_at);
    if (due !== null && due >= 0) {
      out.push({
        type: 'reminder_due',
        severity: due > 2 ? 'high' : 'medium',
        entity: 'intake',
        id: it.id,
        title: it.subject,
        contact: who(it.contact_id),
        detail:
          due === 0
            ? 'Scheduled follow-up is due today'
            : `Scheduled follow-up is ${due} day${due === 1 ? '' : 's'} overdue`,
        days: due,
        action: it.next_action || 'Scheduled follow-up',
        value_cents: Number(it.value_cents || 0),
      });
    }
  }

  // 3. Live work that has stopped moving.
  const activeJobStages = new Set(['Scheduled', 'In progress', 'Blocked']);
  const jobs = await db.all('SELECT * FROM jobs');
  for (const j of jobs) {
    if (!activeJobStages.has(j.stage)) continue;
    const idle = daysSince(j.last_activity_at || j.created_at);
    if (idle !== null && idle >= rules.jobStaleDays) {
      out.push({
        type: 'job_stale',
        severity: j.stage === 'Blocked' ? 'high' : 'medium',
        entity: 'job',
        id: j.id,
        title: j.title,
        contact: who(j.contact_id),
        detail: `${config.labels.job} stuck at "${j.stage}" for ${idle} day${idle === 1 ? '' : 's'}`,
        days: idle,
        action: j.stage === 'Blocked' ? 'Unblock or reschedule' : 'Check progress',
        value_cents: Number(j.value_cents || 0),
      });
    }
    // Work past its promised date.
    if (j.due_date && j.stage !== 'Complete' && j.stage !== 'Cancelled') {
      const late = daysSince(`${j.due_date}T23:59:59`);
      if (late !== null && late > 0) {
        out.push({
          type: 'job_overdue',
          severity: 'high',
          entity: 'job',
          id: j.id,
          title: j.title,
          contact: who(j.contact_id),
          detail: `Promised ${j.due_date} — ${late} day${late === 1 ? '' : 's'} late`,
          days: late,
          action: 'Update the customer',
          value_cents: Number(j.value_cents || 0),
        });
      }
    }
  }

  // 4. Finished work nobody has billed for. Money left on the table.
  const invoices = await db.all('SELECT * FROM invoices');
  const invoicedJobIds = new Set(
    invoices.filter((i) => i.job_id && i.status !== 'Void').map((i) => String(i.job_id))
  );
  for (const j of jobs) {
    if (j.stage !== 'Complete') continue;
    if (invoicedJobIds.has(String(j.id))) continue;
    const since = daysSince(j.completed_at || j.updated_at || j.created_at);
    if (since !== null && since >= rules.uninvoicedJobDays) {
      out.push({
        type: 'job_uninvoiced',
        severity: 'high',
        entity: 'job',
        id: j.id,
        title: j.title,
        contact: who(j.contact_id),
        detail: `Completed ${since} day${since === 1 ? '' : 's'} ago and never invoiced`,
        days: since,
        action: `Raise the ${config.labels.invoice.toLowerCase()}`,
        value_cents: Number(j.value_cents || 0),
      });
    }
  }

  // 5. Invoices written but never sent.
  for (const inv of invoices) {
    if (inv.status !== 'Draft') continue;
    const age = daysSince(inv.created_at);
    if (age !== null && age >= rules.draftInvoiceDays) {
      const full = await loadInvoice(inv.id);
      out.push({
        type: 'invoice_draft',
        severity: 'medium',
        entity: 'invoice',
        id: inv.id,
        title: `${inv.number}`,
        contact: who(inv.contact_id),
        detail: `Draft ${config.labels.invoice.toLowerCase()} sitting unsent for ${age} day${age === 1 ? '' : 's'}`,
        days: age,
        action: 'Send it',
        value_cents: full ? full.totals.total : 0,
      });
    }
  }

  // 6. Sent invoices past their due date and still short.
  for (const inv of invoices) {
    if (!['Sent', 'Partial'].includes(inv.status)) continue;
    if (!inv.due_date) continue;
    const late = daysSince(`${inv.due_date}T23:59:59`) - rules.overdueGraceDays;
    if (late > 0) {
      const full = await loadInvoice(inv.id);
      if (!full || full.totals.balance <= 0) continue;
      out.push({
        type: 'invoice_overdue',
        severity: late > 30 ? 'high' : late > 7 ? 'high' : 'medium',
        entity: 'invoice',
        id: inv.id,
        title: inv.number,
        contact: who(inv.contact_id),
        detail: `${late} day${late === 1 ? '' : 's'} overdue · ${formatMoneyServer(full.totals.balance)} outstanding`,
        days: late,
        action: 'Chase payment',
        value_cents: full.totals.balance,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => {
    const s = rank[a.severity] - rank[b.severity];
    if (s !== 0) return s;
    return (b.days || 0) - (a.days || 0);
  });
  return out;
}

function formatMoneyServer(cents) {
  try {
    return new Intl.NumberFormat(config.currencyLocale, {
      style: 'currency',
      currency: config.currency,
    }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)}`;
  }
}

module.exports = {
  toCents,
  nowIso,
  todayIso,
  addDays,
  daysSince,
  nextInvoiceNumber,
  computeTotals,
  loadInvoice,
  syncInvoiceStatus,
  logActivity,
  touch,
  buildFollowUps,
  formatMoneyServer,
  DAY_MS,
};
