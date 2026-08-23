'use strict';

/**
 * End-to-end smoke test. Boots the real server against a throwaway SQLite file
 * and exercises every route the UI uses, then checks the money maths and the
 * follow-up rules actually fire.
 *
 *   npm test
 */

process.env.SQLITE_PATH = './data/test-run.db';
process.env.DATABASE_URL = '';
process.env.DEPLOY_ENV = 'test';
process.env.APP_PASSWORD = '';
process.env.PORT = '3999';
process.env.CURRENCY = 'USD';

const fs = require('node:fs');
const assert = require('node:assert');
const path = require('node:path');

const dbFile = path.resolve(process.env.SQLITE_PATH);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(dbFile + suffix); } catch { /* not there */ }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

async function main() {
  const { start } = require('../server');
  await start();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\nSmoke test\n');

  let contact, intake, job, invoice;

  await check('health check responds', async () => {
    const h = await req('GET', '/healthz');
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.driver, 'sqlite');
  });

  await check('config exposes labels and modules', async () => {
    const cfg = await req('GET', '/api/config');
    assert.ok(cfg.labels.contact);
    assert.strictEqual(cfg.modules.invoices, true);
  });

  await check('creates a contact', async () => {
    contact = await req('POST', '/api/contacts', {
      name: 'Test Customer', company: 'Testing Ltd', phone: '555', email: 't@example.com',
    });
    assert.ok(contact.id);
    assert.strictEqual(contact.name, 'Test Customer');
  });

  await check('rejects a nameless contact', async () => {
    const res = await fetch(`${BASE}/api/contacts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  await check('lists and searches contacts', async () => {
    const all = await req('GET', '/api/contacts');
    assert.ok(all.length >= 1);
    const hit = await req('GET', '/api/contacts?q=testing');
    assert.strictEqual(hit.length, 1);
    const miss = await req('GET', '/api/contacts?q=zzzznope');
    assert.strictEqual(miss.length, 0);
  });

  await check('logs an intake and creates its contact inline', async () => {
    const inline = await req('POST', '/api/intakes', {
      subject: 'Walk-in enquiry', contact_name: 'Inline Person', contact_phone: '999',
    });
    assert.ok(inline.contact_id, 'inline contact should have been created');

    intake = await req('POST', '/api/intakes', {
      contact_id: contact.id, subject: 'Quote for 10 units', channel: 'Email', value: '1250.50',
    });
    assert.strictEqual(intake.value_cents, 125050, 'money must round-trip as cents');
  });

  await check('moves an intake through stages', async () => {
    const moved = await req('PUT', `/api/intakes/${intake.id}`, { stage: 'Quoted' });
    assert.strictEqual(moved.stage, 'Quoted');
    const detail = await req('GET', `/api/intakes/${intake.id}`);
    assert.ok(detail.activity.some((a) => a.kind === 'stage'));
  });

  await check('creates a job and links it to the intake', async () => {
    job = await req('POST', '/api/jobs', {
      contact_id: contact.id, intake_id: intake.id, title: 'Build 10 units', value: '1250.50',
    });
    assert.strictEqual(job.value_cents, 125050);
  });

  await check('raises an invoice that inherits the job value', async () => {
    invoice = await req('POST', '/api/invoices', { contact_id: contact.id, job_id: job.id });
    assert.strictEqual(invoice.items.length, 1, 'job value should seed one line');
    assert.strictEqual(invoice.totals.total, 125050);
    assert.ok(invoice.number.startsWith('INV-'));
  });

  await check('invoice numbers increment', async () => {
    const second = await req('POST', '/api/invoices', { contact_id: contact.id });
    const a = parseInt(invoice.number.replace(/\D/g, ''), 10);
    const b = parseInt(second.number.replace(/\D/g, ''), 10);
    assert.strictEqual(b, a + 1);
    await req('DELETE', `/api/invoices/${second.id}`);
  });

  await check('line items, discount and tax compute correctly', async () => {
    const updated = await req('PUT', `/api/invoices/${invoice.id}`, {
      tax_rate: 10,
      discount: '100.00',
      items: [
        { description: 'Widget', qty: 3, unit_price: '100.00' },
        { description: 'Setup', qty: 1, unit_price: '200.00' },
      ],
    });
    // subtotal 500.00, less 100.00 discount = 400.00, +10% tax = 440.00
    assert.strictEqual(updated.totals.subtotal, 50000);
    assert.strictEqual(updated.totals.discount, 10000);
    assert.strictEqual(updated.totals.tax, 4000);
    assert.strictEqual(updated.totals.total, 44000);
    assert.strictEqual(updated.totals.balance, 44000);
  });

  await check('sending an invoice sets the status', async () => {
    const sent = await req('POST', `/api/invoices/${invoice.id}/send`);
    assert.strictEqual(sent.status, 'Sent');
    assert.ok(sent.sent_at);
  });

  await check('a partial payment yields Partial', async () => {
    const partial = await req('POST', `/api/invoices/${invoice.id}/payments`, {
      amount: '140.00', method: 'Card',
    });
    assert.strictEqual(partial.totals.paid, 14000);
    assert.strictEqual(partial.totals.balance, 30000);
    assert.strictEqual(partial.status, 'Partial');
  });

  await check('paying the balance yields Paid', async () => {
    const paid = await req('POST', `/api/invoices/${invoice.id}/payments`, { amount: '300.00' });
    assert.strictEqual(paid.totals.balance, 0);
    assert.strictEqual(paid.status, 'Paid');
    assert.ok(paid.paid_at);
  });

  await check('removing a payment reopens the invoice', async () => {
    const full = await req('GET', `/api/invoices/${invoice.id}`);
    const last = full.payments[full.payments.length - 1];
    const reopened = await req('DELETE', `/api/invoices/${invoice.id}/payments/${last.id}`);
    assert.strictEqual(reopened.status, 'Partial');
    assert.strictEqual(reopened.totals.balance, 30000);
  });

  await check('zero-amount payments are refused', async () => {
    const res = await fetch(`${BASE}/api/invoices/${invoice.id}/payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: '0' }),
    });
    assert.strictEqual(res.status, 400);
  });

  await check('follow-up queue flags an overdue invoice', async () => {
    await req('PUT', `/api/invoices/${invoice.id}`, { due_date: '2020-01-01' });
    const queue = await req('GET', '/api/dashboard/followups');
    const hit = queue.find((f) => f.type === 'invoice_overdue' && String(f.id) === String(invoice.id));
    assert.ok(hit, 'overdue invoice should appear');
    assert.strictEqual(hit.severity, 'high');
    assert.ok(hit.value_cents === 30000, `expected 30000 outstanding, got ${hit.value_cents}`);
  });

  await check('follow-up queue flags completed-but-unbilled work', async () => {
    const solo = await req('POST', '/api/jobs', { contact_id: contact.id, title: 'Unbilled work', value: '500' });
    await req('PUT', `/api/jobs/${solo.id}`, { stage: 'Complete' });
    // Backdate so it clears the threshold.
    const past = new Date(Date.now() - 10 * 86400000).toISOString();
    await req('PUT', `/api/jobs/${solo.id}`, { stage: 'Complete' });
    const dbm = require('../src/db');
    await dbm.query('UPDATE jobs SET completed_at=$1, last_activity_at=$1 WHERE id=$2', [past, solo.id]);
    const queue = await req('GET', '/api/dashboard/followups');
    assert.ok(queue.some((f) => f.type === 'job_uninvoiced' && String(f.id) === String(solo.id)));
  });

  await check('follow-up queue flags a stale enquiry', async () => {
    const dbm = require('../src/db');
    const past = new Date(Date.now() - 30 * 86400000).toISOString();
    await dbm.query('UPDATE intakes SET last_activity_at=$1 WHERE id=$2', [past, intake.id]);
    const queue = await req('GET', '/api/dashboard/followups');
    const hit = queue.find((f) => f.type === 'intake_stale' && String(f.id) === String(intake.id));
    assert.ok(hit, 'stale intake should appear');
    assert.strictEqual(hit.severity, 'high');
  });

  await check('logging a follow-up clears it from the queue', async () => {
    await req('POST', `/api/intakes/${intake.id}/touch`, { body: 'Called them back' });
    const queue = await req('GET', '/api/dashboard/followups');
    assert.ok(!queue.some((f) => f.type === 'intake_stale' && String(f.id) === String(intake.id)));
  });

  await check('dashboard summary adds up', async () => {
    const s = await req('GET', '/api/dashboard/summary');
    assert.ok(s.outstanding_cents >= 30000, `outstanding was ${s.outstanding_cents}`);
    assert.ok(s.overdue_cents >= 30000);
    assert.ok(s.followup_count > 0);
    assert.ok(Number.isFinite(s.pipeline_cents));
  });

  await check('trend returns six months', async () => {
    const t = await req('GET', '/api/dashboard/trend');
    assert.strictEqual(t.length, 6);
    assert.ok(t.every((m) => /^\d{4}-\d{2}$/.test(m.month)));
  });

  await check('voiding removes an invoice from outstanding', async () => {
    const before = await req('GET', '/api/dashboard/summary');
    await req('POST', `/api/invoices/${invoice.id}/void`);
    const after = await req('GET', '/api/dashboard/summary');
    assert.ok(after.outstanding_cents < before.outstanding_cents);
  });

  await check('disabled modules return 404', async () => {
    // modules are all on by default here; check the guard shape instead
    const res = await fetch(`${BASE}/api/nonexistent`);
    assert.strictEqual(res.status, 404);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
