'use strict';

const db = require('../db');
const express = require('express');
const { buildFollowUps, todayIso, nowIso, recordClearAndGetStreak } = require('../lib');

const router = express.Router();

/** The seven follow-up rules from src/lib.js, sorted by severity then age. */
router.get('/', async (req, res) => {
  res.json(await buildFollowUps());
});

// Actions that plausibly remove an item from the attention queue — used as a
// proxy for "cleared today" since queue items are derived, not stored rows.
const CLEARING_KINDS = new Set(['sent', 'payment', 'void', 'stage', 'contact', 'note']);

/**
 * Goal-gradient progress: how much of today's queue has been worked through.
 * `total` is derived rather than a stored snapshot — cleared-today plus what
 * is still outstanding right now, which converges to the same number the
 * original client-only version tracked in memory.
 */
router.get('/progress', async (req, res) => {
  const remaining = (await buildFollowUps()).length;
  const activityRows = await db.all(
    "SELECT kind FROM activity WHERE entity_type IN ('invoice','intake','job') AND created_at >= $1",
    [`${todayIso()}T00:00:00Z`]
  );
  const clearedToday = activityRows.filter((r) => CLEARING_KINDS.has(r.kind)).length;
  const total = Math.max(clearedToday + remaining, 1);
  const streak = await recordClearAndGetStreak(remaining);

  const openCommitments = await db.all(
    'SELECT id, trigger_at FROM scheduled_followups WHERE done_at IS NULL'
  );
  const overdueCommitments = openCommitments.filter((c) => c.trigger_at <= nowIso()).length;

  res.json({
    done: clearedToday,
    total,
    remaining,
    pct: clearedToday / total,
    streak,
    open_commitments: openCommitments.length,
    overdue_commitments: overdueCommitments,
  });
});

module.exports = router;
