'use strict';

/**
 * Demo data. Run `npm run seed` against a staging instance before a sales
 * call so the dashboard has something to show — an empty product demos badly.
 *
 * Deliberately seeds records at various ages so the follow-up queue lights up.
 */

const db = require('./src/db');
const schema = require('./src/schema');
const { nowIso, todayIso, addDays, nextInvoiceNumber } = require('./src/lib');

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

async function main() {
  await db.init();
  await schema.migrate();

  const existing = await db.one('SELECT COUNT(*) AS n FROM contacts');
  if (Number(existing.n) > 0 && !process.argv.includes('--force')) {
    console.log('Data already present. Re-run with --force to add more anyway.');
    await db.close();
    return;
  }

  const people = [
    ['Margaret Ellis', 'Ellis & Co', 'margaret@ellisco.example', '+1 555 0111', 'wholesale'],
    ['Danny Okafor', 'Okafor Interiors', 'danny@okafor.example', '+1 555 0122', 'trade'],
    ['Priya Raman', '', 'priya.raman@example.com', '+1 555 0133', 'retail, vip'],
    ['Tom Brennan', 'Brennan Fitout', 'tom@brennanfitout.example', '+1 555 0144', 'trade'],
    ['Alice Chen', 'Chen Studio', 'alice@chenstudio.example', '+1 555 0155', 'retail'],
  ];
  const contactIds = [];
  for (const [name, company, email, phone, tags] of people) {
    const row = await db.one(
      `INSERT INTO contacts (name, company, email, phone, tags, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
      [name, company || null, email, phone, tags, nowIso()]
    );
    contactIds.push(row.id);
  }

  // Intakes — one deliberately left to rot so the queue has something to say.
  const intakes = [
    [contactIds[0], 'Phone call', 'Quote for 40m upholstery weight linen', 'New', 480000, 0],
    [contactIds[1], 'Email', 'Repeat order, navy twill', 'Quoted', 265000, 9],
    [contactIds[2], 'Walk-in', 'Resize two rings, clean a bracelet', 'Contacted', 32000, 5],
    [contactIds[3], 'Website', 'Fit-out fabrics for a 12-room job', 'New', 1250000, 14],
    [contactIds[4], 'Referral', 'Sample pack request', 'Won', 8500, 2],
  ];
  const intakeIds = [];
  for (const [cid, channel, subject, stage, value, ageDays] of intakes) {
    const row = await db.one(
      `INSERT INTO intakes (contact_id, channel, subject, stage, value_cents,
         last_activity_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$6) RETURNING id`,
      [cid, channel, subject, stage, value, ago(ageDays)]
    );
    intakeIds.push(row.id);
  }

  // Jobs — including one finished but never invoiced, and one overdue.
  const jobs = [
    [contactIds[1], intakeIds[1], 'Navy twill — 120m run', 'In progress', 265000, addDays(todayIso(), 5), 2],
    [contactIds[2], intakeIds[2], 'Ring resize ×2 + bracelet clean', 'Complete', 32000, addDays(todayIso(), -3), 6],
    [contactIds[3], null, 'Brennan fit-out phase 1', 'Blocked', 640000, addDays(todayIso(), -4), 11],
    [contactIds[0], null, 'Linen sample cards', 'Complete', 14500, addDays(todayIso(), -10), 12],
  ];
  const jobIds = [];
  for (const [cid, iid, title, stage, value, due, ageDays] of jobs) {
    const row = await db.one(
      `INSERT INTO jobs (contact_id, intake_id, title, stage, value_cents, due_date,
         completed_at, last_activity_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8) RETURNING id`,
      [cid, iid, title, stage, value, due, stage === 'Complete' ? ago(ageDays) : null, ago(ageDays)]
    );
    jobIds.push(row.id);
  }

  // Invoices — one paid, one overdue, one part-paid, one stuck in draft.
  const invoiceSpecs = [
    { contact: contactIds[4], job: null, status: 'Paid', issuedAgo: 40, items: [['Sample pack', 1, 8500]], pay: 8500 },
    { contact: contactIds[1], job: jobIds[0], status: 'Sent', issuedAgo: 45, items: [['Navy twill deposit', 1, 132500]], pay: 0 },
    { contact: contactIds[3], job: jobIds[2], status: 'Sent', issuedAgo: 20, items: [['Fit-out phase 1 — materials', 1, 410000], ['Delivery', 1, 12000]], pay: 150000 },
    { contact: contactIds[2], job: jobIds[1], status: 'Draft', issuedAgo: 4, items: [['Ring resize', 2, 12000], ['Bracelet clean', 1, 8000]], pay: 0 },
  ];

  for (const spec of invoiceSpecs) {
    const number = await nextInvoiceNumber();
    const issue = addDays(todayIso(), -spec.issuedAgo);
    const inv = await db.one(
      `INSERT INTO invoices (number, contact_id, job_id, status, issue_date, due_date,
         tax_rate_bp, created_at, updated_at, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) RETURNING id`,
      [
        number, spec.contact, spec.job, spec.status, issue, addDays(issue, 30), 0,
        ago(spec.issuedAgo), spec.status === 'Draft' ? null : ago(spec.issuedAgo),
      ]
    );
    for (const [i, [desc, qty, unit]] of spec.items.entries()) {
      await db.query(
        `INSERT INTO invoice_items (invoice_id, description, qty, unit_cents, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [inv.id, desc, qty, unit, i]
      );
    }
    if (spec.pay > 0) {
      await db.query(
        `INSERT INTO payments (invoice_id, amount_cents, method, paid_on, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [inv.id, spec.pay, 'Bank transfer', addDays(issue, 6), nowIso()]
      );
    }
    if (spec.status === 'Paid') {
      await db.query("UPDATE invoices SET status='Paid', paid_at=$1 WHERE id=$2", [ago(30), inv.id]);
    } else if (spec.pay > 0) {
      await db.query("UPDATE invoices SET status='Partial' WHERE id=$1", [inv.id]);
    }
  }

  console.log('Seeded demo data.');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
