'use strict';

const db = require('./db');
const { D } = db;

/**
 * Schema is created on boot and is additive only. Safe to run on every deploy.
 *
 * Money is stored as integer cents everywhere. No floats, no rounding drift,
 * no arguments with a client about a penny on an invoice total.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS contacts (
     id            ${D.id},
     name          ${D.text} NOT NULL,
     company       ${D.text},
     email         ${D.text},
     phone         ${D.text},
     address       ${D.text},
     tags          ${D.text},
     notes         ${D.text},
     archived      ${D.bool} DEFAULT ${D.false},
     created_at    ${D.ts} DEFAULT ${D.now},
     updated_at    ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS intakes (
     id               ${D.id},
     contact_id       ${D.fk} REFERENCES contacts(id) ON DELETE SET NULL,
     channel          ${D.text},
     subject          ${D.text} NOT NULL,
     details          ${D.text},
     stage            ${D.text} DEFAULT 'New',
     owner            ${D.text},
     value_cents      ${D.int} DEFAULT 0,
     next_action      ${D.text},
     next_action_at   ${D.ts},
     last_activity_at ${D.ts} DEFAULT ${D.now},
     closed_at        ${D.ts},
     created_at       ${D.ts} DEFAULT ${D.now},
     updated_at       ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS jobs (
     id               ${D.id},
     contact_id       ${D.fk} REFERENCES contacts(id) ON DELETE SET NULL,
     intake_id        ${D.fk} REFERENCES intakes(id) ON DELETE SET NULL,
     reference        ${D.text},
     title            ${D.text} NOT NULL,
     description      ${D.text},
     stage            ${D.text} DEFAULT 'Draft',
     owner            ${D.text},
     value_cents      ${D.int} DEFAULT 0,
     due_date         ${D.text},
     completed_at     ${D.ts},
     last_activity_at ${D.ts} DEFAULT ${D.now},
     created_at       ${D.ts} DEFAULT ${D.now},
     updated_at       ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS invoices (
     id               ${D.id},
     number           ${D.text} NOT NULL,
     contact_id       ${D.fk} REFERENCES contacts(id) ON DELETE SET NULL,
     job_id           ${D.fk} REFERENCES jobs(id) ON DELETE SET NULL,
     status           ${D.text} DEFAULT 'Draft',
     issue_date       ${D.text},
     due_date         ${D.text},
     tax_rate_bp      ${D.int} DEFAULT 0,
     discount_cents   ${D.int} DEFAULT 0,
     notes            ${D.text},
     terms            ${D.text},
     sent_at          ${D.ts},
     paid_at          ${D.ts},
     created_at       ${D.ts} DEFAULT ${D.now},
     updated_at       ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS invoice_items (
     id            ${D.id},
     invoice_id    ${D.fk} NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
     description   ${D.text} NOT NULL,
     qty           ${D.qty} DEFAULT 1,
     unit_cents    ${D.int} DEFAULT 0,
     position      ${D.int} DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS payments (
     id            ${D.id},
     invoice_id    ${D.fk} NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
     amount_cents  ${D.int} NOT NULL,
     method        ${D.text},
     reference     ${D.text},
     paid_on       ${D.text},
     notes         ${D.text},
     created_at    ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS activity (
     id            ${D.id},
     entity_type   ${D.text} NOT NULL,
     entity_id     ${D.fk} NOT NULL,
     kind          ${D.text} DEFAULT 'note',
     body          ${D.text},
     actor         ${D.text},
     created_at    ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key           ${D.text} PRIMARY KEY,
     value         ${D.text},
     updated_at    ${D.ts} DEFAULT ${D.now}
   )`,

  `CREATE TABLE IF NOT EXISTS counters (
     key           ${D.text} PRIMARY KEY,
     value         ${D.int} NOT NULL
   )`,

  // The unified inbox — every inbound/outbound touch across channels, distinct
  // from `intakes` (which models an enquiry, not a single communication).
  `CREATE TABLE IF NOT EXISTS messages (
     id            ${D.id},
     contact_id    ${D.fk} REFERENCES contacts(id) ON DELETE SET NULL,
     channel       ${D.text} NOT NULL,
     direction     ${D.text} NOT NULL DEFAULT 'in',
     status        ${D.text} NOT NULL DEFAULT 'new',
     unread        ${D.bool} DEFAULT ${D.true},
     subject       ${D.text},
     body          ${D.text},
     external_id   ${D.text},
     in_reply_to   ${D.fk} REFERENCES messages(id) ON DELETE SET NULL,
     occurred_at   ${D.ts} DEFAULT ${D.now},
     created_at    ${D.ts} DEFAULT ${D.now}
   )`,

  // When-then commitments from the attention queue ("remind me Monday
  // morning"), resolved to an actual timestamp server-side at creation.
  `CREATE TABLE IF NOT EXISTS scheduled_followups (
     id            ${D.id},
     trigger_label ${D.text} NOT NULL,
     trigger_at    ${D.ts} NOT NULL,
     target_kind   ${D.text} NOT NULL,
     target_id     ${D.fk},
     label         ${D.text},
     done_at       ${D.ts},
     created_at    ${D.ts} DEFAULT ${D.now}
   )`,

  // One row per calendar day the attention queue was fully cleared at least
  // once. Powers the "clean queue" streak — loss aversion makes a real,
  // honestly-earned streak worth protecting far more than a bare counter.
  `CREATE TABLE IF NOT EXISTS daily_clear_log (
     date          ${D.text} PRIMARY KEY,
     cleared_at    ${D.ts} DEFAULT ${D.now}
   )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_intakes_stage ON intakes(stage)`,
  `CREATE INDEX IF NOT EXISTS idx_intakes_contact ON intakes(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_contact ON jobs(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_contact ON invoices(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(in_reply_to)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_followups(trigger_at, done_at)`,
];

async function migrate() {
  for (const sql of TABLES) await db.exec(sql);
  for (const sql of INDEXES) await db.exec(sql);
}

module.exports = { migrate };
