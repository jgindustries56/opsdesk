'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const { buildFollowUps, loadInvoice, daysSince, todayIso, responseTimeSummary } = require('../lib');

const router = express.Router();

router.get('/followups', async (req, res) => {
  res.json(await buildFollowUps());
});

/**
 * The numbers an owner actually asks about: what am I owed, what is late,
 * what came in this month, and what is sitting in the pipeline.
 */
router.get('/summary', async (req, res) => {
  const invoices = await db.all('SELECT * FROM invoices');
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  let collectedThisMonth = 0;
  let billedThisMonth = 0;
  let draftCount = 0;

  const monthPrefix = todayIso().slice(0, 7);

  for (const inv of invoices) {
    if (inv.status === 'Void') continue;
    const full = await loadInvoice(inv.id);
    if (!full) continue;

    if (inv.status === 'Draft') draftCount += 1;
    if (['Sent', 'Partial'].includes(inv.status)) {
      outstanding += full.totals.balance;
      if (inv.due_date && daysSince(`${inv.due_date}T23:59:59`) > 0) {
        overdue += full.totals.balance;
        overdueCount += 1;
      }
    }
    if (inv.issue_date && String(inv.issue_date).startsWith(monthPrefix)) {
      billedThisMonth += full.totals.total;
    }
    for (const p of full.payments) {
      if (p.paid_on && String(p.paid_on).startsWith(monthPrefix)) {
        collectedThisMonth += Number(p.amount_cents || 0);
      }
    }
  }

  const intakes = await db.all('SELECT * FROM intakes');
  const openIntakes = intakes.filter((i) => ['New', 'Contacted', 'Quoted'].includes(i.stage));
  const pipeline = openIntakes.reduce((s, i) => s + Number(i.value_cents || 0), 0);
  const newThisMonth = intakes.filter((i) =>
    String(i.created_at || '').startsWith(monthPrefix)
  ).length;

  const jobs = await db.all('SELECT * FROM jobs');
  const activeJobs = jobs.filter((j) =>
    ['Scheduled', 'In progress', 'Blocked'].includes(j.stage)
  ).length;

  const followUps = await buildFollowUps();

  const messages = await db.all('SELECT status, unread FROM messages');
  const missedCount = messages.filter((m) => m.status === 'missed').length;
  const unreadCount = messages.filter((m) => Number(m.unread)).length;
  const responseTime = await responseTimeSummary();

  res.json({
    currency: config.currency,
    outstanding_cents: outstanding,
    overdue_cents: overdue,
    overdue_count: overdueCount,
    collected_this_month_cents: collectedThisMonth,
    billed_this_month_cents: billedThisMonth,
    draft_invoice_count: draftCount,
    open_intakes: openIntakes.length,
    new_intakes_this_month: newThisMonth,
    pipeline_cents: pipeline,
    active_jobs: activeJobs,
    followup_count: followUps.length,
    followup_high: followUps.filter((f) => f.severity === 'high').length,
    unreturned_count: missedCount + unreadCount,
    median_response_minutes: responseTime.median_minutes,
    prior_median_response_minutes: responseTime.prior_median_minutes,
  });
});

/** Six months of billed vs collected, for the dashboard chart. */
router.get('/trend', async (req, res) => {
  const months = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 5; i >= 0; i -= 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(m.toISOString().slice(0, 7));
  }

  const invoices = await db.all('SELECT * FROM invoices');
  const result = months.map((m) => ({ month: m, billed_cents: 0, collected_cents: 0 }));
  const byMonth = new Map(result.map((r) => [r.month, r]));

  for (const inv of invoices) {
    if (inv.status === 'Void') continue;
    const full = await loadInvoice(inv.id);
    if (!full) continue;
    const bm = byMonth.get(String(inv.issue_date || '').slice(0, 7));
    if (bm) bm.billed_cents += full.totals.total;
    for (const p of full.payments) {
      const pm = byMonth.get(String(p.paid_on || '').slice(0, 7));
      if (pm) pm.collected_cents += Number(p.amount_cents || 0);
    }
  }
  res.json(result);
});

module.exports = router;
